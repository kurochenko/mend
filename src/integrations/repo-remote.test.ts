import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import type { ProjectConfig } from '@/config'
import {
  ensureCommitsAvailable,
  originTrackingRef,
  refetchOrigin,
} from '@/integrations/repo-remote'
import { execGit } from '@/lib/exec'

const testCommitIdentity = {
  'user.name': 'Mend Test',
  'user.email': 'mend-test@example.com',
}

const makeProject = (root: string): ProjectConfig => ({
  key: 'repo-remote-test',
  clone_path: join(root, 'bare.git'),
  platform: 'gitlab',
  url: 'https://gitlab.example.com',
  token: 'token',
  webhook_secret: 'secret',
  project_id: 1,
  repo_url: join(root, 'origin'),
  default_branch: 'main',
  trigger: { mode: 'ready' },
  tools: { context7: {} },
  review: {
    llm: { model: 'model', thinking_level: 'medium' },
    agent: { harness: 'pi' },
    flags: {
      structured_findings_post: true,
      structural_signals: true,
      bug_history: true,
      dry_run: false,
    },
    comparison: { enabled: false, harness: 'opencode', timeout_ms: 300_000 },
    memory: { project_scope_usernames: [] },
  },
})

const commit = async (cwd: string, content: string): Promise<string> => {
  writeFileSync(join(cwd, 'file.txt'), content)
  await execGit(['add', 'file.txt'], cwd)
  await execGit(['commit', '-m', content], cwd, { config: testCommitIdentity })
  return await execGit(['rev-parse', 'HEAD'], cwd)
}

const createOrigin = async (root: string): Promise<string> => {
  const origin = join(root, 'origin')
  await execGit(['init', '-b', 'main', origin], root)
  await commit(origin, 'one')
  return origin
}

const cloneBare = async (project: ProjectConfig, origin: string): Promise<void> => {
  await execGit(['clone', '--bare', origin, project.clone_path], origin)
}

const readFetchRefspecs = async (project: ProjectConfig): Promise<string> =>
  await execGit(['config', '--get-all', 'remote.origin.fetch'], project.clone_path).catch(() => '')

const roots: string[] = []

const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'mend-repo-remote-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('refetchOrigin', () => {
  it('adds the fetch refspec to bare clones so the target branch advances', async () => {
    const root = makeRoot()
    const origin = await createOrigin(root)
    const project = makeProject(root)
    await cloneBare(project, origin)
    expect(await readFetchRefspecs(project)).toBe('')

    const advancedSha = await commit(origin, 'two')
    await refetchOrigin(project)

    expect(await execGit(['rev-parse', originTrackingRef('main')], project.clone_path)).toBe(
      advancedSha,
    )
    await refetchOrigin(project)
    expect(await readFetchRefspecs(project)).toBe('+refs/heads/*:refs/remotes/origin/*')
  })

  it('keeps fetching when a source branch is checked out in a worktree', async () => {
    const root = makeRoot()
    const origin = await createOrigin(root)
    const project = makeProject(root)
    await execGit(['checkout', '-b', 'feature'], origin)
    await commit(origin, 'feature')
    await execGit(['checkout', 'main'], origin)
    await cloneBare(project, origin)
    await execGit(['worktree', 'add', join(root, 'mr-1'), 'feature'], project.clone_path)

    await execGit(['checkout', 'feature'], origin)
    const featureSha = await commit(origin, 'feature two')
    await execGit(['checkout', 'main'], origin)
    const mainSha = await commit(origin, 'two')

    await refetchOrigin(project)

    expect(await execGit(['rev-parse', originTrackingRef('main')], project.clone_path)).toBe(
      mainSha,
    )
    expect(await execGit(['rev-parse', originTrackingRef('feature')], project.clone_path)).toBe(
      featureSha,
    )
  })
})

describe('ensureCommitsAvailable', () => {
  it('fetches a base commit missing from the clone', async () => {
    const root = makeRoot()
    const origin = await createOrigin(root)
    const project = makeProject(root)
    await cloneBare(project, origin)
    const baseSha = await commit(origin, 'two')

    const warnings = await ensureCommitsAvailable(project, [baseSha])

    expect(warnings).toEqual([])
    expect(await execGit(['cat-file', '-t', baseSha], project.clone_path)).toBe('commit')
  })

  it('returns a warning when a commit cannot be fetched', async () => {
    const root = makeRoot()
    const origin = await createOrigin(root)
    const project = makeProject(root)
    await cloneBare(project, origin)

    const warnings = await ensureCommitsAvailable(project, ['f'.repeat(40)])

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(`Unable to fetch requested commit SHA ${'f'.repeat(40)}`)
  })
})
