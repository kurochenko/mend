import { describe, expect, it } from 'bun:test'
import {
  applyAssessmentPolicy,
  buildFinderInstructions,
  buildFinderPrompt,
  buildSynthesizerInstructions,
  createEnsembleReviewHarness,
  dedupeCandidates,
  detectReviewMode,
  finderRoles,
  parseChangedFilesFromPrompt,
  parseFinderCandidates,
  rankChangedFilesForSharding,
  shardFinderRoles,
  type EnsembleCandidate,
} from '@/agents/ensemble-harness'
import type { ReviewOutputV2 } from '@/mastra/review/schema'
import {
  FINDER_PREVIOUS_FINDINGS_GUIDANCE,
  RESOLUTION_INSTRUCTIONS,
} from '@/mastra/review/prompt-templates'
import type { ReviewAgentHarness, ReviewAgentResult } from '@/agents/review-harness'

const basePrompt = [
  'Review MR !1',
  '',
  '## Changed files',
  '',
  '- src/app.ts (+2/-1)',
  '',
  '## Diff',
  '',
  '```diff',
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -9,6 +9,7 @@ export const run = () => {',
  '+changed',
  '```',
].join('\n')

const baseInstructions = [
  basePrompt,
  '',
  '',
  'Your final output MUST be a JSON object matching this exact schema:',
  '```json',
  '{ "version": "v2" }',
  '```',
  'Output ONLY the JSON object as your final message, no other text around it.',
].join('\n')

const reviewFinding = (title: string, line = 12) => ({
  id: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  category: 'correctness',
  severity: 'bug',
  actionability: 'required',
  scope: 'single_file',
  title,
  body: 'The reviewed code has a concrete issue.',
  files: ['src/app.ts'],
  evidence: [{ type: 'file_line', file: 'src/app.ts', line }],
})

const reviewOutput = (
  summary = 'No issues found',
  findings: unknown[] = [],
  inlineComments: unknown[] = [],
): string =>
  JSON.stringify({
    version: 'v2',
    assessment: 'approve',
    summary,
    findings,
    inlineComments,
    resolutionVerdicts: [],
  })

const candidateOutput = (
  input: { title?: string; file?: string; line?: number; body?: string } = {},
): string =>
  JSON.stringify({
    candidates: [
      {
        file: input.file ?? 'src/app.ts',
        line: input.line ?? 12,
        category: 'correctness',
        severity: 'bug',
        title: input.title ?? 'Missing null guard',
        body: input.body ?? 'The new branch dereferences a nullable value before checking it.',
        evidence: [
          {
            type: 'file_line',
            file: input.file ?? 'src/app.ts',
            line: input.line ?? 12,
            note: 'value.name',
          },
        ],
      },
    ],
  })

const emptyCandidateOutput = (): string => JSON.stringify({ candidates: [] })

const verificationOutput = (verdict: 'confirmed' | 'refuted' | 'uncertain'): string =>
  JSON.stringify({ verdict, reason: `${verdict} reason` })

const createResult = (
  config: { harness: ReviewAgentResult['harness']; model: string },
  output: string,
  overrides: Partial<ReviewAgentResult> = {},
): ReviewAgentResult => ({
  harness: config.harness,
  model: config.model,
  success: true,
  output,
  durationMs: 1,
  ...overrides,
})

const createRoutingHarness = (
  route: (
    config: Parameters<ReviewAgentHarness['invoke']>[0],
  ) => ReviewAgentResult | Promise<ReviewAgentResult>,
): ReviewAgentHarness => ({
  id: 'codex',
  invoke: async (config) => route(config),
})

const invokeConfig = {
  cwd: '/tmp/repo',
  sessionDir: '/tmp/sessions',
  model: 'outer-model',
  thinkingLevel: 'medium' as const,
  instructions: baseInstructions,
  prompt: basePrompt,
  changedFiles: ['src/app.ts'],
}

const largeChangedFilesPrompt = (count: number): string =>
  [
    'Review MR !1',
    '',
    '## Changed files',
    '',
    ...Array.from({ length: count }, (_, index) => {
      const file = `src/file-${String(index + 1).padStart(2, '0')}.ts`
      return `- ${file} (+${index + 1}/-${index % 3})`
    }),
    '',
    '## Diff',
    '',
    '```diff',
    'diff omitted',
    '```',
  ].join('\n')

describe('ensemble prompt construction', () => {
  it('preserves the base prompt and replaces the full schema for finders', () => {
    const role = finderRoles[0]
    if (!role) {
      throw new Error('missing finder role')
    }

    const instructions = buildFinderInstructions(baseInstructions)
    const prompt = buildFinderPrompt('base user prompt', role)

    expect(instructions).toContain('Review MR !1')
    expect(instructions).toContain('## Changed files')
    expect(instructions).toContain('"candidates"')
    expect(instructions).not.toContain('"version": "v2"')
    expect(instructions).not.toContain(FINDER_PREVIOUS_FINDINGS_GUIDANCE)
    expect(prompt).toContain('base user prompt')
    expect(prompt).toContain('Finder role: diff-correctness')
    expect(prompt).toContain(role.addendum)
    expect(prompt).toContain('realistic intended-use trigger')
    expect(prompt).toContain(
      'Omit borderline suspicions, theoretical risks, and optional hardening',
    )
  })

  it('replaces resolution verification with previous-finding guidance for update finders', () => {
    const updateInstructions = [
      basePrompt,
      '',
      RESOLUTION_INSTRUCTIONS,
      '',
      'Your final output MUST be a JSON object matching this exact schema:',
      '```json',
      '{ "version": "v2" }',
      '```',
      'Output ONLY the JSON object as your final message, no other text around it.',
    ].join('\n')

    expect(updateInstructions).toContain('resolutionVerdicts')

    const instructions = buildFinderInstructions(updateInstructions)

    expect(instructions).not.toContain('resolutionVerdicts')
    expect(instructions).not.toContain('## Resolution Verification')
    expect(instructions).toContain(FINDER_PREVIOUS_FINDINGS_GUIDANCE)
    expect(instructions).toContain('marked resolved are settled decisions')
    expect(instructions).toContain('## Changed files')
    expect(instructions).toContain('"candidates"')
  })

  it('assembles a synthesizer prompt with candidates, provenance, deep draft, and full schema', () => {
    const instructions = buildSynthesizerInstructions({
      baseInstructions,
      candidates: [
        {
          file: 'src/app.ts',
          line: 12,
          category: 'correctness',
          severity: 'bug',
          title: 'Missing null guard',
          body: 'Body',
          evidence: [{ type: 'file_line', file: 'src/app.ts', line: 12 }],
          provenance: ['diff-correctness', 'tests-adequacy'],
        },
      ],
      deepDraft: { assessment: 'approve', summary: 'Draft summary' },
    })

    expect(instructions).toContain('## Ensemble Candidate Synthesis')
    expect(instructions).toContain('"provenance"')
    expect(instructions).toContain('Draft summary')
    expect(instructions).toContain(
      'Your final output MUST be a JSON object matching this exact schema:',
    )
    expect(instructions).toContain('"version": "v2"')
    expect(instructions).toContain('Verification stats:')
    expect(instructions).toContain('Apply the finding eligibility gate again')
    expect(instructions).toContain('Every emitted finding must block release')
  })

  it('includes the scenario-simulation finder role', () => {
    expect(finderRoles.map((role) => role.id)).toEqual([
      'diff-correctness',
      'cross-file-impact',
      'tests-adequacy',
      'conventions-structure',
      'scenario-simulation',
    ])
  })

  it('parses changed files from the generated prompt section', () => {
    expect(parseChangedFilesFromPrompt(largeChangedFilesPrompt(2))).toEqual([
      { file: 'src/file-01.ts', added: 1, deleted: 0 },
      { file: 'src/file-02.ts', added: 2, deleted: 1 },
    ])
  })

  it('ranks files mentioned in structural signals before diff-size ordering', () => {
    const prompt = [
      largeChangedFilesPrompt(3),
      '',
      '## Structural signals',
      '',
      '- Blast radius: src/file-01.ts is imported by 20 modules.',
    ].join('\n')

    expect(rankChangedFilesForSharding(parseChangedFilesFromPrompt(prompt), prompt)[0]?.file).toBe(
      'src/file-01.ts',
    )
  })

  it('round-robin shards large changed-file lists across finder roles', () => {
    const shards = shardFinderRoles(largeChangedFilesPrompt(35))
    const assigned = shards.flatMap((shard) => shard.assignedFiles)

    expect(shards).toHaveLength(finderRoles.length)
    expect(new Set(assigned).size).toBe(35)
    expect(assigned).toEqual(expect.arrayContaining(['src/file-01.ts', 'src/file-35.ts']))
    expect(shards.every((shard) => shard.assignedFiles.length > 0)).toBe(true)
  })

  it('does not shard finder roles at or below the large-MR threshold', () => {
    expect(shardFinderRoles(largeChangedFilesPrompt(30))).toEqual(
      finderRoles.map((role) => ({ role, assignedFiles: [] })),
    )
  })

  it('appends assigned files to finder prompts only when sharded', () => {
    const role = finderRoles[0]
    if (!role) {
      throw new Error('missing finder role')
    }

    expect(buildFinderPrompt('base user prompt', role)).not.toContain('Assigned files')
    expect(buildFinderPrompt('base user prompt', role, ['src/a.ts'])).toContain(
      'Assigned files — inspect EACH of these with tools before finishing',
    )
  })
})

describe('parseFinderCandidates', () => {
  it('parses valid reduced finder JSON', () => {
    const candidates = parseFinderCandidates(candidateOutput())

    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.title).toBe('Missing null guard')
  })

  it('rejects invalid reduced finder JSON', () => {
    expect(() => parseFinderCandidates('{"candidates":[{"title":"missing fields"}]}')).toThrow()
  })

  it('ignores a stray top-level resolutionVerdicts key instead of crashing the role', () => {
    const output = JSON.stringify({
      candidates: JSON.parse(candidateOutput()).candidates,
      resolutionVerdicts: [
        { previousFindingId: 'dup-layout', status: 'fixed', explanation: 'addressed' },
      ],
    })

    const candidates = parseFinderCandidates(output)

    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.title).toBe('Missing null guard')
  })
})

