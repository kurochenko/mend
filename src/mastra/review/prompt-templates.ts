import type {
  PreviousReviewContext,
  PreviousFinding,
  PreviousInlineComment,
} from '@/mastra/review/previous-context'
import type { ReviewContextPackage } from '@/mastra/review/context-package'
import { renderStructuralSignals } from '@/mastra/review/structural-signals'
import type { StructuralSignals } from '@/mastra/review/structural-signals'

const PREVIOUS_ITEMS_DETAIL_LIMIT = 20

const HIGH_PRIORITY_SEVERITIES = new Set(['bug', 'security'])

interface SystemPromptInput {
  mrIid: number
  title: string
  description: string
  sourceBranch: string
  targetBranch: string
  url: string
  reviewMode: 'initial' | 'update'
  diffBaseRef: string
  previousReviewedSha: string | null
  contextPackage: ReviewContextPackage
  structuralSignals?: StructuralSignals | null
  previousReviewContext?: PreviousReviewContext | null
  memorySections?: string[]
}

const isHighPriorityFinding = (f: PreviousFinding): boolean =>
  HIGH_PRIORITY_SEVERITIES.has(f.severity)

const formatFindingDetailed = (f: PreviousFinding): string =>
  [
    `- **[${f.identity ?? f.id}]** (${f.category} / ${f.severity} / ${f.actionability}) ${f.title}`,
    `  ${f.body}`,
    f.files.length > 0 ? `  Files: ${f.files.join(', ')}` : null,
    `  Status: ${f.discussionId ? (f.resolved ? 'resolved on the code host' : 'open on the code host') : 'not tracked on the code host'}`,
  ]
    .filter(Boolean)
    .join('\n')

const formatFindingSummary = (f: PreviousFinding): string =>
  `- **[${f.identity ?? f.id}]** (${f.severity} / ${f.actionability}) ${f.title} — ${f.discussionId ? (f.resolved ? 'resolved' : 'open') : 'not tracked'}`

const formatInlineDetailed = (c: PreviousInlineComment): string =>
  [
    `- **[${c.identity ?? `${c.file}:${c.line}`}]** ${c.file}:${c.line}`,
    `  ${c.body}`,
    `  Status: ${c.resolved ? 'resolved on the code host' : 'unresolved'}`,
  ].join('\n')

const formatInlineSummary = (c: PreviousInlineComment): string =>
  `- **[${c.identity ?? `${c.file}:${c.line}`}]** ${c.file}:${c.line} — ${c.resolved ? 'resolved' : 'unresolved'}`

const buildPreviousContextSections = (ctx: PreviousReviewContext): string[] => {
  const totalItems = ctx.findings.length + ctx.inlineComments.length
  const needsSummarization = totalItems > PREVIOUS_ITEMS_DETAIL_LIMIT

  const sections: string[] = []

  if (ctx.findings.length > 0) {
    const lines: string[] = ['## Previous Review Findings', '']
    if (needsSummarization) {
      const highPriority = ctx.findings.filter(isHighPriorityFinding)
      const lowPriority = ctx.findings.filter((f) => !isHighPriorityFinding(f))
      for (const f of highPriority) {
        lines.push(formatFindingDetailed(f))
      }
      if (lowPriority.length > 0) {
        lines.push('')
        lines.push('Lower-severity findings (summarized):')
        for (const f of lowPriority) {
          lines.push(formatFindingSummary(f))
        }
      }
    } else {
      for (const f of ctx.findings) {
        lines.push(formatFindingDetailed(f))
      }
    }
    sections.push(lines.join('\n'))
  }

  if (ctx.inlineComments.length > 0) {
    const lines: string[] = ['## Previous Inline Comments', '']
    if (needsSummarization) {
      for (const c of ctx.inlineComments) {
        lines.push(formatInlineSummary(c))
      }
    } else {
      for (const c of ctx.inlineComments) {
        lines.push(formatInlineDetailed(c))
      }
    }
    sections.push(lines.join('\n'))
  }

  return sections
}

