import type { Mastra } from '@mastra/core'
import type { AppConfig, ProjectConfig } from '@/config'
import {
  claimPendingReviewJob,
  deleteReviewQueueRecord,
  finishRunningReview,
  getReviewQueueRecord,
  listReviewQueueRecords,
  recoverReviewQueueAfterRestart,
  setPendingCommitSha,
  setRunningCommitSha,
  upsertPendingReviewRequest,
  type ReviewQueueJob,
  type ReviewQueueRecord,
} from '@/db/review-queue'
import { getServiceRuntimeMode } from '@/db/service-runtime'
import { createReviewProvider, type ReviewProvider } from '@/integrations/provider/client'
import { toErrorMessage } from '@/lib/errors'
import { asMrReviewRequestEvent, type MrReviewRequestEvent } from '@/lib/review-events'
import { executeMrReview } from '@/mastra/run-mr-review'
import { mrIidFromLockKey, mrLockKey, withMrLock } from '@/server/mr-locks'
import { getLatestSuccessfulRun, hasSuccessfulRunForSha } from '@/server/review-context'
import type { StatusNoteInput } from '@/server/status-note-body'
import { syncStatusNote } from '@/server/status-note-sync'

const activeWorkers = new Set<string>()
const runningReviewAbortControllers = new Map<string, AbortController>()
let processDraining = false

interface ReviewQueueDependencies {
  claimPendingReviewJob: typeof claimPendingReviewJob
  deleteReviewQueueRecord: typeof deleteReviewQueueRecord
  finishRunningReview: typeof finishRunningReview
  getReviewQueueRecord: typeof getReviewQueueRecord
  listReviewQueueRecords: typeof listReviewQueueRecords
  recoverReviewQueueAfterRestart: typeof recoverReviewQueueAfterRestart
  setPendingCommitSha: typeof setPendingCommitSha
  setRunningCommitSha: typeof setRunningCommitSha
  upsertPendingReviewRequest: typeof upsertPendingReviewRequest
  getServiceRuntimeMode: typeof getServiceRuntimeMode
  createReviewProvider: typeof createReviewProvider
  hasSuccessfulRunForSha: typeof hasSuccessfulRunForSha
  getLatestSuccessfulRun: typeof getLatestSuccessfulRun
  executeMrReview: typeof executeMrReview
  syncStatusNote: typeof syncStatusNote
  isProcessDraining: () => boolean
}

const defaultDependencies: ReviewQueueDependencies = {
  claimPendingReviewJob,
  deleteReviewQueueRecord,
  finishRunningReview,
  getReviewQueueRecord,
  listReviewQueueRecords,
  recoverReviewQueueAfterRestart,
  setPendingCommitSha,
  setRunningCommitSha,
  upsertPendingReviewRequest,
  getServiceRuntimeMode,
  createReviewProvider,
  hasSuccessfulRunForSha,
  getLatestSuccessfulRun,
  executeMrReview,
  syncStatusNote,
  isProcessDraining: () => processDraining,
}

const isMissingRemoteRefFailure = (message: string): boolean => {
  const normalized = message.toLowerCase()
  return (
    normalized.includes("couldn't find remote ref") ||
    normalized.includes('could not find remote ref')
  )
}

export const stopClaimingReviewJobs = (): void => {
  processDraining = true
}

const isDraining = async (dependencies: ReviewQueueDependencies): Promise<boolean> =>
  dependencies.isProcessDraining() || (await dependencies.getServiceRuntimeMode()) === 'draining'

const syncQueueStatusNote = async (params: {
  project: ProjectConfig
  provider: ReviewProvider
  dependencies: ReviewQueueDependencies
  input: StatusNoteInput
}): Promise<void> => {
  if (params.project.review.flags.dry_run) {
    return
  }

  await params.dependencies.syncStatusNote({
    input: params.input,
    dependencies: { provider: params.provider },
  })
}

const queueMessageForRecord = (
  record: ReviewQueueRecord,
  draining: boolean,
  supersedingRunningReview: boolean,
): { state: 'queued' | 'running'; message: string } => {
  if (record.runningEvent) {
    if (supersedingRunningReview) {
      return {
        state: 'running',
        message: 'Stopping review of an older commit; newer update queued',
      }
    }

    return {
      state: 'running',
      message: draining
        ? 'Review is in progress; newer update queued while service is draining for restart'
        : 'Review is in progress; newer update queued',
    }
  }

  return {
    state: 'queued',
    message: draining
      ? 'Queued while service is draining for restart'
      : 'Queued latest review request',
  }
}

