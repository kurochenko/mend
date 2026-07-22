import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { ProjectConfig } from '@/config'
import { maskCommandResult } from '@/fix-workspaces/redaction'
import type {
  FixWorkspaceProvider,
  PrepareFixWorkspaceInput,
  PreparedFixWorkspace,
  WorkspaceCommandInput,
  WorkspaceCommandResult,
} from '@/fix-workspaces/types'

const DEFAULT_TIMEOUT_MS = 600_000
const CONTAINER_WORKDIR = '/workspace'

interface ProcessResult {
  exitCode: number
  stdout: string
  stderr: string
}

type ProcessRunner = (
  command: string,
  args: string[],
  options?: { timeoutMs?: number; env?: Record<string, string> },
) => Promise<ProcessResult>

interface DockerProviderDeps {
  runProcess?: ProcessRunner
}

interface ResolvedEnvVar {
  name: string
  value: string
}

const readPipe = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
  if (!stream) {
    return ''
  }
  return await new Response(stream).text()
}

const runProcess: ProcessRunner = async (command, args, options) => {
  const proc = Bun.spawn([command, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: options?.env ? { ...process.env, ...options.env } : undefined,
  })
  const timeoutId = setTimeout(() => {
    proc.kill()
  }, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    readPipe(proc.stdout),
    readPipe(proc.stderr),
  ]).finally(() => {
    clearTimeout(timeoutId)
  })

  return { exitCode, stdout, stderr }
}

const sanitizeContainerName = (value: string): string =>
  value
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .replace(/^-+/, '')
    .slice(0, 120)

const stringifyEnvValue = (value: string | number | boolean): string => `${value}`

const resolveEnv = (project: ProjectConfig): ResolvedEnvVar[] => {
  const workspace = project.review.fix.workspace
  if (!workspace) {
    return []
  }

  return Object.entries(workspace.env).map(([name, value]) => {
    if (typeof value === 'object' && 'from_env' in value) {
      const resolved = process.env[value.from_env]
      if (resolved === undefined) {
        throw new Error(`Environment variable "${value.from_env}" referenced by ${name} is not set`)
      }
      return { name, value: resolved }
    }

    if (typeof value === 'object' && 'value' in value) {
      return { name, value: stringifyEnvValue(value.value) }
    }

    return { name, value: stringifyEnvValue(value) }
  })
}

