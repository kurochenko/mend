import type { DiffMap } from '@/lib/diff'
import { lookupPosition } from '@/lib/diff'
import {
  buildInlineThreadFingerprint,
  buildSummaryFindingThreadFingerprint,
} from '@/lib/review-threads'
import {
  formatCommentBody,
  formatFindingDiscussionBody,
  formatSkippedInlineCommentDiscussionBody,
  formatSummaryNote,
  type SkippedInlineComment,
  type SkippedInlineReason,
} from '@/mastra/review/formatting'
import {
  appendInlineMarkers,
  appendSummaryFindingMarkers,
  appendSummaryMarkers,
} from '@/mastra/review/markers'
import type { ResolutionVerdict } from '@/mastra/review/schema'
import type { ReviewFinding, ReviewInlineComment } from '@/mastra/review/schema'
import type { PostStepInput } from '@/mastra/review/run-result'

export interface PostPlanDiffRefs {
  base_sha: string
  head_sha: string
  start_sha: string
}

export interface PlannedDraftNotePosition {
  position_type: 'text'
  base_sha: string
  head_sha: string
  start_sha: string
  old_path: string
  new_path: string
  old_line?: number
  new_line?: number
}

export interface ExistingPublishedThread {
  findingFingerprint: string
  status: 'open' | 'resolved'
}

interface SummaryFindingDiscussionDraft {
  fingerprint: string
  previousFindingId: string
  path: string | null
  line: number | null
  body: string
}

export interface PlannedInlineDraft {
  inlineCommentIndex: number
  comment: ReviewInlineComment
  fingerprint: string
  body: string
  markedBody: string
  position: PlannedDraftNotePosition
}

export interface PlannedFindingDiscussion {
  fingerprint: string
  previousFindingId: string
  path: string | null
  line: number | null
  body: string
  markedBody: string
  findingIndex: number | null
  inlineCommentIndex: number | null
  finding: ReviewFinding | null
  inlineComment: ReviewInlineComment | null
}

export interface PlannedThreadResolution {
  previousFindingId: string
  discussionId: string
  status: 'fixed' | 'partially_fixed'
  replyBody: string
  markResolved: boolean
}

interface PreviousFindingForResolution {
  id: string
  discussionId: string | null
  resolved: boolean
}

interface PreviousInlineCommentForResolution {
  file: string
  line: number
  discussionId: string | null
  resolved: boolean
}

export interface PostPlanDiagnostics {
  findingsCount: number
  outOfScopeFindingCount: number
  inlineCommentCount: number
  outOfScopeInlineCount: number
  postedInlineCount: number
  skippedInlineReasons: Record<string, number>
  dedupedExistingThreadCount: number
  suppressedResolvedThreadCount: number
}

export interface PostPlan {
  input: PostStepInput
  findings: ReviewFinding[]
  inlineComments: ReviewInlineComment[]
  outOfScopeFindings: ReviewFinding[]
  outOfScopeInlineComments: ReviewInlineComment[]
  inlineDrafts: PlannedInlineDraft[]
  findingDiscussions: PlannedFindingDiscussion[]
  skippedInlineComments: SkippedInlineComment[]
  summaryBody: string
  markedSummaryBody: string
  reviewNumber: number
  diagnostics: PostPlanDiagnostics
  threadResolutions: PlannedThreadResolution[]
  unmatchedVerdictCount: number
}

export const emptyPostedThreadRef = (): {
  providerThreadId: null
  providerMessageId: null
} => ({
  providerThreadId: null,
  providerMessageId: null,
})

const recordSkippedInlineReason = (
  skippedInlineReasons: Record<string, number>,
  reason: SkippedInlineReason,
): void => {
  skippedInlineReasons[reason] = (skippedInlineReasons[reason] ?? 0) + 1
}

export const findingFiles = (finding: ReviewFinding): string[] => {
  const directFiles = finding.files ?? []
  const evidenceFiles = finding.evidence
    .filter((evidence) => evidence.type === 'file_line')
    .map((evidence) => evidence.file)

  const allFiles = [...directFiles, ...evidenceFiles]
  const unique = new Set<string>()
  const out: string[] = []

  for (const file of allFiles) {
    const normalized = file.trim()
    if (!normalized || unique.has(normalized)) {
      continue
    }
    unique.add(normalized)
    out.push(normalized)
  }

  return out
}

