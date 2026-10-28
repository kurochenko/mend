import { describe, expect, it } from 'bun:test'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { getFinalAssistantError, invokePiReview } from '@/agents/pi-harness'

type SessionMessage = AgentSession['messages'][number]

const userMessage = (text: string): SessionMessage => ({
  role: 'user',
  content: text,
  timestamp: 0,
})

const assistantMessage = (
  stopReason: 'stop' | 'error',
  text: string,
  errorMessage?: string,
): SessionMessage => ({
  role: 'assistant',
  content: text ? [{ type: 'text', text }] : [],
  api: 'anthropic-messages',
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason,
  errorMessage,
  timestamp: 0,
})

describe('invokePiReview', () => {
  it('returns immediately when aborted before start', async () => {
    const controller = new AbortController()
    controller.abort()

    const result = await invokePiReview({
      cwd: '/tmp',
      sessionDir: '/tmp/mend-pi-test',
      model: 'missing/provider',
      instructions: 'instructions',
      prompt: 'prompt',
      signal: controller.signal,
    })

    expect(result).toEqual({
      success: false,
      output: '',
      sessionFile: undefined,
      error: 'Pi review aborted before start',
    })
  })
})

describe('getFinalAssistantError', () => {
  it('returns the provider error when the final assistant response failed', () => {
    expect(
      getFinalAssistantError([
        userMessage('review'),
        assistantMessage('error', '', 'OAuth refresh failed for anthropic'),
      ]),
    ).toBe('OAuth refresh failed for anthropic')
  })

  it('falls back to a generic error when the provider omits the message', () => {
    expect(getFinalAssistantError([userMessage('review'), assistantMessage('error', '')])).toBe(
      'Pi assistant response ended with an error',
    )
  })

  it('returns undefined when the final assistant response succeeded', () => {
    expect(
      getFinalAssistantError([
        assistantMessage('error', '', 'transient'),
        userMessage('retry'),
        assistantMessage('stop', 'PI_OK'),
      ]),
    ).toBeUndefined()
  })

  it('returns undefined when there is no assistant response', () => {
    expect(getFinalAssistantError([userMessage('review')])).toBeUndefined()
  })
})
