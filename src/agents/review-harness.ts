export type ReviewAgentHarnessId = 'pi' | 'codex' | 'opencode' | 'ensemble'

export type ReviewAgentToolMode = 'full' | 'none'

export type ReviewAgentThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high'

export interface ReviewAgentRunConfig {
  cwd: string
  sessionDir: string
  model: string
  thinkingLevel?: ReviewAgentThinkingLevel
  instructions: string
  prompt: string
  changedFiles?: string[]
  expectedPriorBlockerIds?: readonly string[]
  timeoutMs?: number
  context7ApiKey?: string | null
  toolMode?: ReviewAgentToolMode
  signal?: AbortSignal
}

export interface ReviewAgentResult {
  harness: ReviewAgentHarnessId
  model: string
  success: boolean
  output: string
  durationMs: number
  sessionFile?: string
  inspectedFiles?: string[]
  error?: string
}

export interface ReviewAgentHarness {
  id: ReviewAgentHarnessId
  invoke: (config: ReviewAgentRunConfig) => Promise<ReviewAgentResult>
}
