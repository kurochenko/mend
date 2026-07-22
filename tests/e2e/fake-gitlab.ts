import { Hono } from 'hono'

interface FakeGitLabUser {
  id: number
  username: string
}

interface FakeMr {
  iid: number
  title: string
  description: string
  labels: string[]
  sourceBranch: string
  targetBranch: string
  webUrl: string
  sha: string
  diffRefs: {
    base_sha: string
    head_sha: string
    start_sha: string
  }
  changes: Array<{
    old_path: string
    new_path: string
  }>
}

export interface FakeDraftNote {
  id: number
  note: string
  body: string
  position?: unknown
}

export interface FakeNote {
  id: number
  body: string
  author: FakeGitLabUser
  created_at: string
  updated_at: string
}

export interface FakeDiscussionNote {
  id: number
  body: string
  author: FakeGitLabUser
  type: string | null
  resolvable: boolean
  resolved: boolean
  created_at: string
  updated_at: string
  url: string
  position?: unknown
}

export interface FakeDiscussion {
  id: string
  individual_note: boolean
  notes: FakeDiscussionNote[]
}

export interface FakeGitLabState {
  user: FakeGitLabUser
  mr: FakeMr
  draftNotes: FakeDraftNote[]
  notes: FakeNote[]
  discussions: FakeDiscussion[]
  published: Array<{ mrIid: number; draftNoteIds: number[] }>
  reactions: Array<{ path: string; name: string }>
  unhandledRoutes: string[]
}

export interface FakeGitLabServer {
  url: string
  state: FakeGitLabState
  stop: () => Promise<void>
}

interface StartFakeGitLabParams {
  mr: FakeMr
}

const now = (): string => new Date().toISOString()

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const parseJson = async (request: Request): Promise<Record<string, unknown>> => {
  if (request.method === 'GET' || request.method === 'DELETE') {
    return {}
  }

  const text = await request.text()
  if (!text) {
    return {}
  }

  const parsed = JSON.parse(text)
  return parsed && typeof parsed === 'object' ? parsed : {}
}

const stringField = (value: unknown): string => (typeof value === 'string' ? value : '')

const noteUrl = (mrIid: number, noteId: number): string =>
  `http://gitlab.example.invalid/mr/${mrIid}#note_${noteId}`

const createDiscussionFromDraft = (
  state: FakeGitLabState,
  mrIid: number,
  draft: FakeDraftNote,
): FakeDiscussion => {
  const id = `discussion-${state.discussions.length + 1}`
  const timestamp = now()
  return {
    id,
    individual_note: false,
    notes: [
      {
        id: draft.id,
        body: draft.body,
        author: state.user,
        type: 'DiffNote',
        resolvable: true,
        resolved: false,
        created_at: timestamp,
        updated_at: timestamp,
        url: noteUrl(mrIid, draft.id),
        position: draft.position,
      },
    ],
  }
}

const createNote = (state: FakeGitLabState, body: string): FakeNote => {
  const id = 10_000 + state.notes.length + 1
  const timestamp = now()
  return {
    id,
    body,
    author: state.user,
    created_at: timestamp,
    updated_at: timestamp,
  }
}

const createDiscussion = (state: FakeGitLabState, mrIid: number, body: string): FakeDiscussion => {
  const id = `discussion-${state.discussions.length + 1}`
  const noteId = 20_000 + state.discussions.length + 1
  const timestamp = now()
  return {
    id,
    individual_note: false,
    notes: [
      {
        id: noteId,
        body,
        author: state.user,
        type: null,
        resolvable: true,
        resolved: false,
        created_at: timestamp,
        updated_at: timestamp,
        url: noteUrl(mrIid, noteId),
      },
    ],
  }
}

const toGitLabMr = (mr: FakeMr) => ({
  title: mr.title,
  description: mr.description,
  labels: mr.labels,
  source_branch: mr.sourceBranch,
  target_branch: mr.targetBranch,
  web_url: mr.webUrl,
  sha: mr.sha,
  diff_refs: mr.diffRefs,
})

