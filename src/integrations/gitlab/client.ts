import type { ProjectConfig } from '@/config'
import {
  bulkPublishDrafts,
  createDraftNote,
  deleteDraftNote,
  listMrDraftNotes,
  publishDraftNote,
  type DraftNotePosition,
  type MrDraftNote,
} from '@/integrations/gitlab/notes'
import {
  createDiscussion,
  listMrDiscussions,
  replyToDiscussion,
  resolveDiscussion,
  type Discussion,
  type DiscussionNote,
} from '@/integrations/gitlab/discussions'
import {
  createMrNote,
  deleteMrNote,
  fetchCurrentUser,
  listMrNotes,
  updateMrNote,
  type GitLabUser,
  type MrNote,
} from '@/integrations/gitlab/notes'

export interface GitLabClient {
  fetchCurrentUser: () => Promise<GitLabUser>
  listMrNotes: (mrIid: number) => Promise<MrNote[]>
  listMrDraftNotes: (mrIid: number) => Promise<MrDraftNote[]>
  createDraftNote: (
    mrIid: number,
    note: string,
    position?: DraftNotePosition,
  ) => Promise<{ id: number }>
  deleteDraftNote: (mrIid: number, noteId: number) => Promise<void>
  publishDraftNote: (mrIid: number, noteId: number) => Promise<void>
  bulkPublishDrafts: (mrIid: number) => Promise<void>
  createMrNote: (mrIid: number, body: string) => Promise<MrNote>
  updateMrNote: (mrIid: number, noteId: number, body: string) => Promise<MrNote>
  deleteMrNote: (mrIid: number, noteId: number) => Promise<void>
  listMrDiscussions: (mrIid: number) => Promise<Discussion[]>
  createDiscussion: (mrIid: number, body: string) => Promise<Discussion>
  replyToDiscussion: (mrIid: number, discussionId: string, body: string) => Promise<DiscussionNote>
  resolveDiscussion: (mrIid: number, discussionId: string) => Promise<void>
}

export const createGitLabClient = (project: ProjectConfig): GitLabClient => ({
  fetchCurrentUser: async () => await fetchCurrentUser(project),
  listMrNotes: async (mrIid) => await listMrNotes(project, mrIid),
  listMrDraftNotes: async (mrIid) => await listMrDraftNotes(project, mrIid),
  createDraftNote: async (mrIid, note, position) =>
    await createDraftNote(project, mrIid, note, position),
  deleteDraftNote: async (mrIid, noteId) => await deleteDraftNote(project, mrIid, noteId),
  publishDraftNote: async (mrIid, noteId) => await publishDraftNote(project, mrIid, noteId),
  bulkPublishDrafts: async (mrIid) => await bulkPublishDrafts(project, mrIid),
  createMrNote: async (mrIid, body) => await createMrNote(project, mrIid, body),
  updateMrNote: async (mrIid, noteId, body) => await updateMrNote(project, mrIid, noteId, body),
  deleteMrNote: async (mrIid, noteId) => await deleteMrNote(project, mrIid, noteId),
  listMrDiscussions: async (mrIid) => await listMrDiscussions(project, mrIid),
  createDiscussion: async (mrIid, body) => await createDiscussion(project, mrIid, body),
  replyToDiscussion: async (mrIid, discussionId, body) =>
    await replyToDiscussion(project, mrIid, discussionId, body),
  resolveDiscussion: async (mrIid, discussionId) =>
    await resolveDiscussion(project, mrIid, discussionId),
})
