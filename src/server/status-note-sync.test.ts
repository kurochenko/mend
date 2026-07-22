import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { MrStatusNoteRecord } from '@/db/status-notes'
import type { GitLabClient } from '@/integrations/gitlab/client'
import type { GitLabUser, MrNote } from '@/integrations/gitlab/notes'
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

const makeNote = (id: number, authorId = 100): MrNote => ({
  id,
  body: `status ${STATUS_MARKER}`,
  author: { id: authorId, username: `user-${authorId}` },
})

const makeGitLabClient = (notes: MrNote[] = []): GitLabClient => {
  const currentUser: GitLabUser = { id: 100, username: 'mend-bot' }

  return {
    fetchCurrentUser: mock(() => Promise.resolve(currentUser)),
    listMrNotes: mock(() => Promise.resolve(notes)),
    listMrDraftNotes: mock(() => Promise.resolve([])),
    createDraftNote: mock(() => Promise.resolve({ id: 1 })),
    deleteDraftNote: mock(() => Promise.resolve()),
    publishDraftNote: mock(() => Promise.resolve()),
    bulkPublishDrafts: mock(() => Promise.resolve()),
    createMrNote: mock((_mrIid: number, body: string) =>
      Promise.resolve({
        id: 9,
        body,
        author: currentUser,
      }),
    ),
    updateMrNote: mock((_mrIid: number, noteId: number, body: string) =>
      Promise.resolve({
        id: noteId,
        body,
        author: currentUser,
      }),
    ),
    deleteMrNote: mock(() => Promise.resolve()),
    listMrDiscussions: mock(() => Promise.resolve([])),
    createDiscussion: mock(() =>
      Promise.resolve({ id: 'discussion-1', individual_note: false, notes: [], raw: {} }),
    ),
    replyToDiscussion: mock(() =>
      Promise.resolve({
        id: 1,
        body: '',
        author: { id: currentUser.id, username: currentUser.username, raw: currentUser },
        resolvable: false,
        raw: {},
      }),
    ),
    resolveDiscussion: mock(() => Promise.resolve()),
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
    const gitlab = makeGitLabClient()

    await upsertStatusNote({
      input: { state: 'queued', event: makeEvent() },
      dependencies: { gitlab, ...dependencies },
    })

    expect(gitlab.createMrNote).toHaveBeenCalledWith(42, 'rendered status body')
    expect(markMrStatusNoteSynced).toHaveBeenCalledWith({ id: 'status-1', noteId: 9 })
  })

  test('updates an existing persisted status note id', async () => {
    const gitlab = makeGitLabClient()
    upsertDesiredMrStatusNote.mockImplementation(() =>
      Promise.resolve(makeStatusRecord({ noteId: 7, syncAction: 'update' })),
    )

    await upsertStatusNote({
      input: { state: 'running', event: makeEvent() },
      dependencies: { gitlab, ...dependencies },
    })

    expect(gitlab.updateMrNote).toHaveBeenCalledWith(42, 7, 'rendered status body')
    expect(gitlab.createMrNote).not.toHaveBeenCalled()
    expect(markMrStatusNoteSynced).toHaveBeenCalledWith({ id: 'status-1', noteId: 7 })
  })

  test('reuses newest matching remote status note and deletes duplicates', async () => {
    const gitlab = makeGitLabClient([makeNote(1), makeNote(3), makeNote(2, 200)])

    await upsertStatusNote({
      input: { state: 'queued', event: makeEvent() },
      dependencies: { gitlab, ...dependencies },
    })

    expect(gitlab.updateMrNote).toHaveBeenCalledWith(42, 3, 'rendered status body')
    expect(gitlab.deleteMrNote).toHaveBeenCalledWith(42, 1)
    expect(gitlab.deleteMrNote).not.toHaveBeenCalledWith(42, 2)
    expect(gitlab.createMrNote).not.toHaveBeenCalled()
    expect(markMrStatusNoteSynced).toHaveBeenCalledWith({ id: 'status-1', noteId: 3 })
  })

  test('recreates local note binding after recoverable update failure', async () => {
    const gitlab = makeGitLabClient()
    upsertDesiredMrStatusNote.mockImplementation(() =>
      Promise.resolve(makeStatusRecord({ noteId: 7, syncAction: 'update' })),
    )
    ;(gitlab.updateMrNote as ReturnType<typeof mock>).mockImplementationOnce(() =>
      Promise.reject(new Error('GitLab API 404 PUT /notes/7')),
    )

    await upsertStatusNote({
      input: { state: 'running', event: makeEvent() },
      dependencies: { gitlab, ...dependencies },
    })

    expect(markMrStatusNoteForCreate).toHaveBeenCalledWith('status-1')
    expect(gitlab.createMrNote).toHaveBeenCalledWith(42, 'rendered status body')
    expect(markMrStatusNoteSynced).toHaveBeenCalledWith({ id: 'status-1', noteId: 9 })
  })
})

describe('syncStatusNote', () => {
  test('returns false without throwing when sync fails', async () => {
    const gitlab = makeGitLabClient()
    ;(gitlab.createMrNote as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.reject(new Error('GitLab API 500 POST /notes')),
    )

    await expect(
      syncStatusNote({
        input: { state: 'queued', event: makeEvent() },
        dependencies: { gitlab, ...dependencies },
      }),
    ).resolves.toBe(false)
  })
})
