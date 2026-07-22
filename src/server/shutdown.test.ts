import { describe, expect, mock, test } from 'bun:test'
import { SHUTDOWN_GRACE_PERIOD_MS } from '@/server/service-drain'
import { createShutdownHandler } from '@/server/shutdown'

const deferred = <T>() => {
  let resolve: (value: T | PromiseLike<T>) => void = () => {}
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  throw new Error('Timed out waiting for condition')
}

describe('createShutdownHandler', () => {
  test('sets draining mode, stops server, waits for work, closes db, and exits cleanly', async () => {
    const calls: string[] = []
    const exited = deferred<number>()
    const handler = createShutdownHandler({
      setServiceRuntimeMode: mock(async (mode) => {
        calls.push(`mode:${mode}`)
      }),
      stopServer: mock(async () => {
        calls.push('stop-server')
      }),
      clearTimers: mock(() => {
        calls.push('clear-timers')
      }),
      waitForDrainedWork: mock(async (params) => {
        calls.push(`wait:${params.timeoutMs}`)
        return {
          drained: true,
          counts: { reviewQueueEntries: 0, fixBatchEntries: 0 },
        }
      }),
      closeDb: mock(async () => {
        calls.push('close-db')
      }),
      exit: mock((code) => {
        calls.push(`exit:${code}`)
        exited.resolve(code)
      }),
      log: mock(() => {}),
      error: mock(() => {}),
    })

    handler('SIGTERM')

    await exited.promise

    expect(calls).toEqual([
      'mode:draining',
      'stop-server',
      'clear-timers',
      `wait:${SHUTDOWN_GRACE_PERIOD_MS}`,
      'close-db',
      'exit:0',
    ])
  })

  test('forces exit on a second signal while shutdown is in progress', async () => {
    const calls: string[] = []
    const wait = deferred<{
      drained: true
      counts: { reviewQueueEntries: 0; fixBatchEntries: 0 }
    }>()
    const handler = createShutdownHandler({
      setServiceRuntimeMode: mock(async (mode) => {
        calls.push(`mode:${mode}`)
      }),
      stopServer: mock(async () => {
        calls.push('stop-server')
      }),
      clearTimers: mock(() => {
        calls.push('clear-timers')
      }),
      waitForDrainedWork: mock(async () => {
        calls.push('wait')
        return await wait.promise
      }),
      closeDb: mock(async () => {
        calls.push('close-db')
      }),
      exit: mock((code) => {
        calls.push(`exit:${code}`)
      }),
      log: mock(() => {}),
      error: mock((message) => {
        calls.push(`error:${message}`)
      }),
    })

    handler('SIGTERM')
    await waitFor(() => calls.includes('wait'))
    handler('SIGINT')

    expect(calls).toContain('exit:1')

    wait.resolve({
      drained: true,
      counts: { reviewQueueEntries: 0, fixBatchEntries: 0 },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(calls.filter((call) => call.startsWith('exit:'))).toEqual(['exit:1'])
    expect(calls).not.toContain('close-db')
  })
})
