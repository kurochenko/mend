import type { Mastra } from '@mastra/core'
import type { AppConfig, ProjectConfig } from '@/config'
import {
  failFixBatchRun,
  listRunnableFixBatches,
  recoverFixBatchesAfterRestart,
  startFixBatchRun,
  type FixBatchRecord,
} from '@/db/fix-batches'
import { getReviewQueueRecord } from '@/db/review-queue'
import { listReviewFindingsForMr } from '@/db/review-findings'
import { getServiceRuntimeMode } from '@/db/service-runtime'
import { createFixWorkspaceProvider } from '@/fix-workspaces/factory'
import type { PreparedFixWorkspace } from '@/fix-workspaces/types'
import { createReviewProvider } from '@/integrations/provider/client'
import type { ChangeRequestDetails } from '@/integrations/provider/types'
import { createWorktree, ensureClone, removeWorktree } from '@/integrations/repo'
import { toErrorMessage } from '@/lib/errors'
import { completeFixBatch } from '@/mastra/fix/commit-push'
import { runFixerAgent } from '@/mastra/fix/fixer-agent'
import { mrIidFromLockKey, mrLockKey, withMrLock } from '@/server/mr-locks'
import type { MrReviewRequestEvent } from '@/lib/review-events'

const activeFixWorkers = new Set<string>()

export type EnqueueMrReview = (params: {
  mastra: Mastra
  project: ProjectConfig
  payload: unknown
  event: MrReviewRequestEvent
}) => Promise<void>

interface FixBatchRunnerDependencies {
  listRunnableFixBatches: typeof listRunnableFixBatches
  startFixBatchRun: typeof startFixBatchRun
  failFixBatchRun: typeof failFixBatchRun
  getReviewQueueRecord: typeof getReviewQueueRecord
  listReviewFindingsForMr: typeof listReviewFindingsForMr
  createFixWorkspaceProvider: typeof createFixWorkspaceProvider
  createReviewProvider: typeof createReviewProvider
  ensureClone: typeof ensureClone
  createWorktree: typeof createWorktree
  removeWorktree: typeof removeWorktree
  runFixerAgent: typeof runFixerAgent
  completeFixBatch: typeof completeFixBatch
  enqueueMrReview: EnqueueMrReview
  getServiceRuntimeMode: typeof getServiceRuntimeMode
}

const missingEnqueueMrReview: EnqueueMrReview = async () => {
  throw new Error('Fix batch runner requires an enqueueMrReview dependency')
}

const defaultDependencies: FixBatchRunnerDependencies = {
  listRunnableFixBatches,
  startFixBatchRun,
  failFixBatchRun,
  getReviewQueueRecord,
  listReviewFindingsForMr,
  createFixWorkspaceProvider,
  createReviewProvider,
  ensureClone,
  createWorktree,
  removeWorktree,
  runFixerAgent,
  completeFixBatch,
  enqueueMrReview: missingEnqueueMrReview,
  getServiceRuntimeMode,
}

const isDraining = async (dependencies: FixBatchRunnerDependencies): Promise<boolean> =>
  (await dependencies.getServiceRuntimeMode()) === 'draining'

export const assertFixSourceRepository = (
  project: ProjectConfig,
  changeRequest: ChangeRequestDetails,
): void => {
  if (
    project.platform === 'github' &&
    changeRequest.sourceRepository?.toLowerCase() !== project.repo.toLowerCase()
  ) {
    throw new Error(
      `GitHub fix batches require the pull request source branch to belong to ${project.repo}`,
    )
  }
}

