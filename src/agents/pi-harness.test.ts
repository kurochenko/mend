import { describe, expect, it } from 'bun:test'
import { invokePiReview } from '@/agents/pi-harness'

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
