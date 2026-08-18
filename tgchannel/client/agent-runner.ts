#!/usr/bin/env bun

import { query, type Options, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { createConnection, type Socket } from 'net'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { createFishLauncher, resolveFishCommand, type FishLauncher } from './fish-launcher.js'
import { createTelegramReply, getFinalOutput } from './agent-output.js'

type ForwardMessage = {
  type: 'forward'
  content: string
  meta: Record<string, string>
}

type ResetSessionMessage = {
  type: 'reset_session'
  sessionId: string
  requestId: string
  requesterSessionId?: string
}

type StatusRequestMessage = {
  type: 'status'
  sessionId: string
  requestId: string
  requesterSessionId?: string
}

type AgentSocketMessage =
  | { type: 'registered'; sessionId: string; activeSessionId: string | null }
  | { type: 'active_changed'; activeSessionId: string | null }
  | ForwardMessage
  | ResetSessionMessage
  | StatusRequestMessage
  | { type: 'pong' }
  | { type: 'rejected'; reason: string }

type AgentRunnerConfig = {
  commandParts: string[]
  cwd: string
  socketPath?: string
  label?: string
}

const DEFAULT_SOCKET_PATH = process.env.TGCHANNEL_SOCKET_PATH
  ?? join(homedir(), '.claude', 'channels', 'tgchannel', 'center.sock')
const OUTPUT_PREVIEW_CHAR_LIMIT = 200
const MAX_TOOL_ARGUMENT_CHARS = 200
const MAX_TOOL_ARGUMENT_PREVIEW_CHARS = 120

function log(...args: unknown[]): void {
  process.stderr.write(`${new Date().toISOString()} ${args.join(' ')}\n`)
}

function extractAssistantText(message: SDKMessage): string {
  if (message.type !== 'assistant') return ''

  return message.message.content
    .filter(content => content.type === 'text')
    .map(content => content.text)
    .join('')
}

function extractToolCalls(message: SDKMessage): string[] {
  if (message.type !== 'assistant') return []

  return message.message.content
    .filter(content => content.type === 'tool_use' && typeof content.name === 'string')
    .map(content => {
      if (content.type !== 'tool_use') return ''
      const input = content.input
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length === 0) {
        return `🔧 ${content.name}`
      }

      const argumentsText = Object.entries(input)
        .map(([name, value]) => `${name}=${formatToolValue(value)}`)
        .join(' ')
      return argumentsText ? `🔧 ${content.name} ${argumentsText}` : `🔧 ${content.name}`
    })
    .filter(Boolean)
}

function formatToolValue(value: unknown): string {
  if (typeof value === 'string') {
    if (value.length > MAX_TOOL_ARGUMENT_CHARS) {
      const preview = value.slice(0, MAX_TOOL_ARGUMENT_PREVIEW_CHARS).replaceAll('`', '\\`')
      return `\`${preview}…\` (共 ${value.length} 字符)`
    }
    if (value.length === 0 || /\s/.test(value)) {
      return `\`${value.replaceAll('`', '\\`')}\``
    }
    return value
  }
  if (value === null) return 'null'
  if (typeof value === 'object') {
    const json = JSON.stringify(value)
    if (json.length > MAX_TOOL_ARGUMENT_CHARS) {
      return `\`${json.slice(0, MAX_TOOL_ARGUMENT_PREVIEW_CHARS)}…\` (共 ${json.length} 字符)`
    }
    return json
  }
  return String(value)
}

function formatOutputStats(output: string): string {
  const characters = Array.from(output)
  const preview = characters.slice(0, OUTPUT_PREVIEW_CHAR_LIMIT).join('')

  return [
    `output_chars=${characters.length}`,
    `output_preview_chars=${Array.from(preview).length}`,
    `output_preview=${JSON.stringify(preview)}`,
  ].join(' ')
}

