import { describe, expect, it } from 'bun:test'
import { parseDiff } from '@/lib/diff'
import { buildPostPlan, dedupeInlineComments } from '@/mastra/review/publish-plan'
import type { DiffRefs } from '@/integrations/provider/types'
import type { PostStepInput } from '@/mastra/review/run-result'
import type { ReviewFinding, ReviewInlineComment } from '@/mastra/review/schema'
import { buildInlineThreadFingerprint } from '@/lib/review-threads'
import { formatCommentBody } from '@/mastra/review/formatting'

const diffRefs: DiffRefs = {
  baseSha: 'base',
  startSha: 'start',
  headSha: 'head',
}

const baseDiagnostics = {
  reviewMode: 'initial' as const,
  previousReviewedSha: null,
  diffBaseRef: 'base',
  changedFileCount: 1,
  diffExcerptChars: 100,
  diffTruncated: false,
  intentClassifierModel: 'test',
  intentClassifierDurationMs: 1,
  intentClassifierFailure: null,
  intentSecondaryIntents: [],
  agent: { harness: 'pi' as const, model: 'test', durationMs: 1 },
  inspection: {
    files: [],
    changedFiles: ['src/app.ts'],
    changedFileCount: 1,
    changedFileCoverage: 1,
  },
  contextPackageDiagnostics: [],
  templateWarnings: [],
}

const makeInput = (
  params: {
    findings?: ReviewFinding[]
    inlineComments?: ReviewInlineComment[]
    resolutionVerdicts?: PostStepInput['resolutionVerdicts']
  } = {},
): PostStepInput => ({
  version: 'v2',
  assessment: 'request_changes',
  summary: 'Summary',
  findings: params.findings ?? [],
  inlineComments: params.inlineComments ?? [],
  resolutionVerdicts: params.resolutionVerdicts ?? [],
  meta: {
    templateId: 'bugfix',
    intent: 'bugfix',
    confidence: 1,
    selectionSource: 'classifier',
  },
  projectKey: 'demo',
  mrIid: 1,
  reviewRunId: 'run-1',
  url: 'https://gitlab.example/mr/1',
  worktreePath: '/tmp/worktree',
  targetBranch: 'main',
  commitSha: 'head',
  reviewMode: 'initial',
  previousReviewedSha: null,
  previousRunId: null,
  reviewIntent: 'bugfix',
  reviewIntentConfidence: 1,
  reviewIntentRationale: [],
  reviewTemplateId: 'bugfix',
  reviewTemplateSource: 'classifier',
  featureFlags: {
    promptTemplatesV2: true,
    schemaV2: true,
    structuredFindingsPost: true,
    structuralSignals: true,
    bugHistory: true,
    dryRun: false,
  },
  reviewDiagnostics: baseDiagnostics,
  comparisonResult: null,
  activeReviewMemoryEntries: [],
})

const inlineComment = (params: Partial<ReviewInlineComment> = {}): ReviewInlineComment => ({
  file: params.file ?? 'src/app.ts',
  line: params.line ?? 2,
  severity: params.severity ?? 'bug',
  body: params.body ?? 'The changed line is wrong.',
  suggestion: params.suggestion,
})

const finding = (params: Partial<ReviewFinding> = {}): ReviewFinding => ({
  id: params.id ?? 'finding-1',
  category: params.category ?? 'correctness',
  severity: params.severity ?? 'bug',
  actionability: params.actionability ?? 'required',
  scope: params.scope ?? 'single_file',
  title: params.title ?? 'Finding title',
  body: params.body ?? 'Finding body',
  files: params.files ?? ['src/app.ts'],
  evidence: params.evidence ?? [{ type: 'file_line', file: 'src/app.ts', line: 2 }],
})

const mrDiff = parseDiff(`diff --git a/src/app.ts b/src/app.ts
@@ -10,3 +1,3 @@
 old context
-old value
+new value
 unchanged
`)

describe('dedupeInlineComments', () => {
  it('removes identical inline comments while preserving order', () => {
    const first = inlineComment()
    const duplicate = inlineComment()
    const withSuggestion = inlineComment({ suggestion: 'const x = 1' })

    expect(dedupeInlineComments([first, duplicate, withSuggestion])).toEqual([
      first,
      withSuggestion,
    ])
  })
})

