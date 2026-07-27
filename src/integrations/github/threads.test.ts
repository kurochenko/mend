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
                                path: 'src/app.ts',
                                line: 12,
                                originalLine: 10,
                                diffSide: 'RIGHT',
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
  })

  test('maps LEFT-side comments to the old file position and outdated comments to originalLine', async () => {
    const reviewThread = (comments: Record<string, unknown>[]) => ({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: 'thread-node',
                  isResolved: false,
                  comments: {
                    nodes: comments,
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    })
    const comment = (overrides: Record<string, unknown>) => ({
      id: 'comment-node',
      databaseId: 44,
      body: 'inline',
      author: { login: 'alice', databaseId: 7 },
      path: 'src/app.ts',
      ...overrides,
    })
    const fetchMock = mock()
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify(
              reviewThread([
                comment({ line: 8, originalLine: 8, diffSide: 'LEFT' }),
                comment({
                  id: 'comment-node-2',
                  databaseId: 45,
                  line: null,
                  originalLine: 15,
                  diffSide: 'RIGHT',
                }),
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
    expect(threads[0]?.messages[1]?.position).toEqual({
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

    await resolveThread(project, 'note_55')

    expect(fetchMock).not.toHaveBeenCalled()
  })
})
