import { join } from 'node:path'
import { z } from 'zod'
import { invokeCodexReview } from '@/agents/codex-harness'
import type {
  ReviewAgentHarness,
  ReviewAgentHarnessId,
  ReviewAgentResult,
  ReviewAgentRunConfig,
  ReviewAgentThinkingLevel,
} from '@/agents/review-harness'
import { toErrorMessage } from '@/lib/errors'
import { extractJson } from '@/lib/json'
import {
  FINDER_PREVIOUS_FINDINGS_GUIDANCE,
  RESOLUTION_INSTRUCTIONS,
} from '@/mastra/review/prompt-templates'
import {
  parseReviewOutputV2,
  reviewEvidenceSchema,
  type ReviewFinding,
  type ReviewInlineComment,
  type ReviewOutputV2,
} from '@/mastra/review/schema'

export type EnsembleSubHarnessId = Exclude<ReviewAgentHarnessId, 'ensemble'>

export interface ReviewAgentEnsembleConfig {
  finder_harness: EnsembleSubHarnessId
  finder_model: string
  finder_thinking_level: ReviewAgentThinkingLevel
  finder_timeout_ms: number
  verify_enabled: boolean
  verifier_model: string
  verifier_thinking_level: ReviewAgentThinkingLevel
  verifier_timeout_ms: number
  deep_samples: number
  deep_model: string
  deep_timeout_ms: number
  synthesizer_model: string
  synthesizer_timeout_ms: number
}

export const defaultEnsembleConfig: ReviewAgentEnsembleConfig = {
  finder_harness: 'codex',
  finder_model: 'gpt-5.5',
  finder_thinking_level: 'low',
  finder_timeout_ms: 300_000,
  verify_enabled: true,
  verifier_model: 'gpt-5.5',
  verifier_thinking_level: 'low',
  verifier_timeout_ms: 180_000,
  deep_samples: 2,
  deep_model: 'gpt-5.5',
  deep_timeout_ms: 1_200_000,
  synthesizer_model: 'gpt-5.5',
  synthesizer_timeout_ms: 300_000,
}

const reviewCategorySchema = z.enum([
  'correctness',
  'architecture',
  'duplication',
  'convention',
  'dead_code',
  'performance',
  'security',
  'testing',
])

const reviewSeveritySchema = z.enum(['bug', 'security', 'performance', 'suggestion'])

const finderCandidateSchema = z
  .object({
    file: z.string().min(1).optional(),
    line: z.number().int().positive().optional(),
    category: reviewCategorySchema,
    severity: reviewSeveritySchema,
    title: z.string().min(1),
    body: z.string().min(1),
    evidence: z.array(reviewEvidenceSchema).default([]),
  })
  .strict()

const finderOutputSchema = z.object({
  candidates: z.array(finderCandidateSchema),
})

export type FinderCandidate = z.infer<typeof finderCandidateSchema>

export interface EnsembleCandidate extends FinderCandidate {
  provenance: string[]
  verification?: CandidateVerification
}

export interface CandidateVerification {
  verdict: VerificationVerdict
  reason: string
}

export interface VerificationStats {
  checked: number
  confirmed: number
  refuted: number
  uncertain: number
  skippedMultirole: number
}

export type VerificationVerdict = 'confirmed' | 'refuted' | 'uncertain'

export type FinderRoleId =
  | 'diff-correctness'
  | 'cross-file-impact'
  | 'tests-adequacy'
  | 'conventions-structure'
  | 'scenario-simulation'

interface FinderRole {
  id: FinderRoleId
  addendum: string
}

interface ChangedPromptFile {
  file: string
  added: number
  deleted: number
}

export interface FinderRoleShard {
  role: FinderRole
  assignedFiles: string[]
}

export const finderRoles: FinderRole[] = [
  {
    id: 'diff-correctness',
    addendum:
      'Focus exclusively on the diff hunks and their enclosing functions. Hunt logic bugs, edge cases, broken contracts, regressions.',
  },
  {
    id: 'cross-file-impact',
    addendum:
      'For each changed exported symbol, read its callers and callees across the repo. Hunt breaking changes, contract violations, missed call sites.',
  },
  {
    id: 'tests-adequacy',
    addendum:
      'Read the changed code and its tests and judge whether the amount of testing is proportionate to the behavior, in both directions. Hunt untested branches and bug-fixes lacking regression tests, AND flag over-testing per the Over-Testing Smells guidance (tests that guard nothing beyond a compile error, change-detector tests, scaffolding out of proportion, redundant cases). Do not request tests for trivially-correct code such as a useEffect that only wires a subscription or sets a title.',
  },
  {
    id: 'conventions-structure',
    addendum:
      "Check project conventions (instructions above) and the Structural signals section. Triage structural regressions worth human attention, and flag over-engineering per the Over-Engineering Smells guidance — abstraction, indirection, or configurability beyond the change's actual requirements — always naming the simpler construct that would suffice.",
  },
  {
    id: 'scenario-simulation',
    addendum:
      'Identify every state transition, retry loop, time/date boundary, timezone conversion, pagination cursor, and concurrency interaction this diff touches. For each, walk through 2-3 concrete executions step by step (specific inputs, specific clock times, repeated calls) and report where the traced behavior diverges from the intended behavior. Prefer boundary values: midnight crossings, empty sets, first/last items, repeated retries of the same operation, two actors acting at once.',
  },
]

