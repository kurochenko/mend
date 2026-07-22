import { listRunnableFixBatches } from '@/db/fix-batches'
import { countRunningReviewQueueEntries } from '@/db/review-queue'

interface RunningWorkCounts {
  reviewQueueEntries: number
  fixBatchEntries: number
}

interface WaitForDrainedWorkDependencies {
  countRunningReviewQueueEntries: () => Promise<number>
  countRunningFixBatchEntries: () => Promise<number>
  sleep: (ms: number) => Promise<void>
  logStatus?: (counts: RunningWorkCounts) => void
}

export interface WaitForDrainedWorkResult {
  drained: boolean
  counts: RunningWorkCounts
}

export const DEFAULT_DRAIN_POLL_INTERVAL_MS = 2_000
export const SHUTDOWN_GRACE_PERIOD_MS = 30_000

const defaultSleep = async (ms: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, ms))

const countRunningFixBatchEntries = async (): Promise<number> => {
  const batches = await listRunnableFixBatches()
  return batches.filter((batch) => batch.status === 'running').length
}

const defaultDependencies: WaitForDrainedWorkDependencies = {
  countRunningReviewQueueEntries,
  countRunningFixBatchEntries,
  sleep: defaultSleep,
}

const hasRunningWork = (counts: RunningWorkCounts): boolean =>
  counts.reviewQueueEntries > 0 || counts.fixBatchEntries > 0

const getRunningWorkCounts = async (
  dependencies: Pick<
    WaitForDrainedWorkDependencies,
    'countRunningReviewQueueEntries' | 'countRunningFixBatchEntries'
  >,
): Promise<RunningWorkCounts> => ({
  reviewQueueEntries: await dependencies.countRunningReviewQueueEntries(),
  fixBatchEntries: await dependencies.countRunningFixBatchEntries(),
})

export const waitForDrainedWork = async (params?: {
  timeoutMs?: number
  pollIntervalMs?: number
  dependencies?: Partial<WaitForDrainedWorkDependencies>
}): Promise<WaitForDrainedWorkResult> => {
  const dependencies = { ...defaultDependencies, ...params?.dependencies }
  const pollIntervalMs = params?.pollIntervalMs ?? DEFAULT_DRAIN_POLL_INTERVAL_MS
  const deadline = params?.timeoutMs === undefined ? null : Date.now() + params.timeoutMs

  for (;;) {
    const counts = await getRunningWorkCounts(dependencies)
    if (!hasRunningWork(counts)) {
      return { drained: true, counts }
    }

    if (deadline !== null && Date.now() >= deadline) {
      return { drained: false, counts }
    }

    dependencies.logStatus?.(counts)

    const remainingMs = deadline === null ? pollIntervalMs : deadline - Date.now()
    await dependencies.sleep(Math.max(0, Math.min(pollIntervalMs, remainingMs)))
  }
}
