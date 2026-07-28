import type { ProjectConfig } from '@/config'
import { createGitHubReviewProvider } from '@/integrations/provider/github'
import { createGitLabReviewProvider } from '@/integrations/provider/gitlab'
import type {
  ChangeRequestDetails,
  DiffRefs,
  DraftClassification,
  PublishBatchResult,
  PublishInlineDraft,
  ProviderKind,
  ProviderNote,
  ProviderThread,
  ProviderThreadMessage,
  ProviderUser,
} from '@/integrations/provider/types'

export interface ReviewProvider {
  kind: ProviderKind
  fetchCurrentUser(): Promise<ProviderUser>
  fetchChangeRequest(changeNumber: number): Promise<ChangeRequestDetails>
  fetchDiffRefs(changeNumber: number): Promise<DiffRefs>
  fetchChangedFiles(changeNumber: number): Promise<string[]>
  listNotes(changeNumber: number): Promise<ProviderNote[]>
  createNote(changeNumber: number, body: string): Promise<ProviderNote>
  updateNote(changeNumber: number, noteId: number, body: string): Promise<ProviderNote>
  deleteNote(changeNumber: number, noteId: number): Promise<void>
  listThreads(changeNumber: number): Promise<ProviderThread[]>
  getThread(changeNumber: number, threadId: string): Promise<ProviderThread>
  createThread(changeNumber: number, body: string): Promise<ProviderThread>
  replyToThread(
    changeNumber: number,
    threadId: string,
    body: string,
  ): Promise<ProviderThreadMessage>
  resolveThread(changeNumber: number, threadId: string): Promise<boolean>
  addNoteReaction(changeNumber: number, noteId: number, reaction: string): Promise<void>
  addThreadMessageReaction(changeNumber: number, messageId: number, reaction: string): Promise<void>
  publishReviewBatch(params: {
    changeNumber: number
    projectKey: string
    reviewRunId: string
    inlineDrafts: PublishInlineDraft[]
    summaryBody: string
    diffRefs: DiffRefs
    classifyDraft: (body: string) => DraftClassification
    matchSummaryNote: (notes: ProviderNote[]) => ProviderNote | undefined
  }): Promise<PublishBatchResult>
}

const assertNever = (value: never): never => {
  throw new Error(`Unsupported provider platform: ${value}`)
}

export const createReviewProvider = (project: ProjectConfig): ReviewProvider => {
  switch (project.platform) {
    case 'gitlab':
      return createGitLabReviewProvider(project)
    case 'github':
      return createGitHubReviewProvider(project)
    default:
      return assertNever(project)
  }
}
