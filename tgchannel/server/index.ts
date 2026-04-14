#!/usr/bin/env bun
/**
 * Center Manager for tgchannel multi-instance support.
 *
 * Runs as a standalone process (not via MCP). Connects to Telegram,
 * maintains socket connections to registered Claude instances, routes
 * messages to the active instance, and handles reply routing back to Telegram.
 *
 * State: ~/.claude/channels/tgchannel/center/
 */

import { Bot, InlineKeyboard, InputFile } from 'grammy'
import { createServer, type Socket as NetSocket } from 'net'
import { existsSync, mkdirSync, chmodSync, readFileSync, writeFileSync, unlinkSync, renameSync } from 'fs'
import { join, extname } from 'path'
import { homedir } from 'os'
import { randomBytes } from 'crypto'
import { SessionStore, type Instance } from './session-store.js'
import type { SocketMessage } from './socket-server.js'

// --- State directory ---
const BASE_DIR = join(homedir(), '.claude', 'channels', 'tgchannel')
const SOCKET_PATH = join(BASE_DIR, 'center.sock')
const PID_FILE = join(BASE_DIR, 'center.pid')
const ENV_FILE = join(BASE_DIR, '.env')
const ACCESS_FILE = join(BASE_DIR, 'access.json')
const INBOX_DIR = join(BASE_DIR, 'inbox')
const LOG_DIR = join(BASE_DIR, 'logs')

// --- PID lock ---
if (existsSync(PID_FILE)) {
  try {
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim())
    process.kill(pid, 0)
    log('manager: already running (PID', pid + ')')
    process.exit(1)
  } catch {
    // Stale PID file, clean up
    try { unlinkSync(PID_FILE) } catch {}
  }
}

mkdirSync(INBOX_DIR, { recursive: true, mode: 0o755 })
mkdirSync(LOG_DIR, { recursive: true, mode: 0o755 })
writeFileSync(PID_FILE, String(process.pid), { mode: 0o644 })

function log(...args: string[]) {
  const msg = new Date().toISOString() + ' ' + args.join(' ') + '\n'
  process.stderr.write(msg)
}

// Load env
if (existsSync(ENV_FILE)) {
  try {
    chmodSync(ENV_FILE, 0o600)
    for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
    }
  } catch {}
}

// --- Access control ---
interface PendingEntry {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

interface GroupPolicy {
  allowFrom: string[]
  requireMention: boolean
}

interface Access {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns: string[]
}

const DEFAULT_ACCESS: Access = {
  dmPolicy: 'allowlist',
  allowFrom: [],
  groups: {},
  pending: {},
  mentionPatterns: [],
}

function loadAccess(): Access {
  try {
    if (!existsSync(ACCESS_FILE)) return { ...DEFAULT_ACCESS }
    const raw = readFileSync(ACCESS_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'allowlist',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns ?? [],
    }
  } catch {
    return { ...DEFAULT_ACCESS }
  }
}

function saveAccess(a: Access): void {
  mkdirSync(BASE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}

function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

function isMentioned(ctx: any, patterns: string[]): boolean {
  const entities = ctx.message?.entities ?? ctx.message?.caption_entities ?? []
  const text = ctx.message?.text ?? ctx.message?.caption ?? ''
  const me = ctx.me?.username
  for (const e of entities) {
    if (e.type === 'mention' || e.type === 'text_mention') {
      const mention = text.slice(e.offset, e.offset + e.length).toLowerCase()
      if (me && mention === `@${me.toLowerCase()}`) return true
      for (const p of patterns) {
        if (mention.includes(p.toLowerCase())) return true
      }
    }
  }
  return false
}

type GateResult =
  | { action: 'deliver' }
  | { action: 'drop' }
  | { action: 'reject' }
  | { action: 'pair'; code: string; isResend: boolean }

function gate(ctx: any): GateResult {
  const access = loadAccess()
  const pruned = pruneExpired(access)
  if (pruned) saveAccess(access)

  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  const from = ctx.from
  if (!from) return { action: 'drop' }
  const senderId = String(from.id)
  const chatType = ctx.chat?.type

  if (chatType === 'private') {
    if (access.allowFrom.includes(senderId)) return { action: 'deliver' }
    if (access.dmPolicy === 'allowlist') return { action: 'reject' }

    // pairing mode
    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'reject' }
        p.replies = (p.replies ?? 1) + 1
        saveAccess(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

    const code = randomBytes(3).toString('hex')
    const now = Date.now()
    access.pending[code] = {
      senderId,
      chatId: String(ctx.chat!.id),
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000,
      replies: 1,
    }
    saveAccess(access)
    return { action: 'pair', code, isResend: false }
  }

  if (chatType === 'group' || chatType === 'supergroup') {
    const groupId = String(ctx.chat!.id)
    const policy = access.groups[groupId]
    if (!policy) return { action: 'drop' }
    const groupAllowFrom = policy.allowFrom ?? []
    const requireMention = policy.requireMention ?? true
    if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) {
      return { action: 'drop' }
    }
    if (requireMention && !isMentioned(ctx, access.mentionPatterns)) {
      return { action: 'drop' }
    }
    return { action: 'deliver' }
  }

  return { action: 'drop' }
}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!TOKEN) {
  log('manager: TELEGRAM_BOT_TOKEN required in', ENV_FILE)
  process.exit(1)
} else {
  log(`using bot: ${TOKEN}`)
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

const MAX_CHUNK_LIMIT = 4096

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    const cut = rest.lastIndexOf('\n', limit)
    out.push(rest.slice(0, cut > 0 ? cut : limit))
    rest = rest.slice(cut > 0 ? cut + 1 : limit)
  }
  if (rest) out.push(rest)
  return out
}