const verificationOutputSchema = z
  .object({
    verdict: z.enum(['confirmed', 'refuted', 'uncertain']),
    reason: z.string().min(1),
  })
  .strict()

const fullSchemaStart = 'Your final output MUST be a JSON object matching this exact schema:'
const fullSchemaEnd = 'Output ONLY the JSON object as your final message, no other text around it.'

const reducedFinderSchemaSection = [
  'Your final output MUST be a JSON object matching this exact reduced finder schema:',
  '```json',
  '{',
  '  "candidates": [',
  '    {',
  '      "file": "relative/path optional",',
  '      "line": 42,',
  '      "category": "correctness" | "architecture" | "duplication" | "convention" | "dead_code" | "performance" | "security" | "testing",',
  '      "severity": "bug" | "security" | "performance" | "suggestion",',
  '      "title": "Candidate title",',
  '      "body": "Defensible issue description",',
  '      "evidence": [',
  '        { "type": "file_line", "file": "relative/path", "line": 42, "note": "optional" },',
  '        { "type": "symbol", "value": "SymbolName" },',
  '        { "type": "command_output", "command": "command", "excerpt": "key output" }',
  '      ]',
  '    }',
  '  ]',
  '}',
  '```',
  'Output ONLY the JSON object as your final message, no other text around it.',
].join('\n')

const replaceOutputSchemaSection = (instructions: string, replacement: string): string => {
  const start = instructions.indexOf(fullSchemaStart)
  if (start === -1) {
    return [instructions, replacement].join('\n\n')
  }

  const end = instructions.indexOf(fullSchemaEnd, start)
  if (end === -1) {
    return [instructions.slice(0, start).trimEnd(), replacement].join('\n\n')
  }

  const afterEnd = end + fullSchemaEnd.length
  return [instructions.slice(0, start).trimEnd(), replacement, instructions.slice(afterEnd).trim()]
    .filter(Boolean)
    .join('\n\n')
}

const extractOutputSchemaSection = (instructions: string): string => {
  const start = instructions.indexOf(fullSchemaStart)
  if (start === -1) {
    return ''
  }

  const end = instructions.indexOf(fullSchemaEnd, start)
  if (end === -1) {
    return instructions.slice(start).trim()
  }

  return instructions.slice(start, end + fullSchemaEnd.length).trim()
}

const stripOutputSchemaSection = (instructions: string): string =>
  replaceOutputSchemaSection(instructions, '').trim()

const sectionAfterHeading = (text: string, heading: string): string => {
  const headingIndex = text.indexOf(heading)
  if (headingIndex === -1) {
    return ''
  }
  const start = headingIndex + heading.length
  const nextHeading = text.indexOf('\n## ', start)
  return (nextHeading === -1 ? text.slice(start) : text.slice(start, nextHeading)).trim()
}

export const parseChangedFilesFromPrompt = (prompt: string): ChangedPromptFile[] =>
  sectionAfterHeading(prompt, '## Changed files')
    .split('\n')
    .map((line) => /^- (.+?) \(\+(\d+)\/-(\d+)\)$/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      file: match[1] ?? '',
      added: Number.parseInt(match[2] ?? '0', 10),
      deleted: Number.parseInt(match[3] ?? '0', 10),
    }))
    .filter((entry) => entry.file.length > 0)

const structuralSignalsSection = (prompt: string): string =>
  sectionAfterHeading(prompt, '## Structural signals')

export const rankChangedFilesForSharding = (
  files: ChangedPromptFile[],
  prompt: string,
): ChangedPromptFile[] => {
  const structuralSignals = structuralSignalsSection(prompt)
  return [...files].sort((left, right) => {
    const leftMentioned = structuralSignals.includes(left.file) ? 1 : 0
    const rightMentioned = structuralSignals.includes(right.file) ? 1 : 0
    return (
      rightMentioned - leftMentioned ||
      right.added + right.deleted - (left.added + left.deleted) ||
      left.file.localeCompare(right.file)
    )
  })
}

export const shardFinderRoles = (prompt: string, roles = finderRoles): FinderRoleShard[] => {
  const files = parseChangedFilesFromPrompt(prompt)
  if (files.length <= 30) {
    return roles.map((role) => ({ role, assignedFiles: [] }))
  }

  const shards = roles.map((role) => ({ role, assignedFiles: [] as string[] }))
  for (const [index, file] of rankChangedFilesForSharding(files, prompt).entries()) {
    const shard = shards[index % shards.length]
    if (shard) {
      shard.assignedFiles.push(file.file)
    }
  }
  return shards
}

