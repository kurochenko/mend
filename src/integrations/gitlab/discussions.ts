import { z } from 'zod'
import type { ProjectConfig } from '@/config'
import { gitlabApi } from '@/integrations/gitlab/transport'

const discussionAuthorSchema = z
  .object({
    id: z.number(),
    username: z.string(),
  })
  .passthrough()

const discussionNoteSchema = z
  .object({
    id: z.number(),
    body: z.string(),
    author: discussionAuthorSchema,
    type: z.string().nullable().optional(),
    system: z.boolean().optional(),
    resolvable: z.boolean(),
    resolved: z.boolean().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    url: z.string().optional(),
    position: z.unknown().nullable().optional(),
  })
  .passthrough()

const discussionSchema = z
  .object({
    id: z.string(),
    individual_note: z.boolean(),
    notes: z.array(discussionNoteSchema),
  })
  .passthrough()

export interface DiscussionAuthor {
  id: number
  username: string
  raw: unknown
}

export interface DiscussionNote {
  id: number
  body: string
  author: DiscussionAuthor
  type?: string | null
  system?: boolean
  resolvable: boolean
  resolved?: boolean
  createdAt?: string
  updatedAt?: string
  url?: string
  position?: unknown | null
  raw: unknown
}

export interface Discussion {
  id: string
  individual_note: boolean
  notes: DiscussionNote[]
  raw: unknown
}

type RawDiscussionNote = z.infer<typeof discussionNoteSchema>
type RawDiscussion = z.infer<typeof discussionSchema>

const mapNote = (note: RawDiscussionNote): DiscussionNote => ({
  id: note.id,
  body: note.body,
  author: {
    id: note.author.id,
    username: note.author.username,
    raw: note.author,
  },
  type: note.type,
  system: note.system,
  resolvable: note.resolvable,
  resolved: note.resolved,
  createdAt: note.created_at,
  updatedAt: note.updated_at,
  url: note.url,
  position: note.position,
  raw: note,
})

const mapDiscussion = (discussion: RawDiscussion): Discussion => ({
  id: discussion.id,
  individual_note: discussion.individual_note,
  notes: discussion.notes.map(mapNote),
  raw: discussion,
})

export const listMrDiscussions = async (
  project: ProjectConfig,
  mrIid: number,
): Promise<Discussion[]> => {
  const discussions: Discussion[] = []
  let page = 1

  for (;;) {
    const res = await gitlabApi(
      project,
      `/merge_requests/${mrIid}/discussions?per_page=100&page=${page}`,
    )
    const data = z.array(discussionSchema).parse(await res.json())
    discussions.push(...data.map(mapDiscussion))

    const nextPage = res.headers.get('x-next-page')
    if (!nextPage) {
      break
    }

    page = Number(nextPage)
  }

  return discussions
}

export const getMrDiscussion = async (
  project: ProjectConfig,
  mrIid: number,
  discussionId: string,
): Promise<Discussion> => {
  const res = await gitlabApi(
    project,
    `/merge_requests/${mrIid}/discussions/${encodeURIComponent(discussionId)}`,
  )
  const data = discussionSchema.parse(await res.json())
  return mapDiscussion(data)
}

export const createDiscussion = async (
  project: ProjectConfig,
  mrIid: number,
  body: string,
): Promise<Discussion> => {
  const res = await gitlabApi(
    project,
    `/merge_requests/${mrIid}/discussions`,
    {
      method: 'POST',
      body: JSON.stringify({ body }),
    },
    undefined,
    { maxRetries: 0 },
  )
  const data = discussionSchema.parse(await res.json())
  return mapDiscussion(data)
}

export const resolveDiscussion = async (
  project: ProjectConfig,
  mrIid: number,
  discussionId: string,
): Promise<void> => {
  await gitlabApi(project, `/merge_requests/${mrIid}/discussions/${discussionId}`, {
    method: 'PUT',
    body: JSON.stringify({ resolved: true }),
  })
}

export const replyToDiscussion = async (
  project: ProjectConfig,
  mrIid: number,
  discussionId: string,
  body: string,
): Promise<DiscussionNote> => {
  const res = await gitlabApi(
    project,
    `/merge_requests/${mrIid}/discussions/${discussionId}/notes`,
    {
      method: 'POST',
      body: JSON.stringify({ body }),
    },
  )

  const note = discussionNoteSchema.parse(await res.json())
  return mapNote(note)
}