const updateQueuedStatusNote = async (params: {
  project: ProjectConfig
  record: ReviewQueueRecord
  provider: ReviewProvider
  dependencies: ReviewQueueDependencies
  supersedingRunningReview?: boolean
}): Promise<void> => {
  const { project, record, provider, dependencies } = params
  const event = asMrReviewRequestEvent(record.runningEvent ?? record.pendingEvent)
  if (!event) {
    return
  }

  const draining = await isDraining(dependencies)
  const queueState = queueMessageForRecord(
    record,
    draining,
    params.supersedingRunningReview ?? false,
  )
  await syncQueueStatusNote({
    project,
    provider,
    dependencies,
    input: {
      state: queueState.state,
      event,
      runningSha: record.runningCommitSha ?? undefined,
      pendingSha: record.pendingCommitSha ?? undefined,
      message: queueState.message,
    },
  })
}

const hasRunningReviewForSha = (
  record: ReviewQueueRecord | null,
  commitSha: string | null,
): boolean =>
  Boolean(
    record &&
      record.runningEvent &&
      record.runningCommitSha &&
      commitSha &&
      record.runningCommitSha === commitSha,
  )

const isRunningReviewForOtherSha = (
  record: ReviewQueueRecord | null,
  commitSha: string | null,
): boolean =>
  Boolean(
    record?.runningEvent &&
      record.runningCommitSha &&
      commitSha &&
      record.runningCommitSha !== commitSha,
  )

const hasPendingDuplicateForSha = (
  record: ReviewQueueRecord | null,
  commitSha: string | null,
): boolean =>
  Boolean(
    record &&
      record.pendingEvent &&
      record.pendingCommitSha &&
      commitSha &&
      record.pendingCommitSha === commitSha,
  )

const logSupersededReview = (job: ReviewQueueJob): void => {
  console.log(
    `[queue] stopped superseded review for ${job.event.projectKey} MR !${job.event.mrIid}; newer commit queued`,
  )
}

