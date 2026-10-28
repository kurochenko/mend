import { isAbsolute } from 'node:path'
import type { ProjectConfig } from '@/config'
import { withProjectRepoLock } from '@/integrations/repo-locks'
import { toErrorMessage } from '@/lib/errors'
import { assertCommitSha, execGit } from '@/lib/exec'

const authUsername = (project: ProjectConfig): string =>
  project.platform === 'github' ? 'x-access-token' : 'oauth2'

const buildAuthHeader = (project: ProjectConfig): string =>
  `Authorization: Basic ${Buffer.from(`${authUsername(project)}:${project.token}`).toString('base64')}`

export const execGitWithAuth = async (
  args: string[],
  cwd: string,
  project: ProjectConfig,
): Promise<string> =>
  await execGit(args, cwd, { config: { 'http.extraHeader': buildAuthHeader(project) } })

export const cloneUrl = (project: ProjectConfig): string => {
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

const ORIGIN_FETCH_REFSPEC = '+refs/heads/*:refs/remotes/origin/*'

export const originTrackingRef = (branch: string): string => `refs/remotes/origin/${branch}`

export const syncOriginBranches = async (project: ProjectConfig): Promise<void> => {
  await execGit(['remote', 'set-url', 'origin', cloneUrl(project)], project.clone_path)
  await execGit(
    ['config', '--replace-all', 'remote.origin.fetch', ORIGIN_FETCH_REFSPEC],
    project.clone_path,
  )
  await execGitWithAuth(['fetch', '--prune', 'origin'], project.clone_path, project)
}

export const hasCommit = async (repoPath: string, commitSha: string): Promise<boolean> => {
  try {
    await execGit(['cat-file', '-e', `${commitSha}^{commit}`], repoPath)
    return true
  } catch {
    return false
  }
}

export const fetchCommitSha = async (project: ProjectConfig, commitSha: string): Promise<void> => {
  const safeCommitSha = assertCommitSha(commitSha)
  try {
    await execGitWithAuth(['fetch', 'origin', safeCommitSha], project.clone_path, project)
  } catch (error) {
    throw new Error(
      `Unable to fetch requested commit SHA ${safeCommitSha} from origin: ${toErrorMessage(error)}`,
    )
  }
}

export const ensureCommitsAvailable = async (
  project: ProjectConfig,
  commitShas: string[],
): Promise<string[]> =>
  await withProjectRepoLock(project.key, async () => {
    const warnings: string[] = []

    for (const commitSha of new Set(commitShas)) {
      try {
        const safeCommitSha = assertCommitSha(commitSha)
        if (!(await hasCommit(project.clone_path, safeCommitSha))) {
          console.log(`[repo] fetching missing commit ${safeCommitSha} for ${project.key}`)
          await fetchCommitSha(project, safeCommitSha)
        }
      } catch (error) {
        warnings.push(toErrorMessage(error))
      }
    }

    return warnings
  })

export const refetchOrigin = async (project: ProjectConfig): Promise<void> => {
  await withProjectRepoLock(project.key, async () => await syncOriginBranches(project))
}