// --- Telegram bot ---
const bot = new Bot(TOKEN)

async function sendReply(chat_id: string, text: string, reply_to?: string, files?: string[], format?: string): Promise<number[]> {
  const access = loadAccess()
  if (!access.allowFrom.includes(chat_id) && !(chat_id in access.groups)) {
    log('reply blocked: chat', chat_id, 'not allowlisted')
    return []
  }

  // Send files first as media group or individual messages
  const ids: number[] = []
  const parseMode: 'HTML' | undefined = format !== 'text' ? 'HTML' : undefined

  if (files && files.length > 0) {
    for (const filePath of files) {
      try {
        if (existsSync(filePath)) {
          const ext = extname(filePath).toLowerCase()
          const isPhoto = ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)
          if (isPhoto) {
            const sent = await bot.api.sendPhoto(chat_id, new InputFile(filePath), {
              caption: ids.length === 0 ? text : undefined,
              ...(ids.length === 0 && reply_to ? { reply_parameters: { message_id: Number(reply_to) } } : {}),
              ...(parseMode && ids.length === 0 ? { parse_mode: parseMode } : {}),
            })
            ids.push(sent.message_id)
          } else {
            const sent = await bot.api.sendDocument(chat_id, new InputFile(filePath), {
              caption: ids.length === 0 ? text : undefined,
              ...(ids.length === 0 && reply_to ? { reply_parameters: { message_id: Number(reply_to) } } : {}),
              ...(parseMode && ids.length === 0 ? { parse_mode: parseMode } : {}),
            })
            ids.push(sent.message_id)
          }
        }
      } catch (err) {
        log('send file error:', err, filePath)
      }
    }
    // If files were sent and text was included with the first file, we're done
    if (ids.length > 0 && text) return ids
  }

  // Send text chunks if not already sent with files
  if (!files || files.length === 0 || !text) {
    const chunks = chunkText(text, MAX_CHUNK_LIMIT)
    for (let i = 0; i < chunks.length; i++) {
      const sent = await bot.api.sendMessage(chat_id, chunks[i], {
        ...(reply_to && i === 0 ? { reply_parameters: { message_id: Number(reply_to) } } : {}),
        ...(parseMode ? { parse_mode: parseMode } : {}),
      })
      ids.push(sent.message_id)
    }
  }
  return ids
}

// --- Session store ---
const store = new SessionStore()

// --- Socket server ---
const sockets = new Map<string, NetSocket>()
const lastPongTime = new Map<string, number>()