export const dedupeInlineComments = (
  inlineComments: ReviewInlineComment[],
): ReviewInlineComment[] => {
  const seen = new Set<string>()
  const deduped: ReviewInlineComment[] = []

  for (const comment of inlineComments) {
    const key = JSON.stringify([
      comment.file,
      comment.line,
      comment.severity,
      comment.body,
      comment.suggestion ?? null,
    ])

    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    deduped.push(comment)
  }

  return deduped
}

const isWithinMrScope = (files: string[], mrChangedFiles: Set<string>): boolean =>
  files.every((file) => mrChangedFiles.has(file))

interface ScopeGuardResult {
  findings: ReviewFinding[]
  inlineComments: ReviewInlineComment[]
  outOfScopeFindings: ReviewFinding[]
  outOfScopeInlineComments: ReviewInlineComment[]
}

export const applyMrScopeGuard = (
  findings: ReviewFinding[],
  inlineComments: ReviewInlineComment[],
  mrChangedFiles: Set<string>,
): ScopeGuardResult => {
  const inScopeFindings: ReviewFinding[] = []
  const outOfScopeFindings: ReviewFinding[] = []

  for (const finding of findings) {
    if (isWithinMrScope(findingFiles(finding), mrChangedFiles)) {
      inScopeFindings.push(finding)
      continue
    }
    outOfScopeFindings.push(finding)
  }

  const inScopeInlineComments: ReviewInlineComment[] = []
  const outOfScopeInlineComments: ReviewInlineComment[] = []

  for (const inlineComment of inlineComments) {
    if (mrChangedFiles.has(inlineComment.file)) {
      inScopeInlineComments.push(inlineComment)
      continue
    }
    outOfScopeInlineComments.push(inlineComment)
  }

  return {
    findings: inScopeFindings,
    inlineComments: inScopeInlineComments,
    outOfScopeFindings,
    outOfScopeInlineComments,
  }
}

const buildInlineCommentAnchorKey = (file: string, line: number): string => `${file}:${line}`

const buildActiveMemoryAnchorKeys = (input: PostStepInput): Set<string> => {
  const keys = new Set<string>()

  for (const memory of input.activeReviewMemoryEntries) {
    if (
      memory.scope !== 'mr' ||
      memory.status !== 'active' ||
      !memory.matchPath ||
      !memory.matchLine
    ) {
      continue
    }

    keys.add(buildInlineCommentAnchorKey(memory.matchPath, memory.matchLine))
  }

  return keys
}

export const findingHasInlineAnchor = (
  finding: ReviewFinding,
  inlineCommentAnchorKeys: Set<string>,
): boolean =>
  finding.evidence.some(
    (evidence) =>
      evidence.type === 'file_line' &&
      inlineCommentAnchorKeys.has(buildInlineCommentAnchorKey(evidence.file, evidence.line)),
  )

export const shouldPostFindingAsDiscussion = (
  finding: ReviewFinding,
  inlineCommentAnchorKeys: Set<string>,
): boolean => !findingHasInlineAnchor(finding, inlineCommentAnchorKeys)

const deriveFindingDiscussionContext = (
  finding: ReviewFinding,
): {
  path: string | null
  line: number | null
} => {
  const fileLineEvidence = finding.evidence.filter((evidence) => evidence.type === 'file_line')
  const onlyFileLineEvidence = fileLineEvidence.length === 1 ? fileLineEvidence[0] : undefined
  if (onlyFileLineEvidence) {
    return {
      path: onlyFileLineEvidence.file,
      line: onlyFileLineEvidence.line,
    }
  }

  const files = findingFiles(finding)
  const onlyFile = files.length === 1 ? files[0] : undefined
  if (onlyFile) {
    return {
      path: onlyFile,
      line: null,
    }
  }

  return {
    path: null,
    line: null,
  }
}

const buildFindingDiscussionDraft = (finding: ReviewFinding): SummaryFindingDiscussionDraft => {
  const context = deriveFindingDiscussionContext(finding)

  return {
    fingerprint: buildSummaryFindingThreadFingerprint(finding.id),
    previousFindingId: finding.id,
    path: context.path,
    line: context.line,
    body: formatFindingDiscussionBody(finding),
  }
}

