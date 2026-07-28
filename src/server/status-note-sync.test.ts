import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { MrStatusNoteRecord } from '@/db/status-notes'
import type { ReviewProvider } from '@/integrations/provider/client'
import { ProviderApiError } from '@/integrations/provider/error'
import type { ProviderNote, ProviderUser } from '@/integrations/provider/types'
import type { MrReviewRequestEvent } from '@/lib/review-events'
import { STATUS_MARKER } from '@/server/status-note-body'
import { syncStatusNote, upsertStatusNote } from '@/server/status-note-sync'

const createdAt = new Date('2026-07-03T00:00:00.000Z')

const makeEvent = (): MrReviewRequestEvent => ({
  projectKey: 'test-project',
  mrIid: 42,
  title: 'Test MR',
  description: 'A test merge request',
  labels: [],
  sourceBranch: 'feature/test',
  targetBranch: 'main',
  url: 'https://gitlab.example.com/test/-/merge_requests/42',
})

const makeStatusRecord = (overrides: Partial<MrStatusNoteRecord> = {}): MrStatusNoteRecord => ({
  id: 'status-1',
  projectKey: 'test-project',
  mrIid: 42,
  noteId: null,
  renderedBody: 'status note body',
  renderedBodyHash: 'hash',
  syncAction: 'create',
  lastSyncedAt: null,
  createdAt,
  updatedAt: createdAt,
  ...overrides,
})

const makeNote = (id: number, authorId = 100): ProviderNote => ({
  id,
  body: `status ${STATUS_MARKER}`,
  author: { id: authorId, username: `user-${authorId}` },
})

const makeProvider = (notes: ProviderNote[] = []): ReviewProvider => {
  const currentUser: ProviderUser = { id: 100, username: 'mend-bot' }

  return {
    kind: 'gitlab',
    fetchCurrentUser: mock(() => Promise.resolve(currentUser)),
    fetchChangeRequest: mock(async () => {
      throw new Error('unused')
    }),
    fetchDiffRefs: mock(async () => ({ baseSha: 'base', headSha: 'head', startSha: 'start' })),
    fetchChangedFiles: mock(async () => []),
    listNotes: mock(() => Promise.resolve(notes)),
    createNote: mock((_mrIid: number, body: string) =>
      Promise.resolve({
        id: 9,
        body,
        author: currentUser,
      }),
    ),
    updateNote: mock((_mrIid: number, noteId: number, body: string) =>
      Promise.resolve({
        id: noteId,
        body,
        author: currentUser,
      }),
    ),
    deleteNote: mock(() => Promise.resolve()),
    listThreads: mock(() => Promise.resolve([])),
    getThread: mock(async () => ({ id: 'thread-1', isThread: true, messages: [], raw: {} })),
    createThread: mock(async () => ({ id: 'thread-1', isThread: true, messages: [], raw: {} })),
    replyToThread: mock(async () => ({
      id: '1',
      body: '',
      author: { id: currentUser.id, username: currentUser.username, raw: currentUser },
      resolvable: false,
      position: null,
      raw: {},
    })),
    resolveThread: mock(() => Promise.resolve(true)),
    addNoteReaction: mock(() => Promise.resolve()),
    addThreadMessageReaction: mock(() => Promise.resolve()),
    publishReviewBatch: mock(async () => ({
      preExistingDraftCount: 0,
      recoveredDraftCount: 0,
      draftRecoveryAction: 'none' as const,
      summaryNoteId: 1,
      summaryReconciled: false,
    })),
  }
}

const buildStatusNoteBody = mock(() => Promise.resolve('rendered status body'))
const upsertDesiredMrStatusNote = mock(() => Promise.resolve(makeStatusRecord()))
const markMrStatusNoteSynced = mock((params: { id: string; noteId: number }) =>
  Promise.resolve(makeStatusRecord({ noteId: params.noteId, syncAction: 'none' })),
)
const markMrStatusNoteForCreate = mock((id: string) =>
  Promise.resolve(makeStatusRecord({ id, noteId: null, syncAction: 'create' })),
)

const dependencies = {
  buildStatusNoteBody,
  upsertDesiredMrStatusNote,
  markMrStatusNoteSynced,
  markMrStatusNoteForCreate,
}

beforeEach(() => {
  buildStatusNoteBody.mockClear()
  upsertDesiredMrStatusNote.mockClear()
  markMrStatusNoteSynced.mockClear()
  markMrStatusNoteForCreate.mockClear()

  buildStatusNoteBody.mockImplementation(() => Promise.resolve('rendered status body'))
  upsertDesiredMrStatusNote.mockImplementation(() => Promise.resolve(makeStatusRecord()))
  markMrStatusNoteSynced.mockImplementation((params) =>
    Promise.resolve(makeStatusRecord({ noteId: params.noteId, syncAction: 'none' })),
  )
  markMrStatusNoteForCreate.mockImplementation((id) =>
    Promise.resolve(makeStatusRecord({ id, noteId: null, syncAction: 'create' })),
  )
})

