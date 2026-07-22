import { toErrorMessage } from '@/lib/errors'

export interface OpenCodeReviewConfig {
  cwd: string
  model: string
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high'
  instructions: string
  prompt: string
  timeoutMs?: number
  signal?: AbortSignal
}

export interface OpenCodeReviewResult {
  success: boolean
  output: string
  durationMs: number
  error?: string
}

const DEFAULT_TIMEOUT_MS = 300_000

const buildFullPrompt = (instructions: string, prompt: string): string =>
  `<instructions>\n${instructions}\n</instructions>\n\n${prompt}`

const buildCommand = (config: OpenCodeReviewConfig, fullPrompt: string): string[] => {
  const args = ['opencode', 'run', '--format', 'json', '--dir', config.cwd, '-m', config.model]

  if (config.thinkingLevel) {
    args.push('--variant', config.thinkingLevel)
  }

  args.push(fullPrompt)

  return args
}

const readEventText = (event: Record<string, unknown>): string | null => {
  const partValue = event.part
  const part =
    partValue && typeof partValue === 'object' ? (partValue as Record<string, unknown>) : null

  if (part && part.type === 'text' && typeof part.text === 'string') {
    return part.text
  }

  if (event.type === 'text') {
    if (typeof event.content === 'string') {
      return event.content
    }
    if (typeof event.text === 'string') {
      return event.text
    }
  }

  if (event.type === 'assistant' && typeof event.content === 'string') {
    return event.content
  }

  if (event.type === 'message' && event.role === 'assistant') {
    const content = event.content
    if (typeof content === 'string') {
      return content
    }
    if (Array.isArray(content)) {
      const textParts = content
        .map((item) =>
          item && typeof item === 'object' ? (item as Record<string, unknown>) : null,
        )
        .filter((item): item is Record<string, unknown> => item !== null)
        .filter((item) => item.type === 'text' && typeof item.text === 'string')
        .map((item) => item.text as string)

      if (textParts.length > 0) {
        return textParts.join('')
      }
    }
  }

  return null
}

export const extractAssistantText = (stdout: string): string => {
  const lines = stdout.split('\n').filter((line) => line.trim().length > 0)
  const textParts: string[] = []

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>

      const text = readEventText(event)
      if (text !== null) {
        textParts.push(text)
      }
    } catch {}
  }

  if (textParts.length > 0) {
    return textParts.join('')
  }

  return stdout
}

export const invokeOpenCodeReview = async (
  config: OpenCodeReviewConfig,
): Promise<OpenCodeReviewResult> => {
  if (config.signal?.aborted) {
    return {
      success: false,
      output: '',
      durationMs: 0,
      error: 'OpenCode review aborted before start',
    }
  }

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fullPrompt = buildFullPrompt(config.instructions, config.prompt)
  const command = buildCommand(config, fullPrompt)
  const startTime = Date.now()

  try {
    const proc = Bun.spawn(command, {
      cwd: config.cwd,
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

    const [exitCode, stdoutBuf, stderrBuf] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]).finally(() => {
      clearTimeout(timeoutId)
      config.signal?.removeEventListener('abort', onAbort)
    })

    const durationMs = Date.now() - startTime

    if (config.signal?.aborted) {
      return {
        success: false,
        output: extractAssistantText(stdoutBuf),
        durationMs,
        error: 'OpenCode review aborted',
      }
    }

    if (durationMs >= timeoutMs) {
      return {
        success: false,
        output: extractAssistantText(stdoutBuf),
        durationMs,
        error: `OpenCode review timed out after ${timeoutMs}ms`,
      }
    }

    if (exitCode !== 0) {
      return {
        success: false,
        output: extractAssistantText(stdoutBuf),
        durationMs,
        error: `OpenCode exited with code ${exitCode}: ${stderrBuf.trim()}`,
      }
    }

    return {
      success: true,
      output: extractAssistantText(stdoutBuf),
      durationMs,
    }
  } catch (err) {
    return {
      success: false,
      output: '',
      durationMs: Date.now() - startTime,
      error: toErrorMessage(err),
    }
  }
}
