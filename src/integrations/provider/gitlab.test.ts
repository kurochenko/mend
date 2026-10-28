import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { GitLabProjectConfig } from '@/config'
import { createGitLabReviewProvider } from '@/integrations/provider/gitlab'
import type { DraftClassification, ProviderNote } from '@/integrations/provider/types'

const project = {
  key: 'repo',
  platform: 'gitlab',
  url: 'https://gitlab.com',
  token: 'token',
  webhook_secret: 'secret',
  project_id: 'org/provider-gitlab-test',
  repo_url: 'git@gitlab.com:org/repo.git',
  default_branch: 'main',
  clone_path: '/tmp/repo',
  trigger: { mode: 'ready' },
  tools: { context7: {} },
  review: {
    llm: { model: 'model', thinking_level: 'medium' },
    agent: { harness: 'pi' },
    flags: {
      structured_findings_post: true,
      structural_signals: true,
      bug_history: true,
      dry_run: false,
    },
    comparison: { enabled: false, harness: 'opencode', timeout_ms: 300_000 },
    memory: { project_scope_usernames: [] },
  },
} satisfies GitLabProjectConfig

const BOT_USER_ID = 7
const projectPath = '/api/v4/projects/org%2Fprovider-gitlab-test'

interface RecordedRequest {
  method: string
  path: string
}

type RouteHandler = (request: RecordedRequest) => Response | Promise<Response>

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const json = (value: unknown): Response => new Response(JSON.stringify(value))

const installRoutes = (routes: Record<string, RouteHandler>): RecordedRequest[] => {
  const requests: RecordedRequest[] = []
  globalThis.fetch = mock(async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    const request = { method: init?.method ?? 'GET', path: `${url.pathname}${url.search}` }
    requests.push(request)
    const key = `${request.method} ${url.pathname.replace(projectPath, '')}`
    const handler = routes[key]
    if (!handler) {
      throw new Error(`unexpected request ${key}`)
    }
    return await handler(request)
  }) as unknown as typeof fetch
  return requests
}

const classifyDraft = (body: string): DraftClassification => {
  if (body.includes('run:current')) {
    return 'current_run'
  }
  return body.includes('run:') ? 'mend_other_run' : 'foreign'
}

const summaryNote = (id: number): ProviderNote => ({
  id,
  body: 'summary run:current',
  author: { id: BOT_USER_ID, username: 'mend-bot' },
})

const matchSummaryNote = (notes: ProviderNote[]): ProviderNote | undefined =>
  notes.find((note) => note.body === 'summary run:current')

const publishParams = {
  changeNumber: 5,
  projectKey: 'repo',
  reviewRunId: 'current',
  inlineDrafts: [],
  diffRefs: { baseSha: 'base', headSha: 'head', startSha: 'start' },
  classifyDraft,
}

const summaryParams = { changeNumber: 5, body: 'summary run:current', matchSummaryNote }

const userRoute = (): Response => json({ id: BOT_USER_ID, username: 'mend-bot' })

describe('GitLab publishReviewBatch draft recovery', () => {
  test('deletes leftover bot-authored Mend drafts from earlier runs and publishes', async () => {
    const requests = installRoutes({
      'GET /merge_requests/5/draft_notes': () =>
        json([
          { id: 11, note: 'stale run:old', author_id: BOT_USER_ID },
          { id: 12, note: 'retry run:current', author_id: BOT_USER_ID },
        ]),
      'GET /api/v4/user': userRoute,
      'DELETE /merge_requests/5/draft_notes/11': () => new Response(null, { status: 204 }),
      'DELETE /merge_requests/5/draft_notes/12': () => new Response(null, { status: 204 }),
    })

    const result = await createGitLabReviewProvider(project).publishReviewBatch(publishParams)

    expect(result).toMatchObject({
      preExistingDraftCount: 2,
      recoveredDraftCount: 2,
      draftRecoveryAction: 'cleaned',
    })
    expect(requests.filter((request) => request.method === 'DELETE')).toHaveLength(2)
  })

  test('refuses to publish when a Mend-marked draft was authored by another user', async () => {
    const requests = installRoutes({
      'GET /merge_requests/5/draft_notes': () =>
        json([
          { id: 11, note: 'stale run:old', author_id: BOT_USER_ID },
          { id: 12, note: 'copied run:old', author_id: 42 },
        ]),
      'GET /api/v4/user': userRoute,
    })

    await expect(
      createGitLabReviewProvider(project).publishReviewBatch(publishParams),
    ).rejects.toThrow('(0 current-run, 1 other-run, 1 foreign)')
    expect(requests.filter((request) => request.method !== 'GET')).toHaveLength(0)
  })

  test('refuses to publish when a bot-authored draft has no Mend markers', async () => {
    const requests = installRoutes({
      'GET /merge_requests/5/draft_notes': () =>
        json([{ id: 11, note: 'manual note', author_id: BOT_USER_ID }]),
      'GET /api/v4/user': userRoute,
    })

    await expect(
      createGitLabReviewProvider(project).publishReviewBatch(publishParams),
    ).rejects.toThrow('(0 current-run, 0 other-run, 1 foreign)')
    expect(requests.filter((request) => request.method !== 'GET')).toHaveLength(0)
  })
})

describe('GitLab publishSummaryNote', () => {
  test('reuses an existing summary note for the run without creating another', async () => {
    const requests = installRoutes({
      'GET /merge_requests/5/notes': () => json([summaryNote(77)]),
    })

    const result = await createGitLabReviewProvider(project).publishSummaryNote(summaryParams)

    expect(result).toEqual({ id: 77, reconciled: true })
    expect(requests.some((request) => request.method === 'POST')).toBe(false)
  })

  test('does not retry an ambiguous summary create and reconciles from the note list', async () => {
    let noteListCount = 0
    const requests = installRoutes({
      'GET /merge_requests/5/notes': () => {
        noteListCount += 1
        return json(noteListCount === 1 ? [] : [summaryNote(88)])
      },
      'POST /merge_requests/5/notes': () => new Response('bad gateway', { status: 502 }),
    })

    const result = await createGitLabReviewProvider(project).publishSummaryNote(summaryParams)

    expect(result).toEqual({ id: 88, reconciled: true })
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1)
  })
})

describe('GitLab fetchDiffRefsForCommit', () => {
  test('returns the diff refs of the MR version whose head is the reviewed commit', async () => {
    installRoutes({
      'GET /merge_requests/5/versions': (request) =>
        request.path.endsWith('page=1')
          ? new Response(
              JSON.stringify([
                { head_commit_sha: 'newer', base_commit_sha: 'base2', start_commit_sha: 'start2' },
              ]),
              { headers: { 'x-next-page': '2' } },
            )
          : json([
              {
                head_commit_sha: 'reviewed',
                base_commit_sha: 'base1',
                start_commit_sha: 'start1',
              },
            ]),
    })

    await expect(
      createGitLabReviewProvider(project).fetchDiffRefsForCommit(5, 'reviewed'),
    ).resolves.toEqual({ baseSha: 'base1', headSha: 'reviewed', startSha: 'start1' })
  })

  test('returns null when no MR version matches the reviewed commit', async () => {
    installRoutes({
      'GET /merge_requests/5/versions': () =>
        json([{ head_commit_sha: 'other', base_commit_sha: 'base', start_commit_sha: 'start' }]),
    })

    await expect(
      createGitLabReviewProvider(project).fetchDiffRefsForCommit(5, 'reviewed'),
    ).resolves.toBeNull()
  })
})
