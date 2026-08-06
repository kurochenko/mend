import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { loadConfig, parseProjectsFileConfig, type GitHubProjectConfig } from '@/config'
import { getDb } from '@/db/client'
import { getReviewFindingByProviderThreadId, upsertReviewFinding } from '@/db/review-findings'
import { reviewFindings, reviewMessages, reviewRuns, reviewThreads } from '@/db/schema'
import { getReviewThreadByProviderThreadId, upsertReviewThread } from '@/db/review-threads'
import { setReviewHarnessOverridesForTesting } from '@/agents/harness-overrides'
import type { ReviewAgentHarness } from '@/agents/review-harness'
import { createGitHubReviewProvider } from '@/integrations/provider/github'
import { createMastra } from '@/mastra/index'
import {
  applyBlockingReviewPolicy,
  collectExpectedPriorBlockerIds,
} from '@/mastra/review/blocking-policy'
import { buildPreviousReviewContext } from '@/mastra/review/previous-context'
import { postStepOutputSchema } from '@/mastra/review/run-result'
import { createGitlabWebhookRoute } from '@/server/gitlab-webhook'
import { hasActiveReviewWorkers } from '@/server/mr-review-queue'
import { STATUS_MARKER } from '@/server/status-note-body'
import { executeThreadResolutions } from '@/server/thread-resolution'
import { startFakeGitLab, type FakeGitLabServer } from './fake-gitlab'
import { connectTestDb, disconnectTestDb, truncateReviewFlowTables } from './helpers/db'
import { createTestGitOrigin, type TestGitOrigin } from './helpers/git'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const projectKey = 'e2e-project'
const webhookSecret = 'e2e-secret'
const githubProjectKey = 'github-e2e-project'

const reviewOutput = JSON.stringify({
  version: 'v2',
  assessment: 'request_changes',
  summary: 'The review flow found one inline issue and one summary finding.',
  findings: [
    {
      id: 'summary-new-feature',
      category: 'testing',
      severity: 'bug',
      actionability: 'required',
      scope: 'single_file',
      title: 'New feature needs coverage',
      body: 'The added feature module has no test coverage in this fixture.',
      files: ['src/new-feature.ts'],
      evidence: [
        {
          type: 'file_line',
          file: 'src/new-feature.ts',
          line: 1,
          note: 'The new module is introduced here.',
        },
      ],
    },
  ],
  inlineComments: [
    {
      file: 'src/app.ts',
      line: 2,
      severity: 'bug',
      body: 'Uppercasing the caller-provided name changes user-visible output.',
      suggestion: null,
    },
  ],
  resolutionVerdicts: [],
  meta: {
    templateId: 'mixed',
    intent: 'mixed',
    confidence: 1,
    selectionSource: 'fallback',
  },
})

const fakeHarness: ReviewAgentHarness = {
  id: 'pi',
  invoke: async (config) => ({
    harness: 'pi',
    model: config.model,
    success: true,
    output: reviewOutput,
    durationMs: 1,
    inspectedFiles: config.changedFiles ?? [],
  }),
}

const writeConfig = (root: string, fake: FakeGitLabServer, gitOrigin: TestGitOrigin): string => {
  const configPath = join(root, 'mend.yml')
  writeFileSync(
    configPath,
    [
      'projects:',
      `  ${projectKey}:`,
      '    platform: gitlab',
      `    url: ${fake.url}/test/project`,
      '    token: test-token',
      `    webhook_secret: ${webhookSecret}`,
      '    project_id: 1',
      `    repo_url: ${gitOrigin.originPath}`,
      '    default_branch: main',
      '    trigger:',
      '      mode: ready',
      '    review:',
      '      llm:',
      '        model: test/model',
      '        thinking_level: medium',
      '      agent:',
      '        harness: pi',
      '        model: test/model',
      '        thinking_level: minimal',
      '        timeout_ms: 1000',
      '      template:',
      '        prompt: auto',
      '        label_prefix: "ai-review:"',
      '      flags:',
      '        prompt_templates_v2: true',
      '        schema_v2: true',
      '        structured_findings_post: true',
      '        structural_signals: true',
      '        bug_history: true',
      '        dry_run: false',
      '      intent:',
      '        harness: pi',
      '        model: missing/model',
      '        thinking_level: minimal',
      '        timeout_ms: 1000',
      '        failure_policy: mixed',
      '      comparison:',
      '        enabled: false',
      '        harness: opencode',
      '        timeout_ms: 300000',
      '      memory:',
      '        project_scope_usernames: []',
      '      triage:',
      '        trusted_usernames: []',
      '      fix:',
      '        enabled: false',
      '        automatic: false',
      '        max_loops: 3',
      '    tools:',
      '      context7: {}',
      '',
    ].join('\n'),
  )
  return configPath
}

