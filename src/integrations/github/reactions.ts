import type { GitHubProjectConfig } from '@/config'
import { githubApi } from '@/integrations/github/transport'
import { githubRepoPath } from '@/integrations/github/pr'

const reactionMap = new Map([
  ['thumbsup', '+1'],
  ['thumbsdown', '-1'],
  ['laughing', 'laugh'],
  ['laugh', 'laugh'],
  ['confused', 'confused'],
  ['heart', 'heart'],
  ['tada', 'hooray'],
  ['hooray', 'hooray'],
  ['rocket', 'rocket'],
  ['eyes', 'eyes'],
  ['white_check_mark', '+1'],
])

export const mapReaction = (name: string): string => {
  const mapped = reactionMap.get(name)
  if (mapped) {
    return mapped
  }

  console.warn(`Unknown GitHub reaction mapping for "${name}", using +1`)
  return '+1'
}

export const addNoteReaction = async (
  project: GitHubProjectConfig,
  noteId: number,
  reaction: string,
): Promise<void> => {
  await githubApi(
    project,
    `${githubRepoPath(project)}/issues/comments/${noteId}/reactions`,
    {
      method: 'POST',
      body: JSON.stringify({ content: mapReaction(reaction) }),
    },
    undefined,
    { maxRetries: 0 },
  )
}

export const addThreadMessageReaction = async (
  project: GitHubProjectConfig,
  messageId: number,
  reaction: string,
): Promise<void> => {
  if (!Number.isInteger(messageId)) {
    console.warn(`Cannot add GitHub review-comment reaction to non-numeric id ${messageId}`)
    return
  }

  await githubApi(
    project,
    `${githubRepoPath(project)}/pulls/comments/${messageId}/reactions`,
    {
      method: 'POST',
      body: JSON.stringify({ content: mapReaction(reaction) }),
    },
    undefined,
    { maxRetries: 0 },
  )
}
