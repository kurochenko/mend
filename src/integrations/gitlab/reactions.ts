import type { ProjectConfig } from '@/config'
import { gitlabApi } from '@/integrations/gitlab/transport'

interface AddMergeRequestNoteReactionParams {
  mrIid: number
  noteId: number
  name: string
}

interface AddDiscussionNoteReactionParams {
  mrIid: number
  discussionId: string
  noteId: number
  name: string
}

const createAwardEmoji = async (
  project: ProjectConfig,
  path: string,
  name: string,
): Promise<void> => {
  await gitlabApi(
    project,
    path,
    {
      method: 'POST',
      body: JSON.stringify({ name }),
    },
    undefined,
    { maxRetries: 0 },
  )
}

export const addMergeRequestNoteReaction = async (
  project: ProjectConfig,
  params: AddMergeRequestNoteReactionParams,
): Promise<void> => {
  await createAwardEmoji(
    project,
    `/merge_requests/${params.mrIid}/notes/${params.noteId}/award_emoji`,
    params.name,
  )
}

export const addDiscussionNoteReaction = async (
  project: ProjectConfig,
  params: AddDiscussionNoteReactionParams,
): Promise<void> => {
  await createAwardEmoji(
    project,
    `/merge_requests/${params.mrIid}/notes/${params.noteId}/award_emoji`,
    params.name,
  )
}
