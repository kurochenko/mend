import { z } from 'zod'
import type { GitLabProjectConfig } from '@/config'
import { gitlabApi } from '@/integrations/gitlab/transport'

interface DiffRefs {
  base_sha: string
  head_sha: string
  start_sha: string
}

interface MrChange {
  old_path: string
  new_path: string
}

export interface MrDiffRefs {
  diffRefs: DiffRefs
}

export interface MrChangedFiles {
  files: string[]
}

export interface MrDetails {
  title: string
  description: string
  labels: string[]
  sourceBranch: string
  targetBranch: string
  url: string
  sha: string
}

const gitlabMrSchema = z.object({
  title: z.string(),
  description: z.string().nullable(),
  labels: z.array(z.string()).optional(),
  source_branch: z.string(),
  target_branch: z.string(),
  web_url: z.string(),
  sha: z.string(),
  diff_refs: z
    .object({
      base_sha: z.string(),
      head_sha: z.string(),
      start_sha: z.string(),
    })
    .nullable(),
})

const gitlabMrChangesSchema = z.object({
  changes: z.array(
    z.object({
      old_path: z.string(),
      new_path: z.string(),
    }),
  ),
})

export const fetchMrDiffRefs = async (
  project: GitLabProjectConfig,
  mrIid: number,
): Promise<MrDiffRefs> => {
  const res = await gitlabApi(project, `/merge_requests/${mrIid}`)
  const data = gitlabMrSchema.parse(await res.json())

  if (!data.diff_refs) {
    throw new Error(
      `GitLab returned null diff_refs for MR !${mrIid} — the MR may still be processing`,
    )
  }

  return { diffRefs: data.diff_refs }
}

const dedupePaths = (paths: string[]): string[] => {
  const out: string[] = []
  const seen = new Set<string>()

  for (const path of paths) {
    const normalized = path.trim()
    if (!normalized || seen.has(normalized)) {
      continue
    }

    seen.add(normalized)
    out.push(normalized)
  }

  return out
}

export const fetchMrChangedFiles = async (
  project: GitLabProjectConfig,
  mrIid: number,
): Promise<MrChangedFiles> => {
  const res = await gitlabApi(project, `/merge_requests/${mrIid}/changes`)
  const data = gitlabMrChangesSchema.parse(await res.json())

  const files = dedupePaths(
    data.changes.flatMap((change: MrChange) => [change.new_path, change.old_path]),
  )
  return { files }
}

export const fetchMr = async (project: GitLabProjectConfig, mrIid: number): Promise<MrDetails> => {
  const res = await gitlabApi(project, `/merge_requests/${mrIid}`)
  const data = gitlabMrSchema.parse(await res.json())

  return {
    title: data.title,
    description: data.description ?? '',
    labels: data.labels ?? [],
    sourceBranch: data.source_branch,
    targetBranch: data.target_branch,
    url: data.web_url,
    sha: data.sha,
  }
}
