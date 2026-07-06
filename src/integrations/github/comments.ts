import { z } from 'zod'
import type { GitHubProjectConfig } from '@/config'
import { githubApi, githubPaginated } from '@/integrations/github/transport'
import { githubRepoPath } from '@/integrations/github/pr'
import type { ProviderNote, ProviderUser } from '@/integrations/provider/types'

const userSchema = z
  .object({
    id: z.number(),
    login: z.string(),
  })
  .passthrough()

const nullableUserSchema = userSchema.nullable().optional()

const issueCommentSchema = z
  .object({
    id: z.number(),
    body: z.string().nullable(),
    user: nullableUserSchema,
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    html_url: z.string().optional(),
  })
  .passthrough()

const mapUser = (user: z.infer<typeof userSchema>): ProviderUser => ({
  id: user.id,
  username: user.login,
})

export const mapIssueComment = (comment: z.infer<typeof issueCommentSchema>): ProviderNote => ({
  id: comment.id,
  body: comment.body ?? '',
  author: comment.user ? mapUser(comment.user) : null,
  createdAt: comment.created_at,
  updatedAt: comment.updated_at,
})

const issueCommentsPath = (project: GitHubProjectConfig, number: number): string =>
  `${githubRepoPath(project)}/issues/${number}/comments`

export const listPrIssueComments = async (
  project: GitHubProjectConfig,
  number: number,
): Promise<ProviderNote[]> =>
  await githubPaginated(project, `${issueCommentsPath(project, number)}?per_page=100`, (value) =>
    z.array(issueCommentSchema).parse(value).map(mapIssueComment),
  )

export const getPrIssueComment = async (
  project: GitHubProjectConfig,
  commentId: number,
): Promise<ProviderNote> => {
  const res = await githubApi(project, `${githubRepoPath(project)}/issues/comments/${commentId}`)
  return mapIssueComment(issueCommentSchema.parse(await res.json()))
}

export const createPrIssueComment = async (
  project: GitHubProjectConfig,
  number: number,
  body: string,
): Promise<ProviderNote> => {
  const res = await githubApi(project, issueCommentsPath(project, number), {
    method: 'POST',
    body: JSON.stringify({ body }),
  })
  return mapIssueComment(issueCommentSchema.parse(await res.json()))
}

export const updatePrIssueComment = async (
  project: GitHubProjectConfig,
  commentId: number,
  body: string,
): Promise<ProviderNote> => {
  const res = await githubApi(project, `${githubRepoPath(project)}/issues/comments/${commentId}`, {
    method: 'PATCH',
    body: JSON.stringify({ body }),
  })
  return mapIssueComment(issueCommentSchema.parse(await res.json()))
}

export const deletePrIssueComment = async (
  project: GitHubProjectConfig,
  commentId: number,
): Promise<void> => {
  await githubApi(project, `${githubRepoPath(project)}/issues/comments/${commentId}`, {
    method: 'DELETE',
  })
}

const currentUserCache = new Map<string, ProviderUser>()

export const fetchCurrentUser = async (project: GitHubProjectConfig): Promise<ProviderUser> => {
  const cached = currentUserCache.get(`${project.url}:${project.repo}`)
  if (cached) {
    return cached
  }

  const res = await githubApi(project, '/user')
  const user = mapUser(userSchema.parse(await res.json()))
  currentUserCache.set(`${project.url}:${project.repo}`, user)
  return user
}
