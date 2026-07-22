import type { ProjectConfig } from '@/config'
import type { FixBatchRecord } from '@/db/fix-batches'
import {
  completeFixBatchRun,
  failFixBatchRun,
  recordFixBatchPush,
  startFixBatchRun,
} from '@/db/fix-batches'
import type { PreparedFixWorkspace } from '@/fix-workspaces/types'
import { commitAndPushWorktree } from '@/integrations/repo'
import { toErrorMessage } from '@/lib/errors'
import { applyFixerFindingStates } from '@/mastra/fix/finding-state'
import type { FixerOutput } from '@/mastra/fix/schema'

export interface FixBatchMrContext {
  title: string
  description: string
  labels: string[]
  sourceBranch: string
  targetBranch: string
  url: string
}

export interface FixBatchReviewEvent extends FixBatchMrContext {
  projectKey: string
  mrIid: number
}

export interface FixBatchCommitPushResult {
  commitSha: string
  pushedBranch: string
  remoteHeadSha: string
}

export interface FixBatchCompletionResult {
  batch: FixBatchRecord
  commit: FixBatchCommitPushResult
}

export interface FixBatchCompletionDependencies {
  store: {
    start(params: { projectKey: string; mrIid: number; maxLoops: number }): Promise<FixBatchRecord>
    complete(params: {
      projectKey: string
      mrIid: number
      sourceBranch: string
      pushedCommitSha: string
      result: unknown
    }): Promise<FixBatchRecord>
    recordPush(params: {
      projectKey: string
      mrIid: number
      sourceBranch: string
      pushedCommitSha: string
      result: unknown
    }): Promise<FixBatchRecord>
    fail(params: {
      projectKey: string
      mrIid: number
      failureMessage: string
      result?: unknown
      sourceBranch?: string
      pushedCommitSha?: string
    }): Promise<FixBatchRecord>
  }
  git: {
    commitAndPush(params: {
      project: ProjectConfig
      worktreePath: string
      sourceBranch: string
      commitMessage: string
    }): Promise<FixBatchCommitPushResult>
  }
  review: {
    enqueue(params: {
      project: ProjectConfig
      event: FixBatchReviewEvent
      payload: unknown
      commitSha: string
    }): Promise<void>
  }
  findingState: {
    apply(params: {
      project: ProjectConfig
      projectKey: string
      mrIid: number
      fixerOutput: FixerOutput
    }): Promise<void>
  }
}

export interface CompleteFixBatchInput {
  project: ProjectConfig
  batch: FixBatchRecord
  mr: FixBatchMrContext
  workspace: PreparedFixWorkspace
  fixerOutput: FixerOutput
  dependencies?: Partial<FixBatchCompletionDependencies>
}

const protectedBranches = (project: ProjectConfig, targetBranch: string): Set<string> =>
  new Set(['main', 'master', 'trunk', project.default_branch, targetBranch])

