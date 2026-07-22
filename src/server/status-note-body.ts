import { getProject } from '@/config'
import { getFixBatchRecord, type FixBatchRecord } from '@/db/fix-batches'
import {
  countReviewFindingSeveritiesForMr,
  countReviewFindingsByStateForMr,
} from '@/db/review-findings'
import { listReviewRuns, type ReviewRunRecord } from '@/db/review-runs'
import type { ReviewFindingState } from '@/db/schema'
import type { MrReviewRequestEvent } from '@/lib/review-events'
import { getEffectiveReviewAgentConfig } from '@/mastra/review/review-pipeline'

export const STATUS_MARKER = '<!-- mend:review-status -->'

export type StatusState = 'queued' | 'running' | 'completed' | 'failed' | 'no_change'

export interface StatusNoteInput {
  state: StatusState
  event: MrReviewRequestEvent
  runningSha?: string
  pendingSha?: string
  reviewMode?: 'initial' | 'update'
  previousReviewedSha?: string | null
  runId?: string
  message?: string
}

export interface StatusNoteReviewConfig {
  harness: string
  stages: Array<{ label: string; model: string; thinking?: string }>
}

const utcNow = (): string => new Date().toISOString()
const STATUS_HISTORY_RUN_LIMIT = 15

type HistorySlot = 'Current' | 'Queued' | 'Previous'

interface StatusHistoryRow {
  slot: HistorySlot
  sha: string | null
  outcome: string
  assessment: string | null
  findings: FindingSeverityCounts | null
  startedAt: string | null
  durationMs: number | null
}

const FINDING_STATE_LABELS: Array<[ReviewFindingState, string]> = [
  ['pending', 'Pending'],
  ['accepted', 'Accepted'],
  ['rejected', 'Rejected'],
  ['deferred', 'Deferred'],
  ['fixed', 'Fixed'],
  ['not_fixed', 'Not fixed'],
  ['resolved', 'Resolved'],
]

const fixBatchStatusLabel = (batch: FixBatchRecord): string => {
  switch (batch.status) {
    case 'pending':
      return '🕒 Queued'
    case 'running':
      return '⏳ Running'
    case 'completed':
      return '✅ Completed'
    case 'failed':
      return '❌ Failed'
  }

  throw new Error(`Unsupported fix batch status: ${batch.status}`)
}

const stateOutcomeLabel = (state: StatusState): string => {
  switch (state) {
    case 'queued':
      return '🕒 Queued'
    case 'running':
      return '⏳ Running'
    case 'completed':
      return '✅ Completed'
    case 'failed':
      return '❌ Failed'
    case 'no_change':
      return '⏭️ No changes'
  }

  throw new Error(`Unsupported status state: ${state}`)
}

const runOutcomeLabel = (status: ReviewRunRecord['status']): string => {
  switch (status) {
    case 'running':
      return '⏳ Running'
    case 'success':
      return '✅ Completed'
    case 'failed':
      return '❌ Failed'
  }

  throw new Error(`Unsupported review run status: ${status}`)
}

const assessmentLabel = (value: string | null): string => {
  if (!value) {
    return '-'
  }

  switch (value) {
    case 'approve':
      return 'Approve'
    case 'request_changes':
      return 'Request changes'
    case 'needs_discussion':
      return 'Needs discussion'
    default:
      return value.replaceAll('_', ' ')
  }
}

const shortSha = (sha: string | null | undefined): string => {
  if (!sha) {
    return '-'
  }

  return `\`${sha.slice(0, 8)}\``
}

const formatUtcTimestamp = (value: Date | string | null | undefined): string => {
  if (!value) {
    return '-'
  }

  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    return '-'
  }

  const iso = date.toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

