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
    }
  | {
      type: 'mr_note_received'
      projectKey: string
      projectId: number
      mrIid: number
      noteId: number
    }
  | { type: 'ignored'; reason: string }

export interface ReviewNoteEventPayload {
  project: {
    id: number | string
  }
  user: {
    id: number
    username: string
  }
  merge_request?: {
    iid: number
  }
  object_attributes: {
    id: number
    note: string
    noteable_type: string
    type?: string | null
    discussion_id?: string | null
    created_at?: string
    updated_at?: string
    action?: string
    url?: string
    system?: boolean
  }
}

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