export const RESOLUTION_INSTRUCTIONS = [
  '## Resolution Verification',
  '',
  'For each open required previous blocker tracked on the code host:',
  '- Check whether the current changes address the concern',
  '- Include a resolutionVerdicts array in your output',
  '- Set previousFindingId to the exact typed identity shown in square brackets (for example, "inline:discussion-42" or "finding:discussion-84")',
  '- Use status "fixed" only when the code change clearly addresses the concern',
  '- Use "not_fixed" when the issue persists unchanged',
  '- Use "partially_fixed" when the fix is incomplete',
  '- Use "cannot_determine" when the code changed too much to tell',
  '- Do not include resolved, recommended, optional, or untracked previous content in resolutionVerdicts',
  '- Do not let resolution checking distract from reviewing new changes — new issues take priority',
].join('\n')

export const FINDER_PREVIOUS_FINDINGS_GUIDANCE = [
  '## Previous Findings Guidance',
  '',
  'Findings in Previous Review Findings or Previous Inline Comments that are marked resolved are settled decisions. Do not report the same underlying concern again, even if the code moved to another file or line.',
  'Unresolved previous findings are tracked elsewhere. Do not duplicate them. Focus on genuinely new issues.',
].join('\n')

const buildChangedFilesSection = (contextPackage: ReviewContextPackage): string => {
  const statsByFile = new Map(
    contextPackage.fileStats.map((stat) => [stat.file, `(+${stat.added}/-${stat.deleted})`]),
  )

  const lines =
    contextPackage.changedFiles.length > 0
      ? contextPackage.changedFiles.map((file) => `- ${file} ${statsByFile.get(file) ?? '(+0/-0)'}`)
      : ['(none)']

  return ['## Changed files', '', ...lines].join('\n')
}

const pushBudgetedLine = (lines: string[], line: string, maxChars: number): boolean => {
  const next = [...lines, line].join('\n')
  if (next.length > maxChars) {
    return false
  }
  lines.push(line)
  return true
}

const buildChangedSymbolCallersSection = (
  contextPackage: ReviewContextPackage,
  maxChars = 3_000,
): string | null => {
  if (contextPackage.changedSymbolCallers.length === 0) {
    return null
  }

  const lines = ['## Changed-symbol callers', '']
  for (const caller of contextPackage.changedSymbolCallers) {
    const sites = caller.sites.map((site) => `${site.file}:${site.line}`).join(', ')
    const suffix = caller.hiddenSiteCount > 0 ? ` (+${caller.hiddenSiteCount} more)` : ''
    const line = `- ${caller.symbol} — used by: ${sites}${suffix}`
    if (!pushBudgetedLine(lines, line, maxChars)) {
      break
    }
  }

  return lines.length > 2 ? lines.join('\n') : null
}

const hasTestsTouchingChangedCode = (
  tests: ReviewContextPackage['testsTouchingChangedCode'],
): boolean =>
  Boolean(
    tests &&
      (tests.testReferences.length > 0 || tests.changedFilesWithoutTestReferences.length > 0),
  )

const pushChangedFilesWithoutTestReferences = (
  lines: string[],
  files: string[],
  maxChars: number,
): void => {
  if (files.length === 0) {
    return
  }
  if (!pushBudgetedLine(lines, 'Changed files with no test references:', maxChars)) {
    return
  }
  for (const file of files) {
    if (!pushBudgetedLine(lines, `- ${file}`, maxChars)) {
      return
    }
  }
}

const buildTestsTouchingChangedCodeSection = (
  contextPackage: ReviewContextPackage,
  maxChars = 1_500,
): string | null => {
  const tests = contextPackage.testsTouchingChangedCode
  if (!hasTestsTouchingChangedCode(tests) || !tests) {
    return null
  }

  const lines = ['## Tests touching changed code', '']
  for (const reference of tests.testReferences) {
    const line = `- ${reference.testFile} — references: ${reference.references.join(', ')}`
    if (!pushBudgetedLine(lines, line, maxChars)) {
      return lines.length > 2 ? lines.join('\n') : null
    }
  }
  pushChangedFilesWithoutTestReferences(lines, tests.changedFilesWithoutTestReferences, maxChars)

  return lines.length > 2 ? lines.join('\n') : null
}

const buildDiffSection = (contextPackage: ReviewContextPackage): string => {
  const lines = [
    '## Diff',
    '',
    'The diff below is authoritative for what changed. You must still open surrounding source for context before reporting findings.',
  ]

  if (contextPackage.diffTruncated) {
    const incompleteFiles =
      contextPackage.diffIncompleteFiles.length > 0
        ? contextPackage.diffIncompleteFiles.join(', ')
        : '(unknown)'
    lines.push(
      `diff truncated; inspect the remaining files with tools. Files not fully included: ${incompleteFiles}`,
    )
  }

  lines.push('', '```diff', contextPackage.diffExcerpt || '(empty diff)', '```')

  return lines.join('\n')
}

