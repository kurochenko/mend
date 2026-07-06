export type ProviderKind = 'gitlab' | 'github'

export interface ProviderUser {
  id: number
  username: string
}

export interface ProviderNote {
  id: number
  body: string
  author: ProviderUser | null
  createdAt?: string
  updatedAt?: string
}

export interface ThreadPosition {
  path: string | null
  oldPath: string | null
  line: number | null
  oldLine: number | null
}

export interface ProviderThreadMessage {
  id: string
  body: string
  author: { id: number; username: string; raw: unknown }
  resolvable: boolean
  resolved?: boolean
  system?: boolean
  createdAt?: string
  updatedAt?: string
  url?: string
  position: ThreadPosition | null
  raw: unknown
}

export interface ProviderThread {
  id: string
  isThread: boolean
  messages: ProviderThreadMessage[]
  raw: unknown
}

export interface ChangeRequestDetails {
  title: string
  description: string
  labels: string[]
  sourceBranch: string
  targetBranch: string
  url: string
  sha: string
}

export interface DiffRefs {
  baseSha: string
  headSha: string
  startSha?: string
}

export interface PublishInlineDraft {
  path: string
  body: string
  anchor: { old_line?: number; new_line?: number }
  logLabel: string
}

export type DraftClassification = 'current_run' | 'mend_other_run' | 'foreign'

export interface PublishBatchResult {
  preExistingDraftCount: number
  recoveredDraftCount: number
  draftRecoveryAction: 'none' | 'reused' | 'cleaned'
  summaryNoteId: number
  summaryReconciled: boolean
}