const buildSkippedInlineDiscussionDraft = (
  skipped: SkippedInlineComment,
): SummaryFindingDiscussionDraft => ({
  fingerprint: buildInlineThreadFingerprint(
    skipped.comment.file,
    skipped.comment.line,
    formatCommentBody(skipped.comment),
  ),
  previousFindingId: `${skipped.comment.file}:${skipped.comment.line}`,
  path: skipped.comment.file,
  line: skipped.comment.line,
  body: formatSkippedInlineCommentDiscussionBody(skipped),
})

const markFindingDiscussion = (draft: SummaryFindingDiscussionDraft, reviewRunId: string): string =>
  appendSummaryFindingMarkers(draft.body, reviewRunId, {
    fingerprint: draft.fingerprint,
    previousFindingId: draft.previousFindingId,
    path: draft.path ?? undefined,
    line: draft.line ?? undefined,
  })

const getExistingThreadStatus = (
  fingerprint: string,
  existingThreadStatuses: Map<string, ExistingPublishedThread['status']>,
): ExistingPublishedThread['status'] | undefined => existingThreadStatuses.get(fingerprint)

interface ResolvableReviewThread {
  identifier: string
  discussionId: string | null
  resolved: boolean
}

const findResolvableThreadForVerdict = (
  verdict: ResolutionVerdict,
  findings: PreviousFindingForResolution[],
  inlineComments: PreviousInlineCommentForResolution[],
): ResolvableReviewThread | undefined => {
  const finding = findings.find((candidate) => candidate.id === verdict.previousFindingId)
  if (finding) {
    return {
      identifier: finding.id,
      discussionId: finding.discussionId,
      resolved: finding.resolved,
    }
  }

  const inlineComment = inlineComments.find(
    (candidate) => `${candidate.file}:${candidate.line}` === verdict.previousFindingId,
  )
  if (!inlineComment) {
    return undefined
  }

  return {
    identifier: `${inlineComment.file}:${inlineComment.line}`,
    discussionId: inlineComment.discussionId,
    resolved: inlineComment.resolved,
  }
}

const planThreadResolutions = (params: {
  commitSha: string
  verdicts: ResolutionVerdict[]
  findings: PreviousFindingForResolution[]
  inlineComments: PreviousInlineCommentForResolution[]
}): { resolutions: PlannedThreadResolution[]; unmatchedVerdictCount: number } => {
  const resolutions: PlannedThreadResolution[] = []
  let unmatchedVerdictCount = 0

  for (const verdict of params.verdicts) {
    if (verdict.status !== 'fixed' && verdict.status !== 'partially_fixed') {
      continue
    }

    const thread = findResolvableThreadForVerdict(verdict, params.findings, params.inlineComments)

    if (!thread?.discussionId) {
      unmatchedVerdictCount++
      continue
    }

    if (verdict.status === 'fixed' && thread.resolved) {
      continue
    }

    resolutions.push({
      previousFindingId: thread.identifier,
      discussionId: thread.discussionId,
      status: verdict.status,
      replyBody:
        verdict.status === 'fixed'
          ? `Verified as fixed in \`${params.commitSha}\`: ${verdict.explanation}`
          : `Partially addressed in \`${params.commitSha}\`: ${verdict.explanation}`,
      markResolved: verdict.status === 'fixed',
    })
  }

  return { resolutions, unmatchedVerdictCount }
}

