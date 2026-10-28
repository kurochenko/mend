import { describe, expect, it } from 'bun:test'
import { buildReviewEnv, extractAssistantText } from '@/agents/opencode-harness'

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

describe('buildReviewEnv', () => {
  it('ignores repo opencode config and denies edits, shell, web and outside paths', () => {
    const env = buildReviewEnv({ PATH: '/bin', OPENCODE_PERMISSION: '{"bash":"allow"}' })

    expect(env.PATH).toBe('/bin')
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1')
    expect(JSON.parse(env.OPENCODE_PERMISSION ?? '{}')).toEqual({
      edit: 'deny',
      bash: 'deny',
      webfetch: 'deny',
      external_directory: 'deny',
    })
  })
})
