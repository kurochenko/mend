import type { GitHubProjectConfig } from '@/config'
import {
  createPrIssueComment,
  deletePrIssueComment,
  fetchCurrentUser,
  listPrIssueComments,
  updatePrIssueComment,
} from '@/integrations/github/comments'
import { fetchChangedFiles, fetchDiffRefs, fetchPr } from '@/integrations/github/pr'
import { addNoteReaction, addThreadMessageReaction } from '@/integrations/github/reactions'
import {
  createThread,
  getThread,
  listThreads,
  replyToThread,
  resolveThread,
} from '@/integrations/github/threads'
import { publishReviewBatch } from '@/integrations/github/publish'

export const createGitHubReviewProvider = (project: GitHubProjectConfig) => ({
  kind: 'github' as const,
  fetchCurrentUser: async () => await fetchCurrentUser(project),
  fetchChangeRequest: async (changeNumber: number) => await fetchPr(project, changeNumber),
  fetchDiffRefs: async (changeNumber: number) => await fetchDiffRefs(project, changeNumber),
  fetchChangedFiles: async (changeNumber: number) => await fetchChangedFiles(project, changeNumber),
  listNotes: async (changeNumber: number) => await listPrIssueComments(project, changeNumber),
  createNote: async (changeNumber: number, body: string) =>
    await createPrIssueComment(project, changeNumber, body),
  updateNote: async (_changeNumber: number, noteId: number, body: string) =>
    await updatePrIssueComment(project, noteId, body),
  deleteNote: async (_changeNumber: number, noteId: number) =>
    await deletePrIssueComment(project, noteId),
  listThreads: async (changeNumber: number) => await listThreads(project, changeNumber),
  getThread: async (changeNumber: number, threadId: string) =>
    await getThread(project, changeNumber, threadId),
  createThread: async (changeNumber: number, body: string) =>
    await createThread(project, changeNumber, body),
  replyToThread: async (changeNumber: number, threadId: string, body: string) =>
    await replyToThread(project, changeNumber, threadId, body),
  resolveThread: async (_changeNumber: number, threadId: string) =>
    await resolveThread(project, threadId),
  addNoteReaction: async (_changeNumber: number, noteId: number, reaction: string) =>
    await addNoteReaction(project, noteId, reaction),
  addThreadMessageReaction: async (_changeNumber: number, messageId: number, reaction: string) =>
    await addThreadMessageReaction(project, messageId, reaction),
  publishReviewBatch: async (
    params: Omit<Parameters<typeof publishReviewBatch>[1], 'currentUser'>,
  ) =>
    await publishReviewBatch(project, {
      ...params,
      currentUser: await fetchCurrentUser(project),
    }),
})
