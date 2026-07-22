import { describe, expect, test } from 'bun:test'
import { withProjectRepoLock } from '@/integrations/repo-locks'

const wait = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe('withProjectRepoLock', () => {
  test('serializes work for the same project', async () => {
    const events: string[] = []

    await Promise.all([
      withProjectRepoLock('beta', async () => {
        events.push('a:start')
        await wait(10)
        events.push('a:end')
      }),
      withProjectRepoLock('beta', async () => {
        events.push('b:start')
        await wait(1)
        events.push('b:end')
      }),
    ])

    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
  })

  test('allows different projects to run concurrently', async () => {
    const events: string[] = []

    await Promise.all([
      withProjectRepoLock('alpha', async () => {
        events.push('alpha:start')
        await wait(10)
        events.push('alpha:end')
      }),
      withProjectRepoLock('beta', async () => {
        events.push('beta:start')
        await wait(1)
        events.push('beta:end')
      }),
    ])

    expect(events).toEqual(['alpha:start', 'beta:start', 'beta:end', 'alpha:end'])
  })
})
