import type { ReviewOutputV2 } from '@/mastra/review/schema'
import type { PreviousReviewContext } from '@/mastra/review/previous-context'

const isRequiredFinding = (finding: ReviewOutputV2['findings'][number]): boolean =>
  finding.actionability === 'required' && finding.severity !== 'suggestion'

const isRequiredInlineComment = (comment: ReviewOutputV2['inlineComments'][number]): boolean =>
  comment.severity !== 'suggestion'

const isUnresolvedVerdict = (verdict: ReviewOutputV2['resolutionVerdicts'][number]): boolean =>
  verdict.status !== 'fixed'

export const collectExpectedPriorBlockerIds = (
  context: Pick<PreviousReviewContext, 'findings' | 'inlineComments'> | null,
): string[] => {
  if (!context) {
    return []
  }

  const findingIds = context.findings
    .filter(
      (finding) =>
        finding.discussionId !== null && !finding.resolved && finding.severity !== 'suggestion',
    )
    .map((finding) => finding.id)
  const inlineCommentIds = context.inlineComments
    .filter(
      (comment) =>
        comment.discussionId !== null && !comment.resolved && comment.severity !== 'suggestion',
    )
    .map((comment) => `${comment.file}:${comment.line}`)

  return [...new Set([...findingIds, ...inlineCommentIds])]
}

const buildFilteredSummary = (
  blockingFindingCount: number,
  unresolvedVerdictCount: number,
  assessment: ReviewOutputV2['assessment'],
): string => {
  if (blockingFindingCount > 0 && unresolvedVerdictCount > 0) {
    return `Review found ${blockingFindingCount} new release- or development-blocking ${blockingFindingCount === 1 ? 'defect' : 'defects'}, and ${unresolvedVerdictCount} previous ${unresolvedVerdictCount === 1 ? 'blocker remains' : 'blockers remain'} unresolved.`
  }

  if (blockingFindingCount > 0) {
    return `Review found ${blockingFindingCount} release- or development-blocking ${blockingFindingCount === 1 ? 'defect' : 'defects'}.`
  }

  if (unresolvedVerdictCount > 0) {
    return `${unresolvedVerdictCount} previous release- or development-blocking ${unresolvedVerdictCount === 1 ? 'defect remains' : 'defects remain'} unresolved.`
  }

  return assessment === 'needs_discussion'
    ? 'Review requires discussion; no release- or development-blocking defects were retained.'
    : 'No release- or development-blocking defects found.'
}

export const applyBlockingReviewPolicy = (
  output: ReviewOutputV2,
  expectedPriorBlockerIds: readonly string[] = [],
): ReviewOutputV2 => {
  const findings = output.findings.filter(isRequiredFinding)
  const inlineComments = output.inlineComments.filter(isRequiredInlineComment)
  const verdictsByPriorBlockerId = new Map<string, ReviewOutputV2['resolutionVerdicts'][number][]>()
  const expectedPriorBlockerIdSet = new Set(expectedPriorBlockerIds)

  for (const verdict of output.resolutionVerdicts) {
    if (!expectedPriorBlockerIdSet.has(verdict.previousFindingId)) {
      continue
    }

    const verdicts = verdictsByPriorBlockerId.get(verdict.previousFindingId) ?? []
    verdicts.push(verdict)
    verdictsByPriorBlockerId.set(verdict.previousFindingId, verdicts)
  }

  let unresolvedPriorBlockerCount = 0
  for (const id of expectedPriorBlockerIdSet) {
    const verdicts = verdictsByPriorBlockerId.get(id) ?? []
    if (verdicts.length === 0 || verdicts.some(isUnresolvedVerdict)) {
      unresolvedPriorBlockerCount += 1
    }
  }
  const blockingFindingCount = findings.length + inlineComments.length
  const hasBlockingDefect = blockingFindingCount > 0 || unresolvedPriorBlockerCount > 0
  const assessment = hasBlockingDefect
    ? ('request_changes' as const)
    : output.assessment === 'needs_discussion'
      ? ('needs_discussion' as const)
      : ('approve' as const)
  const summary = buildFilteredSummary(
    blockingFindingCount,
    unresolvedPriorBlockerCount,
    assessment,
  )

  return { ...output, assessment, summary, findings, inlineComments }
}