const replaceResolutionInstructions = (instructions: string): string =>
  instructions
    .replace(RESOLUTION_INSTRUCTIONS, FINDER_PREVIOUS_FINDINGS_GUIDANCE)
    .replace(/\n{3,}/g, '\n\n')
    .trim()

export const buildFinderInstructions = (baseInstructions: string): string =>
  replaceResolutionInstructions(
    replaceOutputSchemaSection(baseInstructions, reducedFinderSchemaSection),
  )

const assignedFilesAddendum = (assignedFiles: string[]): string[] =>
  assignedFiles.length === 0
    ? []
    : [
        `Assigned files — inspect EACH of these with tools before finishing (the shared diff excerpt may not include them): ${assignedFiles.join(', ')}`,
      ]

export const buildFinderPrompt = (
  basePrompt: string,
  role: FinderRole,
  assignedFiles: string[] = [],
): string =>
  [
    basePrompt,
    '',
    `Finder role: ${role.id}`,
    role.addendum,
    ...assignedFilesAddendum(assignedFiles),
    'Report every defensible suspicion -- a separate verification stage filters false positives. Do not self-censor borderline findings. Every candidate still requires concrete evidence: exact file and line plus a specific claim someone could check.',
    'Return only candidate findings in the reduced finder JSON schema. Do not emit assessment, summary, meta, inlineComments, or resolutionVerdicts.',
  ].join('\n')

export const parseFinderCandidates = (output: string): FinderCandidate[] => {
  const parsed = finderOutputSchema.safeParse(extractJson(output))
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => issue.message).join('; '))
  }

  return parsed.data.candidates
}

const normalizeTitleTokens = (title: string): Set<string> =>
  new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .map((token) => token.trim())
      .filter((token) => token.length >= 3),
  )

const titleOverlap = (left: string, right: string): number => {
  const leftTokens = normalizeTitleTokens(left)
  const rightTokens = normalizeTitleTokens(right)
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return left.trim().toLowerCase() === right.trim().toLowerCase() ? 1 : 0
  }

  let shared = 0
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      shared += 1
    }
  }

  return shared / Math.min(leftTokens.size, rightTokens.size)
}

const linesNear = (left: number | undefined, right: number | undefined): boolean => {
  if (left === undefined || right === undefined) {
    return true
  }

  return Math.abs(left - right) <= 3
}

const filesCompatible = (left: string | undefined, right: string | undefined): boolean => {
  if (!left || !right) {
    return true
  }

  return left === right
}

const candidatesMatch = (left: EnsembleCandidate, right: EnsembleCandidate): boolean =>
  filesCompatible(left.file, right.file) &&
  linesNear(left.line, right.line) &&
  titleOverlap(left.title, right.title) >= 0.6

const mergeEvidence = (
  left: EnsembleCandidate['evidence'],
  right: EnsembleCandidate['evidence'],
): EnsembleCandidate['evidence'] => {
  const seen = new Set<string>()
  const merged: EnsembleCandidate['evidence'] = []

  for (const item of [...left, ...right]) {
    const key = JSON.stringify(item)
    if (!seen.has(key)) {
      seen.add(key)
      merged.push(item)
    }
  }

  return merged
}

const mergeCandidates = (left: EnsembleCandidate, right: EnsembleCandidate): EnsembleCandidate => ({
  file: left.file ?? right.file,
  line: left.line ?? right.line,
  category: left.category,
  severity: left.severity,
  title: left.title.length >= right.title.length ? left.title : right.title,
  body: left.body.length >= right.body.length ? left.body : right.body,
  evidence: mergeEvidence(left.evidence, right.evidence),
  provenance: [...new Set([...left.provenance, ...right.provenance])].sort((a, b) =>
    a.localeCompare(b),
  ),
})

export const dedupeCandidates = (candidates: EnsembleCandidate[]): EnsembleCandidate[] => {
  const deduped: EnsembleCandidate[] = []

  for (const candidate of candidates) {
    const existingIndex = deduped.findIndex((existing) => candidatesMatch(existing, candidate))
    if (existingIndex === -1) {
      deduped.push(candidate)
      continue
    }

    const existing = deduped[existingIndex]
    if (existing) {
      deduped[existingIndex] = mergeCandidates(existing, candidate)
    }
  }

  return deduped
}

const firstFileLineEvidence = (
  evidence: ReviewFinding['evidence'],
): { file: string; line: number } | null => {
  const fileLine = evidence.find((item) => item.type === 'file_line')
  return fileLine?.type === 'file_line' ? { file: fileLine.file, line: fileLine.line } : null
}

const candidateFromFinding = (finding: ReviewFinding, provenance: string): EnsembleCandidate => {
  const fileLine = firstFileLineEvidence(finding.evidence)
  return {
    file: finding.files?.[0] ?? fileLine?.file,
    line: fileLine?.line,
    category: finding.category,
    severity: finding.severity,
    title: finding.title,
    body: finding.body,
    evidence: finding.evidence,
    provenance: [provenance],
  }
}

