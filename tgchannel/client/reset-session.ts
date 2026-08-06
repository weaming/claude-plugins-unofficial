#!/usr/bin/env bun

import { createConnection } from 'net'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'

const sessionId = process.argv[2]
const socketPath = process.env.TGCHANNEL_SOCKET_PATH
  ?? join(homedir(), '.claude', 'channels', 'tgchannel', 'center.sock')

if (!sessionId) {
  process.stderr.write('用法：tgchannel-reset <agent-session-id>\n')
  process.exit(1)
}

const requestId = randomUUID()
const socket = createConnection(socketPath)
let buffer = ''

socket.setTimeout(30000, () => {
  process.stderr.write('等待 reset_session 回执超时\n')
  process.exit(1)
})

socket.on('connect', () => {
  socket.write(JSON.stringify({
    type: 'reset_session',
    sessionId,
    requestId,
  }) + '\n')
})

socket.on('data', chunk => {
  buffer += chunk.toString()
  let newlineIndex = buffer.indexOf('\n')
  while (newlineIndex !== -1) {
    const line = buffer.slice(0, newlineIndex)
    buffer = buffer.slice(newlineIndex + 1)
    if (line.trim()) {
      let message: {
        type?: string
        ok?: boolean
        error?: string
        claudeSessionId?: string
      }
      try {
        message = JSON.parse(line) as typeof message
      } catch {
        process.stderr.write('收到无效的 Center Manager 响应\n')
        process.exit(1)
      }
      if (message.type === 'control_result') {
        if (message.ok) {
          process.stdout.write('reset_session 已发送，下一条消息将创建新 Claude 会话。\n')
          process.exit(0)
        }
        process.stderr.write(`reset_session 失败：${message.error ?? 'unknown error'}\n`)
        process.exit(1)
      }
    }
    newlineIndex = buffer.indexOf('\n')
  }
})

socket.on('error', error => {
  process.stderr.write(`连接 Center Manager 失败：${error.message}\n`)
  process.exit(1)
})