export const buildPostPlan = (params: {
  input: PostStepInput
  diffRefs: PostPlanDiffRefs
  diffMap: DiffMap
  changedFiles: string[]
  reviewNumber: number
  existingPublishedThreads: ExistingPublishedThread[]
  previousContext?: {
    findings: PreviousFindingForResolution[]
    inlineComments: PreviousInlineCommentForResolution[]
  } | null
}): PostPlan => {
  const existingThreadStatuses = new Map(
    params.existingPublishedThreads.map(
      (thread) => [thread.findingFingerprint, thread.status] as const,
    ),
  )
  const dedupedInlineComments = dedupeInlineComments(params.input.inlineComments)
  const scopeGuard = applyMrScopeGuard(
    params.input.findings,
    dedupedInlineComments,
    new Set(params.changedFiles),
  )
  const inlineDrafts: PlannedInlineDraft[] = []
  const skippedInlineComments: SkippedInlineComment[] = []
  const skippedInlineReasons: Record<string, number> = {}
  const inlineComments: ReviewInlineComment[] = []
  const outOfScopeInlineComments: ReviewInlineComment[] = []
  const skippedInlineDiscussionDrafts: Array<
    SummaryFindingDiscussionDraft & {
      inlineCommentIndex: number | null
      inlineComment: ReviewInlineComment
    }
  > = []
  let dedupedExistingThreadCount = 0
  let suppressedResolvedThreadCount = 0
  const anchoredInlineCommentKeys = new Set<string>()
  const memoryAnchorKeys = buildActiveMemoryAnchorKeys(params.input)

  const suppressExistingThread = (fingerprint: string, inlineComment: boolean): boolean => {
    const status = getExistingThreadStatus(fingerprint, existingThreadStatuses)
    if (!status) {
      return false
    }

    if (status === 'open') {
      dedupedExistingThreadCount++
      return true
    }

    suppressedResolvedThreadCount++
    if (inlineComment) {
      recordSkippedInlineReason(skippedInlineReasons, 'resolved_thread')
    }
    return true
  }

  for (const comment of scopeGuard.outOfScopeInlineComments) {
    const skipped = { comment, reason: 'out_of_scope_file' as const }
    const draft = buildSkippedInlineDiscussionDraft(skipped)
    if (suppressExistingThread(draft.fingerprint, true)) {
      continue
    }

    skippedInlineComments.push(skipped)
    skippedInlineDiscussionDrafts.push({
      ...draft,
      inlineCommentIndex: null,
      inlineComment: comment,
    })
    outOfScopeInlineComments.push(comment)
    recordSkippedInlineReason(skippedInlineReasons, 'out_of_scope_file')
  }

  for (const comment of scopeGuard.inlineComments) {
    if (memoryAnchorKeys.has(buildInlineCommentAnchorKey(comment.file, comment.line))) {
      recordSkippedInlineReason(skippedInlineReasons, 'suppressed_by_memory')
      continue
    }

    const body = formatCommentBody(comment)
    const fingerprint = buildInlineThreadFingerprint(comment.file, comment.line, body)

    if (suppressExistingThread(fingerprint, true)) {
      continue
    }

    const inlineCommentIndex = inlineComments.length
    inlineComments.push(comment)

    const fileMap = params.diffMap.get(comment.file)
    if (!fileMap) {
      const skipped = { comment, reason: 'file_not_in_diff' as const }
      const draft = buildSkippedInlineDiscussionDraft(skipped)
      skippedInlineComments.push(skipped)
      skippedInlineDiscussionDrafts.push({
        ...draft,
        inlineCommentIndex,
        inlineComment: comment,
      })
      recordSkippedInlineReason(skippedInlineReasons, 'file_not_in_diff')
      continue
    }

    const position = lookupPosition(params.diffMap, comment.file, comment.line)

    if (!position) {
      const skipped = { comment, reason: 'line_not_in_diff' as const }
      const draft = buildSkippedInlineDiscussionDraft(skipped)
      skippedInlineComments.push(skipped)
      skippedInlineDiscussionDrafts.push({
        ...draft,
        inlineCommentIndex,
        inlineComment: comment,
      })
      recordSkippedInlineReason(skippedInlineReasons, 'line_not_in_diff')
      continue
    }

    inlineDrafts.push({
      inlineCommentIndex,
      comment,
      fingerprint,
      body,
      markedBody: appendInlineMarkers(body, params.input.reviewRunId, comment.file, comment.line),
      position: {
        position_type: 'text',
        base_sha: params.diffRefs.base_sha,
        head_sha: params.diffRefs.head_sha,
        start_sha: params.diffRefs.start_sha,
        old_path: comment.file,
        new_path: comment.file,
        ...position,
      },
    })
    anchoredInlineCommentKeys.add(buildInlineCommentAnchorKey(comment.file, comment.line))
  }

  const findings = scopeGuard.findings.filter((finding) => {
    const fingerprint = buildSummaryFindingThreadFingerprint(finding.id)
    if (!suppressExistingThread(fingerprint, false)) {
      return true
    }
    return false
  })

  const outOfScopeFindings = scopeGuard.outOfScopeFindings.filter((finding) => {
    const fingerprint = buildSummaryFindingThreadFingerprint(finding.id)
    if (!suppressExistingThread(fingerprint, false)) {
      return true
    }
    return false
  })

  const findingDiscussions: PlannedFindingDiscussion[] = [
    ...skippedInlineDiscussionDrafts.map((draft) => ({
      ...draft,
      markedBody: markFindingDiscussion(draft, params.input.reviewRunId),
      findingIndex: null,
      finding: null,
      inlineCommentIndex: draft.inlineCommentIndex,
    })),
    ...(params.input.featureFlags.structuredFindingsPost
      ? findings.flatMap((finding, index) => {
          if (!shouldPostFindingAsDiscussion(finding, anchoredInlineCommentKeys)) {
            return []
          }

          const draft = buildFindingDiscussionDraft(finding)
          return [
            {
              ...draft,
              markedBody: markFindingDiscussion(draft, params.input.reviewRunId),
              findingIndex: index,
              inlineCommentIndex: null,
              finding,
              inlineComment: null,
            },
          ]
        })
      : []),
    ...(params.input.featureFlags.structuredFindingsPost
      ? outOfScopeFindings.map((finding) => {
          const draft = buildFindingDiscussionDraft(finding)
          return {
            ...draft,
            markedBody: markFindingDiscussion(draft, params.input.reviewRunId),
            findingIndex: null,
            inlineCommentIndex: null,
            finding,
            inlineComment: null,
          }
        })
      : []),
  ]

  const findingsForSummary = params.input.featureFlags.structuredFindingsPost
    ? findings.filter(
        (finding) => !shouldPostFindingAsDiscussion(finding, anchoredInlineCommentKeys),
      )
    : []
  const summaryBody = formatSummaryNote(
    params.reviewNumber,
    params.input.assessment,
    params.input.summary,
    findingsForSummary,
    inlineDrafts.length,
    findingDiscussions.length,
    [],
  )
  const resolutionPlan = params.previousContext
    ? planThreadResolutions({
        commitSha: params.input.commitSha,
        verdicts: params.input.resolutionVerdicts,
        findings: params.previousContext.findings,
        inlineComments: params.previousContext.inlineComments,
      })
    : { resolutions: [], unmatchedVerdictCount: 0 }

  return {
    input: params.input,
    findings,
    inlineComments,
    outOfScopeFindings,
    outOfScopeInlineComments,
    inlineDrafts,
    findingDiscussions,
    skippedInlineComments,
    summaryBody,
    markedSummaryBody: appendSummaryMarkers(summaryBody, params.input.reviewRunId),
    reviewNumber: params.reviewNumber,
    diagnostics: {
      findingsCount: findings.length,
      outOfScopeFindingCount: outOfScopeFindings.length,
      inlineCommentCount: inlineComments.length,
      outOfScopeInlineCount: outOfScopeInlineComments.length,
      postedInlineCount: inlineDrafts.length,
      skippedInlineReasons,
      dedupedExistingThreadCount,
      suppressedResolvedThreadCount,
    },
    threadResolutions: resolutionPlan.resolutions,
    unmatchedVerdictCount: resolutionPlan.unmatchedVerdictCount,
  }
}

export const renderPostPlanDryRun = (plan: PostPlan): void => {
  for (const draft of plan.inlineDrafts) {
    console.log(`[post/dry-run] draft note on ${draft.comment.file}:${draft.comment.line}`)
    console.log(`[post/dry-run] position: ${JSON.stringify(draft.position)}`)
    console.log(`[post/dry-run] body:\n${draft.markedBody}\n`)
  }

  console.log(`[post/dry-run] summary note:\n${plan.markedSummaryBody}\n`)
  if (plan.inlineDrafts.length > 0) {
    console.log(`[post/dry-run] would publish ${plan.inlineDrafts.length} inline draft notes`)
  }

  for (const draft of plan.findingDiscussions) {
    console.log(`[post/dry-run] summary finding discussion ${draft.previousFindingId}`)
    console.log(`[post/dry-run] body:\n${draft.markedBody}\n`)
  }

  for (const resolution of plan.threadResolutions) {
    console.log(
      `[post/dry-run] would reply to discussion ${resolution.discussionId}: ${resolution.replyBody}`,
    )
    if (resolution.markResolved) {
      console.log(`[post/dry-run] would resolve discussion ${resolution.discussionId}`)
    }
  }
}