const candidateFromInlineComment = (
  comment: ReviewInlineComment,
  provenance: string,
): EnsembleCandidate => ({
  file: comment.file,
  line: comment.line,
  category: 'correctness',
  severity: comment.severity,
  title: comment.body.split('\n')[0]?.slice(0, 120) ?? `${comment.file}:${comment.line}`,
  body: comment.body,
  evidence: [{ type: 'file_line', file: comment.file, line: comment.line }],
  provenance: [provenance],
})

const candidatesFromDeepReview = (
  review: ReviewOutputV2,
  provenance: string,
): EnsembleCandidate[] => [
  ...review.findings.map((finding) => candidateFromFinding(finding, provenance)),
  ...review.inlineComments.map((comment) => candidateFromInlineComment(comment, provenance)),
]

const extractDiffSection = (prompt: string): string => {
  const headingIndex = prompt.indexOf('## Diff')
  const searchStart = headingIndex === -1 ? 0 : headingIndex
  const fenceStart = prompt.indexOf('```diff', searchStart)

  if (fenceStart === -1) {
    return headingIndex === -1 ? '' : prompt.slice(headingIndex).trim()
  }

  const contentStart = prompt.indexOf('\n', fenceStart)
  if (contentStart === -1) {
    return ''
  }

  const fenceEnd = prompt.indexOf('```', contentStart + 1)
  if (fenceEnd === -1) {
    return prompt.slice(contentStart + 1).trim()
  }

  return prompt.slice(contentStart + 1, fenceEnd).trim()
}

const normalizeDiffPath = (path: string): string => path.replace(/^"?[ab]\//, '').replace(/"$/, '')

const splitDiffByFile = (diff: string): Map<string, string> => {
  const files = new Map<string, string>()
  let currentFiles: string[] = []
  let currentLines: string[] = []

  const flush = (): void => {
    if (currentFiles.length === 0 || currentLines.length === 0) {
      return
    }

    const block = currentLines.join('\n')
    for (const file of currentFiles) {
      files.set(file, block)
    }
  }

  for (const line of diff.split('\n')) {
    const gitMatch = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
    if (gitMatch?.[1] && gitMatch[2]) {
      flush()
      currentFiles = [...new Set([normalizeDiffPath(gitMatch[1]), normalizeDiffPath(gitMatch[2])])]
      currentLines = [line]
      continue
    }

    const fileMatch = /^(?:---|\+\+\+) (?:[ab]\/)?(.+)$/.exec(line)
    if (fileMatch?.[1] && fileMatch[1] !== '/dev/null') {
      currentFiles = [...new Set([...currentFiles, normalizeDiffPath(fileMatch[1])])]
    }

    currentLines.push(line)
  }

  flush()
  return files
}

const candidateFiles = (candidate: EnsembleCandidate): string[] => {
  const files = new Set<string>()
  if (candidate.file) {
    files.add(candidate.file)
  }

  for (const evidence of candidate.evidence) {
    if (evidence.type === 'file_line') {
      files.add(evidence.file)
    }
  }

  return [...files].sort((left, right) => left.localeCompare(right))
}

const diffContextForCandidate = (basePrompt: string, candidate: EnsembleCandidate): string => {
  const diffByFile = splitDiffByFile(extractDiffSection(basePrompt))
  const fileBlocks = candidateFiles(candidate)
    .map((file) => {
      const block = diffByFile.get(file)
      return block ? `### ${file}\n${block}` : null
    })
    .filter((block): block is string => block !== null)

  if (fileBlocks.length === 0) {
    return 'No matching per-file diff hunks were found in the base prompt. Read the cited code with tools if needed.'
  }

  return fileBlocks.join('\n\n')
}

export const buildVerifierPrompt = (input: {
  basePrompt: string
  candidate: EnsembleCandidate
}): string =>
  [
    'Adversarially verify this code-review finding. Read the cited code with tools if needed.',
    'Refute ONLY with concrete evidence: the code already handles it, the claim misreads the code, or the scenario is impossible. Uncertain means you could not disprove it.',
    'Output JSON {"verdict": "confirmed" | "refuted" | "uncertain", "reason": "..."} with no other text.',
    '',
    'Candidate:',
    '```json',
    JSON.stringify(
      {
        file: input.candidate.file,
        line: input.candidate.line,
        category: input.candidate.category,
        severity: input.candidate.severity,
        title: input.candidate.title,
        body: input.candidate.body,
        evidence: input.candidate.evidence,
        provenance: input.candidate.provenance,
      },
      null,
      2,
    ),
    '```',
    '',
    'Relevant diff hunks:',
    '```diff',
    diffContextForCandidate(input.basePrompt, input.candidate),
    '```',
  ].join('\n')

const parseVerificationOutput = (output: string): CandidateVerification => {
  const parsed = verificationOutputSchema.safeParse(extractJson(output))
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => issue.message).join('; '))
  }

  return parsed.data
}

