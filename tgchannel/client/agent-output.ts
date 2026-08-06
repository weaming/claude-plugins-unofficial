export type TelegramForwardMessage = {
  meta: Record<string, string>
}

export type TelegramReplyMessage = {
  type: 'reply'
  sessionId: string
  chat_id: string
  text: string
  format: 'markdown'
}

export function getFinalOutput(resultOutput: string, assistantOutput: string): string {
  return resultOutput || assistantOutput
}

export function createTelegramReply(
  sessionId: string,
  message: TelegramForwardMessage,
  output: string,
): TelegramReplyMessage | null {
  const chatId = message.meta.chat_id?.trim()
  const text = output.trim()

  if (!chatId || !text) return null

  return {
    type: 'reply',
    sessionId,
    chat_id: chatId,
    text,
    format: 'markdown',
  }
}