const getPreviousContext = (input: SystemPromptInput): PreviousReviewContext | null => {
  const previousContext = input.previousReviewContext ?? null
  if (
    !previousContext ||
    (previousContext.findings.length === 0 && previousContext.inlineComments.length === 0)
  ) {
    return null
  }

  return previousContext
}

const buildReviewScopeLine = (input: SystemPromptInput): string =>
  input.reviewMode === 'update'
    ? `Review mode: consecutive update. Verify all files changed since previous reviewed SHA ${input.previousReviewedSha ?? '(unknown)'} using diff ${input.diffBaseRef}...HEAD.`
    : `Review mode: initial. Verify all files changed in this MR scope using diff ${input.diffBaseRef}...HEAD.`

const buildScopeAnchoringLine = (reviewMode: SystemPromptInput['reviewMode']): string => {
  const scopeAnchoringLines = [
    '- Use MR description and linked task context as the requirement scope',
  ]
  if (reviewMode === 'update') {
    scopeAnchoringLines.push(
      '- In update reviews, verify each previous finding and answer via the resolutionVerdicts array; do not re-post previous findings as new findings.',
    )
  }

  return scopeAnchoringLines.join('\n')
}

const buildResolutionVerdictSchema = (hasPreviousContext: boolean): string | null =>
  hasPreviousContext
    ? [
        '  "resolutionVerdicts": [',
        '    {',
        '      "previousFindingId": "id-from-previous-review",',
        '      "status": "fixed" | "not_fixed" | "partially_fixed" | "cannot_determine",',
        '      "explanation": "Why this status was chosen"',
        '    }',
        '  ],',
      ].join('\n')
    : null

const buildOutputSchemaSection = (resolutionVerdictSchema: string | null): string[] => [
  'Your final output MUST be a JSON object matching this exact schema:',
  '```json',
  '{',
  '  "version": "v2",',
  '  "assessment": "approve" | "request_changes" | "needs_discussion",',
  '  "summary": "Overall review summary",',
  '  "findings": [',
  '    {',
  '      "id": "short-stable-id",',
  '      "category": "correctness" | "architecture" | "duplication" | "convention" | "dead_code" | "performance" | "security" | "testing",',
  '      "severity": "bug" | "security" | "performance" | "suggestion",',
  '      "actionability": "required" | "recommended" | "optional",',
  '      "scope": "single_file" | "cross_file" | "project",',
  '      "title": "Finding title",',
  '      "body": "Detailed finding",',
  '      "files": ["relative/path"],',
  '      "evidence": [',
  '        { "type": "file_line", "file": "relative/path", "line": 42, "note": "optional" },',
  '        { "type": "symbol", "value": "SymbolName" },',
  '        { "type": "command_output", "command": "git diff ...", "excerpt": "key output" }',
  '      ]',
  '    }',
  '  ],',
  '  "inlineComments": [',
  '    {',
  '      "file": "relative/path/to/file.ts",',
  '      "line": 42,',
  '      "severity": "bug" | "security" | "performance" | "suggestion",',
  '      "body": "Description of the issue",',
  '      "suggestion": "optional replacement code"',
  '    }',
  '  ],',
  ...(resolutionVerdictSchema ? [resolutionVerdictSchema] : []),
  '}',
  '```',
  'Output ONLY the JSON object as your final message, no other text around it.',
]

