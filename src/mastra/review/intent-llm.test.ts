import { beforeEach, describe, expect, it, mock } from 'bun:test'

const featureIntentOutput = JSON.stringify({
  intent: 'feature',
  confidence: 0.82,
  rationale: ['Title describes new behavior'],
  secondaryIntents: ['style_refactor'],
})

const bugfixIntentOutput = JSON.stringify({
  intent: 'bugfix',
  confidence: 0.66,
  rationale: ['Fix wording in title and AC'],
  secondaryIntents: ['bugfix', 'feature', 'bugfix'],
})

const mockInvokePiReview = mock(() =>
  Promise.resolve({
    success: true,
    output: featureIntentOutput,
    sessionFile: undefined,
  }),
)

const mockInvokeCodexReview = mock(() =>
  Promise.resolve({
    harness: 'codex' as const,
    model: 'gpt-5-mini',
    success: true,
    output: featureIntentOutput,
    durationMs: 1,
  }),
)

mock.module('@/agents/pi-harness', () => ({
  invokePiReview: mockInvokePiReview,
}))

mock.module('@/agents/codex-harness', () => ({
  invokeCodexReview: mockInvokeCodexReview,
}))

const { classifyMrIntentWithLlm, parseLlmIntentOutput } = await import('@/mastra/review/intent-llm')

const input = {
  title: 'feat: add calendar',
  description: 'Adds a calendar view',
  labels: [],
  sourceBranch: 'feature/calendar',
  targetBranch: 'main',
  changedFiles: ['src/calendar.ts'],
}

beforeEach(() => {
  mockInvokePiReview.mockClear()
  mockInvokeCodexReview.mockClear()
})

describe('parseLlmIntentOutput', () => {
  it('parses valid fenced json output', () => {
    const raw = ['```json', featureIntentOutput, '```'].join('\n')

    const parsed = parseLlmIntentOutput(raw)

    expect(parsed.intent).toBe('feature')
    expect(parsed.confidence).toBe(0.82)
    expect(parsed.secondaryIntents).toEqual(['style_refactor'])
  })

  it('removes primary intent from secondaryIntents', () => {
    const parsed = parseLlmIntentOutput(bugfixIntentOutput)

    expect(parsed.secondaryIntents).toEqual(['feature'])
  })

  it('throws on invalid output shape', () => {
    expect(() => parseLlmIntentOutput(JSON.stringify({ intent: 'unknown' }))).toThrow()
  })
})

describe('classifyMrIntentWithLlm', () => {
  it('uses Pi by default-compatible configuration', async () => {
    const result = await classifyMrIntentWithLlm(input, {
      harness: 'pi',
      cwd: '/tmp/repo',
      sessionDir: '/tmp/sessions',
      model: 'anthropic/claude-sonnet-4-20250514',
      thinkingLevel: 'minimal',
      timeoutMs: 45_000,
    })

    expect(result.intent).toBe('feature')
    expect(mockInvokePiReview).toHaveBeenCalledTimes(1)
    expect(mockInvokeCodexReview).toHaveBeenCalledTimes(0)
  })

  it('uses Codex when configured for intent classification', async () => {
    const result = await classifyMrIntentWithLlm(input, {
      harness: 'codex',
      cwd: '/tmp/repo',
      sessionDir: '/tmp/sessions',
      model: 'gpt-5-mini',
      thinkingLevel: 'minimal',
      timeoutMs: 45_000,
    })

    expect(result.intent).toBe('feature')
    expect(mockInvokeCodexReview).toHaveBeenCalledTimes(1)
    expect(mockInvokePiReview).toHaveBeenCalledTimes(0)
    const firstCall = mockInvokeCodexReview.mock.calls[0] as
      | [{ model: string; toolMode: 'none' }]
      | undefined
    expect(firstCall?.[0]).toMatchObject({
      model: 'gpt-5-mini',
      toolMode: 'none',
    })
  })
})