function broadcastToAll(msg: unknown, excludeSessionId?: string): void {
  const data = JSON.stringify(msg) + '\n'
  for (const [sid, sock] of sockets) {
    if (sid !== excludeSessionId) {
      sock.write(data)
    }
  }
}

// --- Heartbeat checker ---
setInterval(() => {
  const now = Date.now()
  for (const [sid, lastPong] of lastPongTime) {
    if (now - lastPong > 6000) { // 6 seconds without ping from client
      log('heartbeat timeout, removing client:', sid)
      const sock = sockets.get(sid)
      if (sock) {
        sock.destroy()
      }
      sockets.delete(sid)
      lastPongTime.delete(sid)
      store.unregister(sid)
      broadcastToAll({ type: 'instances_updated', instances: store.getAllInstances() })
    }
  }
}, 10000)

const server = createServer((socket: NetSocket) => {
  let sessionId: string | null = null

  socket.on('data', chunk => {
    const lines = chunk.toString().split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line) as SocketMessage
        handleSocketMessage(msg, socket, () => sessionId, (sid) => { sessionId = sid })
      } catch (e) {
        log('socket parse error:', e)
      }
    }
  })

  socket.on('close', () => {
    if (sessionId) {
      sockets.delete(sessionId)
      store.unregister(sessionId)
      broadcastToAll({ type: 'instances_updated' })
      log('instance disconnected:', sessionId)
    }
  })

  socket.on('error', err => {
    log('socket error:', err)
  })
})

async function handleSocketMessage(
  msg: SocketMessage,
  socket: NetSocket,
  getSessionId: () => string | null,
  setSessionId: (sid: string) => void,
): Promise<void> {
  switch (msg.type) {
    case 'register': {
      // Reject "ghost" clients: channelReady is true only when the client
      // detects that Claude was launched with --channels/--dangerously-load-development-channels
      // containing "tgchannel" (via inspecting Claude's CLI args).
      if (msg.channelReady !== true) {
        log('register rejected (channel not ready):', msg.sessionId)
        socket.write(JSON.stringify({ type: 'rejected', reason: 'channel not ready' }) + '\n')
        break
      }
      const inst: Instance = {
        sessionId: msg.sessionId,
        pid: msg.pid,
        label: msg.label,
        lastMessage: msg.lastMessage,
        cwd: msg.cwd,
        registeredAt: Date.now(),
        lastActivityAt: Date.now(),
      }
      store.register(inst)
      sockets.set(msg.sessionId, socket)
      setSessionId(msg.sessionId)
      log('instance registered:', msg.sessionId)
      // Notify all instances of update
      broadcastToAll({ type: 'instances_updated', instances: store.getAllInstances() })
      // Confirm to the instance
      socket.write(JSON.stringify({ type: 'registered', sessionId: msg.sessionId, activeSessionId: store.getActive() }) + '\n')
      break
    }
    case 'update_last_message': {
      store.updateLastMessage(msg.sessionId, msg.message)
      broadcastToAll({ type: 'instances_updated', instances: store.getAllInstances() })
      break
    }
    case 'unregister': {
      sockets.delete(msg.sessionId)
      lastPongTime.delete(msg.sessionId)
      store.unregister(msg.sessionId)
      broadcastToAll({ type: 'instances_updated', instances: store.getAllInstances() })
      log('client unregistered:', msg.sessionId)
      break
    }
    case 'switch': {
      if (store.setActive(msg.toSessionId)) {
        log('switched active to:', msg.toSessionId)
        // Notify all instances
        broadcastToAll({ type: 'active_changed', activeSessionId: msg.toSessionId })
      }
      break
    }
    case 'list_instances': {
      socket.write(JSON.stringify({
        type: 'instances_list',
        instances: store.getAllInstances(),
        activeSessionId: store.getActive(),
      }) + '\n')
      break
    }
    case 'get_active': {
      socket.write(JSON.stringify({
        type: 'active_result',
        activeSessionId: store.getActive(),
      }) + '\n')
      break
    }
    case 'ping': {
      const sid = getSessionId()
      if (sid) {
        lastPongTime.set(sid, Date.now())
        socket.write(JSON.stringify({ type: 'pong' }) + '\n')
      }
      break
    }
    case 'reply': {
      const chat_id = msg.chat_id
      const text = msg.text
      void sendReply(chat_id, text, msg.reply_to, msg.files, msg.format).then(ids => {
        log('reply sent to', chat_id, 'ids:', ids.join(','))
      }).catch(err => {
        log('reply error:', err)
      })
      break
    }
    case 'react': {
      // Forward reaction to Telegram
      bot.api.setMessageReaction(msg.chat_id, Number(msg.message_id), [
        { type: 'emoji', emoji: msg.emoji as any },
      ]).catch(err => {
        log('react error:', err)
      })
      break
    }
    case 'edit_message': {
      const editText = msg.format === 'markdown'
        ? escapeHtml(msg.text)
        : msg.text
      bot.api.editMessageText(msg.chat_id, Number(msg.message_id), editText, {
        parse_mode: 'HTML',
      }).catch(err => {
        log('edit_message error:', err)
      })
      break
    }
    case 'download_attachment': {
      // Download file and return path to client
      try {
        const file = await bot.api.getFile(msg.file_id)
        if (!file.file_path) throw new Error('Telegram returned no file_path')
        const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
        const res = await fetch(url)
        if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
        const buf = Buffer.from(await res.arrayBuffer())
        const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'bin'
        const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
        const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
        const path = join(INBOX_DIR, `${Date.now()}-${uniqueId}.${ext}`)
        mkdirSync(INBOX_DIR, { recursive: true })
        writeFileSync(path, buf)
        // Send result back to client
        const sock = sockets.get(msg.sessionId)
        if (sock) {
          sock.write(JSON.stringify({ type: 'download_result', file_path: path, _corrId: msg.corrId ?? msg.file_id }) + '\n')
        }
      } catch (err) {
        log('download_attachment error:', err)
        const sock = sockets.get(msg.sessionId)
        if (sock) {
          sock.write(JSON.stringify({ type: 'download_error', _corrId: msg.corrId ?? msg.file_id, error: String(err) }) + '\n')
        }
      }
      break
    }
    case 'permission_request': {
      // Relay permission decision back to the active client
      const sock = sockets.get(msg.sessionId ?? '')
      if (sock) {
        sock.write(JSON.stringify({
          type: 'permission_response',
          request_id: msg.request_id,
          // Center doesn't make permission decisions itself,
          // just relays to the client which handles them
          // This is a placeholder for future permission infrastructure
        }) + '\n')
      }
      break
    }
  }
}