describe('dedupeCandidates', () => {
  it('merges near-identical titles within a three-line window and keeps provenance', () => {
    const candidates: EnsembleCandidate[] = [
      {
        file: 'src/app.ts',
        line: 10,
        category: 'correctness',
        severity: 'bug',
        title: 'Missing null guard',
        body: 'Short body',
        evidence: [{ type: 'file_line', file: 'src/app.ts', line: 10 }],
        provenance: ['diff-correctness'],
      },
      {
        file: 'src/app.ts',
        line: 13,
        category: 'correctness',
        severity: 'bug',
        title: 'Missing null guard for value',
        body: 'A much more detailed body explaining the nullable value regression.',
        evidence: [{ type: 'file_line', file: 'src/app.ts', line: 13 }],
        provenance: ['cross-file-impact'],
      },
    ]

    const deduped = dedupeCandidates(candidates)

    expect(deduped).toHaveLength(1)
    expect(deduped[0]?.body).toContain('much more detailed')
    expect(deduped[0]?.provenance).toEqual(['cross-file-impact', 'diff-correctness'])
    expect(deduped[0]?.evidence).toHaveLength(2)
  })
})

describe('createEnsembleReviewHarness', () => {
  it('verifies candidates, drops refuted ones, keeps uncertain ones, and skips multi-role candidates', async () => {
    let synthesizerInstructions = ''
    const calls: string[] = []
    const harness = createRoutingHarness((config) => {
      const { sessionDir } = config
      calls.push(sessionDir)
      if (sessionDir.includes('finder-diff-correctness')) {
        return createResult(
          { harness: 'codex', model: 'gpt-5-mini' },
          candidateOutput({ title: 'Refuted candidate', line: 10 }),
        )
      }
      if (sessionDir.includes('finder-cross-file-impact')) {
        return createResult(
          { harness: 'codex', model: 'gpt-5-mini' },
          candidateOutput({ title: 'Confirmed candidate', line: 20 }),
        )
      }
      if (sessionDir.includes('finder-tests-adequacy')) {
        return createResult(
          { harness: 'codex', model: 'gpt-5-mini' },
          candidateOutput({ title: 'Uncertain candidate', line: 30 }),
        )
      }
      if (
        sessionDir.includes('finder-conventions-structure') ||
        sessionDir.includes('finder-scenario-simulation')
      ) {
        return createResult(
          { harness: 'codex', model: 'gpt-5-mini' },
          candidateOutput({ title: 'Multi role candidate', line: 40 }),
        )
      }
      if (sessionDir.includes('deep-')) {
        return createResult({ harness: 'codex', model: 'gpt-5.5' }, reviewOutput('Deep summary'))
      }
      if (sessionDir.includes('verify-')) {
        if (config.prompt.includes('Refuted candidate')) {
          return createResult({ harness: 'codex', model: 'gpt-5.5' }, verificationOutput('refuted'))
        }
        if (config.prompt.includes('Confirmed candidate')) {
          return createResult(
            { harness: 'codex', model: 'gpt-5.5' },
            verificationOutput('confirmed'),
          )
        }
        return createResult({ harness: 'codex', model: 'gpt-5.5' }, verificationOutput('uncertain'))
      }

      synthesizerInstructions = config.instructions
      return createResult({ harness: 'codex', model: 'gpt-5.5' }, reviewOutput('Synth summary'))
    })

    const ensemble = createEnsembleReviewHarness({
      config: { deep_samples: 1 },
      harnesses: { codex: harness },
    })
    const result = await ensemble.invoke(invokeConfig)

    expect(result.success).toBe(true)
    expect(calls.filter((call) => call.includes('verify-'))).toHaveLength(3)
    expect(synthesizerInstructions).not.toContain('Refuted candidate')
    expect(synthesizerInstructions).toContain('Confirmed candidate')
    expect(synthesizerInstructions).toContain('Uncertain candidate')
    expect(synthesizerInstructions).toContain('Multi role candidate')
    expect(synthesizerInstructions).toContain('"checked": 3')
    expect(synthesizerInstructions).toContain('"confirmed": 1')
    expect(synthesizerInstructions).toContain('"refuted": 1')
    expect(synthesizerInstructions).toContain('"uncertain": 1')
    expect(synthesizerInstructions).toContain('"skippedMultirole": 1')
  })

  it('keeps candidates when verification output cannot be parsed', async () => {
    let synthesizerInstructions = ''
    const harness = createRoutingHarness((config) => {
      const { sessionDir } = config
      if (sessionDir.includes('finder-diff-correctness')) {
        return createResult(
          { harness: 'codex', model: 'gpt-5-mini' },
          candidateOutput({ title: 'Parse error candidate', line: 10 }),
        )
      }
      if (sessionDir.includes('finder-')) {
        return createResult({ harness: 'codex', model: 'gpt-5-mini' }, emptyCandidateOutput())
      }
      if (sessionDir.includes('deep-')) {
        return createResult({ harness: 'codex', model: 'gpt-5.5' }, reviewOutput('Deep summary'))
      }
      if (sessionDir.includes('verify-')) {
        return createResult({ harness: 'codex', model: 'gpt-5.5' }, 'not json')
      }

      synthesizerInstructions = config.instructions
      return createResult({ harness: 'codex', model: 'gpt-5.5' }, reviewOutput('Synth summary'))
    })

    const ensemble = createEnsembleReviewHarness({
      config: { deep_samples: 1 },
      harnesses: { codex: harness },
    })
    const result = await ensemble.invoke(invokeConfig)

    expect(result.success).toBe(true)
    expect(synthesizerInstructions).toContain('Parse error candidate')
    expect(synthesizerInstructions).toContain('"uncertain": 1')
  })

  it('runs configured deep samples, dedupes their findings, and skips multi-sample verification', async () => {
    let synthesizerInstructions = ''
    const calls: string[] = []
    const harness = createRoutingHarness((config) => {
      const { sessionDir } = config
      calls.push(sessionDir)
      if (sessionDir.includes('finder-')) {
        return createResult({ harness: 'codex', model: 'gpt-5-mini' }, emptyCandidateOutput())
      }
      if (sessionDir.includes('deep-1')) {
        return createResult(
          { harness: 'codex', model: 'gpt-5.5' },
          reviewOutput('First deep summary', [reviewFinding('Shared deep finding', 12)]),
        )
      }
      if (sessionDir.includes('deep-2')) {
        return createResult(
          { harness: 'codex', model: 'gpt-5.5' },
          reviewOutput('Second deep summary', [reviewFinding('Shared deep finding', 13)]),
        )
      }

      synthesizerInstructions = config.instructions
      return createResult({ harness: 'codex', model: 'gpt-5.5' }, reviewOutput('Synth summary'))
    })

    const ensemble = createEnsembleReviewHarness({
      config: { deep_samples: 2 },
      harnesses: { codex: harness },
    })
    const result = await ensemble.invoke(invokeConfig)

    expect(result.success).toBe(true)
    expect(calls.filter((call) => call.includes('deep-'))).toHaveLength(2)
    expect(calls.filter((call) => call.includes('verify-'))).toHaveLength(0)
    expect(synthesizerInstructions).toContain('Shared deep finding')
    expect(synthesizerInstructions).toContain('"deep-1"')
    expect(synthesizerInstructions).toContain('"deep-2"')
    expect(synthesizerInstructions).toContain('First deep summary')
    expect(synthesizerInstructions).toContain('"skippedMultirole": 1')
  })

  it('contains finder failures and still returns synthesizer output', async () => {
    const calls: string[] = []
    const harness = createRoutingHarness((config) => {
      const { sessionDir } = config
      calls.push(sessionDir)
      if (sessionDir.includes('finder-diff-correctness')) {
        throw new Error('finder timeout')
      }
      if (sessionDir.includes('finder-')) {
        return createResult({ harness: 'codex', model: 'gpt-5-mini' }, candidateOutput())
      }
      if (sessionDir.includes('deep-')) {
        return createResult({ harness: 'codex', model: 'gpt-5.5' }, reviewOutput('Deep summary'))
      }
      if (sessionDir.includes('verify-')) {
        return createResult({ harness: 'codex', model: 'gpt-5.5' }, verificationOutput('uncertain'))
      }
      return createResult({ harness: 'codex', model: 'gpt-5.5' }, reviewOutput('Synth summary'))
    })

    const ensemble = createEnsembleReviewHarness({
      config: { deep_samples: 1 },
      harnesses: { codex: harness },
    })
    const result = await ensemble.invoke(invokeConfig)

    expect(result.success).toBe(true)
    expect(result.harness).toBe('ensemble')
    expect(result.model).toBe('gpt-5.5')
    expect(result.output).toContain('Synth summary')
    expect(result.inspectedFiles).toEqual(['src/app.ts'])
    expect(calls.filter((call) => call.includes('finder-'))).toHaveLength(5)
    expect(calls.some((call) => call.includes('finder-scenario-simulation'))).toBe(true)
  })

  it('falls back to the deep explorer when synthesis fails', async () => {
    const harness = createRoutingHarness((config) => {
      const { sessionDir } = config
      if (sessionDir.includes('finder-')) {
        return createResult({ harness: 'codex', model: 'gpt-5-mini' }, candidateOutput())
      }
      if (sessionDir.includes('deep-')) {
        return createResult({ harness: 'codex', model: 'gpt-5.5' }, reviewOutput('Deep summary'))
      }
      if (sessionDir.includes('verify-')) {
        return createResult({ harness: 'codex', model: 'gpt-5.5' }, verificationOutput('uncertain'))
      }
      return createResult({ harness: 'codex', model: 'gpt-5.5' }, '', {
        success: false,
        error: 'synth timeout',
      })
    })

    const ensemble = createEnsembleReviewHarness({
      config: { deep_samples: 1 },
      harnesses: { codex: harness },
    })
    const result = await ensemble.invoke(invokeConfig)

    expect(result.success).toBe(true)
    expect(result.harness).toBe('ensemble')
    expect(result.output).toContain('Deep summary')
  })

  it('returns failure when synthesis fails without a valid deep fallback', async () => {
    const harness = createRoutingHarness((config) => {
      const { sessionDir } = config
      if (sessionDir.includes('finder-')) {
        return createResult({ harness: 'codex', model: 'gpt-5-mini' }, candidateOutput())
      }
      if (sessionDir.includes('deep-')) {
        return createResult({ harness: 'codex', model: 'gpt-5.5' }, '', {
          success: false,
          error: 'deep timeout',
        })
      }
      if (sessionDir.includes('verify-')) {
        return createResult({ harness: 'codex', model: 'gpt-5.5' }, verificationOutput('uncertain'))
      }
      return createResult({ harness: 'codex', model: 'gpt-5.5' }, '', {
        success: false,
        error: 'synth timeout',
      })
    })

    const ensemble = createEnsembleReviewHarness({
      config: { deep_samples: 1 },
      harnesses: { codex: harness },
    })
    const result = await ensemble.invoke(invokeConfig)

    expect(result.success).toBe(false)
    expect(result.error).toContain('no valid deep fallback')
  })
})