const formatDuration = (durationMs: number | null): string => {
  if (durationMs === null) {
    return '-'
  }

  if (durationMs < 1_000) {
    return `${durationMs}ms`
  }

  if (durationMs < 60_000) {
    const seconds = durationMs / 1_000
    return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`
  }

  let minutes = Math.floor(durationMs / 60_000)
  let seconds = Math.round((durationMs % 60_000) / 1_000)

  if (seconds === 60) {
    minutes += 1
    seconds = 0
  }

  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
}

const extractAssessment = (result: unknown): string | null => {
  if (!result || typeof result !== 'object') {
    return null
  }

  const assessment = (result as Record<string, unknown>).assessment
  return typeof assessment === 'string' ? assessment : null
}

type FindingSeverity = 'bug' | 'security' | 'performance' | 'suggestion'

type FindingSeverityCounts = Record<FindingSeverity, number>

const extractFindingSeverityCounts = (result: unknown): FindingSeverityCounts | null => {
  if (!result || typeof result !== 'object') {
    return null
  }

  const resultRecord = result as Record<string, unknown>
  const findingGroups = [resultRecord.findings, resultRecord.inlineComments].filter(Array.isArray)
  if (findingGroups.length === 0) {
    return null
  }

  const counts: FindingSeverityCounts = {
    bug: 0,
    security: 0,
    performance: 0,
    suggestion: 0,
  }

  for (const findings of findingGroups) {
    for (const finding of findings) {
      if (!finding || typeof finding !== 'object') {
        continue
      }

      const severity = (finding as Record<string, unknown>).severity
      switch (severity) {
        case 'bug':
        case 'security':
        case 'performance':
        case 'suggestion':
          counts[severity] += 1
      }
    }
  }

  return counts
}

const buildRunHistoryRow = (slot: HistorySlot, run: ReviewRunRecord): StatusHistoryRow => ({
  slot,
  sha: run.commitSha,
  outcome: runOutcomeLabel(run.status),
  assessment: extractAssessment(run.result),
  findings: extractFindingSeverityCounts(run.result),
  startedAt: run.createdAt instanceof Date ? run.createdAt.toISOString() : String(run.createdAt),
  durationMs: run.durationMs,
})

const buildSyntheticCurrentRow = (input: StatusNoteInput): StatusHistoryRow | null => {
  if (input.state === 'queued') {
    return null
  }

  if (!input.runningSha && input.state !== 'failed' && input.state !== 'no_change') {
    return null
  }

  return {
    slot: 'Current',
    sha: input.runningSha ?? null,
    outcome: stateOutcomeLabel(input.state),
    assessment: null,
    findings: null,
    startedAt: null,
    durationMs: null,
  }
}

const buildQueuedRow = (input: StatusNoteInput): StatusHistoryRow | null => {
  if (!input.pendingSha || input.pendingSha === input.runningSha) {
    return null
  }

  return {
    slot: 'Queued',
    sha: input.pendingSha,
    outcome: '🕒 Pending',
    assessment: null,
    findings: null,
    startedAt: null,
    durationMs: null,
  }
}

const buildRunHistory = (
  input: StatusNoteInput,
  reviewRuns: ReviewRunRecord[],
): StatusHistoryRow[] => {
  const rows: StatusHistoryRow[] = []
  const usedRunIds = new Set<string>()

  const queuedRow = buildQueuedRow(input)
  if (queuedRow) {
    rows.push(queuedRow)
  }

  const currentRun = input.runId ? reviewRuns.find((run) => run.id === input.runId) : undefined

  if (currentRun) {
    rows.push(buildRunHistoryRow('Current', currentRun))
    usedRunIds.add(currentRun.id)
  } else {
    const syntheticCurrent = buildSyntheticCurrentRow(input)
    if (syntheticCurrent) {
      rows.push(syntheticCurrent)
    }
  }

  for (const run of reviewRuns) {
    if (usedRunIds.has(run.id)) {
      continue
    }

    if (!currentRun && run.commitSha === input.runningSha && run.status === 'running') {
      continue
    }

    rows.push(buildRunHistoryRow('Previous', run))
  }

  return rows
}

const formatHistoryFindingCounts = (counts: FindingSeverityCounts | null): string => {
  if (!counts) {
    return '—'
  }

  const groups = [
    counts.bug > 0 ? `${counts.bug}🐞` : null,
    counts.security > 0 ? `${counts.security}🔒` : null,
    counts.performance > 0 ? `${counts.performance}⚡` : null,
    counts.suggestion > 0 ? `${counts.suggestion}💡` : null,
  ].filter((group): group is string => group !== null)

  if (groups.length === 0) {
    return '—'
  }

  const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
  return `${total} (${groups.join(' ')})`
}

const renderHistoryTable = (rows: StatusHistoryRow[]): string[] => {
  if (rows.length === 0) {
    return []
  }

  return [
    '| Slot | SHA | Outcome | Assessment | Findings | Started | Duration |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      (row) =>
        `| ${row.slot} | ${shortSha(row.sha)} | ${row.outcome} | ${assessmentLabel(row.assessment)} | ${formatHistoryFindingCounts(row.findings)} | ${formatUtcTimestamp(row.startedAt)} | ${formatDuration(row.durationMs)} |`,
    ),
  ]
}

const renderHistoryLimitNotice = (truncated: boolean): string[] => {
  if (!truncated) {
    return []
  }

  return ['', `Showing the latest ${STATUS_HISTORY_RUN_LIMIT} persisted runs.`]
}

const renderFindingDecisionCounts = (
  counts: Partial<Record<ReviewFindingState, number>> | undefined,
): string[] => {
  const total = Object.values(counts ?? {}).reduce((sum, value) => sum + (value ?? 0), 0)
  if (total === 0) {
    return []
  }

  return [
    '',
    '### Finding Decisions',
    '',
    `| ${FINDING_STATE_LABELS.map(([, label]) => label).join(' | ')} |`,
    `| ${FINDING_STATE_LABELS.map(() => '---:').join(' | ')} |`,
    `| ${FINDING_STATE_LABELS.map(([state]) => counts?.[state] ?? 0).join(' | ')} |`,
  ]
}

const renderReviewConfig = (reviewConfig: StatusNoteReviewConfig | undefined): string[] => {
  if (!reviewConfig) {
    return []
  }

  const stages = reviewConfig.stages.map(
    (stage) => `${stage.label} \`${stage.model}\`${stage.thinking ? ` (${stage.thinking})` : ''}`,
  )
  return [`**Review:** ${[reviewConfig.harness, ...stages].join(' · ')}`]
}