// Display name: strip "client-" prefix from label
function displayName(label: string): string {
  return label.startsWith('client-') ? label.slice(7) : label
}

// Build inline keyboard with instance buttons
function buildInstanceKeyboard(activeSessionId: string | null): InlineKeyboard {
  const instances = store.getAllInstances()
  const keyboard = new InlineKeyboard()

  for (const inst of instances) {
    const mark = inst.sessionId === activeSessionId ? ' ✅' : ''
    keyboard.text(`${displayName(inst.label)}${mark}`, `switch:${inst.sessionId}`)
  }

  return keyboard
}

// --- Callback query handler for instance switching ---
bot.on('callback_query:data', async ctx => {
  const data = ctx.callbackQuery.data
  if (!data?.startsWith('switch:')) {
    // Not our callback
    await ctx.answerCallbackQuery().catch(() => {})
    return
  }

  log('telegram callback: 切换实例 from', ctx.from?.username ?? ctx.from?.id, 'to', data.slice(7))
  const targetSessionId = data.slice(7)
  if (!targetSessionId) {
    await ctx.answerCallbackQuery({ text: '无效的目标' }).catch(() => {})
    return
  }

  const success = store.setActive(targetSessionId)
  if (success) {
    const inst = store.getInstance(targetSessionId)
    await ctx.answerCallbackQuery({ text: `已切换到 ${displayName(inst?.label ?? targetSessionId)}` }).catch(() => {})
    // Update message with new keyboard
    const keyboard = buildInstanceKeyboard(targetSessionId)
    await ctx.editMessageReplyMarkup({ reply_markup: keyboard }).catch(() => {})
    // Notify all instances
    broadcastToAll({ type: 'active_changed', activeSessionId: targetSessionId })
  } else {
    await ctx.answerCallbackQuery({ text: '实例未找到' }).catch(() => {})
  }
})