const policyOutput = (overrides: Partial<ReviewOutputV2> = {}): ReviewOutputV2 => ({
  version: 'v2',
  assessment: 'request_changes',
  summary: 'summary',
  findings: [],
  inlineComments: [],
  resolutionVerdicts: [],
  ...overrides,
})

describe('detectReviewMode', () => {
  it('detects consecutive update reviews from the machine-written scope line', () => {
    expect(detectReviewMode('Review mode: consecutive update. Verify all files')).toBe('update')
    expect(detectReviewMode('Review mode: initial. Verify all files')).toBe('initial')
  })
})

describe('applyAssessmentPolicy', () => {
  it('requests changes only when a bug or security severity finding exists', () => {
    const gated = applyAssessmentPolicy(
      policyOutput({
        assessment: 'approve',
        inlineComments: [{ file: 'src/app.ts', line: 2, severity: 'bug', body: 'broken' }],
      }),
      { reviewMode: 'initial', changedFiles: ['src/app.ts'] },
    )
    expect(gated.assessment).toBe('request_changes')

    const ungated = applyAssessmentPolicy(
      policyOutput({
        assessment: 'request_changes',
        inlineComments: [{ file: 'src/app.ts', line: 2, severity: 'suggestion', body: 'style' }],
      }),
      { reviewMode: 'initial', changedFiles: ['src/app.ts'] },
    )
    expect(ungated.assessment).toBe('approve')
  })

  it('preserves needs_discussion when nothing gates', () => {
    const result = applyAssessmentPolicy(policyOutput({ assessment: 'needs_discussion' }), {
      reviewMode: 'initial',
      changedFiles: ['src/app.ts'],
    })
    expect(result.assessment).toBe('needs_discussion')
  })

  it('downgrades out-of-delta findings to optional suggestions in update mode', () => {
    const result = applyAssessmentPolicy(
      policyOutput({
        findings: [
          {
            id: 'out-of-delta',
            category: 'correctness',
            severity: 'bug',
            actionability: 'required',
            scope: 'single_file',
            title: 'Old code issue',
            body: 'Not introduced by this delta.',
            files: ['src/legacy.ts'],
            evidence: [{ type: 'file_line', file: 'src/legacy.ts', line: 5 }],
          },
        ],
        inlineComments: [{ file: 'src/other.ts', line: 9, severity: 'security', body: 'x' }],
      }),
      { reviewMode: 'update', changedFiles: ['src/app.ts'] },
    )

    expect(result.findings[0]?.severity).toBe('suggestion')
    expect(result.findings[0]?.actionability).toBe('optional')
    expect(result.inlineComments[0]?.severity).toBe('suggestion')
    expect(result.assessment).toBe('approve')
  })

  it('keeps in-delta gate findings gating during update reviews', () => {
    const result = applyAssessmentPolicy(
      policyOutput({
        assessment: 'approve',
        inlineComments: [{ file: 'src/app.ts', line: 3, severity: 'bug', body: 'regression' }],
      }),
      { reviewMode: 'update', changedFiles: ['src/app.ts'] },
    )
    expect(result.assessment).toBe('request_changes')
  })

  it('skips the delta downgrade when the changed-file list is unavailable', () => {
    const result = applyAssessmentPolicy(
      policyOutput({
        inlineComments: [{ file: 'src/other.ts', line: 9, severity: 'bug', body: 'x' }],
      }),
      { reviewMode: 'update', changedFiles: [] },
    )
    expect(result.inlineComments[0]?.severity).toBe('bug')
    expect(result.assessment).toBe('request_changes')
  })
})

