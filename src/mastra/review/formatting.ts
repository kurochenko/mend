import type { ReviewFinding, ReviewInlineComment } from '@/mastra/review/schema'

const SEVERITY_PREFIX: Record<ReviewInlineComment['severity'], string> = {
  bug: ':bug: **Bug:**',
  security: ':lock: **Security:**',
  performance: ':zap: **Performance:**',
  suggestion: ':bulb: **Suggestion:**',
}

const FINDING_CATEGORY_TITLE: Record<ReviewFinding['category'], string> = {
  correctness: 'Correctness',
  architecture: 'Architecture',
  duplication: 'Duplication',
  convention: 'Conventions',
  dead_code: 'Dead Code',
  performance: 'Performance',
  security: 'Security',
  testing: 'Testing',
}

const ACTIONABILITY_LABEL: Record<ReviewFinding['actionability'], string> = {
  required: 'Required',
  recommended: 'Recommended',
  optional: 'Optional',
}

const CATEGORY_ORDER: ReviewFinding['category'][] = [
  'correctness',
  'security',
  'performance',
  'architecture',
  'duplication',
  'convention',
  'dead_code',
  'testing',
]

export type SkippedInlineReason =
  | 'file_not_in_diff'
  | 'line_not_in_diff'
  | 'out_of_scope_file'
  | 'resolved_thread'
  | 'suppressed_by_memory'

export interface SkippedInlineComment {
  comment: ReviewInlineComment
  reason: SkippedInlineReason
}

const formatSuggestionBlock = (suggestion: string): string => {
  const lines = suggestion.split('\n')
  const lineCount = lines.length
  const aboveCount = lineCount > 1 ? lineCount - 1 : 0
  const suggestionHeader = aboveCount > 0 ? `suggestion:-${aboveCount}+0` : 'suggestion'

  return `\n\n\`\`\`${suggestionHeader}\n${suggestion}\n\`\`\``
}

export const formatCommentBody = (comment: ReviewInlineComment): string => {
  const prefix = SEVERITY_PREFIX[comment.severity]
  let body = `${prefix} ${comment.body}`

  if (comment.suggestion) {
    body += formatSuggestionBlock(comment.suggestion)
  }

  return body
}

const formatFindingEvidence = (finding: ReviewFinding, prefix: string): string[] => {
  const lines: string[] = []

  for (const evidence of finding.evidence) {
    if (evidence.type === 'file_line') {
      const note = evidence.note ? ` — ${evidence.note}` : ''
      lines.push(`${prefix}evidence: \`${evidence.file}:${evidence.line}\`${note}`)
      continue
    }

    if (evidence.type === 'symbol') {
      lines.push(`${prefix}evidence: symbol \`${evidence.value}\``)
      continue
    }

    lines.push(`${prefix}evidence: \`${evidence.command}\` -> ${evidence.excerpt}`)
  }

  if (finding.files && finding.files.length > 0) {
    lines.push(`${prefix}files: ${finding.files.map((file) => `\`${file}\``).join(', ')}`)
  }

  return lines
}

export const formatFindingDiscussionBody = (finding: ReviewFinding): string => {
  const lines = [
    `${SEVERITY_PREFIX[finding.severity]} **${finding.title}** (${ACTIONABILITY_LABEL[finding.actionability]}, ${finding.scope.replace('_', ' ')})`,
    '',
    finding.body,
  ]

  const evidenceLines = formatFindingEvidence(finding, '- ')
  if (evidenceLines.length > 0) {
    lines.push('', ...evidenceLines)
  }

  return lines.join('\n')
}

export const formatSkippedReason = (reason: SkippedInlineReason): string =>
  reason === 'file_not_in_diff'
    ? 'file not present in diff'
    : reason === 'line_not_in_diff'
      ? 'line is not present in a diff hunk'
      : reason === 'out_of_scope_file'
        ? 'file is outside current MR diff scope'
        : reason === 'resolved_thread'
          ? 'matching review thread was already resolved'
          : 'suppressed by active review memory'

export const formatSkippedInlineCommentDiscussionBody = (skipped: SkippedInlineComment): string => {
  const lines = [
    `${SEVERITY_PREFIX[skipped.comment.severity]} ${skipped.comment.body}`,
    '',
    `- source: \`${skipped.comment.file}:${skipped.comment.line}\``,
    `- reason: ${formatSkippedReason(skipped.reason)}`,
  ]

  if (skipped.comment.suggestion) {
    lines.push(formatSuggestionBlock(skipped.comment.suggestion).trimStart())
  }

  return lines.join('\n')
}

export const formatFindingsSection = (findings: ReviewFinding[]): string => {
  if (findings.length === 0) {
    return '### Structured Findings\n\nNo high-level findings.'
  }

  const grouped = new Map<ReviewFinding['category'], ReviewFinding[]>()
  for (const finding of findings) {
    const current = grouped.get(finding.category)
    if (current) {
      current.push(finding)
    } else {
      grouped.set(finding.category, [finding])
    }
  }

  const lines: string[] = ['### Structured Findings', '']

  for (const category of CATEGORY_ORDER) {
    const categoryFindings = grouped.get(category)
    if (!categoryFindings || categoryFindings.length === 0) {
      continue
    }

    lines.push(`#### ${FINDING_CATEGORY_TITLE[category]}`)
    lines.push('')

    for (const finding of categoryFindings) {
      lines.push(
        `- ${SEVERITY_PREFIX[finding.severity]} **${finding.title}** (${ACTIONABILITY_LABEL[finding.actionability]}, ${finding.scope.replace('_', ' ')})`,
      )
      lines.push(`  - ${finding.body}`)
      lines.push(...formatFindingEvidence(finding, '  - '))
    }

    lines.push('')
  }

  return lines.join('\n').trim()
}

export const formatSummaryNote = (
  reviewNumber: number,
  assessment: 'approve' | 'request_changes' | 'needs_discussion',
  summary: string,
  findings: ReviewFinding[],
  inlineCount: number,
  findingDiscussionCount: number,
  skippedComments: SkippedInlineComment[],
): string => {
  const assessmentEmoji =
    assessment === 'approve'
      ? ':white_check_mark:'
      : assessment === 'request_changes'
        ? ':warning:'
        : ':speech_balloon:'

  let note = `## Mend Review #${reviewNumber}\n\n${assessmentEmoji} **${assessment.replace('_', ' ')}**\n\n${summary}`

  note += `\n\n${formatFindingsSection(findings)}`

  if (inlineCount > 0) {
    note += `\n\n${inlineCount} inline comment${inlineCount === 1 ? '' : 's'} posted.`
  }

  if (findingDiscussionCount > 0) {
    note += `\n\n${findingDiscussionCount} additional discussion thread${findingDiscussionCount === 1 ? '' : 's'} posted.`
  }

  if (skippedComments.length > 0) {
    note +=
      '\n\n### Skipped Inline Comments\n\nThe following inline comments could not be positioned:\n'
    for (const skipped of skippedComments) {
      const prefix = SEVERITY_PREFIX[skipped.comment.severity]
      note += `\n- **${skipped.comment.file}:${skipped.comment.line}** — ${formatSkippedReason(skipped.reason)} — ${prefix} ${skipped.comment.body}`
    }
  }

  return note
}
