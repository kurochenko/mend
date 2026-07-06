import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { GitHubProjectConfig } from '@/config'
import { listThreads } from '@/integrations/github/threads'

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
          position: { path: 'src/app.ts', oldPath: 'src/app.ts', line: 12, oldLine: 10 },
        },
      ],
    })
    expect(threads[1]).toMatchObject({
      id: 'note_55',
      isThread: false,
      messages: [{ id: '55', body: 'summary', resolvable: false, position: null }],
    })
  })
})
