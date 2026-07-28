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
  type ReviewQueueRecord,
} from '@/db/review-queue'
import { updateReviewRunResult } from '@/db/review-runs'
import { getServiceRuntimeMode } from '@/db/service-runtime'
import { createReviewProvider, type ReviewProvider } from '@/integrations/provider/client'
import { toErrorMessage } from '@/lib/errors'
import { asMrReviewRequestEvent, type MrReviewRequestEvent } from '@/lib/review-events'
import {
  automaticLoopLimitBody,
  queueAutomaticFixBatch,
  type AutomaticFixBatchOutcome,
} from '@/mastra/fix/automatic-batch'
import { executeMrReview } from '@/mastra/run-mr-review'
import type { PostStepOutput } from '@/mastra/review/run-result'
import { mrIidFromLockKey, mrLockKey, withMrLock } from '@/server/mr-locks'
import { getLatestSuccessfulRun, hasSuccessfulRunForSha } from '@/server/review-context'
import { syncStatusNote } from '@/server/status-note-sync'

const activeWorkers = new Set<string>()

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
  queueAutomaticFixBatch: typeof queueAutomaticFixBatch
  updateReviewRunResult: typeof updateReviewRunResult
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
  queueAutomaticFixBatch,
  updateReviewRunResult,
}

const createMrNoteOnceByBody = async (params: {
  provider: ReviewProvider
  mrIid: number
  body: string
}): Promise<void> => {
  const notes = await params.provider.listNotes(params.mrIid)
  if (notes.some((note) => note.body === params.body)) {
    return
  }

  await params.provider.createNote(params.mrIid, params.body)
}

const queueAutomaticFixAfterReview = async (params: {
  project: ProjectConfig
  provider: ReviewProvider
  output: PostStepOutput
  dependencies: ReviewQueueDependencies
}): Promise<AutomaticFixBatchOutcome['status'] | null> => {
  if (params.output.featureFlags.dryRun) {
    return null
  }

  const persistedFindingCount = params.output.postDiagnostics.persistedFindingCount
  if (persistedFindingCount === 0) {
    return params.project.review.fix.enabled && params.project.review.fix.automatic
      ? 'no_findings'
      : 'disabled'
  }

  const automaticOutcome = await params.dependencies.queueAutomaticFixBatch({
    project: params.project,
    mrIid: params.output.mrIid,
  })

  if (automaticOutcome.status === 'queued') {
    console.log(`[post] queued automatic fix batch for ${automaticOutcome.queuedCount} finding(s)`)
  }

  if (automaticOutcome.status === 'loop_limit') {
    await createMrNoteOnceByBody({
      provider: params.provider,
      mrIid: params.output.mrIid,
      body: automaticLoopLimitBody(params.output.projectKey, params.output.mrIid, automaticOutcome),
    })
  }

  return automaticOutcome.status
}

const isMissingRemoteRefFailure = (message: string): boolean => {
  const normalized = message.toLowerCase()
  return (
    normalized.includes("couldn't find remote ref") ||
    normalized.includes('could not find remote ref')
  )
}

const isDraining = async (dependencies: ReviewQueueDependencies): Promise<boolean> =>
  (await dependencies.getServiceRuntimeMode()) === 'draining'

const extractWebhookCommitSha = (payload: unknown): string | null => {
  if (!payload || typeof payload !== 'object') {
    return null
  }

  const webhook = payload as {
    object_attributes?: { last_commit?: { id?: unknown } }
    pull_request?: { head?: { sha?: unknown } }
  }
  const commitSha = webhook.object_attributes?.last_commit?.id ?? webhook.pull_request?.head?.sha
  return typeof commitSha === 'string' && commitSha.length > 0 ? commitSha : null
}