const runQueuedJob = async (params: {
  mastra: Mastra
  project: ProjectConfig
  job: ReviewQueueJob
  provider: ReviewProvider
  dependencies: ReviewQueueDependencies
  signal: AbortSignal
}): Promise<void> => {
  const { mastra, project, job, provider, dependencies, signal } = params
  let statusReviewMode: 'initial' | 'update' = 'initial'
  let statusPreviousReviewedSha: string | null = null
  let statusRunningSha: string | undefined

  try {
    const commitSha = job.commitSha ?? (await provider.fetchChangeRequest(job.mrIid)).sha
    statusRunningSha = commitSha
    await dependencies.setRunningCommitSha(job.projectKey, job.mrIid, commitSha)

    if (
      await dependencies.hasSuccessfulRunForSha(job.event.projectKey, job.event.mrIid, commitSha)
    ) {
      console.log(
        `[queue] skipping ${job.event.projectKey} MR !${job.event.mrIid}: SHA ${commitSha.slice(0, 8)} already reviewed`,
      )
      await syncQueueStatusNote({
        project,
        provider,
        dependencies,
        input: {
          state: 'no_change',
          event: job.event,
          runningSha: commitSha,
          message: 'Latest SHA already reviewed successfully; skipping duplicate event',
        },
      })
      return
    }

    const latestSuccessfulRun = await dependencies.getLatestSuccessfulRun(
      job.event.projectKey,
      job.event.mrIid,
    )
    const reviewMode = latestSuccessfulRun ? ('update' as const) : ('initial' as const)
    const previousReviewedSha = latestSuccessfulRun?.commitSha ?? null
    const previousRunId = latestSuccessfulRun?.id ?? null
    statusReviewMode = reviewMode
    statusPreviousReviewedSha = previousReviewedSha

    if (signal.aborted) {
      logSupersededReview(job)
      return
    }

    console.log(
      `[queue] starting ${reviewMode} review for ${job.event.projectKey} MR !${job.event.mrIid} SHA ${commitSha.slice(0, 8)}`,
    )
    await syncQueueStatusNote({
      project,
      provider,
      dependencies,
      input: {
        state: 'running',
        event: job.event,
        runningSha: commitSha,
        reviewMode,
        previousReviewedSha,
        message: 'Review is in progress',
      },
    })

    const execution = await dependencies.executeMrReview({
      mastra,
      source: 'webhook',
      webhookPayload: job.payload,
      signal,
      input: {
        projectKey: job.event.projectKey,
        mrIid: job.event.mrIid,
        title: job.event.title,
        description: job.event.description,
        labels: job.event.labels,
        sourceBranch: job.event.sourceBranch,
        targetBranch: job.event.targetBranch,
        url: job.event.url,
        commitSha,
        reviewMode,
        previousReviewedSha,
        previousRunId,
      },
    })

    if (execution.workflowResult.status === 'success') {
      await syncQueueStatusNote({
        project,
        provider,
        dependencies,
        input: {
          state: 'completed',
          event: job.event,
          runningSha: commitSha,
          reviewMode,
          previousReviewedSha,
          runId: execution.reviewRunId,
          message: `Completed with assessment ${execution.output?.assessment ?? 'unknown'}`,
        },
      })
      console.log(`[webhook] review completed for ${job.event.projectKey} MR !${job.event.mrIid}`)
      console.log(`[webhook] run id: ${execution.reviewRunId}`)
      return
    }

    if (signal.aborted) {
      logSupersededReview(job)
      return
    }

    await syncQueueStatusNote({
      project,
      provider,
      dependencies,
      input: {
        state: 'failed',
        event: job.event,
        runningSha: commitSha,
        reviewMode,
        previousReviewedSha,
        runId: execution.reviewRunId,
        message: `Workflow status: ${execution.workflowResult.status}`,
      },
    })
    console.error(
      `[webhook] review ${execution.workflowResult.status} for ${job.event.projectKey} MR !${job.event.mrIid}`,
    )
  } catch (error) {
    if (signal.aborted) {
      logSupersededReview(job)
      return
    }

    const message = toErrorMessage(error)

    if (isMissingRemoteRefFailure(message)) {
      await syncQueueStatusNote({
        project,
        provider,
        dependencies,
        input: {
          state: 'no_change',
          event: job.event,
          runningSha: statusRunningSha,
          reviewMode: statusReviewMode,
          previousReviewedSha: statusPreviousReviewedSha,
          message: 'Source branch no longer exists on remote; skipping review',
        },
      })
      console.warn(
        `[webhook] review skipped for ${job.event.projectKey} MR !${job.event.mrIid}: ${message}`,
      )
      return
    }

    await syncQueueStatusNote({
      project,
      provider,
      dependencies,
      input: {
        state: 'failed',
        event: job.event,
        runningSha: statusRunningSha,
        reviewMode: statusReviewMode,
        previousReviewedSha: statusPreviousReviewedSha,
        message,
      },
    })
    console.error(
      `[webhook] review failed for ${job.event.projectKey} MR !${job.event.mrIid}:`,
      error,
    )
  }
}

const processQueueLoop = async (
  mastra: Mastra,
  project: ProjectConfig,
  key: string,
  dependencies: ReviewQueueDependencies,
): Promise<void> => {
  const provider = dependencies.createReviewProvider(project)

  try {
    for (;;) {
      if (await isDraining(dependencies)) {
        return
      }

      const job = await withMrLock(key, async () => {
        if (await isDraining(dependencies)) {
          return null
        }

        return await dependencies.claimPendingReviewJob(project.key, mrIidFromLockKey(key))
      })

      if (!job) {
        return
      }

      const abortController = new AbortController()
      runningReviewAbortControllers.set(key, abortController)
      try {
        await runQueuedJob({
          mastra,
          project,
          job,
          provider,
          dependencies,
          signal: abortController.signal,
        })
      } finally {
        runningReviewAbortControllers.delete(key)
      }

      const remaining = await withMrLock(key, async () => {
        const finished = await dependencies.finishRunningReview(project.key, job.mrIid)

        if (!finished) {
          return null
        }

        if (hasPendingDuplicateForSha(finished, job.commitSha)) {
          await dependencies.deleteReviewQueueRecord(finished.id)
          return null
        }

        return finished
      })

      if (remaining?.pendingEvent && (await isDraining(dependencies))) {
        await updateQueuedStatusNote({ project, record: remaining, provider, dependencies })
        return
      }
    }
  } catch (error) {
    console.error(`[queue] worker loop failed for ${key}:`, error)
  } finally {
    let shouldRestart = false

    try {
      shouldRestart = await withMrLock(key, async () => {
        activeWorkers.delete(key)

        if (await isDraining(dependencies)) {
          return false
        }

        const record = await dependencies.getReviewQueueRecord(project.key, mrIidFromLockKey(key))
        return Boolean(record && !record.runningEvent && record.pendingEvent)
      })
    } catch (error) {
      activeWorkers.delete(key)
      console.error(`[queue] worker restart check failed for ${key}:`, error)
    }

    if (shouldRestart) {
      await ensureWorkerRunning(mastra, project, key, dependencies)
    }
  }
}

