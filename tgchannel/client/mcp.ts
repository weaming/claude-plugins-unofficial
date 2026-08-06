#!/usr/bin/env bun
/**
 * Claude Client Plugin - runs inside each Claude CLI instance.
 *
 * Connects to Center Manager via Unix socket, registers the instance,
 * receives forwarded messages, and sends replies back through the center.
 *
 * Usage: bun mcp.ts
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { createConnection, type Socket as NetSocket } from 'net'
import { createWriteStream, readlinkSync, mkdirSync } from 'fs'
import { execSync } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'

// --- Config ---
const BASE_DIR = join(homedir(), '.claude', 'channels', 'tgchannel')
const SOCKET_PATH = process.env.TGCHANNEL_SOCKET_PATH ?? join(BASE_DIR, 'center.sock')
const LOG_DIR = process.env.TGCHANNEL_LOG_DIR ?? join(BASE_DIR, 'logs')
const toolsOnly = process.env.TGCHANNEL_MODE === 'tools'

// Derive client ID from parent's cwd: /Users/garden/src/ai-box -> ai-box
// Client ID format: client-{parentName}-{pid}, e.g. client-ai-box-12345
const ppid = process.ppid
let parentName = 'unknown'
try {
  let parentCwd: string
  try {
    // Linux
    parentCwd = readlinkSync(`/proc/${ppid}/cwd`)
  } catch {
    // macOS: parse lsof output
    const out = execSync(`lsof -p ${ppid} -a -d cwd 2>/dev/null | tail -1`).toString()
    const fields = out.trim().split(/\s+/)
    parentCwd = fields[fields.length - 1] ?? ''
  }
  if (parentCwd) {
    const parts = parentCwd.split('/').filter(Boolean)
    parentName = parts.slice(-1)[0] ?? 'unknown'
  }
} catch {
  // fallback
}
const clientId = `client-${parentName}-${ppid}`
const LOG_PATH = join(LOG_DIR, `${clientId}.log`)

// --- Detect whether Claude actually enabled this channel ---
// Walk up the process tree to find the Claude CLI binary, then check
// if it was launched with --channels or --dangerously-load-development-channels
// containing "tgchannel". The MCP subprocess is always started regardless of
// the channel gate outcome, so we must inspect Claude's CLI args.
function detectChannelEnabled(): boolean {
  let pid = process.ppid
  for (let depth = 0; depth < 10; depth++) {
    try {
      const cmd = execSync(`ps -o command= -p ${pid}`).toString().trim()
      if (!cmd) break

      // Check if the executable is the claude binary
      const exe = cmd.split(' ')[0]
      const exeBase = exe.split('/').pop()
      if (exeBase === 'claude' || exeBase === 'claude.exe') {
        // Found Claude — check if it has channel args for tgchannel
        const hasChannel = cmd.includes('--channels') || cmd.includes('--dangerously-load-development-channels')
        return hasChannel && cmd.includes('tgchannel')
      }

      const ppid = execSync(`ps -o ppid= -p ${pid}`).toString().trim()
      if (!ppid || ppid === '1' || ppid === '0') break
      pid = parseInt(ppid)
    } catch {
      break
    }
  }
  return false
}

// Determined once at startup — inspects Claude's CLI args
const channelEnabled = toolsOnly ? false : detectChannelEnabled()

// --- Ensure log dir exists ---
mkdirSync(LOG_DIR, { recursive: true, mode: 0o755 })

// --- Log ---
const logStream = createWriteStream(LOG_PATH, { flags: 'a' })
function log(...args: unknown[]): void {
  const ts = new Date().toISOString()
  const line = [ts, ...args].join(' ') + '\n'
  logStream.write(line)
  process.stderr.write(line)
}

// --- MCP Server ---
const mcp = new Server(
  { name: toolsOnly ? 'tgclient-tools' : 'tgclient', version: '1.0.0' },
  {
    capabilities: {
      tools: {},
      ...(toolsOnly ? {} : {
        experimental: {
          'claude/channel': {},
          'claude/channel/permission': {},
        },
      }),
    },
    instructions: [
      'CRITICAL: The user is on Telegram and CANNOT see your terminal output. ALL responses must use the reply tool — your normal text response never reaches them.',
      '',
      'Messages arrive as <channel source="tgclient" chat_id="..." message_id="..." user="..." ts="...">.',
      'The chat_id in the tag is REQUIRED for the reply tool — always pass it back.',
      'If the tag has an image_path attribute, Read that file — it is a photo the sender attached.',
      'If the tag has attachment_file_id, call download_attachment with that file_id to fetch the file, then Read the returned path.',
      '',
      'WORKFLOW: Do all your thinking and work, then call the reply tool with your final answer.',
      'For the latest message from the user, call reply with chat_id and text — no reply_to needed.',
      'Only use reply_to (set to a message_id) when quoting an earlier message in a multi-turn thread.',
      '',
      'reply accepts file paths (files: ["/abs/path.png"]) for attachments. Use react to add emoji reactions, and edit_message for interim progress updates.',
      'Edits don\'t trigger push notifications — when a long task completes, send a new reply so the user\'s device pings.',
      '',
      'Telegram\'s Bot API exposes no history or search — you only see messages as they arrive.',
      'If you need earlier context, ask the user to paste it or summarize.',
    ].join('\n'),
  },
)

// --- Socket client ---
let socket: NetSocket | null = null
let sessionId: string | null = process.env.TGCHANNEL_SESSION_ID ?? clientId
let activeSessionId: string | null = null
let isConnected = false

// Pending downloads for confirmation
const pendingDownloads = new Map<string, { resolve: (v: string) => void; reject: (e: Error) => void }>()

function connectSocket(): Promise<void> {
  return new Promise((resolve, reject) => {
    socket = createConnection(SOCKET_PATH)
    socket.on('connect', () => {
      log('client: connected to center')
      isConnected = true
      resolve()
    })

    socket.on('data', chunk => {
      const lines = chunk.toString().split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          handleSocketMessage(msg)
        } catch (e) {
          log('client: parse error', e)
        }
      }
    })

    socket.on('close', () => {
      log('client: disconnected from center')
      isConnected = false
      stopHeartbeat()
      scheduleReconnect()
    })

    socket.on('error', err => {
      log('client: socket error', err)
      reject(err)
    })
  })
}

let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let lastPingTime = 0

function scheduleReconnect(): void {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (!channelEnabled) return
    log('client: reconnecting...')
    connectSocket()
      .then(() => register(channelEnabled))
      .catch(err => {
        log('client: reconnect failed:', err.message ?? err)
        scheduleReconnect()
      })
  }, 3000)
}

function startHeartbeat(): void {
  stopHeartbeat()
  lastPingTime = 0
  heartbeatTimer = setInterval(() => {
    if (socket && isConnected) {
      // Check if last ping got a pong response
      if (lastPingTime > 0 && Date.now() - lastPingTime > 3000) {
        log('client: pong timeout, reconnecting...')
        isConnected = false
        stopHeartbeat()
        socket.destroy()
        scheduleReconnect()
        lastPingTime = 0
        return
      }
      // Send ping to center
      lastPingTime = Date.now()
      socket.write(JSON.stringify({ type: 'ping' }) + '\n')
    }
  }, 5000)
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

function send(msg: unknown): void {
  if (socket && isConnected) {
    socket.write(JSON.stringify(msg) + '\n')
  }
}

function handleSocketMessage(msg: any): void {
  switch (msg.type) {
    case 'registered':
      sessionId = msg.sessionId
      activeSessionId = msg.activeSessionId
      log('client: registered as', sessionId, 'active=', activeSessionId)
      startHeartbeat()
      break

    case 'rejected':
      log('client: register rejected:', msg.reason)
      if (channelEnabled) {
        log('client: channel is enabled, will retry forever')
        stopHeartbeat()
        socket?.destroy()
      } else {
        process.exit(0)
      }
      break

    case 'forward':
      // Forward message to Claude via MCP notification
      if (sessionId === activeSessionId) {
        // We're active - deliver to Claude
        // Must match official plugin format: params has content + nested meta object
        mcp.notification({
          method: 'notifications/claude/channel',
          params: {
            content: msg.content,
            meta: msg.meta ?? {},
          },
        }).catch(err => {
          log('client: failed to deliver forward to Claude:', err)
        })
      } else {
        log('client: received forward but not active instance, ignoring')
      }
      break

    case 'active_changed':
      activeSessionId = msg.activeSessionId
      log('client: active changed to', activeSessionId)
      break

    case 'pong':
      // Heartbeat response - connection is alive
      lastPingTime = 0
      break

    case 'instances_updated':
      log('client: instances updated')
      break

    case 'download_result':
      // Download confirmation
      const downloadPending = pendingDownloads.get(msg._corrId)
      if (downloadPending) {
        pendingDownloads.delete(msg._corrId)
        downloadPending.resolve(msg.file_path)
      }
      break

    case 'download_error':
      // Download error
      const dlErr = pendingDownloads.get(msg._corrId)
      if (dlErr) {
        pendingDownloads.delete(msg._corrId)
        dlErr.reject(new Error(msg.error ?? 'download failed'))
      }
      break

    case 'permission_response':
      // Permission relay acknowledgment
      log('client: permission response for', msg.request_id)
      break
  }
}

// --- Register with center ---
async function register(channelEnabled: boolean): Promise<void> {
  const pid = process.pid
  const cwd = process.cwd()
  const label = clientId

  send({
    type: 'register',
    sessionId: clientId,
    kind: 'mcp',
    pid,
    label,
    lastMessage: '',
    cwd,
    channelEnabled,
  })

  // Listen for MCP close - unregister from center when Claude disconnects
  mcp.onclose = () => {
    log('client: MCP connection closed')
    isConnected = false
    stopHeartbeat()
    if (!toolsOnly) {
      send({ type: 'unregister', sessionId: sessionId! })
    }
  }
}

// --- Tools ---
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send your response to the user on Telegram. REQUIRED — the user cannot see your terminal output. Pass chat_id (from the <channel> tag) and text (your response).',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string' },
          text: { type: 'string' },
          reply_to: { type: 'string', description: 'Message ID to reply to' },
          files: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths to attach' },
          format: { type: 'string', enum: ['markdown'], description: "Telegram formatting mode — always 'markdown'" },
        },
        required: ['chat_id', 'text', 'format'],
      },
    },
    {
      name: 'react',
      description: 'Add an emoji reaction to a Telegram message. Telegram only accepts a fixed whitelist (👍 👎 ❤ 🔥 👀 🎉 etc) — non-whitelisted emoji will be rejected.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string' },
          message_id: { type: 'string' },
          emoji: { type: 'string' },
        },
        required: ['chat_id', 'message_id', 'emoji'],
      },
    },
    {
      name: 'edit_message',
      description: 'Edit a message the bot previously sent. Useful for interim progress updates.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string' },
          message_id: { type: 'string' },
          text: { type: 'string' },
          format: { type: 'string', enum: ['markdown'], description: "Telegram formatting mode — always 'markdown'" },
        },
        required: ['chat_id', 'message_id', 'text', 'format'],
      },
    },
    {
      name: 'download_attachment',
      description: 'Download a file attachment from a Telegram message to the local inbox. Use when the inbound <channel> meta shows attachment_file_id.',
      inputSchema: {
        type: 'object',
        properties: {
          file_id: { type: 'string', description: 'The attachment_file_id from inbound meta' },
        },
        required: ['file_id'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>

  if (!isConnected) {
    return { content: [{ type: 'text', text: 'Not connected to center manager' }], isError: true }
  }

  switch (req.params.name) {
    case 'reply': {
      const chat_id = args.chat_id as string
      const text = args.text as string
      const reply_to = args.reply_to as string | undefined
      const files = args.files as string[] | undefined
      const format = args.format as string | undefined

      // Update last message before sending
      if (sessionId) {
        send({ type: 'update_last_message', sessionId, message: text.slice(0, 50) })
      }

      // Send reply through center
      send({
        type: 'reply',
        sessionId: sessionId!,
        chat_id,
        text,
        reply_to,
        files,
        format,
      })

      return { content: [{ type: 'text', text: 'reply sent to center manager' }] }
    }

    case 'react': {
      const chat_id = args.chat_id as string
      const message_id = args.message_id as string
      const emoji = args.emoji as string

      send({
        type: 'react',
        sessionId: sessionId!,
        chat_id,
        message_id,
        emoji,
      })

      return { content: [{ type: 'text', text: 'reaction sent' }] }
    }

    case 'edit_message': {
      const chat_id = args.chat_id as string
      const message_id = args.message_id as string
      const text = args.text as string
      const format = args.format as string | undefined

      send({
        type: 'edit_message',
        sessionId: sessionId!,
        chat_id,
        message_id,
        text,
        format,
      })

      return { content: [{ type: 'text', text: 'edit sent to center manager' }] }
    }

    case 'download_attachment': {
      const file_id = args.file_id as string
      const corrId = `dl-${Date.now()}`

      send({
        type: 'download_attachment',
        sessionId: sessionId!,
        file_id,
        corrId,
      })

      // Wait for result
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          pendingDownloads.delete(corrId)
          resolve({ content: [{ type: 'text', text: 'download timeout' }], isError: true })
        }, 30000)

        pendingDownloads.set(corrId, {
          resolve: (path) => {
            clearTimeout(timeout)
            resolve({ content: [{ type: 'text', text: path }] })
          },
          reject: (err) => {
            clearTimeout(timeout)
            resolve({ content: [{ type: 'text', text: String(err) }], isError: true })
          },
        })
      })
    }

    default:
      return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
  }
})

// --- Permission relay ---
if (!toolsOnly) {
  const notificationServer = mcp as any
  notificationServer.setNotificationHandler(
    z.object({
      method: z.literal('notifications/claude/channel/permission_request'),
      params: z.object({
        request_id: z.string(),
        tool_name: z.string(),
        description: z.string(),
        input_preview: z.string(),
      }),
    }),
    async ({ params }) => {
      send({
        type: 'permission_request',
        request_id: params.request_id,
        tool_name: params.tool_name,
        description: params.description,
        input_preview: params.input_preview,
      })
    },
  )
}

// --- Start ---
async function main() {
  log('client: mode', toolsOnly ? 'tools' : 'channel', 'channel=', channelEnabled ? 'enabled' : 'disabled')

  await connectSocket()
  // mcp.connect() initializes the stdio transport and waits for Claude's initialize request.
  try {
    await mcp.connect(new StdioServerTransport())
  } catch (err) {
    log('client: MCP connect failed:', err)
    process.exit(1)
  }
  if (!toolsOnly) {
    await register(channelEnabled)
  }
  // Keep process alive
  await new Promise(() => {})
}

main().catch(err => {
  log('client plugin error:', err)
  process.exit(1)
})
