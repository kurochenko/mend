import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { GitHubProjectConfig } from '@/config'
import { publishReviewBatch } from '@/integrations/github/publish'

const project = {
  key: 'repo',
  platform: 'github',
  url: 'https://github.com',
  token: 'token',
  webhook_secret: 'secret',
  repo: 'org/repo',
  repo_url: 'git@github.com:org/repo.git',
  default_branch: 'main',
  clone_path: '/tmp/repo',
  trigger: { mode: 'ready' },
  tools: { context7: {} },
  review: {
    llm: { model: 'model', thinking_level: 'medium' },
    agent: { harness: 'pi' },
    template: { prompt: 'auto', label_prefix: 'ai-review:' },
    flags: {
      prompt_templates_v2: true,
      schema_v2: true,
      structured_findings_post: true,
      structural_signals: true,
      bug_history: true,
      dry_run: false,
    },
    intent: {
      harness: 'pi',
      model: 'model',
      thinking_level: 'minimal',
      timeout_ms: 45_000,
      failure_policy: 'mixed',
    },
    comparison: { enabled: false, harness: 'opencode', timeout_ms: 300_000 },
    memory: { project_scope_usernames: [] },
    triage: { trusted_usernames: [] },
    fix: { enabled: false, automatic: false, max_loops: 3 },
  },
} satisfies GitHubProjectConfig

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('publishReviewBatch', () => {
  test('posts one inline review with right and left side anchors and summary note', async () => {
    const fetchMock = mock()
      .mockImplementationOnce(async () => new Response('[]'))
      .mockImplementationOnce(async () => new Response('{"id":99}'))
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              id: 100,
              body: 'summary',
              user: { id: 1, login: 'mend-bot' },
            }),
          ),
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await publishReviewBatch(project, {
      changeNumber: 1,
      projectKey: 'repo',
      reviewRunId: 'run-1',
      currentUser: { id: 1, username: 'mend-bot' },
      diffRefs: { baseSha: 'base', headSha: 'head' },
      classifyDraft: () => 'current_run',
      matchSummaryNote: () => undefined,
      summaryBody: 'summary',
      inlineDrafts: [
        { path: 'src/new.ts', body: 'new', anchor: { new_line: 5 }, logLabel: 'src/new.ts:5' },
        { path: 'src/old.ts', body: 'old', anchor: { old_line: 7 }, logLabel: 'src/old.ts:7' },
      ],
    })

    expect(result.summaryNoteId).toBe(100)
    const reviewInit = fetchMock.mock.calls[1]?.[1] as RequestInit
    if (typeof reviewInit.body !== 'string') {
      throw new Error('expected string request body')
    }
    expect(JSON.parse(reviewInit.body)).toEqual({
      commit_id: 'head',
      event: 'COMMENT',
      comments: [
        { path: 'src/new.ts', body: 'new', line: 5, side: 'RIGHT' },
        { path: 'src/old.ts', body: 'old', line: 7, side: 'LEFT' },
      ],
    })
  })

  test('skips review post when inline drafts are empty', async () => {
    const fetchMock = mock()
      .mockImplementationOnce(async () => new Response('[]'))
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              id: 100,
              body: 'summary',
              user: { id: 1, login: 'mend-bot' },
            }),
          ),
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await publishReviewBatch(project, {
      changeNumber: 1,
      projectKey: 'repo',
      reviewRunId: 'run-1',
      currentUser: { id: 1, username: 'mend-bot' },
      diffRefs: { baseSha: 'base', headSha: 'head' },
      classifyDraft: () => 'current_run',
      matchSummaryNote: () => undefined,
      summaryBody: 'summary',
      inlineDrafts: [],
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(`${fetchMock.mock.calls[1]?.[0]}`).toContain('/issues/1/comments')
  })

  test('refuses pending review comments from another mend run', async () => {
    const fetchMock = mock()
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify([{ id: 5, state: 'PENDING', user: { id: 1, login: 'mend-bot' } }]),
          ),
      )
      .mockImplementationOnce(async () => new Response('[{"id":6,"body":"other"}]'))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(
      publishReviewBatch(project, {
        changeNumber: 1,
        projectKey: 'repo',
        reviewRunId: 'run-1',
        currentUser: { id: 1, username: 'mend-bot' },
        diffRefs: { baseSha: 'base', headSha: 'head' },
        classifyDraft: () => 'mend_other_run',
        matchSummaryNote: () => undefined,
        summaryBody: 'summary',
        inlineDrafts: [],
      }),
    ).rejects.toThrow(
      'Refusing to publish review for repo PR #1: found 1 pending review comments (0 current-run, 1 other-run, 0 foreign)',
    )
  })
})