describe('update-mode ensemble slimming', () => {
  const updateInstructions = baseInstructions.replace(
    'Review MR !1',
    'Review MR !1\n\nReview mode: consecutive update. Verify all files changed since previous reviewed SHA abc using diff abc...HEAD.',
  )

  it('fans out only delta finder roles and a single deep sample on update reviews', async () => {
    const sessionDirs: string[] = []
    const harness = createRoutingHarness((config) => {
      sessionDirs.push(config.sessionDir)
      if (config.sessionDir.includes('finder-')) {
        return createResult({ harness: 'codex', model: config.model }, emptyCandidateOutput())
      }
      return createResult({ harness: 'codex', model: config.model }, reviewOutput())
    })

    const ensemble = createEnsembleReviewHarness({ harnesses: { codex: harness } })
    const result = await ensemble.invoke({
      ...invokeConfig,
      instructions: updateInstructions,
    })

    expect(result.success).toBe(true)
    const finderDirs = sessionDirs.filter((dir) => dir.includes('finder-'))
    expect(finderDirs.some((dir) => dir.includes('diff-correctness'))).toBe(true)
    expect(finderDirs.some((dir) => dir.includes('cross-file-impact'))).toBe(true)
    expect(finderDirs.some((dir) => dir.includes('scenario-simulation'))).toBe(false)
    expect(finderDirs.some((dir) => dir.includes('tests-adequacy'))).toBe(false)
    expect(sessionDirs.filter((dir) => dir.includes('deep-')).length).toBe(1)
  })

  it('includes the update discipline instruction for synthesizers only in update mode', () => {
    const updateText = buildSynthesizerInstructions({
      baseInstructions: updateInstructions,
      candidates: [],
      deepDraft: null,
      reviewMode: 'update',
    })
    const initialText = buildSynthesizerInstructions({
      baseInstructions,
      candidates: [],
      deepDraft: null,
      reviewMode: 'initial',
    })
    expect(updateText).toContain('consecutive UPDATE review')
    expect(initialText).not.toContain('consecutive UPDATE review')
  })
})