const routeRequest = async (state: FakeGitLabState, request: Request): Promise<Response> => {
  const url = new URL(request.url)
  const route = `${request.method} ${url.pathname}${url.search}`
  const path = url.pathname
  const projectPrefix = /^\/api\/v4\/projects\/([^/]+)\/merge_requests\/(\d+)(.*)$/.exec(path)

  if (request.method === 'GET' && path === '/api/v4/user') {
    return json(state.user)
  }

  if (!projectPrefix) {
    state.unhandledRoutes.push(route)
    return json({ error: `Unhandled fake GitLab route: ${route}` }, 404)
  }

  const mrIid = Number(projectPrefix[2])
  const suffix = projectPrefix[3] ?? ''

  if (mrIid !== state.mr.iid) {
    return json({ error: `unknown MR !${mrIid}` }, 404)
  }

  if (request.method === 'GET' && suffix === '') {
    return json(toGitLabMr(state.mr))
  }

  if (request.method === 'GET' && suffix === '/changes') {
    return json({ changes: state.mr.changes })
  }

  if (request.method === 'GET' && suffix === '/draft_notes') {
    return json(state.draftNotes)
  }

  if (request.method === 'POST' && suffix === '/draft_notes') {
    const body = await parseJson(request)
    const id = 1_000 + state.draftNotes.length + 1
    const note = stringField(body.note)
    const draft = { id, note, body: note, position: body.position }
    state.draftNotes.push(draft)
    return json({ id })
  }

  if (request.method === 'DELETE' && /^\/draft_notes\/\d+$/.test(suffix)) {
    const noteId = Number(suffix.split('/').at(-1))
    state.draftNotes = state.draftNotes.filter((draft) => draft.id !== noteId)
    return new Response(null, { status: 204 })
  }

  if (request.method === 'PUT' && /^\/draft_notes\/\d+\/publish$/.test(suffix)) {
    const noteId = Number(suffix.split('/').at(-2))
    const draft = state.draftNotes.find((candidate) => candidate.id === noteId)
    if (draft) {
      state.discussions.push(createDiscussionFromDraft(state, mrIid, draft))
      state.draftNotes = state.draftNotes.filter((candidate) => candidate.id !== noteId)
      state.published.push({ mrIid, draftNoteIds: [noteId] })
    }
    return new Response(null, { status: 204 })
  }

  if (request.method === 'POST' && suffix === '/draft_notes/bulk_publish') {
    const draftNoteIds = state.draftNotes.map((draft) => draft.id)
    for (const draft of state.draftNotes) {
      state.discussions.push(createDiscussionFromDraft(state, mrIid, draft))
    }
    state.draftNotes = []
    state.published.push({ mrIid, draftNoteIds })
    return new Response(null, { status: 204 })
  }

  if (request.method === 'GET' && suffix === '/notes') {
    return json(state.notes)
  }

  if (request.method === 'POST' && suffix === '/notes') {
    const body = await parseJson(request)
    const note = createNote(state, stringField(body.body))
    state.notes.push(note)
    return json(note)
  }

  if (request.method === 'PUT' && /^\/notes\/\d+$/.test(suffix)) {
    const noteId = Number(suffix.split('/').at(-1))
    const body = await parseJson(request)
    const note = state.notes.find((candidate) => candidate.id === noteId)
    if (!note) {
      return json({ error: `unknown note ${noteId}` }, 404)
    }
    note.body = stringField(body.body)
    note.updated_at = now()
    return json(note)
  }

  if (request.method === 'DELETE' && /^\/notes\/\d+$/.test(suffix)) {
    const noteId = Number(suffix.split('/').at(-1))
    state.notes = state.notes.filter((note) => note.id !== noteId)
    return new Response(null, { status: 204 })
  }

  if (request.method === 'POST' && /^\/notes\/\d+\/award_emoji$/.test(suffix)) {
    const body = await parseJson(request)
    const name = stringField(body.name)
    state.reactions.push({ path: suffix, name })
    return json({ name })
  }

  if (request.method === 'GET' && suffix === '/discussions') {
    return json(state.discussions)
  }

  if (request.method === 'POST' && suffix === '/discussions') {
    const body = await parseJson(request)
    const discussion = createDiscussion(state, mrIid, stringField(body.body))
    state.discussions.push(discussion)
    return json(discussion)
  }

  const discussionMatch = /^\/discussions\/([^/]+)(?:\/notes)?$/.exec(suffix)
  if (discussionMatch) {
    const rawDiscussionId = discussionMatch[1]
    if (!rawDiscussionId) {
      state.unhandledRoutes.push(route)
      return json({ error: `Unhandled fake GitLab route: ${route}` }, 404)
    }
    const discussionId = decodeURIComponent(rawDiscussionId)
    const discussion = state.discussions.find((candidate) => candidate.id === discussionId)
    if (!discussion) {
      return json({ error: `unknown discussion ${discussionId}` }, 404)
    }

    if (request.method === 'GET') {
      return json(discussion)
    }

    if (request.method === 'PUT') {
      for (const note of discussion.notes) {
        note.resolved = true
        note.updated_at = now()
      }
      return json(discussion)
    }

    if (request.method === 'POST' && suffix.endsWith('/notes')) {
      const body = await parseJson(request)
      const noteId = 30_000 + discussion.notes.length + 1
      const timestamp = now()
      const note = {
        id: noteId,
        body: stringField(body.body),
        author: state.user,
        type: null,
        resolvable: false,
        resolved: false,
        created_at: timestamp,
        updated_at: timestamp,
        url: noteUrl(mrIid, noteId),
      }
      discussion.notes.push(note)
      return json(note)
    }
  }

  state.unhandledRoutes.push(route)
  return json({ error: `Unhandled fake GitLab route: ${route}` }, 404)
}

export const startFakeGitLab = (params: StartFakeGitLabParams): FakeGitLabServer => {
  const state: FakeGitLabState = {
    user: { id: 7, username: 'mend-bot' },
    mr: params.mr,
    draftNotes: [],
    notes: [],
    discussions: [],
    published: [],
    reactions: [],
    unhandledRoutes: [],
  }
  const app = new Hono()

  app.all('*', async (c) => await routeRequest(state, c.req.raw))

  const server = Bun.serve({
    port: 0,
    fetch: app.fetch,
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    state,
    stop: async () => {
      await server.stop(false)
    },
  }
}
