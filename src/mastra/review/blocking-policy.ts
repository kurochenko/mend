import type { ReviewOutputV2 } from '@/mastra/review/schema'

const isRequiredFinding = (finding: ReviewOutputV2['findings'][number]): boolean =>
  finding.actionability === 'required' && finding.severity !== 'suggestion'

const isRequiredInlineComment = (comment: ReviewOutputV2['inlineComments'][number]): boolean =>
  comment.severity !== 'suggestion'

const isUnresolvedVerdict = (verdict: ReviewOutputV2['resolutionVerdicts'][number]): boolean =>
  verdict.status !== 'fixed'

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

export const applyBlockingReviewPolicy = (output: ReviewOutputV2): ReviewOutputV2 => {
  const findings = output.findings.filter(isRequiredFinding)
  const inlineComments = output.inlineComments.filter(isRequiredInlineComment)
  const unresolvedVerdicts = output.resolutionVerdicts.filter(isUnresolvedVerdict)
  const blockingFindingCount = findings.length + inlineComments.length
  const hasBlockingDefect = blockingFindingCount > 0 || unresolvedVerdicts.length > 0
  const assessment = hasBlockingDefect
    ? ('request_changes' as const)
    : output.assessment === 'needs_discussion'
      ? ('needs_discussion' as const)
      : ('approve' as const)
  const summary = buildFilteredSummary(blockingFindingCount, unresolvedVerdicts.length, assessment)

  return { ...output, assessment, summary, findings, inlineComments }
}