describe('upsertStatusNote', () => {
  test('creates a new status note when no local or remote note exists', async () => {
    const provider = makeProvider()

    await upsertStatusNote({
      input: { state: 'queued', event: makeEvent() },
      dependencies: { provider, ...dependencies },
    })

    expect(provider.createNote).toHaveBeenCalledWith(42, 'rendered status body')
    expect(markMrStatusNoteSynced).toHaveBeenCalledWith({ id: 'status-1', noteId: 9 })
  })

  test('updates an existing persisted status note id', async () => {
    const provider = makeProvider()
    upsertDesiredMrStatusNote.mockImplementation(() =>
      Promise.resolve(makeStatusRecord({ noteId: 7, syncAction: 'update' })),
    )

    await upsertStatusNote({
      input: { state: 'running', event: makeEvent() },
      dependencies: { provider, ...dependencies },
    })

    expect(provider.updateNote).toHaveBeenCalledWith(42, 7, 'rendered status body')
    expect(provider.createNote).not.toHaveBeenCalled()
    expect(markMrStatusNoteSynced).toHaveBeenCalledWith({ id: 'status-1', noteId: 7 })
  })

  test('reuses newest matching remote status note and deletes duplicates', async () => {
    const provider = makeProvider([makeNote(1), makeNote(3), makeNote(2, 200)])

    await upsertStatusNote({
      input: { state: 'queued', event: makeEvent() },
      dependencies: { provider, ...dependencies },
    })

    expect(provider.updateNote).toHaveBeenCalledWith(42, 3, 'rendered status body')
    expect(provider.deleteNote).toHaveBeenCalledWith(42, 1)
    expect(provider.deleteNote).not.toHaveBeenCalledWith(42, 2)
    expect(provider.createNote).not.toHaveBeenCalled()
    expect(markMrStatusNoteSynced).toHaveBeenCalledWith({ id: 'status-1', noteId: 3 })
  })

  test('recreates local note binding after recoverable update failure', async () => {
    const provider = makeProvider()
    upsertDesiredMrStatusNote.mockImplementation(() =>
      Promise.resolve(makeStatusRecord({ noteId: 7, syncAction: 'update' })),
    )
    ;(provider.updateNote as ReturnType<typeof mock>).mockImplementationOnce(() =>
      Promise.reject(
        new ProviderApiError({
          message: 'GitLab API 404 PUT /notes/7',
          status: 404,
          method: 'PUT',
        }),
      ),
    )

    await upsertStatusNote({
      input: { state: 'running', event: makeEvent() },
      dependencies: { provider, ...dependencies },
    })

    expect(markMrStatusNoteForCreate).toHaveBeenCalledWith('status-1')
    expect(provider.createNote).toHaveBeenCalledWith(42, 'rendered status body')
    expect(markMrStatusNoteSynced).toHaveBeenCalledWith({ id: 'status-1', noteId: 9 })
  })

  test('recreates local note binding after recoverable patch update failure', async () => {
    const provider = makeProvider()
    upsertDesiredMrStatusNote.mockImplementation(() =>
      Promise.resolve(makeStatusRecord({ noteId: 7, syncAction: 'update' })),
    )
    ;(provider.updateNote as ReturnType<typeof mock>).mockImplementationOnce(() =>
      Promise.reject(
        new ProviderApiError({
          message: 'GitHub API 403 PATCH /issues/comments/7',
          status: 403,
          method: 'PATCH',
        }),
      ),
    )

    await upsertStatusNote({
      input: { state: 'running', event: makeEvent() },
      dependencies: { provider, ...dependencies },
    })

    expect(markMrStatusNoteForCreate).toHaveBeenCalledWith('status-1')
    expect(provider.createNote).toHaveBeenCalledWith(42, 'rendered status body')
    expect(markMrStatusNoteSynced).toHaveBeenCalledWith({ id: 'status-1', noteId: 9 })
  })
})

describe('syncStatusNote', () => {
  test('returns false without throwing when sync fails', async () => {
    const provider = makeProvider()
    ;(provider.createNote as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.reject(new Error('GitLab API 500 POST /notes')),
    )

    await expect(
      syncStatusNote({
        input: { state: 'queued', event: makeEvent() },
        dependencies: { provider, ...dependencies },
      }),
    ).resolves.toBe(false)
  })
})
