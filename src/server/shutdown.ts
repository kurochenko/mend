import type { ServiceRuntimeMode } from '@/db/service-runtime'
import {
  SHUTDOWN_GRACE_PERIOD_MS,
  waitForDrainedWork,
  type WaitForDrainedWorkResult,
} from '@/server/service-drain'

type ShutdownSignal = 'SIGTERM' | 'SIGINT'
type ShutdownState = 'idle' | 'shutting-down' | 'forced' | 'finished'

interface ShutdownHandlerDependencies {
  setServiceRuntimeMode: (mode: ServiceRuntimeMode) => Promise<void>
  stopServer: () => Promise<void>
  clearTimers: () => void
  waitForDrainedWork: (params: { timeoutMs: number }) => Promise<WaitForDrainedWorkResult>
  closeDb: () => Promise<void>
  exit: (code: number) => never | void
  log: (message: string) => void
  error: (message: string, error?: unknown) => void
}

const defaultDependencies = {
  waitForDrainedWork,
}

export const createShutdownHandler = (
  dependencies: Omit<ShutdownHandlerDependencies, 'waitForDrainedWork'> &
    Partial<Pick<ShutdownHandlerDependencies, 'waitForDrainedWork'>>,
): ((signal: ShutdownSignal) => void) => {
  const deps = { ...defaultDependencies, ...dependencies }
  let state: ShutdownState = 'idle'
  const wasForced = (): boolean => state === 'forced'

  const shutdown = async (signal: ShutdownSignal): Promise<void> => {
    try {
      deps.log(`[shutdown] received ${signal}; draining service`)
      await deps.setServiceRuntimeMode('draining')
      if (wasForced()) {
        return
      }

      await deps.stopServer()
      if (wasForced()) {
        return
      }

      deps.clearTimers()
      const result = await deps.waitForDrainedWork({ timeoutMs: SHUTDOWN_GRACE_PERIOD_MS })
      if (wasForced()) {
        return
      }

      if (!result.drained) {
        deps.error(
          `[shutdown] grace period elapsed with ${result.counts.reviewQueueEntries} running review queue entr${result.counts.reviewQueueEntries === 1 ? 'y' : 'ies'} and ${result.counts.fixBatchEntries} running fix batch entr${result.counts.fixBatchEntries === 1 ? 'y' : 'ies'}`,
        )
      }

      await deps.closeDb()
      if (wasForced()) {
        return
      }

      state = 'finished'
      deps.exit(0)
    } catch (error) {
      deps.error('[shutdown] failed during graceful shutdown', error)
      try {
        await deps.closeDb()
      } catch (closeError) {
        deps.error('[shutdown] failed to close database after shutdown error', closeError)
      }
      if (state !== 'forced') {
        state = 'finished'
        deps.exit(1)
      }
    }
  }

  return (signal: ShutdownSignal): void => {
    if (state === 'idle') {
      state = 'shutting-down'
      void shutdown(signal)
      return
    }

    if (state === 'finished' || state === 'forced') {
      return
    }

    state = 'forced'
    deps.error(`[shutdown] received ${signal} during shutdown; forcing exit`)
    deps.exit(1)
  }
}
