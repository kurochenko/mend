import { z } from 'zod'
import type { GitHubProjectConfig } from '@/config'
import { githubApi, githubPaginated, splitRepo } from '@/integrations/github/transport'
import type { ChangeRequestDetails, DiffRefs } from '@/integrations/provider/types'

const labelSchema = z.object({ name: z.string() }).passthrough()

const prSchema = z
  .object({
    title: z.string(),
    body: z.string().nullable(),
    labels: z.array(labelSchema),
    head: z.object({ ref: z.string(), sha: z.string() }).passthrough(),
    base: z.object({ ref: z.string(), sha: z.string() }).passthrough(),
    html_url: z.string(),
  })
  .passthrough()

const fileSchema = z.object({ filename: z.string() }).passthrough()

const prPath = (project: GitHubProjectConfig, number: number): string => {
  const { owner, name } = splitRepo(project.repo)
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}`
}

export const fetchPr = async (
  project: GitHubProjectConfig,
  number: number,
): Promise<ChangeRequestDetails> => {
  const res = await githubApi(project, prPath(project, number))
  const data = prSchema.parse(await res.json())
  return {
    title: data.title,
    description: data.body ?? '',
    labels: data.labels.map((label) => label.name),
    sourceBranch: data.head.ref,
    targetBranch: data.base.ref,
    url: data.html_url,
    sha: data.head.sha,
  }
}

export const fetchDiffRefs = async (
  project: GitHubProjectConfig,
  number: number,
): Promise<DiffRefs> => {
  const res = await githubApi(project, prPath(project, number))
  const data = prSchema.parse(await res.json())
  return { baseSha: data.base.sha, headSha: data.head.sha }
}

export const fetchChangedFiles = async (
  project: GitHubProjectConfig,
  number: number,
): Promise<string[]> =>
  await githubPaginated(project, `${prPath(project, number)}/files?per_page=100`, (value) =>
    z
      .array(fileSchema)
      .parse(value)
      .map((file) => file.filename),
  )

export const githubRepoPath = (project: GitHubProjectConfig): string => {
  const { owner, name } = splitRepo(project.repo)
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}