const renderTrackedFindingSeverityCounts = (
  counts: FindingSeverityCounts | undefined,
): string[] => {
  const total = Object.values(counts ?? {}).reduce((sum, count) => sum + count, 0)
  if (!counts || total === 0) {
    return []
  }

  return [
    '',
    `**Findings by severity (tracked on MR):** ${total} · ${counts.bug}🐞 ${counts.security}🔒 ${counts.performance}⚡ ${counts.suggestion}💡`,
  ]
}

const jsonArrayLength = (value: unknown): number => (Array.isArray(value) ? value.length : 0)

const renderFixBatchState = (batch: FixBatchRecord | null | undefined): string[] => {
  if (!batch) {
    return []
  }

  const findingCount =
    jsonArrayLength(batch.acceptedFindingIds) + jsonArrayLength(batch.pendingFindingIds)
  const rows = [
    `| Status | ${fixBatchStatusLabel(batch)} |`,
    `| Loop | ${batch.loopCount} |`,
    findingCount > 0 ? `| Findings | ${findingCount} |` : null,
    batch.pushedCommitSha ? `| Pushed commit | ${shortSha(batch.pushedCommitSha)} |` : null,
    batch.failureMessage ? `| Failure | ${batch.failureMessage} |` : null,
  ].filter((row): row is string => row !== null)

  return ['', '### Fix Batch', '', '| Field | Value |', '| --- | --- |', ...rows]
}

const renderTechnicalDetails = (input: StatusNoteInput): string[] => {
  const rows = [
    input.previousReviewedSha
      ? `| Previous reviewed SHA | ${shortSha(input.previousReviewedSha)} |`
      : null,
    input.runId ? `| Run ID | \`${input.runId}\` |` : null,
  ].filter((row): row is string => row !== null)

  if (rows.length === 0) {
    return []
  }

  return [
    '<details>',
    '<summary>Technical details</summary>',
    '',
    '| Field | Value |',
    '| --- | --- |',
    ...rows,
    '',
    '</details>',
  ]
}

