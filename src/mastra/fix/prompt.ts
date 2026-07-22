import type { ReviewFindingRecord } from '@/db/review-findings'

export interface FixerPromptInput {
  projectKey: string
  mrIid: number
  acceptedFindings: ReviewFindingRecord[]
  contextFindings: ReviewFindingRecord[]
  checks: string[]
}

const metadataText = (metadata: unknown): string => {
  if (metadata === null || metadata === undefined) {
    return 'none'
  }

  return JSON.stringify(metadata)
}

const renderFinding = (finding: ReviewFindingRecord): string =>
  [
    `- id: ${finding.id}`,
    `  state: ${finding.state}`,
    `  threadId: ${finding.threadId}`,
    `  providerThreadId: ${finding.providerThreadId}`,
    `  decisionReason: ${finding.decisionReason ?? 'none'}`,
    `  metadata: ${metadataText(finding.metadata)}`,
  ].join('\n')

const renderFindings = (findings: ReviewFindingRecord[]): string =>
  findings.length === 0 ? '- none' : findings.map(renderFinding).join('\n')

const renderChecks = (checks: string[]): string =>
  checks.length === 0
    ? '- No configured checks.'
    : checks.map((command) => `- ${command}`).join('\n')

export const buildFixerInstructions = (): string =>
  [
    'You are Mend fixer agent.',
    'Fix only the findings listed as work items.',
    'Do not fix rejected, deferred, resolved, fixed, or not_fixed findings unless they are necessary context for a listed work item.',
    'Keep changes minimal and directly tied to listed findings.',
    'Run the configured checks before final output unless a check is impossible; report skipped checks with a reason.',
    'Return one final JSON object matching the requested fixer schema.',
  ].join('\n')

export const buildFixerPrompt = (input: FixerPromptInput): string =>
  [
    `Project: ${input.projectKey}`,
    `Merge request: !${input.mrIid}`,
    '',
    'Findings to fix:',
    renderFindings(input.acceptedFindings),
    '',
    'Context findings only. Do not fix these as work items:',
    renderFindings(input.contextFindings),
    '',
    'Configured checks to run:',
    renderChecks(input.checks),
    '',
    'Final output schema:',
    JSON.stringify(
      {
        version: 'fixer-v1',
        summary: 'Brief summary of what changed.',
        fixedFindings: [{ id: 'finding-id', summary: 'What fixed it.' }],
        notFixedFindings: [{ id: 'finding-id', reason: 'Why it was not fixed.' }],
        changedFiles: ['path/to/file.ts'],
        checksRun: [{ command: 'bun test', status: 'passed', summary: 'Result summary.' }],
        errors: ['optional error details'],
      },
      null,
      2,
    ),
  ].join('\n')