const makeMrPayload = (fake: FakeGitLabServer) => ({
  object_kind: 'merge_request' as const,
  project: { id: 1, name: 'e2e', web_url: `${fake.url}/test/project` },
  object_attributes: {
    iid: fake.state.mr.iid,
    title: fake.state.mr.title,
    description: fake.state.mr.description,
    labels: [],
    source_branch: fake.state.mr.sourceBranch,
    target_branch: fake.state.mr.targetBranch,
    state: 'opened',
    action: 'open',
    draft: false,
    url: fake.state.mr.webUrl,
    last_commit: { id: fake.state.mr.sha },
  },
  labels: [],
})

const makeGitHubProject = (url: string): GitHubProjectConfig => {
  const parsed = parseProjectsFileConfig({
    projects: {
      [githubProjectKey]: {
        platform: 'github',
        url,
        token: 'test-token',
        webhook_secret: 'test-secret',
        repo: 'org/repo',
        repo_url: `${url}/org/repo.git`,
        default_branch: 'main',
        trigger: { mode: 'ready' },
        tools: {},
        review: { llm: { model: 'test/model', thinking_level: 'medium' } },
      },
    },
  }).projects[githubProjectKey]

  if (parsed?.platform !== 'github') {
    throw new Error('GitHub E2E project config did not parse')
  }

  return { ...parsed, key: githubProjectKey, clone_path: '/tmp/github-e2e' }
}

const makeGitHubPreviousResult = () =>
  postStepOutputSchema.parse({
    version: 'v2',
    projectKey: githubProjectKey,
    mrIid: 42,
    reviewRunId: 'github-previous-run',
    url: 'https://github.example/org/repo/pull/42',
    commitSha: 'previous-sha',
    reviewMode: 'update',
    previousReviewedSha: 'older-sha',
    previousRunId: 'older-run',
    reviewIntent: 'mixed',
    reviewIntentConfidence: 1,
    reviewIntentRationale: ['test fixture'],
    reviewTemplateId: 'mixed',
    reviewTemplateSource: 'fallback',
    assessment: 'request_changes',
    summary: 'One previous blocker remains.',
    findings: [],
    inlineComments: [],
    resolutionVerdicts: [],
    featureFlags: {
      promptTemplatesV2: true,
      schemaV2: true,
      structuredFindingsPost: true,
      structuralSignals: true,
      bugHistory: true,
      dryRun: false,
    },
    reviewDiagnostics: {
      reviewMode: 'update',
      previousReviewedSha: 'older-sha',
      diffBaseRef: 'older-sha',
      changedFileCount: 1,
      diffExcerptChars: 100,
      diffTruncated: false,
      intentClassifierModel: 'test/model',
      intentClassifierDurationMs: 1,
      intentClassifierFailure: null,
      intentSecondaryIntents: [],
      agent: { harness: 'pi', model: 'test/model', durationMs: 1 },
      inspection: {
        files: ['src/github.ts'],
        changedFiles: ['src/github.ts'],
        changedFileCount: 1,
        changedFileCoverage: 1,
      },
      contextPackageDiagnostics: [],
      templateWarnings: [],
    },
    comparisonResult: null,
    threadedFindings: [
      {
        id: 'github-summary-blocker',
        category: 'correctness',
        severity: 'bug',
        actionability: 'required',
        scope: 'cross_file',
        title: 'GitHub summary blocker',
        body: 'The ordinary flow is broken.',
        files: ['src/github.ts'],
        evidence: [{ type: 'file_line', file: 'src/github.ts', line: 21 }],
        providerThreadId: 'note_55',
        providerMessageId: '55',
      },
    ],
    postDiagnostics: {
      findingsCount: 0,
      outOfScopeFindingCount: 0,
      inlineCommentCount: 0,
      outOfScopeInlineCount: 0,
      postedInlineCount: 0,
      preExistingDraftCount: 0,
      recoveredDraftCount: 0,
      draftRecoveryAction: 'none',
      skippedInlineReasons: {},
      resolvedThreadCount: 0,
      partiallyFixedThreadCount: 0,
      unmatchedVerdictCount: 0,
    },
    posted: 0,
    skipped: 0,
    reviewNumber: 2,
    summaryNoteId: 1,
  })