const runFixBatch = async (params: {
  mastra: Mastra
  project: ProjectConfig
  batch: FixBatchRecord
  dependencies: FixBatchRunnerDependencies
}): Promise<void> => {
  const { mastra, project, batch, dependencies } = params
  const suffix = `fix-${batch.id.replace(/[^a-zA-Z0-9_.-]/g, '-')}`
  let workspace: PreparedFixWorkspace | null = null

  try {
    const runningBatch = await dependencies.startFixBatchRun({
      projectKey: batch.projectKey,
      mrIid: batch.mrIid,
      maxLoops: project.review.fix.max_loops,
    })
    const provider = dependencies.createReviewProvider(project)
    const mr = await provider.fetchChangeRequest(batch.mrIid)
    assertFixSourceRepository(project, mr)

    await dependencies.ensureClone(project)
    const worktreePath = await dependencies.createWorktree(
      project,
      batch.mrIid,
      mr.sourceBranch,
      undefined,
      {
        pathSuffix: suffix,
      },
    )
    workspace = await dependencies.createFixWorkspaceProvider(project).prepare({
      project,
      mrIid: batch.mrIid,
      worktreePath,
      attemptId: `${runningBatch.loopCount}`,
    })

    const findings = await dependencies.listReviewFindingsForMr({
      projectKey: batch.projectKey,
      mrIid: batch.mrIid,
    })
    const fixerResult = await dependencies.runFixerAgent({
      project,
      batch: runningBatch,
      findings,
      workspace,
      sessionDir: 'sessions',
    })

    await dependencies.completeFixBatch({
      project,
      batch: runningBatch,
      mr: {
        title: mr.title,
        description: mr.description,
        labels: mr.labels,
        sourceBranch: mr.sourceBranch,
        targetBranch: mr.targetBranch,
        url: mr.url,
      },
      workspace,
      fixerOutput: fixerResult.output,
      dependencies: {
        review: {
          enqueue: async (input) => {
            await dependencies.enqueueMrReview({
              mastra,
              project: input.project,
              payload: input.payload,
              event: input.event,
            })
          },
        },
      },
    })
  } catch (error) {
    await dependencies.failFixBatchRun({
      projectKey: batch.projectKey,
      mrIid: batch.mrIid,
      failureMessage: toErrorMessage(error),
    })
    console.error(`[fix] batch failed for ${batch.projectKey} MR !${batch.mrIid}:`, error)
  } finally {
    if (workspace) {
      await workspace.teardown()
    }
    await dependencies.removeWorktree(project, batch.mrIid, { pathSuffix: suffix })
  }
}

const hasReviewWorkWithDeps = async (
  dependencies: FixBatchRunnerDependencies,
  projectKey: string,
  mrIid: number,
): Promise<boolean> => {
  const record = await dependencies.getReviewQueueRecord(projectKey, mrIid)
  return Boolean(record?.runningEvent ?? record?.pendingEvent)
}

const processFixBatchLoop = async (
  mastra: Mastra,
  project: ProjectConfig,
  key: string,
  dependencies: FixBatchRunnerDependencies,
): Promise<void> => {
  try {
    for (;;) {
      if (await isDraining(dependencies)) {
        return
      }

      const batch = await withMrLock(key, async () => {
        if (await isDraining(dependencies)) {
          return null
        }

        const mrIid = mrIidFromLockKey(key)
        if (await hasReviewWorkWithDeps(dependencies, project.key, mrIid)) {
          return null
        }

        const runnable = await dependencies.listRunnableFixBatches()
        return (
          runnable.find(
            (candidate) => candidate.projectKey === project.key && candidate.mrIid === mrIid,
          ) ?? null
        )
      })

      if (!batch) {
        return
      }

      await runFixBatch({ mastra, project, batch, dependencies })
    }
  } finally {
    await withMrLock(key, async () => {
      activeFixWorkers.delete(key)
    })
  }
}

export const ensureFixBatchRunner = async (params: {
  mastra: Mastra
  project: ProjectConfig
  mrIid: number
  dependencies?: Partial<FixBatchRunnerDependencies>
}): Promise<boolean> => {
  const dependencies = { ...defaultDependencies, ...params.dependencies }
  const key = mrLockKey(params.project.key, params.mrIid)
  const shouldStart = await withMrLock(key, async () => {
    if (await isDraining(dependencies)) {
      return false
    }

    if (
      activeFixWorkers.has(key) ||
      (await hasReviewWorkWithDeps(dependencies, params.project.key, params.mrIid))
    ) {
      return false
    }

    const runnable = await dependencies.listRunnableFixBatches()
    if (
      !runnable.some(
        (batch) => batch.projectKey === params.project.key && batch.mrIid === params.mrIid,
      )
    ) {
      return false
    }

    activeFixWorkers.add(key)
    return true
  })

  if (!shouldStart) {
    return false
  }

  queueMicrotask(() => {
    void processFixBatchLoop(params.mastra, params.project, key, dependencies)
  })

  return true
}

export const recoverInterruptedFixBatches = async (): Promise<number> =>
  await recoverFixBatchesAfterRestart()

export const resumeRunnableFixBatches = async (
  config: AppConfig,
  mastra: Mastra,
  dependencies?: Pick<Partial<FixBatchRunnerDependencies>, 'enqueueMrReview'>,
): Promise<number> => {
  const batches = await listRunnableFixBatches()
  let resumed = 0

  for (const batch of batches) {
    const project = config.projects.get(batch.projectKey)
    if (!project) {
      await failFixBatchRun({
        projectKey: batch.projectKey,
        mrIid: batch.mrIid,
        failureMessage: `Project ${batch.projectKey} is not configured`,
      })
      continue
    }

    const started = await ensureFixBatchRunner({
      mastra,
      project,
      mrIid: batch.mrIid,
      dependencies,
    })
    if (started) {
      resumed += 1
    }
  }

  return resumed
}