describe('buildPostPlan', () => {
  it('scope guard skips out-of-scope inline comments with the existing skip reason', () => {
    const plan = buildPostPlan({
      input: makeInput({ inlineComments: [inlineComment({ file: 'src/other.ts' })] }),
      diffRefs,
      diffMap: mrDiff,
      changedFiles: ['src/app.ts'],
      reviewNumber: 1,
      existingPublishedThreads: [],
    })

    expect(plan.outOfScopeInlineComments).toHaveLength(1)
    expect(plan.diagnostics.skippedInlineReasons).toEqual({ out_of_scope_file: 1 })
  })

  it('records line_not_in_diff when an inline comment cannot be positioned', () => {
    const plan = buildPostPlan({
      input: makeInput({ inlineComments: [inlineComment({ line: 99 })] }),
      diffRefs,
      diffMap: mrDiff,
      changedFiles: ['src/app.ts'],
      reviewNumber: 1,
      existingPublishedThreads: [],
    })

    expect(plan.inlineDrafts).toHaveLength(0)
    expect(plan.diagnostics.skippedInlineReasons).toEqual({ line_not_in_diff: 1 })
    expect(plan.findingDiscussions[0]?.previousFindingId).toBe('src/app.ts:99')
  })

  it('dedupes planned inline comments and findings against existing open published threads', () => {
    const comment = inlineComment()
    const commentFingerprint = buildInlineThreadFingerprint(
      comment.file,
      comment.line,
      formatCommentBody(comment),
    )
    const plan = buildPostPlan({
      input: makeInput({ inlineComments: [comment], findings: [finding()] }),
      diffRefs,
      diffMap: mrDiff,
      changedFiles: ['src/app.ts'],
      reviewNumber: 1,
      existingPublishedThreads: [
        { findingFingerprint: commentFingerprint, status: 'open' },
        { findingFingerprint: 'summary_finding:finding-1', status: 'open' },
      ],
    })

    expect(plan.inlineComments).toHaveLength(0)
    expect(plan.findings).toHaveLength(0)
    expect(plan.diagnostics.dedupedExistingThreadCount).toBe(2)
    expect(plan.diagnostics.suppressedResolvedThreadCount).toBe(0)
  })

  it('suppresses resolved inline, skipped-inline, and finding fingerprints separately', () => {
    const positionedComment = inlineComment()
    const outOfScopeComment = inlineComment({
      file: 'src/other.ts',
      line: 9,
      body: 'The out-of-scope line is wrong.',
    })
    const positionedFingerprint = buildInlineThreadFingerprint(
      positionedComment.file,
      positionedComment.line,
      formatCommentBody(positionedComment),
    )
    const outOfScopeFingerprint = buildInlineThreadFingerprint(
      outOfScopeComment.file,
      outOfScopeComment.line,
      formatCommentBody(outOfScopeComment),
    )
    const plan = buildPostPlan({
      input: makeInput({
        inlineComments: [positionedComment, outOfScopeComment],
        findings: [finding()],
      }),
      diffRefs,
      diffMap: mrDiff,
      changedFiles: ['src/app.ts'],
      reviewNumber: 1,
      existingPublishedThreads: [
        { findingFingerprint: positionedFingerprint, status: 'resolved' },
        { findingFingerprint: outOfScopeFingerprint, status: 'resolved' },
        { findingFingerprint: 'summary_finding:finding-1', status: 'resolved' },
      ],
    })

    expect(plan.inlineComments).toHaveLength(0)
    expect(plan.outOfScopeInlineComments).toHaveLength(0)
    expect(plan.findings).toHaveLength(0)
    expect(plan.findingDiscussions).toHaveLength(0)
    expect(plan.diagnostics.dedupedExistingThreadCount).toBe(0)
    expect(plan.diagnostics.suppressedResolvedThreadCount).toBe(3)
    expect(plan.diagnostics.skippedInlineReasons).toEqual({ resolved_thread: 2 })
  })

  it('suppresses inline comments matching active MR memory anchors', () => {
    const plan = buildPostPlan({
      input: {
        ...makeInput({ inlineComments: [inlineComment()] }),
        activeReviewMemoryEntries: [
          {
            scope: 'mr',
            status: 'active',
            matchPath: 'src/app.ts',
            matchLine: 2,
            instruction: 'Do not re-raise this concern again on this merge request.',
          },
        ],
      },
      diffRefs,
      diffMap: mrDiff,
      changedFiles: ['src/app.ts'],
      reviewNumber: 1,
      existingPublishedThreads: [],
    })

    expect(plan.inlineComments).toHaveLength(0)
    expect(plan.inlineDrafts).toHaveLength(0)
    expect(plan.findingDiscussions).toHaveLength(0)
    expect(plan.diagnostics.skippedInlineReasons).toEqual({ suppressed_by_memory: 1 })
  })

  it('uses the MR-base diff map for deletion-anchored position numbers', () => {
    const updateBaseDiff = parseDiff(`diff --git a/src/app.ts b/src/app.ts
@@ -20,3 +1,3 @@
 old context
-old value
+new value
 unchanged
`)

    const updateBasePlan = buildPostPlan({
      input: makeInput({ inlineComments: [inlineComment({ line: 1 })] }),
      diffRefs,
      diffMap: updateBaseDiff,
      changedFiles: ['src/app.ts'],
      reviewNumber: 1,
      existingPublishedThreads: [],
    })
    const mrBasePlan = buildPostPlan({
      input: makeInput({ inlineComments: [inlineComment({ line: 1 })] }),
      diffRefs,
      diffMap: mrDiff,
      changedFiles: ['src/app.ts'],
      reviewNumber: 1,
      existingPublishedThreads: [],
    })

    expect(updateBasePlan.inlineDrafts[0]?.anchor.old_line).toBe(20)
    expect(mrBasePlan.inlineDrafts[0]?.anchor.old_line).toBe(10)
  })

  it('publishes a structured finding at its first valid diff evidence line', () => {
    const plan = buildPostPlan({
      input: makeInput({
        findings: [
          finding({
            id: 'owner-scoped-identity',
            scope: 'cross_file',
            evidence: [
              { type: 'file_line', file: 'src/app.ts', line: 99 },
              { type: 'file_line', file: 'src/app.ts', line: 2 },
            ],
          }),
        ],
      }),
      diffRefs,
      diffMap: mrDiff,
      changedFiles: ['src/app.ts'],
      reviewNumber: 1,
      existingPublishedThreads: [],
    })

    expect(plan.inlineDrafts).toHaveLength(1)
    expect(plan.inlineDrafts[0]).toMatchObject({
      source: { kind: 'finding', index: 0 },
      path: 'src/app.ts',
      line: 2,
      fingerprint: 'summary_finding:owner-scoped-identity',
      anchor: { new_line: 2 },
    })
    expect(plan.inlineDrafts[0]?.markedBody).toContain(
      '<!-- mend:summary-finding {"fingerprint":"summary_finding:owner-scoped-identity"',
    )
    expect(plan.findingDiscussions).toHaveLength(0)
    expect(plan.diagnostics.postedInlineCount).toBe(1)
  })

  it('keeps a structured finding as a discussion when no evidence line is in the diff', () => {
    const plan = buildPostPlan({
      input: makeInput({
        findings: [finding({ evidence: [{ type: 'file_line', file: 'src/app.ts', line: 99 }] })],
      }),
      diffRefs,
      diffMap: mrDiff,
      changedFiles: ['src/app.ts'],
      reviewNumber: 1,
      existingPublishedThreads: [],
    })

    expect(plan.inlineDrafts).toHaveLength(0)
    expect(plan.findingDiscussions).toHaveLength(1)
    expect(plan.findingDiscussions[0]?.previousFindingId).toBe('finding-1')
  })

  it('does not publish structured findings when structured finding posting is disabled', () => {
    const input = makeInput({ findings: [finding()] })
    const plan = buildPostPlan({
      input: {
        ...input,
        featureFlags: { ...input.featureFlags, structuredFindingsPost: false },
      },
      diffRefs,
      diffMap: mrDiff,
      changedFiles: ['src/app.ts'],
      reviewNumber: 1,
      existingPublishedThreads: [],
    })

    expect(plan.inlineDrafts).toHaveLength(0)
    expect(plan.findingDiscussions).toHaveLength(0)
  })

  it('maps typed verdict identities to the exact provider thread before posting', () => {
    const plan = buildPostPlan({
      input: makeInput({
        resolutionVerdicts: [
          {
            previousFindingId: 'finding:discussion-finding',
            status: 'fixed',
            explanation: 'The structured blocker is fixed.',
          },
          {
            previousFindingId: 'inline:discussion-a',
            status: 'fixed',
            explanation: 'The first inline blocker is fixed.',
          },
          {
            previousFindingId: 'inline:discussion-b',
            status: 'partially_fixed',
            explanation: 'The second inline blocker remains incomplete.',
          },
        ],
      }),
      diffRefs,
      diffMap: mrDiff,
      changedFiles: ['src/app.ts'],
      reviewNumber: 2,
      existingPublishedThreads: [],
      previousContext: {
        findings: [
          {
            identity: 'finding:discussion-finding',
            id: 'same-human-id',
            discussionId: 'discussion-finding',
            resolved: false,
          },
        ],
        inlineComments: [
          {
            identity: 'inline:discussion-a',
            file: 'src/app.ts',
            line: 2,
            discussionId: 'discussion-a',
            resolved: false,
          },
          {
            identity: 'inline:discussion-b',
            file: 'src/app.ts',
            line: 2,
            discussionId: 'discussion-b',
            resolved: false,
          },
        ],
      },
    })

    expect(plan.threadResolutions).toEqual([
      expect.objectContaining({
        previousFindingId: 'finding:discussion-finding',
        discussionId: 'discussion-finding',
        markResolved: true,
      }),
      expect.objectContaining({
        previousFindingId: 'inline:discussion-a',
        discussionId: 'discussion-a',
        markResolved: true,
      }),
      expect.objectContaining({
        previousFindingId: 'inline:discussion-b',
        discussionId: 'discussion-b',
        markResolved: false,
      }),
    ])
    expect(plan.unmatchedVerdictCount).toBe(0)
  })
})