export const buildReviewSystemPrompt = (input: SystemPromptInput): string => {
  const previousContext = getPreviousContext(input)
  const previousContextSections = previousContext
    ? buildPreviousContextSections(previousContext)
    : []
  const structuralSignalsSection = renderStructuralSignals(input.structuralSignals)
  const scopeAnchoringLine = buildScopeAnchoringLine(input.reviewMode)
  const resolutionVerdictSchema = buildResolutionVerdictSchema(Boolean(previousContext))
  const changedSymbolCallersSection = buildChangedSymbolCallersSection(input.contextPackage)
  const testsTouchingChangedCodeSection = buildTestsTouchingChangedCodeSection(input.contextPackage)

  return [
    `Review MR !${input.mrIid}`,
    '',
    `Base ref: ${input.diffBaseRef}`,
    `Source branch: ${input.sourceBranch} -> ${input.targetBranch}`,
    `MR URL: ${input.url}`,
    `MR title: ${input.title}`,
    `MR description: ${input.description || '(none provided)'}`,
    '',
    buildReviewScopeLine(input),
    'Inspect the changed files that are most relevant to behavior, correctness, tests, and runtime/build/deploy impact before producing final output.',
    'Trace call graph and dependency direction across changed symbols/modules where relevant; flag newly introduced cycles, mutually recursive orchestration, or dependency direction inversions as architecture findings when they materially harm clarity, testability, or change safety.',
    'Use judgment on very large MRs: prioritize hand-written logic, tests, and behavior-shaping config over obvious tooling noise or generated artifacts.',
    '',
    buildChangedFilesSection(input.contextPackage),
    '',
    ...(changedSymbolCallersSection ? [changedSymbolCallersSection, ''] : []),
    ...(testsTouchingChangedCodeSection ? [testsTouchingChangedCodeSection, ''] : []),
    buildDiffSection(input.contextPackage),
    '',
    ...(structuralSignalsSection ? [structuralSignalsSection, ''] : []),
    ...(previousContextSections.length > 0
      ? [...previousContextSections, '', RESOLUTION_INSTRUCTIONS, '']
      : []),
    ...(input.memorySections && input.memorySections.length > 0
      ? [...input.memorySections, '']
      : []),
    'The `context7_lookup` tool is available to validate library/API usage against their documentation.',
    '',
    'Do NOT review or comment on:',
    '- Formatting, whitespace, and import ordering',
    '- Personal style preferences without practical impact',
    '- Code outside the change scope unless the MR clearly breaks it',
    '- Rewrite suggestions that do not solve a concrete problem',
    '- Optional hardening, cleanup, simplification, or generic best-practice recommendations',
    '- Transient inconsistencies or speculative edge cases outside realistic intended use',
    '- Theoretical performance, reliability, concurrency, or scalability risks without a concrete material failure',
    '',
    'Scope anchoring:',
    scopeAnchoringLine,
    '',
    'Finding eligibility gate:',
    '- Report an issue only when all three are established: a realistic trigger in intended or ordinary use, a concrete material consequence, and a proportionate remedy.',
    '- Material consequences include a broken core flow, security or authorization failure, data loss or corruption, an incorrect business outcome, payment failure, a crash, or a significant regression.',
    '- Missing safeguards qualify only when a dependency or service contract requires them, or ordinary usage makes the failure likely and material.',
    '- Apply this gate to every category. A safer design alone is not evidence of a defect.',
    '- Every new finding must be release- or development-blocking and use actionability "required". Do not emit "recommended" or "optional" findings.',
    '',
    'Be concise and high-signal. No low-value nits.',
    'The summary and all findings must describe only the changes visible in the diff. Files read for context are not part of this MR — do not report on them.',
    'It is valid to return zero findings when there are no actionable issues. Do not invent findings to satisfy categories.',
    'Do not report the same issue in both findings and inlineComments.',
    'If the issue can be anchored to a specific diff line, prefer inlineComments.',
    'inlineComments[].line is the NEW-file line number and must be a line added or changed in the diff shown above; if you cannot anchor a finding to a changed line, put it in findings instead.',
    'Use findings for issues that are broader than a single inline comment or cannot be represented inline.',
    'Before emitting a finding, re-read the exact lines you cite; every finding must include at least one file_line evidence entry whose note quotes the relevant code.',
    '',
    ...buildOutputSchemaSection(resolutionVerdictSchema),
  ].join('\n')
}

export const DEFAULT_REVIEW_USER_PROMPT = [
  'Focus areas:',
  '- correctness and regressions',
  '- design quality and decomposition, including mostly acyclic call/dependency flow',
  '- convention adherence (cite specific rules)',
  '- non-UI test gaps for non-trivial business/domain logic',
  '',
  'Across every focus area, report only realistic material defects that should block release or continued development.',
  'Omit theoretical risks, optional hardening, and best-practice improvements that do not have a concrete intended-use trigger and material consequence.',
  '',
  'Do not require or request UI/component tests.',
  'Do not suggest tests for thin wrappers around library APIs (e.g. query definitions, route configs, store setup).',
  'Read repository root AGENTS.md for project rules and cite exact violated rule when relevant.',
].join('\n')
