export interface IsNoteAddressedToMendParams {
  directMention: boolean
  existingMendThread: boolean
  lastExistingMessage: { authorType: string; processingStatus: string | null } | null
  existingThreadMessageCount: number
  firstDiscussionNoteAuthorId: number | null
  currentUserId: number
}

export const isNoteAddressedToMend = (params: IsNoteAddressedToMendParams): boolean => {
  if (params.directMention) {
    return true
  }

  const agentShouldHandleReply =
    params.lastExistingMessage?.authorType === 'agent' ||
    params.lastExistingMessage?.processingStatus === 'pending' ||
    params.lastExistingMessage?.processingStatus === 'processing'

  if (params.existingMendThread) {
    return agentShouldHandleReply || params.existingThreadMessageCount === 0
  }

  if (params.firstDiscussionNoteAuthorId === params.currentUserId) {
    return true
  }

  return false
}