class AgentRunner {
  private readonly config: Required<AgentRunnerConfig>
  private readonly sessionId = `agent-${process.pid}-${randomUUID()}`
  private readonly socketPath: string
  private readonly pendingMessages: ForwardMessage[] = []
  private socket: Socket | null = null
  private socketBuffer = ''
  private activeSessionId: string | null = null
  private claudeSessionId: string | null = null
  private model: string | null = null
  private usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  }
  private activeQuery: Query | null = null
  private drainTask: Promise<void> | null = null
  private isConnected = false
  private isStopping = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private lastPingAt = 0
  private launcher: FishLauncher | null = null

  constructor(config: AgentRunnerConfig) {
    this.config = {
      ...config,
      socketPath: config.socketPath ?? DEFAULT_SOCKET_PATH,
      label: config.label ?? `my-claude:${config.commandParts.join(' ')}:${basename(config.cwd)}:${process.pid}`,
    }
    this.socketPath = this.config.socketPath
  }

  async start(): Promise<void> {
    if (!existsSync(this.socketPath)) {
      throw new Error(`Center Manager 未启动：找不到 Unix socket ${this.socketPath}`)
    }

    const resolvedCommand = await resolveFishCommand(this.config.commandParts)
    log('agent runner command resolved', `profile=${this.config.commandParts[0]}`, `executable=${resolvedCommand.executable}`)
    this.launcher = createFishLauncher(resolvedCommand.commandParts, resolvedCommand.environment)
    log('agent runner launcher created', this.launcher.path)
    try {
      await this.connect()
    } catch (error) {
      this.isStopping = true
      this.socket?.destroy()
      this.launcher.cleanup()
      this.launcher = null
      throw error
    }

    log('agent runner started', this.sessionId, 'cwd=', this.config.cwd)
  }

  async stop(): Promise<void> {
    this.isStopping = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }

    this.activeQuery?.close()
    await this.drainTask?.catch(() => {})
    this.socket?.end()
    this.socket = null
    this.isConnected = false
    this.launcher?.cleanup()
    this.launcher = null
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath)
      let settled = false
      this.socket = socket

      socket.on('connect', () => {
        settled = true
        this.isConnected = true
        this.send({
          type: 'register',
          sessionId: this.sessionId,
          kind: 'agent-sdk',
          pid: process.pid,
          label: this.config.label,
          lastMessage: '',
          cwd: this.config.cwd,
          channelEnabled: true,
          ...(this.claudeSessionId ? { claudeSessionId: this.claudeSessionId } : {}),
        })
        this.startHeartbeat()
        resolve()
      })

      socket.on('data', chunk => {
        this.socketBuffer += chunk.toString()
        let newlineIndex = this.socketBuffer.indexOf('\n')
        while (newlineIndex !== -1) {
          const line = this.socketBuffer.slice(0, newlineIndex)
          this.socketBuffer = this.socketBuffer.slice(newlineIndex + 1)
          if (line.trim()) {
            try {
              this.handleMessage(JSON.parse(line) as AgentSocketMessage)
            } catch (error) {
              log('agent socket parse error:', error)
            }
          }
          newlineIndex = this.socketBuffer.indexOf('\n')
        }
      })

      socket.on('close', () => {
        this.isConnected = false
        if (!this.isStopping) {
          log('agent runner disconnected from center')
          this.scheduleReconnect()
        }
      })

      socket.on('error', error => {
        if (!settled) {
          reject(error)
        } else {
          log('agent socket error:', error)
        }
      })
    })
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.isStopping) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
        .catch(error => {
          log('agent reconnect failed:', error)
          this.scheduleReconnect()
        })
    }, 3000)
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = setInterval(() => {
      if (!this.socket || !this.isConnected) return
      if (this.lastPingAt > 0 && Date.now() - this.lastPingAt > 3000) {
        this.socket.destroy()
        return
      }
      this.lastPingAt = Date.now()
      this.send({ type: 'ping' })
    }, 5000)
  }

  private send(message: unknown): void {
    if (this.socket && this.isConnected) {
      this.socket.write(JSON.stringify(message) + '\n')
    }
  }

  private handleMessage(message: AgentSocketMessage): void {
    switch (message.type) {
      case 'registered':
        this.activeSessionId = message.activeSessionId
        log('agent runner registered as', message.sessionId, `active=${this.activeSessionId}`)
        return
      case 'active_changed':
        this.activeSessionId = message.activeSessionId
        log('agent runner active changed to', this.activeSessionId)
        return
      case 'pong':
        this.lastPingAt = 0
        return
      case 'rejected':
        log('agent runner rejected:', message.reason)
        return
      case 'forward':
        this.pendingMessages.push(message)
        this.drainTask ??= this.drainMessages()
        return
      case 'reset_session':
        if (message.sessionId === this.sessionId) {
          void this.resetSession(message)
        }
        return
      case 'status':
        if (message.sessionId === this.sessionId) {
          this.sendStatus(message)
        }
        return
    }
  }

  private async drainMessages(): Promise<void> {
    try {
      while (this.pendingMessages.length > 0 && !this.isStopping) {
        const message = this.pendingMessages.shift()!
        await this.runQuery(message)
      }
    } finally {
      this.drainTask = null
      if (this.pendingMessages.length > 0 && !this.isStopping) {
        this.drainTask = this.drainMessages()
      }
    }
  }

  private async runQuery(message: ForwardMessage): Promise<void> {
    if (!this.launcher) return

    let hasInitializedClaude = false
    const stderrOutput: string[] = []
    const prompt = message.content
    const assistantOutput: string[] = []
    let resultOutput = ''

    log('query input:', prompt)

    const options: Options = {
      cwd: this.config.cwd,
      pathToClaudeCodeExecutable: this.launcher.path,
      stderr: data => {
        const output = data.trim()
        if (output) stderrOutput.push(output)
      },
      settingSources: ['user', 'project', 'local'],
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: [
          '你正在通过 Telegram 与用户交互。',
          '请将最终答案直接作为普通文本输出；不要依赖当前 Telegram channel 插件的回复工具。',
          `当前 Telegram 消息元信息（仅用于理解上下文）：${JSON.stringify(message.meta)}`,
        ].join('\n'),
      },
      ...(this.claudeSessionId ? { resume: this.claudeSessionId } : {}),
    }

    const currentQuery = query({
      prompt,
      options,
    })
    this.activeQuery = currentQuery

    try {
      for await (const sdkMessage of currentQuery) {
        this.updateSessionId(sdkMessage)
        for (const toolCall of extractToolCalls(sdkMessage)) {
          this.sendTelegramProgress(message, toolCall)
        }
        const assistantText = extractAssistantText(sdkMessage)
        if (assistantText) assistantOutput.push(assistantText)

        if (sdkMessage.type === 'system' && sdkMessage.subtype === 'init') {
          hasInitializedClaude = true
          this.model = sdkMessage.model
        }
        if (sdkMessage.type === 'result' && sdkMessage.subtype === 'success') {
          resultOutput = sdkMessage.result
          this.addUsage(sdkMessage.usage)
          const output = getFinalOutput(resultOutput, assistantOutput.join(''))
          this.sendTelegramReply(message, output)
          log('query done', `session=${sdkMessage.session_id}`, formatOutputStats(output))
        }
        if (sdkMessage.type === 'result' && sdkMessage.is_error) {
          this.addUsage(sdkMessage.usage)
          const output = 'result' in sdkMessage ? sdkMessage.result : assistantOutput.join('')
          this.sendTelegramReply(message, output)
          log('query failed:', formatOutputStats(output), 'error=', 'result' in sdkMessage ? sdkMessage.result : sdkMessage.errors.join('; '))
        }
      }
    } catch (error) {
      const errorLabel = hasInitializedClaude ? 'query failed:' : 'query failed to start:'
      const errorDetails = stderrOutput.length > 0
        ? `${error} stderr=${stderrOutput.join(' ').slice(-2000)}`
        : error
      log(errorLabel, formatOutputStats(resultOutput || assistantOutput.join('')), errorDetails)
    } finally {
      const chatId = message.meta.chat_id?.trim()
      if (chatId) {
        this.send({
          type: 'clear_progress',
          sessionId: this.sessionId,
          chat_id: chatId,
        })
      }
      if (this.activeQuery === currentQuery) {
        this.activeQuery = null
      }
    }
  }

  private sendTelegramReply(message: ForwardMessage, output: string): void {
    const reply = createTelegramReply(this.sessionId, message, output)
    if (!reply) {
      log('query output not sent: missing chat_id or empty output')
      return
    }

    this.send({
      type: 'update_last_message',
      sessionId: this.sessionId,
      message: reply.text.slice(0, 50),
    })
    this.send(reply)
  }

  private sendTelegramProgress(message: ForwardMessage, text: string): void {
    const chatId = message.meta.chat_id?.trim()
    if (!chatId || !text) return

    this.send({
      type: 'progress',
      sessionId: this.sessionId,
      chat_id: chatId,
      text,
    })
  }

  private updateSessionId(message: SDKMessage): void {
    if (!message.session_id || message.session_id === this.claudeSessionId) return
    this.claudeSessionId = message.session_id
    this.send({
      type: 'update_session',
      sessionId: this.sessionId,
      claudeSessionId: this.claudeSessionId,
    })
  }

  private addUsage(usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  }): void {
    this.usage.inputTokens += usage.input_tokens
    this.usage.outputTokens += usage.output_tokens
    this.usage.cacheCreationInputTokens += usage.cache_creation_input_tokens
    this.usage.cacheReadInputTokens += usage.cache_read_input_tokens
  }

  private sendStatus(message: StatusRequestMessage): void {
    this.send({
      type: 'control_result',
      sessionId: this.sessionId,
      requestId: message.requestId,
      command: 'status',
      ok: true,
      claudeSessionId: this.claudeSessionId,
      model: this.model,
      cwd: this.config.cwd,
      pid: process.pid,
      usage: this.usage,
      requesterSessionId: message.requesterSessionId,
    })
  }

  private async resetSession(message: ResetSessionMessage): Promise<void> {
    this.pendingMessages.length = 0
    this.activeQuery?.close()
    await this.drainTask?.catch(() => {})
    this.activeQuery = null
    this.claudeSessionId = null
    this.model = null
    this.usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    }
    this.send({
      type: 'update_session',
      sessionId: this.sessionId,
      claudeSessionId: null,
    })
    this.send({
      type: 'control_result',
      sessionId: this.sessionId,
      requestId: message.requestId,
      command: 'reset_session',
      ok: true,
      requesterSessionId: message.requesterSessionId,
    })
  }
}

export async function runAgentRunner(commandParts: string[]): Promise<void> {
  const runner = new AgentRunner({
    commandParts,
    cwd: process.cwd(),
  })
  await runner.start()

  const stop = () => {
    void runner.stop().finally(() => process.exit(0))
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  await new Promise<void>(() => {})
}