const waitFor = async <T>(probe: () => T | null, label: string): Promise<T> => {
  const deadline = Date.now() + 10_000

  for (;;) {
    const result = probe()
    if (result !== null) {
      return result
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const waitForSuccessfulRun = async (
  fake: FakeGitLabServer,
): Promise<typeof reviewRuns.$inferSelect> => {
  const deadline = Date.now() + 30_000
  let lastError = ''

  while (Date.now() < deadline) {
    const rows = await getDb()
      .select()
      .from(reviewRuns)
      .where(eq(reviewRuns.projectKey, projectKey))

    const row = rows[0]
    if (row?.status === 'success') {
      return row
    }

    if (row?.status === 'failed') {
      lastError = row.error ?? 'review run failed without an error'
      break
    }

    if (fake.state.unhandledRoutes.length > 0) {
      lastError = `unhandled fake GitLab routes: ${fake.state.unhandledRoutes.join(', ')}`
      break
    }

    await Bun.sleep(100)
  }

  throw new Error(lastError || 'timed out waiting for successful review run')
}

if (!testDatabaseUrl) {
  describe.skip('review flow e2e', () => {
    test('requires TEST_DATABASE_URL', () => {})
  })
} else {
  describe('review flow e2e', () => {
    let fake: FakeGitLabServer | null = null
    let gitOrigin: TestGitOrigin | null = null
    let githubServer: ReturnType<typeof Bun.serve> | null = null
    let root: string | null = null
    const originalCwd = process.cwd()
    const originalProjectsConfig = process.env.PROJECTS_CONFIG
    const originalDatabaseUrl = process.env.DATABASE_URL

    beforeAll(async () => {
      await connectTestDb(testDatabaseUrl)
    })

    afterAll(async () => {
      const deadline = Date.now() + 10_000
      while (hasActiveReviewWorkers() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      await disconnectTestDb()
    })

    beforeEach(async () => {
      await truncateReviewFlowTables()
      setReviewHarnessOverridesForTesting({ pi: fakeHarness })
    })

    afterEach(async () => {
      setReviewHarnessOverridesForTesting(undefined)
      process.chdir(originalCwd)
      if (originalProjectsConfig === undefined) {
        delete process.env.PROJECTS_CONFIG
      } else {
        process.env.PROJECTS_CONFIG = originalProjectsConfig
      }
      if (originalDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL
      } else {
        process.env.DATABASE_URL = originalDatabaseUrl
      }
      await fake?.stop()
      githubServer?.stop(true)
      gitOrigin?.cleanup()
      if (root) {
        rmSync(root, { recursive: true, force: true })
      }
      fake = null
      gitOrigin = null
      githubServer = null
      root = null
      await truncateReviewFlowTables()
    })

    test('reviews an MR from webhook through queue, workflow, posting, and persistence', async () => {
      root = mkdtempSync(join(tmpdir(), 'mend-e2e-review-flow-'))
      mkdirSync(join(root, 'workspaces'), { recursive: true })
      gitOrigin = createTestGitOrigin()
      fake = startFakeGitLab({
        mr: {
          iid: 42,
          title: 'Review flow e2e',
          description: 'Exercise the review flow end to end.',
          labels: [],
          sourceBranch: gitOrigin.sourceBranch,
          sourceProjectId: 1,
          targetBranch: gitOrigin.targetBranch,
          targetProjectId: 1,
          webUrl: 'http://gitlab.example.invalid/test/project/-/merge_requests/42',
          sha: gitOrigin.headSha,
          diffRefs: {
            base_sha: gitOrigin.baseSha,
            head_sha: gitOrigin.headSha,
            start_sha: gitOrigin.startSha,
          },
          changes: gitOrigin.changedFiles.map((file) => ({ old_path: file, new_path: file })),
        },
      })

      process.chdir(root)
      process.env.PROJECTS_CONFIG = writeConfig(root, fake, gitOrigin)
      process.env.DATABASE_URL = testDatabaseUrl

      const config = loadConfig()
      const mastra = createMastra(config)
      const app = new Hono()
      app.route('/webhooks/gitlab', createGitlabWebhookRoute(config, mastra))

      const response = await app.request(`/webhooks/gitlab/${projectKey}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Gitlab-Token': webhookSecret,
          'X-Gitlab-Event': 'Merge Request Hook',
        },
        body: JSON.stringify(makeMrPayload(fake)),
      })

      expect(response.status).toBe(200)
      const run = await waitForSuccessfulRun(fake)

      expect(fake.state.unhandledRoutes).toEqual([])

      const fakeState = fake.state
      const completedStatusNote = await waitFor(() => {
        const statusNotes = fakeState.notes.filter((note) => note.body.includes(STATUS_MARKER))
        return statusNotes.length === 1 && statusNotes[0]?.body.includes('Completed')
          ? statusNotes[0]
          : null
      }, 'status note updated to Completed')
      expect(completedStatusNote.body).toContain('Completed')

      const inlineDiscussion = fake.state.discussions.find((discussion) =>
        discussion.notes[0]?.body.includes('Uppercasing the caller-provided name'),
      )
      expect(inlineDiscussion?.notes[0]?.position).toMatchObject({
        new_path: 'src/app.ts',
        old_path: 'src/app.ts',
        new_line: 2,
      })
      expect(fake.state.published).toHaveLength(1)
      expect(fake.state.published[0]?.draftNoteIds).toHaveLength(2)
      expect(fake.state.draftNotes).toHaveLength(0)

      const summaryNote = fake.state.notes.find((note) =>
        note.body.includes('<!-- mend:summary -->'),
      )
      expect(summaryNote?.body).toContain(
        'Review found 2 release- or development-blocking defects.',
      )
      expect(summaryNote?.body).not.toContain('The review flow found one inline issue')

      const summaryFindingDiscussion = fake.state.discussions.find((discussion) =>
        discussion.notes[0]?.body.includes('New feature needs coverage'),
      )
      expect(summaryFindingDiscussion).toBeDefined()

      const findingRows = await getDb()
        .select()
        .from(reviewFindings)
        .where(eq(reviewFindings.projectKey, projectKey))
      const threadRows = await getDb()
        .select()
        .from(reviewThreads)
        .where(eq(reviewThreads.projectKey, projectKey))

      expect(run.status).toBe('success')
      expect(run.commitSha).toBe(gitOrigin.headSha)
      expect(findingRows).toHaveLength(2)
      expect(threadRows.length).toBeGreaterThanOrEqual(2)
      expect(findingRows.map((row) => row.reviewRunId)).toEqual([run.id, run.id])
    })

    test('persists a fixed GitHub pseudo-thread finding without re-gating the next update', async () => {
      const comments = [
        {
          id: 55,
          body: 'Original Mend finding',
          user: { id: 1, login: 'mend-bot' },
          created_at: '2026-08-06T12:00:00Z',
          updated_at: '2026-08-06T12:00:00Z',
        },
      ]
      githubServer = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: async (request) => {
          const url = new URL(request.url)
          if (request.method === 'POST' && url.pathname === '/api/graphql') {
            return Response.json({
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      nodes: [],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                },
              },
            })
          }
          if (url.pathname === '/api/v3/repos/org/repo/issues/42/comments') {
            if (request.method === 'POST') {
              const payload = (await request.json()) as { body: string }
              const reply = {
                id: 56,
                body: payload.body,
                user: { id: 1, login: 'mend-bot' },
                created_at: '2026-08-06T12:05:00Z',
                updated_at: '2026-08-06T12:05:00Z',
              }
              comments.push(reply)
              return Response.json(reply, { status: 201 })
            }
            if (request.method === 'GET') {
              return Response.json(comments)
            }
          }
          return new Response('not found', { status: 404 })
        },
      })

      const project = makeGitHubProject(`http://127.0.0.1:${githubServer.port}`)
      const previousResult = makeGitHubPreviousResult()
      await getDb().insert(reviewRuns).values({
        id: 'github-previous-run',
        projectKey: githubProjectKey,
        mrIid: 42,
        commitSha: 'previous-sha',
        model: 'test/model',
        source: 'webhook',
        status: 'success',
        input: {},
        result: previousResult,
      })
      const thread = await upsertReviewThread({
        provider: 'github',
        projectKey: githubProjectKey,
        repoExternalId: 'org/repo',
        reviewExternalId: 42,
        reviewRunId: 'github-previous-run',
        threadKind: 'summary_finding',
        subjectType: 'general',
        findingFingerprint: 'summary_finding:github-summary-blocker',
        status: 'open',
        providerThreadId: 'note_55',
      })
      await upsertReviewFinding({
        projectKey: githubProjectKey,
        mrIid: 42,
        reviewRunId: 'github-previous-run',
        threadId: thread.id,
        provider: 'github',
        providerThreadId: 'note_55',
        providerNoteId: '55',
        metadata: {
          kind: 'finding',
          finding: previousResult.threadedFindings[0],
        },
      })

      const stats = await executeThreadResolutions({
        provider: createGitHubReviewProvider(project),
        mrIid: 42,
        reviewRunId: 'github-fixed-run',
        unmatchedVerdictCount: 0,
        resolutions: [
          {
            previousFindingId: 'finding:note_55',
            discussionId: 'note_55',
            status: 'fixed',
            replyBody: 'Verified as fixed in `fixed-sha`: ordinary usage now succeeds.',
            markResolved: true,
          },
        ],
      })

      const persistedFinding = await getReviewFindingByProviderThreadId({
        provider: 'github',
        providerThreadId: 'note_55',
      })
      const persistedThread = await getReviewThreadByProviderThreadId({
        provider: 'github',
        providerThreadId: 'note_55',
      })
      const persistedReplies = await getDb()
        .select()
        .from(reviewMessages)
        .where(eq(reviewMessages.threadId, thread.id))
      const nextContext = await buildPreviousReviewContext({
        project,
        mrIid: 42,
        previousRunId: 'github-previous-run',
      })
      const expectedPriorBlockerIds = collectExpectedPriorBlockerIds(nextContext)
      const nextReview = applyBlockingReviewPolicy(
        {
          version: 'v2',
          assessment: 'request_changes',
          summary: 'Previous blocker status pending.',
          findings: [],
          inlineComments: [],
          resolutionVerdicts: [],
        },
        expectedPriorBlockerIds,
      )

      expect(comments).toHaveLength(2)
      expect(persistedReplies).toHaveLength(1)
      expect(persistedFinding?.state).toBe('resolved')
      expect(persistedThread?.status).toBe('open')
      expect(stats).toEqual({
        resolvedThreadCount: 0,
        partiallyFixedThreadCount: 1,
        unmatchedVerdictCount: 0,
      })
      expect(nextContext?.findings).toContainEqual(
        expect.objectContaining({ identity: 'finding:note_55', resolved: true }),
      )
      expect(expectedPriorBlockerIds).toEqual([])
      expect(nextReview.assessment).toBe('approve')
    })
  })
}
