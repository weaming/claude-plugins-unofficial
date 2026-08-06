import { expect, test } from 'bun:test'
import { createTelegramReply, getFinalOutput } from './agent-output.js'

test('uses the query result as the final output', () => {
  expect(getFinalOutput('query result', 'assistant text')).toBe('query result')
})

test('falls back to assistant text when the query result is empty', () => {
  expect(getFinalOutput('', 'assistant text')).toBe('assistant text')
})

test('builds a markdown Telegram reply from the current chat metadata', () => {
  expect(createTelegramReply('agent-1', { meta: { chat_id: '123' } }, '  **完成**  ')).toEqual({
    type: 'reply',
    sessionId: 'agent-1',
    chat_id: '123',
    text: '**完成**',
    format: 'markdown',
  })
})

test('does not create a reply without a chat or output', () => {
  expect(createTelegramReply('agent-1', { meta: {} }, 'answer')).toBeNull()
  expect(createTelegramReply('agent-1', { meta: { chat_id: '123' } }, '  ')).toBeNull()
})