export const assertFixBatchSourceBranch = (
  project: ProjectConfig,
  sourceBranch: string,
  targetBranch: string,
): string => {
  const branch = sourceBranch.trim()
  if (!branch) {
    throw new Error('Fix batch source branch is empty')
  }

  if (
    branch.startsWith('refs/') ||
    branch.includes(':') ||
    branch.includes('..') ||
    branch.endsWith('/') ||
    /[\s~^?*[\\]/.test(branch)
  ) {
    throw new Error(`Fix batch source branch is not a simple branch name: ${sourceBranch}`)
  }

  if (protectedBranches(project, targetBranch).has(branch)) {
    throw new Error(`Refusing to push fix batch to protected branch ${branch}`)
  }

  return branch
}

const defaultDependencies: FixBatchCompletionDependencies = {
  store: {
    start: startFixBatchRun,
    complete: completeFixBatchRun,
    recordPush: recordFixBatchPush,
    fail: failFixBatchRun,
  },
  git: {
    commitAndPush: commitAndPushWorktree,
  },
  review: {
    enqueue: async () => {
      throw new Error('Fix batch review enqueue dependency is not configured')
    },
  },
  findingState: {
    apply: applyFixerFindingStates,
  },
}

const mergeDependencies = (
  overrides: Partial<FixBatchCompletionDependencies> | undefined,
): FixBatchCompletionDependencies => ({
  store: { ...defaultDependencies.store, ...overrides?.store },
  git: { ...defaultDependencies.git, ...overrides?.git },
  review: { ...defaultDependencies.review, ...overrides?.review },
  findingState: { ...defaultDependencies.findingState, ...overrides?.findingState },
})

const buildCommitMessage = (batch: FixBatchRecord): string =>
  `fix: address Mend findings for MR !${batch.mrIid}`

const buildReviewPayload = (commitSha: string): unknown => ({
  object_kind: 'merge_request',
  object_attributes: {
    last_commit: {
      id: commitSha,
    },
  },
})

const buildReviewEvent = (
  projectKey: string,
  mrIid: number,
  mr: FixBatchMrContext,
): FixBatchReviewEvent => ({
  projectKey,
  mrIid,
  title: mr.title,
  description: mr.description,
  labels: mr.labels,
  sourceBranch: mr.sourceBranch,
  targetBranch: mr.targetBranch,
  url: mr.url,
})

const buildStoredResult = (params: {
  fixerOutput: FixerOutput
  commit: FixBatchCommitPushResult
  findingStateError?: string | null
  reviewEnqueueError?: string | null
}): unknown => ({
  version: 'fix-batch-v1',
  fixer: params.fixerOutput,
  git: params.commit,
  findingState: params.findingStateError ? { error: params.findingStateError } : { synced: true },
  review: params.reviewEnqueueError
    ? { queued: false, error: params.reviewEnqueueError }
    : { queued: true },
})

const pushFixBatch = async (params: {
  input: CompleteFixBatchInput
  dependencies: FixBatchCompletionDependencies
  sourceBranch: string
  runBatch: FixBatchRecord
}): Promise<FixBatchCommitPushResult> => {
  const commit = await params.dependencies.git.commitAndPush({
    project: params.input.project,
    worktreePath: params.input.workspace.git.cwd,
    sourceBranch: params.sourceBranch,
    commitMessage: buildCommitMessage(params.runBatch),
  })

  if (commit.pushedBranch !== params.sourceBranch) {
    throw new Error(
      `Fix batch pushed ${commit.pushedBranch}, expected source branch ${params.sourceBranch}`,
    )
  }

  if (commit.remoteHeadSha !== commit.commitSha) {
    throw new Error(
      `Fix batch remote head ${commit.remoteHeadSha} does not match commit ${commit.commitSha}`,
    )
  }

  return commit
}

const recordPushedFixBatch = async (params: {
  input: CompleteFixBatchInput
  dependencies: FixBatchCompletionDependencies
  sourceBranch: string
  commit: FixBatchCommitPushResult
}): Promise<void> => {
  await params.dependencies.store.recordPush({
    projectKey: params.input.batch.projectKey,
    mrIid: params.input.batch.mrIid,
    sourceBranch: params.sourceBranch,
    pushedCommitSha: params.commit.commitSha,
    result: buildStoredResult({
      fixerOutput: params.input.fixerOutput,
      commit: params.commit,
      findingStateError: 'pending',
      reviewEnqueueError: 'pending',
    }),
  })
}

const syncFixerFindingStates = async (
  input: CompleteFixBatchInput,
  dependencies: FixBatchCompletionDependencies,
): Promise<string | null> => {
  try {
    await dependencies.findingState.apply({
      project: input.project,
      projectKey: input.batch.projectKey,
      mrIid: input.batch.mrIid,
      fixerOutput: input.fixerOutput,
    })
    return null
  } catch (error) {
    const errorMessage = toErrorMessage(error)
    console.warn(
      `[fix] finding state sync failed for ${input.batch.projectKey} MR !${input.batch.mrIid}: ${errorMessage}`,
    )
    return errorMessage
  }
}

const enqueueFollowUpReview = async (params: {
  input: CompleteFixBatchInput
  dependencies: FixBatchCompletionDependencies
  sourceBranch: string
  commitSha: string
}): Promise<string | null> => {
  try {
    await params.dependencies.review.enqueue({
      project: params.input.project,
      event: buildReviewEvent(params.input.batch.projectKey, params.input.batch.mrIid, {
        ...params.input.mr,
        sourceBranch: params.sourceBranch,
      }),
      payload: buildReviewPayload(params.commitSha),
      commitSha: params.commitSha,
    })
    return null
  } catch (error) {
    const errorMessage = toErrorMessage(error)
    console.warn(
      `[fix] review enqueue failed for ${params.input.batch.projectKey} MR !${params.input.batch.mrIid} after pushing ${params.commitSha}: ${errorMessage}`,
    )
    return errorMessage
  }
}

export const completeFixBatch = async (
  input: CompleteFixBatchInput,
): Promise<FixBatchCompletionResult> => {
  const dependencies = mergeDependencies(input.dependencies)
  const targetBranch = input.mr.targetBranch.trim()
  const requestedSourceBranch = input.mr.sourceBranch.trim()
  if (requestedSourceBranch === targetBranch) {
    throw new Error(
      `Refusing to push fix batch when source and target branch are both ${requestedSourceBranch}`,
    )
  }
  const sourceBranch = assertFixBatchSourceBranch(
    input.project,
    requestedSourceBranch,
    input.mr.targetBranch,
  )

  let runBatch: FixBatchRecord | null = null
  let pushedCommitSha: string | null = null

  try {
    runBatch = await dependencies.store.start({
      projectKey: input.batch.projectKey,
      mrIid: input.batch.mrIid,
      maxLoops: input.project.review.fix.max_loops,
    })

    const commit = await pushFixBatch({ input, dependencies, sourceBranch, runBatch })
    pushedCommitSha = commit.commitSha

    await recordPushedFixBatch({
      input,
      dependencies,
      sourceBranch,
      commit,
    })

    const findingStateError = await syncFixerFindingStates(input, dependencies)
    const reviewEnqueueError = await enqueueFollowUpReview({
      input,
      dependencies,
      sourceBranch,
      commitSha: commit.commitSha,
    })
    const result = buildStoredResult({
      fixerOutput: input.fixerOutput,
      commit,
      findingStateError,
      reviewEnqueueError,
    })
    const completed = await dependencies.store.complete({
      projectKey: input.batch.projectKey,
      mrIid: input.batch.mrIid,
      sourceBranch,
      pushedCommitSha: commit.commitSha,
      result,
    })

    return { batch: completed, commit }
  } catch (error) {
    if (runBatch) {
      await dependencies.store.fail({
        projectKey: input.batch.projectKey,
        mrIid: input.batch.mrIid,
        failureMessage: toErrorMessage(error),
        result: input.fixerOutput,
        sourceBranch: pushedCommitSha ? sourceBranch : undefined,
        pushedCommitSha: pushedCommitSha ?? undefined,
      })
    }

    throw error
  }
}
