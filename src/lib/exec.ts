const readPipe = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
  if (!stream) {
    return ''
  }
  return await new Response(stream).text()
}

export const assertSafeGitRef = (value: string, label = 'git ref'): string => {
  const ref = value.trim()
  if (!ref) {
    throw new Error(`Invalid ${label}: empty value`)
  }
  if (ref.startsWith('-')) {
    throw new Error(`Invalid ${label}: option-like value "${value}"`)
  }
  if (/\s/.test(ref)) {
    throw new Error(`Invalid ${label}: whitespace is not allowed ("${value}")`)
  }
  if (ref.includes('\u0000')) {
    throw new Error(`Invalid ${label}: contains NUL byte`)
  }
  return ref
}

export const assertCommitSha = (value: string): string => {
  const sha = assertSafeGitRef(value, 'commit SHA')
  if (!/^[0-9a-fA-F]{40}$/.test(sha)) {
    throw new Error(`Invalid commit SHA: "${value}"`)
  }
  return sha
}

const sanitizedGitEnvKeys = new Set([
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
])

export const sanitizeGitEnv = (env: NodeJS.ProcessEnv): Record<string, string> => {
  const sanitized: Record<string, string> = {}

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || sanitizedGitEnvKeys.has(key)) {
      continue
    }

    sanitized[key] = value
  }

  return sanitized
}

export const exec = async (command: string, args: string[], cwd: string): Promise<string> => {
  const proc = Bun.spawn([command, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const exitCode = await proc.exited
  const [stdout, stderr] = await Promise.all([readPipe(proc.stdout), readPipe(proc.stderr)])

  if (exitCode !== 0) {
    const rendered = [command, ...args].join(' ')
    throw new Error(`Command failed (exit ${exitCode}): ${rendered}\n${stderr}`)
  }

  return stdout.trim()
}

export const buildGitConfigEnv = (config: Record<string, string>): Record<string, string> => {
  const entries = Object.entries(config)
  if (entries.length === 0) {
    return {}
  }
  return Object.fromEntries([
    ['GIT_CONFIG_COUNT', String(entries.length)],
    ...entries.flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${index}`, key],
      [`GIT_CONFIG_VALUE_${index}`, value],
    ]),
  ])
}

export const execGit = async (
  args: string[],
  cwd: string,
  options?: { config?: Record<string, string> },
): Promise<string> => {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    env: { ...sanitizeGitEnv(process.env), ...buildGitConfigEnv(options?.config ?? {}) },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const exitCode = await proc.exited
  const [stdout, stderr] = await Promise.all([readPipe(proc.stdout), readPipe(proc.stderr)])

  if (exitCode !== 0) {
    throw new Error(`Command failed (exit ${exitCode}): git ${args.join(' ')}\n${stderr}`)
  }

  return stdout.trim()
}