const renderCandidateList = (candidates: EnsembleCandidate[]): string =>
  JSON.stringify(
    candidates.map((candidate, index) => ({
      index: index + 1,
      file: candidate.file,
      line: candidate.line,
      category: candidate.category,
      severity: candidate.severity,
      title: candidate.title,
      body: candidate.body,
      evidence: candidate.evidence,
      provenance: candidate.provenance,
      agreementCount: candidate.provenance.length,
      verification: candidate.verification,
    })),
    null,
    2,
  )

export const buildSynthesizerInstructions = (input: {
  baseInstructions: string
  candidates: EnsembleCandidate[]
  deepDraft: Pick<ReviewOutputV2, 'assessment' | 'summary'> | null
  verificationStats?: VerificationStats
  reviewMode?: EnsembleReviewMode
}): string => {
  const schema = extractOutputSchemaSection(input.baseInstructions)
  const header = stripOutputSchemaSection(input.baseInstructions)
  const previousContextInstruction =
    input.baseInstructions.includes('## Previous Review Findings') ||
    input.baseInstructions.includes('## Previous Inline Comments')
      ? 'The base prompt contains previous-review context. Produce resolutionVerdicts for every defensible previous finding or inline comment as required by the schema.'
      : 'If the base prompt does not contain previous-review context, return an empty resolutionVerdicts array or omit it.'
  const updateModeInstruction =
    input.reviewMode === 'update'
      ? 'This is a consecutive UPDATE review. Its purpose is to verify previous findings were addressed and to check the new delta — not to re-audit the whole MR. Report a new finding with severity bug or security ONLY when it is introduced by the delta or is a verified defect that blocks merging; anything else belongs in suggestions. If the delta addresses the previous findings and introduces no new defects, approve.'
      : null

  return [
    header,
    '',
    '## Ensemble Candidate Synthesis',
    '',
    'Surviving candidates have already passed the ensemble verification stage. Do not silently drop a surviving candidate unless it is a true duplicate of another finding. This is especially strict for confirmed candidates.',
    'Candidates whose verification verdict is uncertain carry severity suggestion; keep them as suggestions and do not escalate their severity.',
    'Never invent new findings beyond the candidate list.',
    previousContextInstruction,
    updateModeInstruction,
    '',
    'Verification stats:',
    JSON.stringify(
      input.verificationStats ?? {
        checked: 0,
        confirmed: 0,
        refuted: 0,
        uncertain: 0,
        skippedMultirole: 0,
      },
      null,
      2,
    ),
    '',
    'Deduped candidates with provenance:',
    '```json',
    renderCandidateList(input.candidates),
    '```',
    '',
    'Deep explorer draft:',
    input.deepDraft
      ? JSON.stringify(input.deepDraft, null, 2)
      : 'The deep explorer did not produce a valid draft.',
    '',
    schema,
  ]
    .filter(Boolean)
    .join('\n')
}

export type EnsembleReviewMode = 'initial' | 'update'

export const detectReviewMode = (instructions: string): EnsembleReviewMode =>
  instructions.includes('Review mode: consecutive update') ? 'update' : 'initial'

const gateSeverities = new Set(['bug', 'security'])

const isInDelta = (files: string[], changedFiles: string[]): boolean =>
  files.length === 0 || files.some((file) => changedFiles.includes(file))

export const applyAssessmentPolicy = (
  output: ReviewOutputV2,
  params: { reviewMode: EnsembleReviewMode; changedFiles: string[] },
): ReviewOutputV2 => {
  const applyDeltaDowngrade = params.reviewMode === 'update' && params.changedFiles.length > 0

  const findings = output.findings.map((finding) => {
    if (!applyDeltaDowngrade || isInDelta(finding.files ?? [], params.changedFiles)) {
      return finding
    }
    return { ...finding, severity: 'suggestion' as const, actionability: 'optional' as const }
  })

  const inlineComments = output.inlineComments.map((comment) => {
    if (!applyDeltaDowngrade || isInDelta([comment.file], params.changedFiles)) {
      return comment
    }
    return { ...comment, severity: 'suggestion' as const }
  })

  const hasGateFinding =
    findings.some((finding) => gateSeverities.has(finding.severity)) ||
    inlineComments.some((comment) => gateSeverities.has(comment.severity))

  const assessment = hasGateFinding
    ? ('request_changes' as const)
    : output.assessment === 'needs_discussion'
      ? ('needs_discussion' as const)
      : ('approve' as const)

  return { ...output, findings, inlineComments, assessment }
}

const applyPolicyToResult = (
  result: ReviewAgentResult,
  params: { reviewMode: EnsembleReviewMode; changedFiles: string[] },
): ReviewAgentResult => {
  try {
    const output = parseReviewOutputV2(result.output)
    return { ...result, output: JSON.stringify(applyAssessmentPolicy(output, params)) }
  } catch {
    return result
  }
}

const updateModeFinderRoleIds = new Set<FinderRoleId>(['diff-correctness', 'cross-file-impact'])

const rolesForMode = (mode: EnsembleReviewMode): FinderRole[] =>
  mode === 'update'
    ? finderRoles.filter((role) => updateModeFinderRoleIds.has(role.id))
    : finderRoles

