/**
 * Unix socket server for IPC between center manager and Claude instances.
 */

import type { InstanceKind } from './session-store.js'

export type SocketMessage =
  | { type: 'register'; sessionId: string; kind?: InstanceKind; pid: number; label: string; lastMessage: string; cwd: string; channelEnabled?: boolean; claudeSessionId?: string }
  | { type: 'unregister'; sessionId: string }
  | { type: 'switch'; toSessionId: string }
  | { type: 'update_last_message'; sessionId: string; message: string }
  | { type: 'update_session'; sessionId: string; claudeSessionId: string | null }
  | { type: 'forward'; sessionId?: string; content: string; meta: Record<string, string> }
  | { type: 'reply'; sessionId: string; chat_id: string; text: string; reply_to?: string; files?: string[]; format?: string }
  | { type: 'progress'; sessionId: string; chat_id: string; text: string }
  | { type: 'clear_progress'; sessionId: string; chat_id: string }
  | { type: 'react'; sessionId: string; chat_id: string; message_id: string; emoji: string }
  | { type: 'edit_message'; sessionId: string; chat_id: string; message_id: string; text: string; format?: string }
  | { type: 'download_attachment'; sessionId: string; file_id: string; corrId?: string }
  | { type: 'list_instances' }
  | { type: 'get_active' }
  | { type: 'ping' }
  | { type: 'permission_request'; request_id: string; tool_name: string; description: string; input_preview: string; sessionId?: string }
  | { type: 'permission_response'; request_id: string; decision?: 'allow' | 'deny'; message?: string }
  | { type: 'reset_session'; sessionId: string; requestId: string; requesterSessionId?: string }
  | { type: 'status'; sessionId: string; requestId: string; requesterSessionId?: string }
  | {
    type: 'control_result'
    sessionId: string
    requestId: string
    command: 'reset_session' | 'status'
    ok: boolean
    error?: string
    claudeSessionId?: string | null
    model?: string | null
    cwd?: string
    pid?: number
    usage?: {
      inputTokens: number
      outputTokens: number
      cacheCreationInputTokens: number
      cacheReadInputTokens: number
    }
    requesterSessionId?: string
  }