export const hasActiveReviewWorkers = (): boolean => activeWorkers.size > 0

const ensureWorkerRunning = async (
  mastra: Mastra,
  project: ProjectConfig,
  key: string,
  dependencies: ReviewQueueDependencies,
): Promise<boolean> => {
  const shouldStart = await withMrLock(key, async () => {
    if (activeWorkers.has(key)) {
      return false
    }

    activeWorkers.add(key)
    return true
  })

  if (!shouldStart) {
    return false
  }

  queueMicrotask(() => {
    void processQueueLoop(mastra, project, key, dependencies)
  })

  return true
}

export const enqueueMrReview = async (params: {
  mastra: Mastra
  project: ProjectConfig
  payload: unknown
  event: MrReviewRequestEvent
  commitSha: string | null
  dependencies?: Partial<ReviewQueueDependencies>
}): Promise<void> => {
  const { mastra, project, payload, event, commitSha } = params
  const dependencies = { ...defaultDependencies, ...params.dependencies }
  const provider = dependencies.createReviewProvider(project)
  const key = mrLockKey(event.projectKey, event.mrIid)

  const result: { ignored: true } | { ignored: false; record: ReviewQueueRecord } =
    await withMrLock(key, async () => {
      const existing = await dependencies.getReviewQueueRecord(event.projectKey, event.mrIid)

      if (hasRunningReviewForSha(existing, commitSha)) {
        return {
          ignored: true,
        }
      }

      let queuedRecord = await dependencies.upsertPendingReviewRequest({ event, payload })
      if (commitSha) {
        queuedRecord =
          (await dependencies.setPendingCommitSha(event.projectKey, event.mrIid, commitSha)) ??
          queuedRecord
      }

      const runningReviewAbortController = isRunningReviewForOtherSha(existing, commitSha)
        ? runningReviewAbortControllers.get(key)
        : undefined
      if (runningReviewAbortController && !runningReviewAbortController.signal.aborted) {
        console.log(
          `[queue] newer commit ${commitSha?.slice(0, 8)} for ${event.projectKey} MR !${event.mrIid}; stopping review of ${existing?.runningCommitSha?.slice(0, 8)}`,
        )
        runningReviewAbortController.abort()
      }

      await updateQueuedStatusNote({
        project,
        record: queuedRecord,
        provider,
        dependencies,
        supersedingRunningReview: Boolean(runningReviewAbortController),
      })

      return {
        ignored: false,
        record: queuedRecord,
      }
    })

  if (result.ignored) {
    return
  }

  if (await isDraining(dependencies)) {
    console.log(`[queue] deferred ${event.projectKey} MR !${event.mrIid} while service is draining`)
    return
  }

  await ensureWorkerRunning(mastra, project, key, dependencies)
}

export const recoverPersistedReviewQueue = async (
  dependenciesInput?: Partial<ReviewQueueDependencies>,
): Promise<number> => {
  const dependencies = { ...defaultDependencies, ...dependenciesInput }
  return await dependencies.recoverReviewQueueAfterRestart()
}

export const resumePersistedReviewQueue = async (
  config: AppConfig,
  mastra: Mastra,
  dependenciesInput?: Partial<ReviewQueueDependencies>,
): Promise<number> => {
  const dependencies = { ...defaultDependencies, ...dependenciesInput }
  const records = await dependencies.listReviewQueueRecords()
  let resumed = 0

  for (const record of records) {
    const project = config.projects.get(record.projectKey)
    if (!project) {
      console.warn(`[startup] unable to resume queue row ${record.id}; project is unknown`)
      await dependencies.deleteReviewQueueRecord(record.id)
      continue
    }

    if (!record.pendingEvent || record.runningEvent) {
      continue
    }

    const started = await ensureWorkerRunning(
      mastra,
      project,
      mrLockKey(record.projectKey, record.mrIid),
      dependencies,
    )
    if (started) {
      resumed += 1
    }
  }

  return resumed
}
