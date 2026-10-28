import { describe, expect, it } from 'bun:test'
import {
  buildReviewEnv,
  extractAssistantText,
  toCompletedRunResult,
} from '@/agents/opencode-harness'

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

describe('toCompletedRunResult', () => {
  const run = (stdout: string, exitCode = 0, stderr = '') =>
    toCompletedRunResult({
      exitCode,
      stdout,
      stderr,
      durationMs: 10,
      model: 'anthropic/claude-sonnet-5-5',
    })

  it('reports an auth failure even when OpenCode exits successfully', () => {
    expect(
      run(
        '{"type":"error","error":{"name":"APIError","data":{"message":"invalid x-api-key","statusCode":401,"isRetryable":false}}}',
      ),
    ).toEqual({
      success: false,
      output:
        '{"type":"error","error":{"name":"APIError","data":{"message":"invalid x-api-key","statusCode":401,"isRetryable":false}}}',
      durationMs: 10,
      authFailed: true,
      error:
        'OpenCode is not authenticated for model anthropic/claude-sonnet-5-5; set the provider API key in .env or run `opencode auth login` as the user running Mend',
    })
  })

  it('does not treat 401 text in tool output as an auth failure', () => {
    const toolEvent = JSON.stringify({
      type: 'tool_use',
      part: { type: 'tool', state: { output: '{"statusCode":401,"error":"Unauthorized"}' } },
    })

    expect(run(`${toolEvent}\n{"type":"text","part":{"type":"text","text":"ok"}}`)).toEqual({
      success: true,
      output: 'ok',
      durationMs: 10,
    })
  })

  it('keeps a successful review that discusses 401 Unauthorized', () => {
    const review = 'The endpoint correctly returns 401 Unauthorized for invalid tokens.'

    expect(run(JSON.stringify({ type: 'text', part: { type: 'text', text: review } }))).toEqual({
      success: true,
      output: review,
      durationMs: 10,
    })
  })

  it('reports a non-zero exit with stderr', () => {
    expect(run('', 2, 'boom\n')).toEqual({
      success: false,
      output: '',
      durationMs: 10,
      error: 'OpenCode exited with code 2: boom',
    })
  })

  it('returns assistant text on success', () => {
    expect(run('{"type":"text","part":{"type":"text","text":"ok"}}')).toEqual({
      success: true,
      output: 'ok',
      durationMs: 10,
    })
  })
})