export const renderStatusNoteBody = (params: {
  input: StatusNoteInput
  reviewRuns: ReviewRunRecord[]
  reviewConfig?: StatusNoteReviewConfig
  findingSeverityCounts?: FindingSeverityCounts
  findingStateCounts?: Partial<Record<ReviewFindingState, number>>
  fixBatch?: FixBatchRecord | null
  updatedAt?: string
}): string => {
  const { input, reviewRuns } = params
  const updatedAt = params.updatedAt ?? utcNow()
  const truncated = reviewRuns.length > STATUS_HISTORY_RUN_LIMIT
  const visibleRuns = truncated ? reviewRuns.slice(0, STATUS_HISTORY_RUN_LIMIT) : reviewRuns
  const historyRows = buildRunHistory(input, visibleRuns)
  const lines = [STATUS_MARKER, '## Mend Status', '', `Updated ${formatUtcTimestamp(updatedAt)}`]

  if (input.message) {
    lines.push('', input.message)
  }

  const reviewConfig = renderReviewConfig(params.reviewConfig)
  if (reviewConfig.length > 0) {
    lines.push('', ...reviewConfig)
  }

  const historyTable = renderHistoryTable(historyRows)
  if (historyTable.length > 0) {
    lines.push('', ...historyTable)
  }

  const historyLimitNotice = renderHistoryLimitNotice(truncated)
  if (historyLimitNotice.length > 0) {
    lines.push(...historyLimitNotice)
  }

  const findingSeverityCounts = renderTrackedFindingSeverityCounts(params.findingSeverityCounts)
  if (findingSeverityCounts.length > 0) {
    lines.push(...findingSeverityCounts)
  }

  const findingDecisionCounts = renderFindingDecisionCounts(params.findingStateCounts)
  if (findingDecisionCounts.length > 0) {
    lines.push(...findingDecisionCounts)
  }

  const fixBatchState = renderFixBatchState(params.fixBatch)
  if (fixBatchState.length > 0) {
    lines.push(...fixBatchState)
  }

  const technicalDetails = renderTechnicalDetails(input)
  if (technicalDetails.length > 0) {
    lines.push('', ...technicalDetails)
  }

  return lines.join('\n')
}

export const buildStatusNoteBody = async (input: StatusNoteInput): Promise<string> => {
  const [reviewRuns, findingStateCounts, findingSeverityCounts, fixBatch] = await Promise.all([
    listReviewRuns({
      projectKey: input.event.projectKey,
      mrIid: input.event.mrIid,
      limit: STATUS_HISTORY_RUN_LIMIT + 1,
    }),
    countReviewFindingsByStateForMr({
      projectKey: input.event.projectKey,
      mrIid: input.event.mrIid,
    }),
    countReviewFindingSeveritiesForMr({
      projectKey: input.event.projectKey,
      mrIid: input.event.mrIid,
    }),
    getFixBatchRecord(input.event.projectKey, input.event.mrIid),
  ])

  let reviewConfig: StatusNoteReviewConfig | undefined
  try {
    const project = getProject(input.event.projectKey)
    const agent = project.review.agent

    if (agent.harness === 'ensemble') {
      const ensemble = agent.ensemble
      if (!ensemble) {
        throw new Error('Ensemble review config is missing')
      }

      reviewConfig = {
        harness: 'ensemble',
        stages: [
          {
            label: 'Finder',
            model: ensemble.finder_model,
            thinking: ensemble.finder_thinking_level,
          },
          {
            label: 'Verify',
            model: ensemble.verifier_model,
            thinking: ensemble.verifier_thinking_level,
          },
          { label: 'Deep', model: ensemble.deep_model },
          { label: 'Synth', model: ensemble.synthesizer_model },
        ],
      }
    } else {
      const effectiveAgent = getEffectiveReviewAgentConfig(project)
      reviewConfig = {
        harness: effectiveAgent.harness,
        stages: [
          {
            label: 'Model',
            model: effectiveAgent.model,
            thinking: effectiveAgent.thinkingLevel,
          },
        ],
      }
    }
  } catch {
    reviewConfig = undefined
  }

  return renderStatusNoteBody({
    input,
    reviewRuns,
    reviewConfig,
    findingSeverityCounts,
    findingStateCounts,
    fixBatch,
  })
}
