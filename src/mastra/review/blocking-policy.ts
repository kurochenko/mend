import type { ReviewOutputV2 } from '@/mastra/review/schema'

const isRequiredFinding = (finding: ReviewOutputV2['findings'][number]): boolean =>
  finding.actionability === 'required' && finding.severity !== 'suggestion'

const isRequiredInlineComment = (comment: ReviewOutputV2['inlineComments'][number]): boolean =>
  comment.severity !== 'suggestion'

export const applyBlockingReviewPolicy = (output: ReviewOutputV2): ReviewOutputV2 => {
  const findings = output.findings.filter(isRequiredFinding)
  const inlineComments = output.inlineComments.filter(isRequiredInlineComment)
  const hasBlockingFinding = findings.length > 0 || inlineComments.length > 0
  const assessment = hasBlockingFinding
    ? ('request_changes' as const)
    : output.assessment === 'needs_discussion'
      ? ('needs_discussion' as const)
      : ('approve' as const)

  return { ...output, assessment, findings, inlineComments }
}
