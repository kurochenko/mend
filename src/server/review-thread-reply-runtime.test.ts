import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ProjectConfig } from '@/config'

const mockEnsureClone = mock(() => Promise.resolve('/tmp/clone'))
const mockCreateWorktree = mock<(...args: unknown[]) => Promise<string>>(() =>
  Promise.resolve('/tmp/worktree'),
)
const mockRemoveWorktree = mock(() => Promise.resolve())
const mockInvokePiReview = mock<
  (...args: unknown[]) => Promise<{ success: boolean; output: string }>
>(() => Promise.resolve({ success: true, output: 'reply body' }))

mock.module('@/integrations/repo', () => ({
  ensureClone: mockEnsureClone,
  createWorktree: mockCreateWorktree,
  removeWorktree: mockRemoveWorktree,
}))

mock.module('@/agents/pi-harness', () => ({
  invokePiReview: mockInvokePiReview,
}))

const { generateThreadReply } = await import('@/server/review-thread-reply')

const makeProject = (): ProjectConfig => ({
  key: 'test-project',
  platform: 'gitlab',
  url: 'https://gitlab.example.com',
  token: 'test-token',
  webhook_secret: 'secret',
  project_id: 1,
  repo_url: 'https://gitlab.example.com/test/repo.git',
  default_branch: 'main',
  clone_path: '/tmp/test',
  trigger: { mode: 'ready' },
  review: {
    llm: { model: 'test-model', thinking_level: 'medium' },
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
      model: 'test-model',
      thinking_level: 'minimal',
      timeout_ms: 45000,
      failure_policy: 'mixed',
    },
    comparison: { enabled: false, harness: 'opencode', timeout_ms: 300_000 },
    memory: { project_scope_usernames: [] },
    triage: { trusted_usernames: [] },
    fix: { enabled: false, automatic: false, max_loops: 3 },
  },
  tools: { context7: {} },
})

describe('generateThreadReply', () => {
  beforeEach(() => {
    mockEnsureClone.mockReset()
    mockCreateWorktree.mockReset()
    mockRemoveWorktree.mockReset()
    mockInvokePiReview.mockReset()

    mockEnsureClone.mockImplementation(() => Promise.resolve('/tmp/clone'))
    mockCreateWorktree.mockImplementation(() => Promise.resolve('/tmp/worktree'))
    mockRemoveWorktree.mockImplementation(() => Promise.resolve())
    mockInvokePiReview.mockImplementation(() =>
      Promise.resolve({ success: true, output: 'reply body' }),
    )
  })

  test('uses unique worktree suffix based on requestId', async () => {
    await generateThreadReply({
      project: makeProject(),
      mrIid: 42,
      requestId: 'note-999',
      sourceBranch: 'feature/test',
      commitSha: 'abc1234',
      filePath: 'src/app.ts',
      line: 10,
      originalFinding: 'Null check missing.',
      threadMessages: [],
      userQuestion: 'Why?',
    })

    expect(mockCreateWorktree).toHaveBeenCalledWith(
      expect.anything(),
      42,
      'feature/test',
      'abc1234',
      expect.objectContaining({ skipFetch: true, pathSuffix: 'reply-note-999' }),
    )
    expect(mockRemoveWorktree).toHaveBeenCalledWith(
      expect.anything(),
      42,
      expect.objectContaining({ pathSuffix: 'reply-note-999' }),
    )
  })

  test('retries worktree creation with fetch when local refs are stale', async () => {
    mockCreateWorktree
      .mockImplementationOnce(() => Promise.reject(new Error('missing local ref')))
      .mockImplementationOnce(() => Promise.resolve('/tmp/worktree'))

    await generateThreadReply({
      project: makeProject(),
      mrIid: 42,
      requestId: 'note-999',
      sourceBranch: 'feature/test',
      commitSha: 'abc1234',
      filePath: 'src/app.ts',
      line: 10,
      originalFinding: 'Null check missing.',
      threadMessages: [],
      userQuestion: 'Why?',
    })

    expect(mockCreateWorktree).toHaveBeenCalledTimes(2)
    expect(mockCreateWorktree.mock.calls[0]?.[4]).toEqual({
      skipFetch: true,
      pathSuffix: 'reply-note-999',
    })
    expect(mockCreateWorktree.mock.calls[1]?.[4]).toEqual({ pathSuffix: 'reply-note-999' })
  })
})
