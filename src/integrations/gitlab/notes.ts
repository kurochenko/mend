import { z } from 'zod'
import type { ProjectConfig } from '@/config'
import { gitlabApi, gitlabApiGlobal } from '@/integrations/gitlab/transport'

export interface DraftNotePosition {
  position_type: 'text'
  base_sha: string
  head_sha: string
  start_sha: string
  old_path: string
  new_path: string
  old_line?: number
  new_line?: number
}

interface DraftNote {
  id: number
}

export interface MrDraftNote {
  id: number
  body: string
}

export interface GitLabUser {
  id: number
  username: string
}

export interface MrNote {
  id: number
  body: string
  author: GitLabUser | null
  createdAt?: string
  updatedAt?: string
}

const draftNoteSchema = z.object({
  id: z.number(),
})

const mrDraftNoteSchema = z.object({
  id: z.number(),
  note: z.string().optional(),
  body: z.string().optional(),
})

const noteAuthorSchema = z
  .object({
    id: z.number(),
    username: z.string(),
  })
  .nullable()
  .optional()

const noteSchema = z.object({
  id: z.number(),
  body: z.string(),
  author: noteAuthorSchema,
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
})

const currentUserSchema = z.object({
  id: z.number(),
  username: z.string(),
})

const currentUserCache = new Map<string, GitLabUser>()

export const createDraftNote = async (
  project: ProjectConfig,
  mrIid: number,
  note: string,
  position?: DraftNotePosition,
): Promise<DraftNote> => {
  const body: Record<string, unknown> = { note }
  if (position) {
    body.position = position
  }

  const res = await gitlabApi(
    project,
    `/merge_requests/${mrIid}/draft_notes`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
    undefined,
    { maxRetries: 0 },
  )

  return draftNoteSchema.parse(await res.json())
}

export const bulkPublishDrafts = async (project: ProjectConfig, mrIid: number): Promise<void> => {
  await gitlabApi(
    project,
    `/merge_requests/${mrIid}/draft_notes/bulk_publish`,
    {
      method: 'POST',
    },
    undefined,
    { maxRetries: 0 },
  )
}

export const publishDraftNote = async (
  project: ProjectConfig,
  mrIid: number,
  noteId: number,
): Promise<void> => {
  await gitlabApi(
    project,
    `/merge_requests/${mrIid}/draft_notes/${noteId}/publish`,
    {
      method: 'PUT',
    },
    undefined,
    { maxRetries: 0 },
  )
}

export const listMrDraftNotes = async (
  project: ProjectConfig,
  mrIid: number,
): Promise<MrDraftNote[]> => {
  const drafts: MrDraftNote[] = []
  let page = 1

  for (;;) {
    const res = await gitlabApi(
      project,
      `/merge_requests/${mrIid}/draft_notes?per_page=100&page=${page}`,
    )
    const data = z.array(mrDraftNoteSchema).parse(await res.json())
    drafts.push(
      ...data.map((note) => ({
        id: note.id,
        body: note.note ?? note.body ?? '',
      })),
    )

    const nextPage = res.headers.get('x-next-page')
    if (!nextPage) {
      break
    }

    page = Number(nextPage)
  }

  return drafts
}

export const deleteDraftNote = async (
  project: ProjectConfig,
  mrIid: number,
  noteId: number,
): Promise<void> => {
  await gitlabApi(project, `/merge_requests/${mrIid}/draft_notes/${noteId}`, {
    method: 'DELETE',
  })
}

export const listMrNotes = async (project: ProjectConfig, mrIid: number): Promise<MrNote[]> => {
  const notes: MrNote[] = []
  let page = 1

  for (;;) {
    const res = await gitlabApi(project, `/merge_requests/${mrIid}/notes?per_page=100&page=${page}`)
    const data = z.array(noteSchema).parse(await res.json())
    notes.push(
      ...data.map((note) => ({
        id: note.id,
        body: note.body,
        author: note.author ?? null,
        createdAt: note.created_at,
        updatedAt: note.updated_at,
      })),
    )

    const nextPage = res.headers.get('x-next-page')
    if (!nextPage) {
      break
    }

    page = Number(nextPage)
  }

  return notes
}

export const fetchCurrentUser = async (project: ProjectConfig): Promise<GitLabUser> => {
  const cacheKey = `${project.url}:${project.project_id}`
  const cached = currentUserCache.get(cacheKey)
  if (cached) {
    return cached
  }

  const res = await gitlabApiGlobal(project, '/user')
  const user = currentUserSchema.parse(await res.json())
  currentUserCache.set(cacheKey, user)
  return user
}

export const createMrNote = async (
  project: ProjectConfig,
  mrIid: number,
  body: string,
): Promise<MrNote> => {
  const res = await gitlabApi(project, `/merge_requests/${mrIid}/notes`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  })
  const data = noteSchema.parse(await res.json())
  return {
    id: data.id,
    body: data.body,
    author: data.author ?? null,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  }
}

export const updateMrNote = async (
  project: ProjectConfig,
  mrIid: number,
  noteId: number,
  body: string,
): Promise<MrNote> => {
  const res = await gitlabApi(project, `/merge_requests/${mrIid}/notes/${noteId}`, {
    method: 'PUT',
    body: JSON.stringify({ body }),
  })
  const data = noteSchema.parse(await res.json())
  return {
    id: data.id,
    body: data.body,
    author: data.author ?? null,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  }
}

export const deleteMrNote = async (
  project: ProjectConfig,
  mrIid: number,
  noteId: number,
): Promise<void> => {
  await gitlabApi(project, `/merge_requests/${mrIid}/notes/${noteId}`, {
    method: 'DELETE',
  })
}