describe('uncertain verification downgrade', () => {
  it('downgrades uncertain candidates to suggestion severity before synthesis', async () => {
    let synthesizerInstructions = ''
    const harness = createRoutingHarness((config) => {
      if (config.sessionDir.includes('finder-diff-correctness')) {
        return createResult({ harness: 'codex', model: config.model }, candidateOutput())
      }
      if (config.sessionDir.includes('finder-')) {
        return createResult({ harness: 'codex', model: config.model }, emptyCandidateOutput())
      }
      if (config.sessionDir.includes('verify')) {
        return createResult(
          { harness: 'codex', model: config.model },
          verificationOutput('uncertain'),
        )
      }
      if (config.sessionDir.includes('synthesizer')) {
        synthesizerInstructions = config.instructions
        return createResult({ harness: 'codex', model: config.model }, reviewOutput())
      }
      return createResult({ harness: 'codex', model: config.model }, reviewOutput())
    })

    const ensemble = createEnsembleReviewHarness({
      config: { deep_samples: 1 },
      harnesses: { codex: harness },
    })
    const result = await ensemble.invoke(invokeConfig)

    expect(result.success).toBe(true)
    expect(synthesizerInstructions).toContain('"severity": "suggestion"')
    expect(synthesizerInstructions).not.toContain('"severity": "bug"')
  })
})
