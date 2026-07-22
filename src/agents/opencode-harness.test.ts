import { describe, expect, it } from 'bun:test'
import { extractAssistantText } from '@/agents/opencode-harness'

describe('extractAssistantText', () => {
  it('extracts text from opencode part.text events', () => {
    const stream = [
      JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: '{"assessment":"approve"' } }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: ',"summary":"ok"}' } }),
      JSON.stringify({ type: 'step_finish', part: { type: 'step-finish' } }),
    ].join('\n')

    const extracted = extractAssistantText(stream)
    expect(extracted).toBe('{"assessment":"approve","summary":"ok"}')
  })

  it('falls back to stdout when no assistant text is present', () => {
    const stream = JSON.stringify({ type: 'step_start', part: { type: 'step-start' } })
    expect(extractAssistantText(stream)).toBe(stream)
  })
})
