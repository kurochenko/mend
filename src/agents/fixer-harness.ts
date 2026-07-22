import type { ReviewAgentThinkingLevel } from '@/agents/review-harness'
import type { PreparedFixWorkspace, WorkspaceCommandResult } from '@/fix-workspaces/types'

export type FixerAgentHarnessId = 'codex'

export interface FixerAgentRunConfig {
  workspace: PreparedFixWorkspace
  sessionDir: string
  model: string
  thinkingLevel?: ReviewAgentThinkingLevel
  instructions: string
  prompt: string
  timeoutMs?: number
  signal?: AbortSignal
}

export interface FixerAgentResult {
  harness: FixerAgentHarnessId
  model: string
  success: boolean
  output: string
  durationMs: number
  logs: WorkspaceCommandResult[]
  error?: string
}

export interface FixerAgentHarness {
  id: FixerAgentHarnessId
  invoke: (config: FixerAgentRunConfig) => Promise<FixerAgentResult>
}

const toCodexReasoningEffort = (
  thinkingLevel: ReviewAgentThinkingLevel | undefined,
): 'minimal' | 'low' | 'medium' | 'high' | null => {
  if (!thinkingLevel) {
    return null
  }

  if (thinkingLevel === 'off') {
    return 'minimal'
  }

  return thinkingLevel
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

const buildFullPrompt = (instructions: string, prompt: string): string =>
  `<instructions>\n${instructions}\n</instructions>\n\n${prompt}`

export const buildCodexFixerCommand = (config: {
  model: string
  thinkingLevel?: ReviewAgentThinkingLevel
  prompt: string
  runId: string
}): string => {
  const outputPath = '$tmp_dir/output.txt'
  const args = [
    'codex',
    'exec',
    '--cd',
    '/workspace',
    '--sandbox',
    'workspace-write',
    '--model',
    config.model,
    '--output-last-message',
    outputPath,
  ]

  const reasoningEffort = toCodexReasoningEffort(config.thinkingLevel)
  if (reasoningEffort) {
    args.push('--config', `model_reasoning_effort="${reasoningEffort}"`)
  }

  args.push('-')
  const command = args
    .map((arg) => (arg === outputPath ? '"$output_file"' : shellQuote(arg)))
    .join(' ')
  const encodedPrompt = Buffer.from(config.prompt).toString('base64')

  return [
    `tmp_dir=${shellQuote(`/tmp/mend-fixer-${config.runId}`)}`,
    'mkdir -p "$tmp_dir"',
    'output_file="$tmp_dir/output.txt"',
    'events_file="$tmp_dir/events.jsonl"',
    `base64 -d <<'MEND_FIXER_PROMPT' | ${command} > "$events_file"`,
    encodedPrompt,
    'MEND_FIXER_PROMPT',
    'status=$?',
    'if [ -f "$output_file" ]; then cat "$output_file"; else cat "$events_file"; fi',
    'exit "$status"',
  ].join('\n')
}

export const invokeCodexFixer = async (config: FixerAgentRunConfig): Promise<FixerAgentResult> => {
  if (config.signal?.aborted) {
    return {
      harness: 'codex',
      model: config.model,
      success: false,
      output: '',
      durationMs: 0,
      logs: [],
      error: 'Codex fixer aborted before start',
    }
  }

  const start = Date.now()
  const runId = `${Date.now()}`
  const fullPrompt = buildFullPrompt(config.instructions, config.prompt)

  const commandResult = await config.workspace.runAgentCommand(
    buildCodexFixerCommand({
      model: config.model,
      thinkingLevel: config.thinkingLevel,
      prompt: fullPrompt,
      runId,
    }),
    { timeoutMs: config.timeoutMs },
  )

  return {
    harness: 'codex',
    model: config.model,
    success: commandResult.exitCode === 0,
    output: commandResult.stdout,
    durationMs: Date.now() - start,
    logs: [commandResult],
    error: commandResult.exitCode === 0 ? undefined : commandResult.stderr || commandResult.stdout,
  }
}

export const createDefaultFixerHarnesses = (): Partial<
  Record<FixerAgentHarnessId, FixerAgentHarness>
> => ({
  codex: {
    id: 'codex',
    invoke: invokeCodexFixer,
  },
})