const safeEnvName = (value: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid Docker workspace environment variable name: ${value}`)
  }

  return value
}

const mountArgs = (project: ProjectConfig, worktreePath: string): string[] => {
  const workspace = project.review.fix.workspace
  if (!workspace) {
    return []
  }

  const args = [
    '--mount',
    `type=bind,source=${resolve(worktreePath)},target=${CONTAINER_WORKDIR}`,
    ...gitWorktreeMountArgs(worktreePath),
  ]

  for (const mount of workspace.mounts) {
    const options = [`type=bind`, `source=${resolve(mount.source)}`, `target=${mount.target}`]
    if (mount.read_only) {
      options.push('readonly')
    }
    args.push('--mount', options.join(','))
  }

  return args
}

const bindMountArg = (source: string, target = source): string[] => [
  '--mount',
  [`type=bind`, `source=${resolve(source)}`, `target=${target}`].join(','),
]

const readGitdirFile = (path: string): string | null => {
  if (!existsSync(path) || !lstatSync(path).isFile()) {
    return null
  }

  const content = readFileSync(path, 'utf8').trim()
  if (!content.startsWith('gitdir:')) {
    return null
  }

  const gitdir = content.slice('gitdir:'.length).trim()
  return gitdir ? resolve(dirname(path), gitdir) : null
}

const readCommonDir = (gitdir: string): string | null => {
  const commonDirFile = resolve(gitdir, 'commondir')
  if (!existsSync(commonDirFile)) {
    return null
  }

  const commonDir = readFileSync(commonDirFile, 'utf8').trim()
  return commonDir ? resolve(gitdir, commonDir) : null
}

const gitWorktreeMountArgs = (worktreePath: string): string[] => {
  const gitdir = readGitdirFile(resolve(worktreePath, '.git'))
  if (!gitdir) {
    return []
  }

  const paths = new Set([gitdir])
  const commonDir = readCommonDir(gitdir)
  if (commonDir) {
    paths.add(commonDir)
  }

  return [...paths].flatMap((path) => bindMountArg(path))
}

const dockerRunArgs = (
  input: PrepareFixWorkspaceInput,
  containerName: string,
  envVars: ResolvedEnvVar[],
): string[] => {
  const workspace = input.project.review.fix.workspace
  if (!workspace) {
    throw new Error(`Project ${input.project.key} has no fixer workspace configured`)
  }

  const args = [
    'run',
    '--detach',
    '--name',
    containerName,
    '--workdir',
    CONTAINER_WORKDIR,
    '--network',
    workspace.network,
    ...mountArgs(input.project, input.worktreePath),
  ]

  for (const envVar of envVars) {
    args.push('--env', safeEnvName(envVar.name))
  }

  args.push(workspace.image, 'sh', '-lc', 'sleep infinity')
  return args
}

const toCommandResult = (
  input: WorkspaceCommandInput,
  result: ProcessResult,
  durationMs: number,
  secrets: string[],
): WorkspaceCommandResult =>
  maskCommandResult(
    {
      command: input.command,
      phase: input.phase ?? 'command',
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs,
    },
    secrets,
  )

const dockerRunEnv = (envVars: ResolvedEnvVar[]): Record<string, string> =>
  Object.fromEntries(envVars.map((envVar) => [safeEnvName(envVar.name), envVar.value]))

class DockerFixWorkspace implements PreparedFixWorkspace {
  provider = 'docker' as const
  workspaceCwd = CONTAINER_WORKDIR
  git: { mode: 'host'; cwd: string }
  setupResults: WorkspaceCommandResult[] = []

  constructor(
    private options: {
      id: string
      hostWorktreePath: string
      checks: string[]
      secrets: string[]
      runProcess: ProcessRunner
    },
  ) {
    this.id = options.id
    this.hostWorktreePath = options.hostWorktreePath
    this.git = { mode: 'host', cwd: options.hostWorktreePath }
  }

  id: string
  hostWorktreePath: string

  async runCommand(input: WorkspaceCommandInput): Promise<WorkspaceCommandResult> {
    const start = Date.now()
    const result = await this.options.runProcess(
      'docker',
      ['exec', '--workdir', CONTAINER_WORKDIR, this.id, 'sh', '-lc', input.command],
      { timeoutMs: input.timeoutMs },
    )
    return toCommandResult(input, result, Date.now() - start, this.options.secrets)
  }

  async runAgentCommand(
    command: string,
    options?: { timeoutMs?: number },
  ): Promise<WorkspaceCommandResult> {
    return await this.runCommand({ command, phase: 'agent', timeoutMs: options?.timeoutMs })
  }

  async runChecks(): Promise<WorkspaceCommandResult[]> {
    const results: WorkspaceCommandResult[] = []
    for (const command of this.options.checks) {
      results.push(await this.runCommand({ command, phase: 'check' }))
    }
    return results
  }

  async teardown(): Promise<void> {
    await this.options.runProcess('docker', ['rm', '--force', this.id])
  }
}

export class DockerFixWorkspaceProvider implements FixWorkspaceProvider {
  kind = 'docker' as const
  private runProcess: ProcessRunner

  constructor(deps: DockerProviderDeps = {}) {
    this.runProcess = deps.runProcess ?? runProcess
  }

  async prepare(input: PrepareFixWorkspaceInput): Promise<PreparedFixWorkspace> {
    const workspace = input.project.review.fix.workspace
    if (!workspace) {
      throw new Error(`Project ${input.project.key} has no fixer workspace configured`)
    }

    const envVars = resolveEnv(input.project)
    const containerName = sanitizeContainerName(
      `mend-${input.project.key}-mr-${input.mrIid}-${input.attemptId}`,
    )
    const startResult = await this.runProcess(
      'docker',
      dockerRunArgs(input, containerName, envVars),
      {
        timeoutMs: DEFAULT_TIMEOUT_MS,
        env: dockerRunEnv(envVars),
      },
    )

    if (startResult.exitCode !== 0) {
      const masked = maskCommandResult(
        startResult,
        envVars.map((envVar) => envVar.value),
      )
      throw new Error(`Docker workspace failed to start: ${masked.stderr || masked.stdout}`)
    }

    const prepared = new DockerFixWorkspace({
      id: containerName,
      hostWorktreePath: input.worktreePath,
      checks: workspace.checks,
      secrets: envVars.map((envVar) => envVar.value),
      runProcess: this.runProcess,
    })

    for (const command of workspace.setup) {
      const setupResult = await prepared.runCommand({ command, phase: 'setup' })
      prepared.setupResults.push(setupResult)
      if (setupResult.exitCode !== 0) {
        await prepared.teardown()
        throw new Error(
          `Docker workspace setup failed: ${setupResult.stderr || setupResult.stdout}`,
        )
      }
    }

    return prepared
  }
}