const deepSamplesForMode = (mode: EnsembleReviewMode, configured: number): number =>
  mode === 'update' ? 1 : configured

const mergeInspectedFiles = (results: ReviewAgentResult[], changedFiles: string[]): string[] => {
  const files = new Set(changedFiles)
  for (const result of results) {
    for (const file of result.inspectedFiles ?? []) {
      files.add(file)
    }
  }

  return [...files].sort((left, right) => left.localeCompare(right))
}

const defaultSubHarnesses = (): Partial<Record<EnsembleSubHarnessId, ReviewAgentHarness>> => ({
  codex: {
    id: 'codex',
    invoke: invokeCodexReview,
  },
})

const normalizeDeepSamples = (samples: number): number => {
  if (!Number.isFinite(samples)) {
    return defaultEnsembleConfig.deep_samples
  }

  return Math.min(4, Math.max(1, Math.trunc(samples)))
}

interface DeepExplorerResult {
  id: string
  result: ReviewAgentResult | null
  parsed: ReviewOutputV2 | null
}

const emptyVerificationStats = (): VerificationStats => ({
  checked: 0,
  confirmed: 0,
  refuted: 0,
  uncertain: 0,
  skippedMultirole: 0,
})

const mapWithConcurrency = async <Input, Output>(
  items: Input[],
  concurrency: number,
  mapper: (item: Input, index: number) => Promise<Output>,
): Promise<Output[]> => {
  const results: Output[] = []
  let nextIndex = 0

  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      const item = items[index]
      if (item !== undefined) {
        results[index] = await mapper(item, index)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))

  return results
}

const invokeFinderRole = async (input: {
  harness: ReviewAgentHarness | undefined
  shard: FinderRoleShard
  config: ReviewAgentRunConfig
  ensembleConfig: ReviewAgentEnsembleConfig
  finderInstructions: string
  observedResults: ReviewAgentResult[]
}): Promise<EnsembleCandidate[]> => {
  if (!input.harness) {
    return []
  }

  const role = input.shard.role
  try {
    const result = await input.harness.invoke({
      ...input.config,
      sessionDir: join(input.config.sessionDir, 'ensemble', `finder-${role.id}`),
      model: input.ensembleConfig.finder_model,
      thinkingLevel: input.ensembleConfig.finder_thinking_level,
      prompt: buildFinderPrompt(input.config.prompt, role, input.shard.assignedFiles),
      instructions: input.finderInstructions,
      timeoutMs: input.ensembleConfig.finder_timeout_ms,
    })
    input.observedResults.push(result)

    if (!result.success) {
      console.warn(`[ensemble] finder ${role.id} failed: ${result.error ?? 'unknown error'}`)
      return []
    }

    return parseFinderCandidates(result.output).map((candidate) => ({
      ...candidate,
      provenance: [role.id],
    }))
  } catch (error) {
    console.warn(`[ensemble] finder ${role.id} failed: ${toErrorMessage(error)}`)
    return []
  }
}

const invokeVerifierCandidate = async (input: {
  harness: ReviewAgentHarness
  candidate: EnsembleCandidate
  index: number
  config: ReviewAgentRunConfig
  ensembleConfig: ReviewAgentEnsembleConfig
  observedResults: ReviewAgentResult[]
}): Promise<EnsembleCandidate> => {
  try {
    const result = await input.harness.invoke({
      ...input.config,
      sessionDir: join(input.config.sessionDir, 'ensemble', `verify-${input.index + 1}`),
      model: input.ensembleConfig.verifier_model,
      thinkingLevel: input.ensembleConfig.verifier_thinking_level,
      prompt: buildVerifierPrompt({
        basePrompt: input.config.prompt,
        candidate: input.candidate,
      }),
      timeoutMs: input.ensembleConfig.verifier_timeout_ms,
    })
    input.observedResults.push(result)

    if (!result.success) {
      console.warn(
        `[ensemble] verify ${input.index + 1} failed: ${result.error ?? 'unknown error'}`,
      )
      return {
        ...input.candidate,
        verification: { verdict: 'uncertain', reason: result.error ?? 'verification failed' },
      }
    }

    const verification = parseVerificationOutput(result.output)
    return { ...input.candidate, verification }
  } catch (error) {
    console.warn(`[ensemble] verify ${input.index + 1} failed: ${toErrorMessage(error)}`)
    return {
      ...input.candidate,
      verification: { verdict: 'uncertain', reason: toErrorMessage(error) },
    }
  }
}

