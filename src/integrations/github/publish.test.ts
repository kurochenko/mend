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
      .mockImplementationOnce(async () => new Response('[]'))
      .mockImplementationOnce(async () => new Response('{"id":99}'))
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
    const reviewInit = fetchMock.mock.calls[2]?.[1] as RequestInit
    if (typeof reviewInit.body !== 'string') {
      throw new Error('expected string request body')
    }
    expect(JSON.parse(reviewInit.body)).toEqual({
      commit_id: 'head',
      body: '<!-- mend:draft-run:run-1 -->',
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

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(`${fetchMock.mock.calls[2]?.[0]}`).toContain('/issues/1/comments')
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

  test('refuses pending reviews owned by another user', async () => {
    const fetchMock = mock().mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify([{ id: 5, state: 'PENDING', user: { id: 2, login: 'another-reviewer' } }]),
        ),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(
      publishReviewBatch(project, {
        changeNumber: 1,
        projectKey: 'repo',
        reviewRunId: 'run-1',
        currentUser: { id: 1, username: 'mend-bot' },
        diffRefs: { baseSha: 'base', headSha: 'head' },
        classifyDraft: () => 'current_run',
        matchSummaryNote: () => undefined,
        summaryBody: 'summary',
        inlineDrafts: [],
      }),
    ).rejects.toThrow(
      'Refusing to publish review for repo PR #1: found 1 pending review comments (0 current-run, 0 other-run, 1 foreign)',
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('refuses to delete unmarked empty pending reviews', async () => {
    const classifyDraft = mock(() => 'foreign' as const)
    const fetchMock = mock()
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify([
              { id: 5, state: 'PENDING', body: '', user: { id: 1, login: 'mend-bot' } },
            ]),
          ),
      )
      .mockImplementationOnce(async () => new Response('[]'))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(
      publishReviewBatch(project, {
        changeNumber: 1,
        projectKey: 'repo',
        reviewRunId: 'run-1',
        currentUser: { id: 1, username: 'mend-bot' },
        diffRefs: { baseSha: 'base', headSha: 'head' },
        classifyDraft,
        matchSummaryNote: () => undefined,
        summaryBody: 'summary',
        inlineDrafts: [],
      }),
    ).rejects.toThrow(
      'Refusing to publish review for repo PR #1: found 1 pending review comments (0 current-run, 0 other-run, 1 foreign)',
    )
    expect(classifyDraft).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('refuses pending review with foreign top-level body and zero comments', async () => {
    const fetchMock = mock()
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify([
              {
                id: 5,
                state: 'PENDING',
                body: 'Unrelated pending review body',
                user: { id: 1, login: 'mend-bot' },
              },
            ]),
          ),
      )
      .mockImplementationOnce(async () => new Response('[]'))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(
      publishReviewBatch(project, {
        changeNumber: 1,
        projectKey: 'repo',
        reviewRunId: 'run-1',
        currentUser: { id: 1, username: 'mend-bot' },
        diffRefs: { baseSha: 'base', headSha: 'head' },
        classifyDraft: () => 'foreign',
        matchSummaryNote: () => undefined,
        summaryBody: 'summary',
        inlineDrafts: [],
      }),
    ).rejects.toThrow(
      'Refusing to publish review for repo PR #1: found 1 pending review comments (0 current-run, 0 other-run, 1 foreign)',
    )
  })

  test('deletes pending review with current-run top-level body and zero comments', async () => {
    const classifyDraft = mock((body: string) =>
      body === 'Current run pending review body' ? 'current_run' : 'foreign',
    )
    const fetchMock = mock()
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify([
              {
                id: 5,
                state: 'PENDING',
                body: 'Current run pending review body',
                user: { id: 1, login: 'mend-bot' },
              },
            ]),
          ),
      )
      .mockImplementationOnce(async () => new Response('[]'))
      .mockImplementationOnce(async () => new Response(null, { status: 204 }))
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

    const result = await publishReviewBatch(project, {
      changeNumber: 1,
      projectKey: 'repo',
      reviewRunId: 'run-1',
      currentUser: { id: 1, username: 'mend-bot' },
      diffRefs: { baseSha: 'base', headSha: 'head' },
      classifyDraft,
      matchSummaryNote: () => undefined,
      summaryBody: 'summary',
      inlineDrafts: [],
    })

    expect(result).toMatchObject({
      preExistingDraftCount: 1,
      recoveredDraftCount: 1,
      draftRecoveryAction: 'cleaned',
      summaryNoteId: 100,
    })
    expect(classifyDraft).toHaveBeenCalledWith('Current run pending review body')
    const deleteCall = fetchMock.mock.calls[2]
    if (!deleteCall) {
      throw new Error('expected pending review delete call')
    }
    expect(`${deleteCall[0]}`).toContain('/pulls/1/reviews/5')
    expect((deleteCall[1] as RequestInit).method).toBe('DELETE')
  })

  test('reuses an already submitted inline review before creating the summary', async () => {
    const fetchMock = mock()
      .mockImplementationOnce(async () => new Response('[]'))
      .mockImplementationOnce(async () => new Response('[{"id":9,"body":"inline"}]'))
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
        { path: 'src/new.ts', body: 'inline', anchor: { new_line: 5 }, logLabel: 'src/new.ts:5' },
      ],
    })

    expect(result.summaryNoteId).toBe(100)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(`${fetchMock.mock.calls[3]?.[0]}`).toContain('/issues/1/comments')
  })

  test('requires one published comment for each duplicate draft body', async () => {
    const fetchMock = mock()
      .mockImplementationOnce(async () => new Response('[]'))
      .mockImplementationOnce(async () => new Response('[{"id":9,"body":"same"}]'))
      .mockImplementationOnce(async () => new Response('{"id":99}'))
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
      inlineDrafts: [
        { path: 'src/a.ts', body: 'same', anchor: { new_line: 1 }, logLabel: 'src/a.ts:1' },
        { path: 'src/b.ts', body: 'same', anchor: { new_line: 2 }, logLabel: 'src/b.ts:2' },
      ],
    })

    const reviewInit = fetchMock.mock.calls[2]?.[1] as RequestInit
    if (typeof reviewInit.body !== 'string') {
      throw new Error('expected string request body')
    }
    expect(JSON.parse(reviewInit.body).comments).toHaveLength(2)
  })

  test('reuses an existing summary before creating another comment', async () => {
    const fetchMock = mock()
      .mockImplementationOnce(async () => new Response('[]'))
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify([
              {
                id: 100,
                body: 'summary',
                user: { id: 1, login: 'mend-bot' },
              },
            ]),
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
      matchSummaryNote: (notes) => notes.find((note) => note.body === 'summary'),
      summaryBody: 'summary',
      inlineDrafts: [],
    })

    expect(result).toMatchObject({ summaryNoteId: 100, summaryReconciled: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('reconciles an ambiguous summary create without retrying the mutation', async () => {
    const fetchMock = mock()
      .mockImplementationOnce(async () => new Response('[]'))
      .mockImplementationOnce(async () => new Response('[]'))
      .mockImplementationOnce(async () => new Response('temporary failure', { status: 500 }))
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify([
              {
                id: 100,
                body: 'summary',
                user: { id: 1, login: 'mend-bot' },
              },
            ]),
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
      matchSummaryNote: (notes) => notes.find((note) => note.body === 'summary'),
      summaryBody: 'summary',
      inlineDrafts: [],
    })

    expect(result).toMatchObject({ summaryNoteId: 100, summaryReconciled: true })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})