// --- Inbound message handler ---
async function handleInbound(ctx: any, text: string, meta: Record<string, string>): Promise<void> {
  const chat_id = String(ctx.chat?.id)
  const msgId = ctx.message?.message_id
  const from = ctx.from

  // Access control
  const result = gate(ctx)
  if (result.action === 'drop') return

  if (result.action === 'reject') {
    await bot.api.sendMessage(chat_id, '你尚未获得授权，请联系管理员。').catch(() => {})
    return
  }

  if (result.action === 'pair') {
    const msg = result.isResend
      ? '🔑 配对码仍然有效：`' + result.code + '`\n\n将此码发送给 Bot 管理员以获取授权。'
      : '👋 欢迎使用！请向 Bot 管理员发送以下配对码以获取授权：\n\n`' + result.code + '`\n\n配对码 1 小时内有效。'
    await bot.api.sendMessage(chat_id, msg, { parse_mode: 'Markdown' }).catch(() => {})
    return
  }

  log('telegram inbound:', from?.username ?? from?.id, chat_id, text.slice(0, 50))

  // Send typing indicator
  void bot.api.sendChatAction(chat_id, 'typing').catch(() => {})

  // Forward to active instance
  const activeId = store.getActive()
  if (!activeId) {
    await bot.api.sendMessage(chat_id, '当前无活跃的 Claude 实例，请先启动 Claude。')
    return
  }

  const sock = sockets.get(activeId)
  if (!sock) {
    await bot.api.sendMessage(chat_id, '当前 Claude 实例已断开连接。')
    return
  }

  // Build meta
  const messageMeta = {
    chat_id,
    ...(msgId ? { message_id: String(msgId) } : {}),
    user: from?.username ?? String(from?.id ?? 'unknown'),
    user_id: String(from?.id ?? 'unknown'),
    ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
    ...meta,
  }

  // Send to active instance
  sock.write(JSON.stringify({
    type: 'forward',
    content: text,
    meta: messageMeta,
  }) + '\n')
}

// --- Telegram message listeners ---
// NOTE: command handlers must be registered BEFORE general message handlers
// because grammY runs handlers in order and bot.command() is implemented via bot.on()

// --- /start command ---
bot.command('start', async ctx => {
  if (ctx.chat?.type !== 'private') return
  log('telegram command: /start from', ctx.from?.username ?? ctx.from?.id)
  await ctx.reply(
    '此 Bot 将 Telegram 消息转发到 Claude Code，支持多实例。\n\n' +
    '发送消息后，当前活跃的 Claude 实例会回复你。\n' +
    '使用 /switch 可切换交互的 Claude 实例。'
  )
})

// --- /help command ---
bot.command('help', async ctx => {
  if (ctx.chat?.type !== 'private') return
  log('telegram command: /help from', ctx.from?.username ?? ctx.from?.id)
  await ctx.reply(
    '命令列表：\n' +
    '/start - 显示欢迎信息\n' +
    '/help - 显示此帮助\n' +
    '/switch - 切换 Claude 实例\n\n' +
    '支持发送文本、图片或文件。'
  )
})

// --- /switch command: list all instances with buttons ---
bot.command('switch', async ctx => {
  if (ctx.chat?.type !== 'private') return
  log('telegram command: /switch from', ctx.from?.username ?? ctx.from?.id)
  const instances = store.getAllInstances()
  if (instances.length === 0) {
    await ctx.reply('没有 Claude 实例连接。')
    return
  }
  const activeId = store.getActive()
  const keyboard = buildInstanceKeyboard(activeId)
  const lines = instances.map((inst, i) => {
    const mark = inst.sessionId === activeId ? '✅ ' : '  '
    return `${mark}${i + 1}. ${displayName(inst.label)}`
  }).join('\n')
  await ctx.reply(`已连接的 Claude 实例：\n\n${lines}\n\n点击按钮切换：`, {
    reply_markup: keyboard,
  })
})