const verifyCandidates = async (input: {
  harness: ReviewAgentHarness | undefined
  candidates: EnsembleCandidate[]
  config: ReviewAgentRunConfig
  ensembleConfig: ReviewAgentEnsembleConfig
  observedResults: ReviewAgentResult[]
}): Promise<{ candidates: EnsembleCandidate[]; stats: VerificationStats }> => {
  const stats = emptyVerificationStats()

  if (!input.ensembleConfig.verify_enabled || !input.harness) {
    return { candidates: input.candidates, stats }
  }

  const verifierHarness = input.harness
  const verified = await mapWithConcurrency(
    input.candidates,
    4,
    async (candidate, index): Promise<EnsembleCandidate | null> => {
      if (candidate.provenance.length >= 2) {
        stats.skippedMultirole += 1
        return candidate
      }

      stats.checked += 1
      const checkedCandidate = await invokeVerifierCandidate({
        harness: verifierHarness,
        candidate,
        index,
        config: input.config,
        ensembleConfig: input.ensembleConfig,
        observedResults: input.observedResults,
      })
      const verdict = checkedCandidate.verification?.verdict ?? 'uncertain'
      stats[verdict] += 1

      if (verdict === 'refuted') {
        return null
      }

      if (verdict === 'uncertain') {
        return { ...checkedCandidate, severity: 'suggestion' }
      }

      return checkedCandidate
    },
  )

  console.warn(
    `[ensemble] verify checked=${stats.checked} confirmed=${stats.confirmed} refuted=${stats.refuted} uncertain=${stats.uncertain} skipped-multirole=${stats.skippedMultirole}`,
  )

  return {
    candidates: verified.filter((candidate): candidate is EnsembleCandidate => candidate !== null),
    stats,
  }
}

const invokeDeepExplorer = async (input: {
  harness: ReviewAgentHarness
  id: string
  config: ReviewAgentRunConfig
  ensembleConfig: ReviewAgentEnsembleConfig
  observedResults: ReviewAgentResult[]
}): Promise<DeepExplorerResult> => {
  try {
    const result = await input.harness.invoke({
      ...input.config,
      sessionDir: join(input.config.sessionDir, 'ensemble', input.id),
      model: input.ensembleConfig.deep_model,
      timeoutMs: input.ensembleConfig.deep_timeout_ms,
    })
    input.observedResults.push(result)

    if (!result.success) {
      console.warn(`[ensemble] ${input.id} failed: ${result.error ?? 'unknown error'}`)
      return { id: input.id, result, parsed: null }
    }

    try {
      return { id: input.id, result, parsed: parseReviewOutputV2(result.output) }
    } catch (error) {
      console.warn(`[ensemble] ${input.id} returned invalid output: ${toErrorMessage(error)}`)
      return { id: input.id, result, parsed: null }
    }
  } catch (error) {
    console.warn(`[ensemble] ${input.id} failed: ${toErrorMessage(error)}`)
    return { id: input.id, result: null, parsed: null }
  }
}

const invokeSynthesizer = async (input: {
  harness: ReviewAgentHarness
  config: ReviewAgentRunConfig
  ensembleConfig: ReviewAgentEnsembleConfig
  candidates: EnsembleCandidate[]
  deepReview: ReviewOutputV2 | null
  verificationStats: VerificationStats
  reviewMode: EnsembleReviewMode
  observedResults: ReviewAgentResult[]
}): Promise<ReviewAgentResult> => {
  const result = await input.harness.invoke({
    ...input.config,
    sessionDir: join(input.config.sessionDir, 'ensemble', 'synthesizer'),
    model: input.ensembleConfig.synthesizer_model,
    instructions: buildSynthesizerInstructions({
      baseInstructions: input.config.instructions,
      candidates: input.candidates,
      deepDraft: input.deepReview
        ? {
            assessment: input.deepReview.assessment,
            summary: input.deepReview.summary,
          }
        : null,
      verificationStats: input.verificationStats,
      reviewMode: input.reviewMode,
    }),
    timeoutMs: input.ensembleConfig.synthesizer_timeout_ms,
  })
  input.observedResults.push(result)

  if (!result.success) {
    throw new Error(result.error ?? 'synthesizer failed')
  }

  parseReviewOutputV2(result.output)
  return result
}

const buildMissingCodexResult = (input: {
  start: number
  ensembleConfig: ReviewAgentEnsembleConfig
  changedFiles: string[]
}): ReviewAgentResult => ({
  harness: 'ensemble',
  model: input.ensembleConfig.synthesizer_model,
  success: false,
  output: '',
  durationMs: Date.now() - input.start,
  inspectedFiles: input.changedFiles,
  error: 'Ensemble requires the codex sub-harness for deep exploration and synthesis',
})

const buildSynthesizerFailureResult = (input: {
  start: number
  ensembleConfig: ReviewAgentEnsembleConfig
  observedResults: ReviewAgentResult[]
  changedFiles: string[]
  error: unknown
}): ReviewAgentResult => ({
  harness: 'ensemble',
  model: input.ensembleConfig.synthesizer_model,
  success: false,
  output: '',
  durationMs: Date.now() - input.start,
  inspectedFiles: mergeInspectedFiles(input.observedResults, input.changedFiles),
  error: `Ensemble synthesizer failed and no valid deep fallback was available: ${toErrorMessage(input.error)}`,
})

