import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { authFailureMessage, extractErrorEventText, isAuthFailure } from '@/agents/auth-failure'
import { toErrorMessage } from '@/lib/errors'
import type { ReviewAgentRunConfig, ReviewAgentResult } from '@/agents/review-harness'

const DEFAULT_TIMEOUT_MS = 1_200_000

const buildFullPrompt = (instructions: string, prompt: string): string =>
  `<instructions>\n${instructions}\n</instructions>\n\n${prompt}`

const toCodexReasoningEffort = (
  thinkingLevel: ReviewAgentRunConfig['thinkingLevel'],
): 'minimal' | 'low' | 'medium' | 'high' | null => {
  if (!thinkingLevel) {
    return null
  }

  if (thinkingLevel === 'off') {
    return 'minimal'
  }

  return thinkingLevel
}

const REVIEW_PERMISSION_PROFILE = 'mend-review'

export const resolveCodexInstallRoot = (
  findExecutable: (name: string) => string | null = Bun.which,
): string | null => {
  const executable = findExecutable('codex')
  if (!executable) {
    return null
  }
  const realExecutable = realpathSync(executable)
  return realExecutable.endsWith('.js')
    ? dirname(dirname(dirname(realExecutable)))
    : dirname(realExecutable)
}

export const resolveGitCommonDir = (cwd: string): string | null => {
  const result = Bun.spawnSync(
    ['git', '-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { stdout: 'pipe', stderr: 'ignore' },
  )
  const gitCommonDir = result.stdout.toString().trim()
  return result.exitCode === 0 && gitCommonDir ? realpathSync(gitCommonDir) : null
}

const resolveReviewReadRoots = (cwd: string): string[] =>
  [resolveCodexInstallRoot(), resolveGitCommonDir(cwd)].filter(
    (root): root is string => root !== null,
  )

export const buildReviewFilesystemPolicy = (readRoots: string[]): string =>
  [
    '":root" = "deny"',
    '":minimal" = "read"',
    '":workspace_roots" = "read"',
    ...readRoots.map((root) => `${JSON.stringify(root)} = "read"`),
  ].join(', ')

export const buildCommand = (
  config: ReviewAgentRunConfig,
  outputFile: string,
  readRoots: string[] = resolveReviewReadRoots(config.cwd),
): string[] => {
  const command = [
    'codex',
    'exec',
    '--cd',
    config.cwd,
    '--config',
    `default_permissions="${REVIEW_PERMISSION_PROFILE}"`,
    '--config',
    `permissions.${REVIEW_PERMISSION_PROFILE}.filesystem={ ${buildReviewFilesystemPolicy(readRoots)} }`,
    '--config',
    'web_search="disabled"',
    '--model',
    config.model,
    '--json',
    '--output-last-message',
    outputFile,
  ]

  const reasoningEffort = toCodexReasoningEffort(config.thinkingLevel)
  if (reasoningEffort) {
    command.push('--config', `model_reasoning_effort="${reasoningEffort}"`)
  }

  command.push('-')

  return command
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const commandReadsFileContent = (command: string): boolean =>
  /(^|[\s;&|('"`])(?:cat|sed|nl|head|tail|bat)\s/.test(command)

const commandReferencesExactPath = (command: string, file: string): boolean =>
  new RegExp(`(^|[^\\w./-])${escapeRegExp(file)}($|[^\\w./-])`).test(command)

export const extractInspectedChangedFilesFromEvents = (
  eventsJsonl: string,
  changedFiles: string[] | undefined,
): string[] => {
  if (!changedFiles || changedFiles.length === 0) {
    return []
  }

  const inspected = new Set<string>()
  for (const line of eventsJsonl.split('\n')) {
    if (!line.trim()) {
      continue
    }

    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }

    if (!event || typeof event !== 'object') {
      continue
    }

    const item = (event as { item?: unknown }).item
    if (!item || typeof item !== 'object') {
      continue
    }

    const typedItem = item as { type?: unknown; command?: unknown }
    if (typedItem.type !== 'command_execution' || typeof typedItem.command !== 'string') {
      continue
    }

    if (!commandReadsFileContent(typedItem.command)) {
      continue
    }

    for (const file of changedFiles) {
      if (commandReferencesExactPath(typedItem.command, file)) {
        inspected.add(file)
      }
    }
  }

  return [...inspected].sort((left, right) => left.localeCompare(right))
}

interface CodexProcessResult {
  exitCode: number
  stdout: string
  stderr: string
  output: string
  durationMs: number
}

interface RunCodexProcessInput {
  config: ReviewAgentRunConfig
  command: string[]
  outputFile: string
  eventsFile: string
  fullPrompt: string
  timeoutMs: number
}

const runCodexProcess = async (input: RunCodexProcessInput): Promise<CodexProcessResult> => {
  const { config, command, outputFile, eventsFile, fullPrompt, timeoutMs } = input
  const startTime = Date.now()
  const proc = Bun.spawn(command, {
    cwd: config.cwd,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const onAbort = () => {
    proc.kill()
  }

  config.signal?.addEventListener('abort', onAbort, { once: true })

  const timeoutId = setTimeout(() => {
    proc.kill()
  }, timeoutMs)

  await Promise.resolve(proc.stdin.write(fullPrompt))
  await Promise.resolve(proc.stdin.end())

  const [exitCode, stdoutBuf, stderrBuf] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => {
    clearTimeout(timeoutId)
    config.signal?.removeEventListener('abort', onAbort)
  })

  const durationMs = Date.now() - startTime
  writeFileSync(eventsFile, stdoutBuf)
  const output = existsSync(outputFile) ? readFileSync(outputFile, 'utf-8') : stdoutBuf

  return {
    exitCode,
    stdout: stdoutBuf,
    stderr: stderrBuf,
    output,
    durationMs,
  }
}

const toExitFailure = (
  processResult: CodexProcessResult,
  model: string,
): Pick<ReviewAgentResult, 'error' | 'authFailed'> => {
  if (isAuthFailure(`${processResult.stderr}\n${extractErrorEventText(processResult.stdout)}`)) {
    return {
      authFailed: true,
      error: authFailureMessage('Codex', model, 'run `codex login`'),
    }
  }

  return {
    error: `Codex exited with code ${processResult.exitCode}: ${processResult.stderr.trim() || processResult.stdout.trim()}`,
  }
}

export const invokeCodexReview = async (
  config: ReviewAgentRunConfig,
): Promise<ReviewAgentResult> => {
  if (config.signal?.aborted) {
    return {
      harness: 'codex',
      model: config.model,
      success: false,
      output: '',
      durationMs: 0,
      error: 'Codex review aborted before start',
    }
  }

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const codexSessionDir = join(config.sessionDir, 'codex')
  mkdirSync(codexSessionDir, { recursive: true })
  const runId = Date.now()
  const outputFile = join(codexSessionDir, `${runId}-last-message.txt`)
  const eventsFile = join(codexSessionDir, `${runId}-events.jsonl`)
  const fullPrompt = buildFullPrompt(config.instructions, config.prompt)
  const startTime = Date.now()

  try {
    const processResult = await runCodexProcess({
      config,
      command: buildCommand(config, outputFile),
      outputFile,
      eventsFile,
      fullPrompt,
      timeoutMs,
    })
    const inspectedFiles = extractInspectedChangedFilesFromEvents(
      processResult.stdout,
      config.changedFiles,
    )

    if (config.signal?.aborted) {
      return {
        harness: 'codex',
        model: config.model,
        success: false,
        output: processResult.output,
        durationMs: processResult.durationMs,
        sessionFile: eventsFile,
        inspectedFiles,
        error: 'Codex review aborted',
      }
    }

    if (processResult.durationMs >= timeoutMs) {
      return {
        harness: 'codex',
        model: config.model,
        success: false,
        output: processResult.output,
        durationMs: processResult.durationMs,
        sessionFile: eventsFile,
        inspectedFiles,
        error: `Codex review timed out after ${timeoutMs}ms`,
      }
    }

    if (processResult.exitCode !== 0) {
      return {
        harness: 'codex',
        model: config.model,
        success: false,
        output: processResult.output,
        durationMs: processResult.durationMs,
        sessionFile: eventsFile,
        inspectedFiles,
        ...toExitFailure(processResult, config.model),
      }
    }

    return {
      harness: 'codex',
      model: config.model,
      success: true,
      output: processResult.output,
      durationMs: processResult.durationMs,
      sessionFile: eventsFile,
      inspectedFiles,
    }
  } catch (error) {
    return {
      harness: 'codex',
      model: config.model,
      success: false,
      output: '',
      durationMs: Date.now() - startTime,
      error: toErrorMessage(error),
    }
  }
}