const queueMessageForRecord = (
  record: ReviewQueueRecord,
  draining: boolean,
): { state: 'queued' | 'running'; message: string } => {
  if (record.runningEvent) {
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
  record: ReviewQueueRecord
  provider: ReviewProvider
  dependencies: ReviewQueueDependencies
}): Promise<void> => {
  const { record, provider, dependencies } = params
  const event = asMrReviewRequestEvent(record.runningEvent ?? record.pendingEvent)
  if (!event) {
    return
  }

  const draining = await isDraining(dependencies)
  const queueState = queueMessageForRecord(record, draining)
  await dependencies.syncStatusNote({
    input: {
      state: queueState.state,
      event,
      runningSha: record.runningCommitSha ?? undefined,
      pendingSha: record.pendingCommitSha ?? undefined,
      message: queueState.message,
    },
    dependencies: { provider },
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

const runQueuedJob = async (params: {
  mastra: Mastra
  project: ProjectConfig
  job: NonNullable<Awaited<ReturnType<typeof claimPendingReviewJob>>>
  provider: ReviewProvider
  dependencies: ReviewQueueDependencies
}): Promise<void> => {
  const { mastra, job, provider, dependencies } = params
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
      await dependencies.syncStatusNote({
        input: {
          state: 'no_change',
          event: job.event,
          runningSha: commitSha,
          message: 'Latest SHA already reviewed successfully; skipping duplicate event',
        },
        dependencies: { provider },
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

    console.log(
      `[queue] starting ${reviewMode} review for ${job.event.projectKey} MR !${job.event.mrIid} SHA ${commitSha.slice(0, 8)}`,
    )
    await dependencies.syncStatusNote({
      input: {
        state: 'running',
        event: job.event,
        runningSha: commitSha,
        reviewMode,
        previousReviewedSha,
        message: 'Review is in progress',
      },
      dependencies: { provider },
    })

    const execution = await dependencies.executeMrReview({
      mastra,
      source: 'webhook',
      webhookPayload: job.payload,
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
      if (execution.output) {
        const automaticFixBatchStatus = await queueAutomaticFixAfterReview({
          project: params.project,
          provider,
          output: execution.output,
          dependencies,
        })
        execution.output.postDiagnostics.automaticFixBatchStatus = automaticFixBatchStatus
        await dependencies.updateReviewRunResult({
          id: execution.reviewRunId,
          result: execution.output,
          comparisonResult: execution.output.comparisonResult,
        })
      }

      await dependencies.syncStatusNote({
        input: {
          state: 'completed',
          event: job.event,
          runningSha: commitSha,
          reviewMode,
          previousReviewedSha,
          runId: execution.reviewRunId,
          message: `Completed with assessment ${execution.output?.assessment ?? 'unknown'}`,
        },
        dependencies: { provider },
      })
      console.log(`[webhook] review completed for ${job.event.projectKey} MR !${job.event.mrIid}`)
      console.log(`[webhook] run id: ${execution.reviewRunId}`)
      return
    }

    await dependencies.syncStatusNote({
      input: {
        state: 'failed',
        event: job.event,
        runningSha: commitSha,
        reviewMode,
        previousReviewedSha,
        runId: execution.reviewRunId,
        message: `Workflow status: ${execution.workflowResult.status}`,
      },
      dependencies: { provider },
    })
    console.error(
      `[webhook] review ${execution.workflowResult.status} for ${job.event.projectKey} MR !${job.event.mrIid}`,
    )
  } catch (error) {
    const message = toErrorMessage(error)

    if (isMissingRemoteRefFailure(message)) {
      await dependencies.syncStatusNote({
        input: {
          state: 'no_change',
          event: job.event,
          runningSha: statusRunningSha,
          reviewMode: statusReviewMode,
          previousReviewedSha: statusPreviousReviewedSha,
          message: 'Source branch no longer exists on remote; skipping review',
        },
        dependencies: { provider },
      })
      console.warn(
        `[webhook] review skipped for ${job.event.projectKey} MR !${job.event.mrIid}: ${message}`,
      )
      return
    }

    await dependencies.syncStatusNote({
      input: {
        state: 'failed',
        event: job.event,
        runningSha: statusRunningSha,
        reviewMode: statusReviewMode,
        previousReviewedSha: statusPreviousReviewedSha,
        message,
      },
      dependencies: { provider },
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

      await runQueuedJob({ mastra, project, job, provider, dependencies })

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
        await updateQueuedStatusNote({ record: remaining, provider, dependencies })
        return
      }

      if (project.review.fix.enabled && !remaining?.runningEvent && !remaining?.pendingEvent) {
        const { ensureFixBatchRunner } = await import('@/server/fix-batch-runner')
        await ensureFixBatchRunner({
          mastra,
          project,
          mrIid: job.mrIid,
          dependencies: { enqueueMrReview },
        })
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
  dependencies?: Partial<ReviewQueueDependencies>
}): Promise<void> => {
  const { mastra, project, payload, event } = params
  const dependencies = { ...defaultDependencies, ...params.dependencies }
  const provider = dependencies.createReviewProvider(project)
  const key = mrLockKey(event.projectKey, event.mrIid)

  const result: { ignored: true } | { ignored: false; record: ReviewQueueRecord } =
    await withMrLock(key, async () => {
      const existing = await dependencies.getReviewQueueRecord(event.projectKey, event.mrIid)
      const commitSha = extractWebhookCommitSha(payload)

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

      await updateQueuedStatusNote({ record: queuedRecord, provider, dependencies })

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