const runFinderAndDeepStages = async (input: {
  finderHarness: ReviewAgentHarness | undefined
  codexHarness: ReviewAgentHarness
  config: ReviewAgentRunConfig
  ensembleConfig: ReviewAgentEnsembleConfig
  reviewMode: EnsembleReviewMode
  observedResults: ReviewAgentResult[]
}): Promise<{
  candidates: EnsembleCandidate[]
  stats: VerificationStats
  successfulDeepResult: DeepExplorerResult | undefined
}> => {
  const finderInstructions = buildFinderInstructions(input.config.instructions)
  const finderShards = shardFinderRoles(input.config.instructions, rolesForMode(input.reviewMode))
  const finderPromises = finderShards.map((shard) =>
    invokeFinderRole({
      harness: input.finderHarness,
      shard,
      config: input.config,
      ensembleConfig: input.ensembleConfig,
      finderInstructions,
      observedResults: input.observedResults,
    }),
  )

  const deepSampleCount = deepSamplesForMode(input.reviewMode, input.ensembleConfig.deep_samples)
  const [finderResults, deepResults] = await Promise.all([
    Promise.all(finderPromises),
    Promise.all(
      Array.from({ length: deepSampleCount }, (_, index) =>
        invokeDeepExplorer({
          harness: input.codexHarness,
          id: `deep-${index + 1}`,
          config: input.config,
          ensembleConfig: input.ensembleConfig,
          observedResults: input.observedResults,
        }),
      ),
    ),
  ])
  const finderCandidates = finderResults.flat()
  const successfulDeepResult = deepResults.find((result) => result.parsed)
  const deepCandidates = deepResults.flatMap((result) =>
    result.parsed ? candidatesFromDeepReview(result.parsed, result.id) : [],
  )
  const dedupedCandidates = dedupeCandidates([...finderCandidates, ...deepCandidates])

  return {
    ...(await verifyCandidates({
      harness: input.finderHarness,
      candidates: dedupedCandidates,
      config: input.config,
      ensembleConfig: input.ensembleConfig,
      observedResults: input.observedResults,
    })),
    successfulDeepResult,
  }
}

const buildSuccessfulEnsembleResult = (input: {
  result: ReviewAgentResult
  start: number
  model: string
  observedResults: ReviewAgentResult[]
  changedFiles: string[]
}): ReviewAgentResult => ({
  ...input.result,
  harness: 'ensemble',
  model: input.model,
  durationMs: Date.now() - input.start,
  inspectedFiles: mergeInspectedFiles(input.observedResults, input.changedFiles),
})

export const createEnsembleReviewHarness = (options?: {
  config?: Partial<ReviewAgentEnsembleConfig>
  harnesses?: Partial<Record<EnsembleSubHarnessId, ReviewAgentHarness>>
}): ReviewAgentHarness => {
  const ensembleConfig = { ...defaultEnsembleConfig, ...options?.config }
  ensembleConfig.deep_samples = normalizeDeepSamples(ensembleConfig.deep_samples)
  const subHarnesses = { ...defaultSubHarnesses(), ...options?.harnesses }

  return {
    id: 'ensemble',
    invoke: async (config: ReviewAgentRunConfig): Promise<ReviewAgentResult> => {
      const start = Date.now()
      const finderHarness = subHarnesses[ensembleConfig.finder_harness]
      const codexHarness = subHarnesses.codex
      const observedResults: ReviewAgentResult[] = []
      const changedFiles = config.changedFiles ?? []

      if (!finderHarness) {
        console.warn(`[ensemble] finder harness not available: ${ensembleConfig.finder_harness}`)
      }

      if (!codexHarness) {
        return buildMissingCodexResult({ start, ensembleConfig, changedFiles })
      }

      const reviewMode = detectReviewMode(config.instructions)
      const { candidates, stats, successfulDeepResult } = await runFinderAndDeepStages({
        finderHarness,
        codexHarness,
        config,
        ensembleConfig,
        reviewMode,
        observedResults,
      })

      try {
        const synthesizerResult = await invokeSynthesizer({
          harness: codexHarness,
          config,
          ensembleConfig,
          candidates,
          deepReview: successfulDeepResult?.parsed ?? null,
          verificationStats: stats,
          reviewMode,
          observedResults,
        })

        return buildSuccessfulEnsembleResult({
          result: applyPolicyToResult(synthesizerResult, { reviewMode, changedFiles }),
          start,
          model: ensembleConfig.synthesizer_model,
          observedResults,
          changedFiles,
        })
      } catch (error) {
        console.warn(`[ensemble] synthesizer failed: ${toErrorMessage(error)}`)
        if (successfulDeepResult?.result?.success && successfulDeepResult.parsed) {
          return buildSuccessfulEnsembleResult({
            result: applyPolicyToResult(successfulDeepResult.result, { reviewMode, changedFiles }),
            start,
            model: ensembleConfig.deep_model,
            observedResults,
            changedFiles,
          })
        }

        return buildSynthesizerFailureResult({
          start,
          ensembleConfig,
          observedResults,
          changedFiles,
          error,
        })
      }
    },
  }
}
