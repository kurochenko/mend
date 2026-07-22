import type { ProjectConfig } from '@/config'
import { getFixBatchRecord, upsertPendingFixBatch, type FixBatchRecord } from '@/db/fix-batches'
import { listReviewFindingsForMr, type ReviewFindingRecord } from '@/db/review-findings'

export type AutomaticFixBatchOutcome =
  | { status: 'disabled' }
  | { status: 'no_findings'; consideredCount: number }
  | { status: 'duplicate'; batch: FixBatchRecord }
  | { status: 'loop_limit'; batch: FixBatchRecord; maxLoops: number }
  | { status: 'queued'; batch: FixBatchRecord; queuedCount: number; ignoredCount: number }

export const automaticLoopLimitBody = (
  projectKey: string,
  mrIid: number,
  outcome: Extract<AutomaticFixBatchOutcome, { status: 'loop_limit' }>,
): string =>
  [
    `Mend automatic fix loop stopped for ${projectKey} MR !${mrIid}.`,
    '',
    `The configured maximum of ${outcome.maxLoops} fix loop(s) has been reached.`,
    'Please review the remaining findings manually.',
  ].join('\n')

interface AutomaticFixBatchDependencies {
  getExistingBatch(projectKey: string, mrIid: number): Promise<FixBatchRecord | null>
  listFindings(params: { projectKey: string; mrIid: number }): Promise<ReviewFindingRecord[]>
  upsertBatch(params: {
    projectKey: string
    mrIid: number
    force: boolean
    acceptedFindingIds: string[]
    pendingFindingIds: string[]
    resetLoopCount?: boolean
  }): Promise<FixBatchRecord>
}

interface QueueAutomaticFixBatchInput {
  project: ProjectConfig
  mrIid: number
  dependencies?: Partial<AutomaticFixBatchDependencies>
}

const defaultDependencies: AutomaticFixBatchDependencies = {
  getExistingBatch: getFixBatchRecord,
  listFindings: listReviewFindingsForMr,
  upsertBatch: upsertPendingFixBatch,
}

const mergeDependencies = (
  dependencies: Partial<AutomaticFixBatchDependencies> | undefined,
): AutomaticFixBatchDependencies => ({
  ...defaultDependencies,
  ...dependencies,
})

const automaticWorkStates = new Set<ReviewFindingRecord['state']>(['pending', 'accepted'])

const isAutomaticWorkFinding = (finding: ReviewFindingRecord): boolean =>
  automaticWorkStates.has(finding.state)

const findingIds = (findings: ReviewFindingRecord[]): string[] =>
  findings.map((finding) => finding.id)

const isUnavailableForAutomaticFix = (batch: FixBatchRecord): boolean =>
  batch.status === 'pending' ||
  batch.status === 'running' ||
  (batch.status === 'failed' && Boolean(batch.pushedCommitSha))

export const queueAutomaticFixBatch = async (
  input: QueueAutomaticFixBatchInput,
): Promise<AutomaticFixBatchOutcome> => {
  const fixConfig = input.project.review.fix
  if (!fixConfig.enabled || !fixConfig.automatic) {
    return { status: 'disabled' }
  }

  const dependencies = mergeDependencies(input.dependencies)
  const existing = await dependencies.getExistingBatch(input.project.key, input.mrIid)

  if (existing && isUnavailableForAutomaticFix(existing)) {
    return { status: 'duplicate', batch: existing }
  }

  if (existing && existing.loopCount >= fixConfig.max_loops) {
    return { status: 'loop_limit', batch: existing, maxLoops: fixConfig.max_loops }
  }

  const findings = await dependencies.listFindings({
    projectKey: input.project.key,
    mrIid: input.mrIid,
  })
  const workFindings = findings.filter(isAutomaticWorkFinding)

  if (workFindings.length === 0) {
    return { status: 'no_findings', consideredCount: findings.length }
  }

  const batch = await dependencies.upsertBatch({
    projectKey: input.project.key,
    mrIid: input.mrIid,
    force: true,
    acceptedFindingIds: findingIds(workFindings),
    pendingFindingIds: [],
    resetLoopCount: false,
  })

  return {
    status: 'queued',
    batch,
    queuedCount: workFindings.length,
    ignoredCount: findings.length - workFindings.length,
  }
}