// --- General message handlers (run after commands) ---
bot.on('message:text', async ctx => {
  await handleInbound(ctx, ctx.message.text, {})
})

bot.on('message:photo', async ctx => {
  const caption = ctx.message.caption ?? '(photo)'
  log('telegram inbound: photo from', ctx.from?.username ?? ctx.from?.id, String(ctx.chat?.id), caption.slice(0, 30))
  // Download image
  let imagePath: string | undefined
  try {
    const photos = ctx.message.photo
    const best = photos[photos.length - 1]
    const file = await ctx.api.getFile(best.file_id)
    if (file.file_path) {
      const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
      const res = await fetch(url)
      const buf = Buffer.from(await res.arrayBuffer())
      const ext = file.file_path.split('.').pop() ?? 'jpg'
      imagePath = join(INBOX_DIR, `${Date.now()}-${best.file_unique_id}.${ext}`)
      mkdirSync(INBOX_DIR, { recursive: true })
      writeFileSync(imagePath, buf)
    }
  } catch (err) {
    log('photo download error:', err)
  }
  await handleInbound(ctx, caption, imagePath ? { image_path: imagePath } : {})
})

bot.on('message:document', async ctx => {
  const doc = ctx.message.document
  log('telegram inbound: document from', ctx.from?.username ?? ctx.from?.id, String(ctx.chat?.id), doc.file_name ?? 'file')
  await handleInbound(ctx, ctx.message.caption ?? `(document: ${doc.file_name ?? 'file'})`, {
    attachment_kind: 'document',
    attachment_file_id: doc.file_id,
  })
})

bot.on('message:voice', async ctx => {
  const voice = ctx.message.voice
  log('telegram inbound: voice from', ctx.from?.username ?? ctx.from?.id, String(ctx.chat?.id))
  await handleInbound(ctx, '(voice message)', {
    attachment_kind: 'voice',
    attachment_file_id: voice.file_id,
  })
})

// --- Error handler ---
bot.catch(err => {
  const msg = err?.error?.message ?? String(err)
  const isNet = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ENETUNREACH|SOCKET|HTTPError|fetch/i.test(msg)
  log('bot error' + (isNet ? ' [net]' : '') + ':', msg)
})

// --- Fallback handler for unhandled message types ---
bot.on('message', async ctx => {
  const chat_id = String(ctx.chat?.id)
  // Only respond in private chats
  if (ctx.chat?.type !== 'private') return
  // Ignore already-handled message types (text/photo/document/voice handled above)
  if (ctx.message?.photo !== undefined) return
  if (ctx.message?.document !== undefined) return
  if (ctx.message?.voice !== undefined) return
  // Check access
  const result = gate(ctx)
  if (result.action === 'drop' || result.action === 'reject') return
  // Handle other message types with a helpful response
  await bot.api.sendMessage(chat_id, '已收到消息，但目前仅支持文本、图片和文件。').catch(() => {})
})

// --- Start ---
// Clean up stale socket
if (existsSync(SOCKET_PATH)) {
  try { unlinkSync(SOCKET_PATH) } catch {}
}

server.listen(SOCKET_PATH, () => {
  log('center manager listening on', SOCKET_PATH)
})

// Start bot
void (async () => {
  try {
    await bot.start({
      onStart: info => {
        log('bot polling as @' + info.username)
        bot.api.setMyCommands([
          { command: 'start', description: '欢迎信息' },
          { command: 'help', description: '显示帮助' },
          { command: 'switch', description: '切换 Claude 实例' },
        ], { scope: { type: 'all_private_chats' } }).catch(() => {})
      },
    })
  } catch (err) {
    log('bot start error:', err)
  }
})()

process.on('SIGTERM', () => {
  log('center manager shutting down')
  server.close()
  if (existsSync(SOCKET_PATH)) {
    try { unlinkSync(SOCKET_PATH) } catch {}
  }
  if (existsSync(PID_FILE)) {
    try { unlinkSync(PID_FILE) } catch {}
  }
  process.exit(0)
})