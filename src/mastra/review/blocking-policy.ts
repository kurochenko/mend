import type { ReviewOutputV2 } from '@/mastra/review/schema'
import type { PreviousReviewContext } from '@/mastra/review/previous-context'

const isRequiredFinding = (finding: ReviewOutputV2['findings'][number]): boolean =>
  finding.actionability === 'required' && finding.severity !== 'suggestion'

const isRequiredInlineComment = (comment: ReviewOutputV2['inlineComments'][number]): boolean =>
  comment.severity !== 'suggestion'

const isUnresolvedVerdict = (verdict: ReviewOutputV2['resolutionVerdicts'][number]): boolean =>
  verdict.status !== 'fixed'

const normalizeExpectedVerdicts = (
  verdicts: ReviewOutputV2['resolutionVerdicts'],
  expectedPriorBlockerIds: ReadonlySet<string>,
): { resolutionVerdicts: ReviewOutputV2['resolutionVerdicts']; unresolvedCount: number } => {
  const verdictsByPriorBlockerId = new Map<string, ReviewOutputV2['resolutionVerdicts'][number][]>()
  for (const verdict of verdicts) {
    if (!expectedPriorBlockerIds.has(verdict.previousFindingId)) {
      continue
    }
    const matchingVerdicts = verdictsByPriorBlockerId.get(verdict.previousFindingId) ?? []
    matchingVerdicts.push(verdict)
    verdictsByPriorBlockerId.set(verdict.previousFindingId, matchingVerdicts)
  }

  let unresolvedCount = 0
  const resolutionVerdicts: ReviewOutputV2['resolutionVerdicts'] = []
  for (const id of expectedPriorBlockerIds) {
    const matchingVerdicts = verdictsByPriorBlockerId.get(id) ?? []
    const normalizedVerdict = matchingVerdicts.find(isUnresolvedVerdict) ?? matchingVerdicts[0]
    if (normalizedVerdict) {
      resolutionVerdicts.push(normalizedVerdict)
    }
    if (!normalizedVerdict || isUnresolvedVerdict(normalizedVerdict)) {
      unresolvedCount += 1
    }
  }

  return { resolutionVerdicts, unresolvedCount }
}

export const collectExpectedPriorBlockerIds = (
  context: Pick<PreviousReviewContext, 'findings' | 'inlineComments'> | null,
): string[] => {
  if (!context) {
    return []
  }

  const findingIds = context.findings
    .filter(
      (finding) =>
        finding.identity !== null &&
        !finding.resolved &&
        finding.actionability === 'required' &&
        finding.severity !== 'suggestion',
    )
    .flatMap((finding) => (finding.identity ? [finding.identity] : []))
  const inlineCommentIds = context.inlineComments
    .filter(
      (comment) =>
        comment.identity !== null &&
        !comment.resolved &&
        comment.actionability === 'required' &&
        comment.severity !== 'suggestion',
    )
    .flatMap((comment) => (comment.identity ? [comment.identity] : []))

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
  const expectedPriorBlockerIdSet = new Set(expectedPriorBlockerIds)
  const normalizedVerdicts = normalizeExpectedVerdicts(
    output.resolutionVerdicts,
    expectedPriorBlockerIdSet,
  )
  const unresolvedPriorBlockerCount = normalizedVerdicts.unresolvedCount
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

  return {
    ...output,
    assessment,
    summary,
    findings,
    inlineComments,
    resolutionVerdicts: normalizedVerdicts.resolutionVerdicts,
  }
}
