export interface ReviewNote {
  mrIid: number
  noteId: number
  body: string
  author: { id: number; username: string }
  discussionId?: string
  isDiffNote: boolean
  url?: string
  createdAt?: string
  updatedAt?: string
}

export type ReviewWebhookEvent =
  | {
      type: 'mr_review_requested'
      projectKey: string
      projectId: number
      mrIid: number
      title: string
      description: string
      labels: string[]
      sourceBranch: string
      targetBranch: string
      url: string
      headSha: string | null
    }
  | {
      type: 'mr_note_received'
      projectKey: string
      projectId: number
      note: ReviewNote
    }
  | { type: 'ignored'; reason: string }

export const repoExternalIdForProject = (project: {
  platform: 'gitlab' | 'github'
  project_id?: number | string
  repo?: string
}): string => {
  if (project.platform === 'gitlab') {
    return `${project.project_id}`
  }

  return project.repo ?? ''
}
