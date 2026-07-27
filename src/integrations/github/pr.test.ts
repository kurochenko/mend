import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { GitHubProjectConfig } from '@/config'
import { fetchChangedFiles, fetchDiffRefs, fetchPr } from '@/integrations/github/pr'

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

describe('fetchPr', () => {
  test('returns the source repository needed for safe fix routing', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            title: 'PR',
            body: '',
            labels: [],
            head: {
              ref: 'feature/fix',
              sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              repo: { full_name: 'contributor/repo' },
            },
            base: {
              ref: 'main',
              sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            },
            html_url: 'https://github.com/org/repo/pull/42',
          }),
        ),
    ) as unknown as typeof fetch

    const result = await fetchPr(project, 42)

    expect(result.sourceRepository).toBe('contributor/repo')
  })
})

describe('fetchDiffRefs', () => {
  test('maps base and head SHAs without a start SHA', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            title: 'PR',
            body: '',
            labels: [],
            head: { ref: 'feature/fix', sha: 'a'.repeat(40), repo: { full_name: 'org/repo' } },
            base: { ref: 'main', sha: 'b'.repeat(40) },
            html_url: 'https://github.com/org/repo/pull/42',
          }),
        ),
    ) as unknown as typeof fetch

    const result = await fetchDiffRefs(project, 42)

    expect(result).toEqual({ baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40) })
  })
})

describe('fetchChangedFiles', () => {
  test('returns changed file names across pages', async () => {
    const fetchMock = mock()
      .mockImplementationOnce(
        async () =>
          new Response(JSON.stringify([{ filename: 'src/a.ts' }]), {
            status: 200,
            headers: {
              Link: '<https://api.github.com/repos/org/repo/pulls/42/files?page=2>; rel="next"',
            },
          }),
      )
      .mockImplementationOnce(
        async () => new Response(JSON.stringify([{ filename: 'src/b.ts' }]), { status: 200 }),
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await fetchChangedFiles(project, 42)

    expect(result).toEqual(['src/a.ts', 'src/b.ts'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
