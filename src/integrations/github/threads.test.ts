import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { GitHubProjectConfig } from '@/config'
import { listThreads, resolveThread } from '@/integrations/github/threads'

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

describe('listThreads', () => {
  test('maps review threads and issue comment pseudo-threads', async () => {
    const fetchMock = mock()
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      nodes: [
                        {
                          id: 'thread-node',
                          isResolved: true,
                          path: 'src/app.ts',
                          line: 12,
                          originalLine: 10,
                          startLine: null,
                          diffSide: 'RIGHT',
                          comments: {
                            nodes: [
                              {
                                id: 'comment-node',
                                databaseId: 44,
                                body: 'inline',
                                author: { login: 'alice', databaseId: 7 },
                                createdAt: '2026-01-01T00:00:00Z',
                                updatedAt: '2026-01-01T00:00:01Z',
                                url: 'https://github.com/org/repo/pull/1#discussion_r44',
                              },
                            ],
                            pageInfo: { hasNextPage: false, endCursor: null },
                          },
                        },
                      ],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                },
              },
            }),
          ),
      )
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify([
              {
                id: 55,
                body: 'summary',
                user: { id: 8, login: 'bob' },
                created_at: '2026-01-02T00:00:00Z',
                updated_at: '2026-01-02T00:00:01Z',
              },
            ]),
          ),
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const threads = await listThreads(project, 1)

    expect(threads[0]).toMatchObject({
      id: 'thread-node',
      isThread: true,
      messages: [
        {
          id: '44',
          body: 'inline',
          resolvable: true,
          resolved: true,
          position: { path: 'src/app.ts', oldPath: 'src/app.ts', line: 12, oldLine: null },
        },
      ],
    })
    expect(threads[1]).toMatchObject({
      id: 'note_55',
      isThread: false,
      messages: [{ id: '55', body: 'summary', resolvable: false, position: null }],
    })

    const graphqlInit = fetchMock.mock.calls[0]?.[1] as RequestInit
    if (typeof graphqlInit.body !== 'string') {
      throw new Error('expected GraphQL request body')
    }
    const query = JSON.parse(graphqlInit.body).query as string
    const commentsStart = query.indexOf('comments(first: 100)')
    const commentsEnd = query.indexOf('pageInfo', commentsStart)
    expect(query.slice(0, commentsStart)).toContain('diffSide')
    expect(query.slice(commentsStart, commentsEnd)).not.toContain('diffSide')
  })

  test('maps LEFT-side comments to the old file position and outdated comments to originalLine', async () => {
    const reviewThreads = (nodes: Record<string, unknown>[]) => ({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes,
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    })
    const comment = (id: number) => ({
      id: `comment-node-${id}`,
      databaseId: id,
      body: 'inline',
      author: { login: 'alice', databaseId: 7 },
    })
    const thread = (overrides: Record<string, unknown>, id: number) => ({
      id: `thread-node-${id}`,
      isResolved: false,
      path: 'src/app.ts',
      ...overrides,
      comments: {
        nodes: [comment(id)],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    })
    const fetchMock = mock()
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify(
              reviewThreads([
                thread({ line: 8, originalLine: 8, startLine: null, diffSide: 'LEFT' }, 44),
                thread(
                  {
                    line: null,
                    originalLine: 15,
                    startLine: null,
                    diffSide: 'RIGHT',
                  },
                  45,
                ),
              ]),
            ),
          ),
      )
      .mockImplementationOnce(async () => new Response(JSON.stringify([])))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const threads = await listThreads(project, 1)

    expect(threads[0]?.messages[0]?.position).toEqual({
      path: 'src/app.ts',
      oldPath: 'src/app.ts',
      line: null,
      oldLine: 8,
    })
    expect(threads[1]?.messages[0]?.position).toEqual({
      path: 'src/app.ts',
      oldPath: 'src/app.ts',
      line: 15,
      oldLine: null,
    })
  })

  test('paginates thread comments beyond the first page', async () => {
    const comment = (id: number) => ({
      id: `comment-node-${id}`,
      databaseId: id,
      body: `comment ${id}`,
      author: { login: 'alice', databaseId: 7 },
      path: 'src/app.ts',
      line: id,
      originalLine: id,
      diffSide: 'RIGHT',
    })
    const fetchMock = mock()
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      nodes: [
                        {
                          id: 'thread-node',
                          isResolved: false,
                          path: 'src/app.ts',
                          line: 1,
                          originalLine: 1,
                          startLine: null,
                          diffSide: 'RIGHT',
                          comments: {
                            nodes: [comment(1)],
                            pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
                          },
                        },
                      ],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                },
              },
            }),
          ),
      )
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                node: {
                  comments: {
                    nodes: [comment(2)],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            }),
          ),
      )
      .mockImplementationOnce(async () => new Response(JSON.stringify([])))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const threads = await listThreads(project, 1)

    expect(threads[0]?.messages.map((message) => message.body)).toEqual(['comment 1', 'comment 2'])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

describe('resolveThread', () => {
  test('treats issue comment pseudo-threads as a no-op without API calls', async () => {
    const fetchMock = mock()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(resolveThread(project, 'note_55')).resolves.toBe(false)

    expect(fetchMock).not.toHaveBeenCalled()
  })
})
