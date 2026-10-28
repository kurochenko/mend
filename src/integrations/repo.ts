import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ProjectConfig } from '@/config'
import { withProjectRepoLock } from '@/integrations/repo-locks'
import {
  cloneUrl,
  execGitWithAuth,
  fetchCommitSha,
  hasCommit,
  syncOriginBranches,
} from '@/integrations/repo-remote'
import { toErrorMessage } from '@/lib/errors'
import { assertCommitSha, assertSafeGitRef, execGit } from '@/lib/exec'

export const ensureClone = async (project: ProjectConfig): Promise<string> => {
  return await withProjectRepoLock(project.key, async () => {
    const barePath = project.clone_path

    if (existsSync(barePath)) {
      console.log(`[repo] fetching origin for ${project.key}`)
    } else {
      console.log(`[repo] cloning ${project.key} (bare) → ${barePath}`)
      await execGitWithAuth(
        ['clone', '--bare', cloneUrl(project), barePath],
        process.cwd(),
        project,
      )
    }

    await syncOriginBranches(project)

    return barePath
  })
}

const worktreePath = (project: ProjectConfig, mrIid: number): string =>
  resolve(project.clone_path, 'worktrees-mr', `mr-${mrIid}`)

export const shouldFetchRequestedCommitAfterBranchFetch = (
  commitSha: string | undefined,
  hasRequestedCommit: boolean,
): boolean => Boolean(commitSha && !hasRequestedCommit)

const fetchWorktreeRefs = async (
  project: ProjectConfig,
  sourceBranch: string,
  commitSha?: string,
): Promise<void> => {
  await execGit(['remote', 'set-url', 'origin', cloneUrl(project)], project.clone_path)

  try {
    await execGitWithAuth(
      ['fetch', 'origin', `+${sourceBranch}:${sourceBranch}`],
      project.clone_path,
      project,
    )
  } catch (branchError) {
    if (!commitSha) {
      throw branchError
    }

    await fetchCommitSha(project, commitSha)
    return
  }

  if (commitSha) {
    const hasRequestedCommit = await hasCommit(project.clone_path, commitSha)
    if (shouldFetchRequestedCommitAfterBranchFetch(commitSha, hasRequestedCommit)) {
      await fetchCommitSha(project, commitSha)
    }
  }
}

export const createWorktree = async (
  project: ProjectConfig,
  mrIid: number,
  sourceBranch: string,
  commitSha?: string,
  options?: { skipFetch?: boolean; pathSuffix?: string },
): Promise<string> => {
  return await withProjectRepoLock(project.key, async () => {
    const suffix = options?.pathSuffix
    const wt = suffix
      ? resolve(project.clone_path, 'worktrees-mr', `mr-${mrIid}-${suffix}`)
      : worktreePath(project, mrIid)
    const safeSourceBranch = assertSafeGitRef(sourceBranch, 'source branch')
    const safeCommitSha = commitSha ? assertCommitSha(commitSha) : null

    if (existsSync(wt)) {
      console.log(`[repo] removing stale worktree ${wt}`)
      await execGit(['worktree', 'remove', wt, '--force'], project.clone_path)
    }

    if (!options?.skipFetch) {
      await fetchWorktreeRefs(project, safeSourceBranch, safeCommitSha ?? undefined)
    }

    console.log(`[repo] creating worktree for MR !${mrIid} at ${wt}`)
    if (safeCommitSha && (await hasCommit(project.clone_path, safeCommitSha))) {
      await execGit(['worktree', 'add', '--detach', wt, safeCommitSha], project.clone_path)
      return wt
    }

    await execGit(['worktree', 'add', wt, safeSourceBranch], project.clone_path)

    if (safeCommitSha) {
      await execGit(['checkout', '--detach', safeCommitSha], wt)
    }

    return wt
  })
}

export const getWorktreeHeadSha = async (worktreeCwd: string): Promise<string> =>
  await execGit(['rev-parse', 'HEAD'], worktreeCwd)

export const removeWorktree = async (
  project: ProjectConfig,
  mrIid: number,
  options?: { pathSuffix?: string },
): Promise<void> => {
  await withProjectRepoLock(project.key, async () => {
    const suffix = options?.pathSuffix
    const wt = suffix
      ? resolve(project.clone_path, 'worktrees-mr', `mr-${mrIid}-${suffix}`)
      : worktreePath(project, mrIid)

    if (!existsSync(wt)) {
      console.log(`[repo] worktree already absent for MR !${mrIid}, skipping cleanup`)
      return
    }

    try {
      console.log(`[repo] removing worktree for MR !${mrIid} at ${wt}`)
      await execGit(['worktree', 'remove', wt, '--force'], project.clone_path)
      await execGit(['worktree', 'prune'], project.clone_path)
      console.log(`[repo] worktree cleanup complete for MR !${mrIid}`)
    } catch (error) {
      const message = toErrorMessage(error)
      console.error(`[repo] worktree cleanup failed for MR !${mrIid}: ${message}`)
    }
  })
}
