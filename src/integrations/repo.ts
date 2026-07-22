import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { resolve } from 'node:path'
import type { ProjectConfig } from '@/config'
import { withProjectRepoLock } from '@/integrations/repo-locks'
import { toErrorMessage } from '@/lib/errors'
import { assertCommitSha, assertSafeGitRef, execGit } from '@/lib/exec'

const buildAuthHeader = (token: string): string =>
  `Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`

const execGitWithAuth = async (args: string[], cwd: string, token: string): Promise<string> =>
  await execGit(args, cwd, { config: { 'http.extraHeader': buildAuthHeader(token) } })

const branchRef = (branch: string): string => `refs/heads/${branch}`

const assertSafePushBranch = (value: string): string => {
  const branch = assertSafeGitRef(value, 'source branch')
  if (
    branch.startsWith('refs/') ||
    branch.includes(':') ||
    branch.includes('..') ||
    branch.endsWith('/') ||
    /[~^?*[\\]/.test(branch)
  ) {
    throw new Error(`Invalid source branch push destination: "${value}"`)
  }

  return branch
}

const cloneUrl = (project: ProjectConfig): string => {
  const sshMatch = project.repo_url.match(/git@([^:]+):(.+?)(?:\.git)?$/)
  if (sshMatch) {
    const path = sshMatch[2]!.endsWith('.git') ? sshMatch[2]! : `${sshMatch[2]}.git`
    return `https://${sshMatch[1]}/${path}`
  }

  const httpsMatch = project.repo_url.match(/^https?:\/\//)
  if (httpsMatch) {
    const url = new URL(project.repo_url)
    url.username = ''
    url.password = ''
    return url.toString()
  }

  if (isAbsolute(project.repo_url)) {
    return project.repo_url
  }

  throw new Error(`Cannot derive HTTPS clone URL from repo_url: ${project.repo_url}`)
}

export const ensureClone = async (project: ProjectConfig): Promise<string> => {
  return await withProjectRepoLock(project.key, async () => {
    const barePath = project.clone_path
    const repoCloneUrl = cloneUrl(project)

    if (existsSync(barePath)) {
      console.log(`[repo] fetching origin for ${project.key}`)
      await execGit(['remote', 'set-url', 'origin', repoCloneUrl], barePath)
      await execGitWithAuth(['fetch', 'origin'], barePath, project.token)
    } else {
      console.log(`[repo] cloning ${project.key} (bare) → ${barePath}`)
      await execGitWithAuth(
        ['clone', '--bare', repoCloneUrl, barePath],
        process.cwd(),
        project.token,
      )
    }

    return barePath
  })
}

const worktreePath = (project: ProjectConfig, mrIid: number): string =>
  resolve(project.clone_path, 'worktrees-mr', `mr-${mrIid}`)

const hasCommit = async (repoPath: string, commitSha: string): Promise<boolean> => {
  try {
    await execGit(['cat-file', '-e', `${commitSha}^{commit}`], repoPath)
    return true
  } catch {
    return false
  }
}

const fetchCommitSha = async (project: ProjectConfig, commitSha: string): Promise<void> => {
  const safeCommitSha = assertCommitSha(commitSha)
  try {
    await execGitWithAuth(['fetch', 'origin', safeCommitSha], project.clone_path, project.token)
  } catch (error) {
    throw new Error(
      `Unable to fetch requested commit SHA ${safeCommitSha} from origin: ${toErrorMessage(error)}`,
    )
  }
}

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
      project.token,
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

export const commitAndPushWorktree = async (params: {
  project: ProjectConfig
  worktreePath: string
  sourceBranch: string
  commitMessage: string
}): Promise<{
  commitSha: string
  pushedBranch: string
  remoteHeadSha: string
}> => {
  const safeSourceBranch = assertSafePushBranch(params.sourceBranch)
  const currentBranch = await execGit(['branch', '--show-current'], params.worktreePath)
  if (currentBranch !== safeSourceBranch) {
    throw new Error(`Worktree branch ${currentBranch || '<detached>'} is not ${safeSourceBranch}`)
  }

  const status = await execGit(['status', '--porcelain'], params.worktreePath)
  if (!status) {
    throw new Error(`No changes to commit for ${params.project.key} ${safeSourceBranch}`)
  }

  await execGit(['add', '-A'], params.worktreePath)
  await execGit(['commit', '-m', params.commitMessage], params.worktreePath, {
    config: {
      'user.name': 'Mend',
      'user.email': 'mend@example.invalid',
    },
  })
  const commitSha = await getWorktreeHeadSha(params.worktreePath)
  await execGitWithAuth(
    ['push', 'origin', `HEAD:${branchRef(safeSourceBranch)}`],
    params.worktreePath,
    params.project.token,
  )
  const remoteHeadSha = await execGitWithAuth(
    ['ls-remote', 'origin', branchRef(safeSourceBranch)],
    params.worktreePath,
    params.project.token,
  ).then((output) => output.split(/\s+/)[0] ?? '')

  return {
    commitSha,
    pushedBranch: safeSourceBranch,
    remoteHeadSha,
  }
}

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
