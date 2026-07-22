import { resolve } from 'node:path'
import type { ProjectConfig } from '@/config'
import type { FixBatchRecord } from '@/db/fix-batches'
import type { ReviewFindingRecord } from '@/db/review-findings'
import {
  createDefaultFixerHarnesses,
  type FixerAgentHarness,
  type FixerAgentHarnessId,
} from '@/agents/fixer-harness'
import type { ReviewAgentThinkingLevel } from '@/agents/review-harness'
import type { PreparedFixWorkspace, WorkspaceCommandResult } from '@/fix-workspaces/types'
import { buildFixerInstructions, buildFixerPrompt } from '@/mastra/fix/prompt'
import { parseFixerOutput, type FixerOutput } from '@/mastra/fix/schema'

export interface EffectiveFixerAgentConfig {
  harness: FixerAgentHarnessId
  model: string
  thinkingLevel: ReviewAgentThinkingLevel
  timeoutMs: number | undefined
}

export interface RunFixerAgentInput {
  project: ProjectConfig
  batch: FixBatchRecord
  findings: ReviewFindingRecord[]
  workspace: PreparedFixWorkspace
  sessionDir: string
  harnesses?: Partial<Record<FixerAgentHarnessId, FixerAgentHarness>>
}

export interface RunFixerAgentResult {
  output: FixerOutput
  rawOutput: string
  harness: FixerAgentHarnessId
  model: string
  durationMs: number
  logs: WorkspaceCommandResult[]
}

const includesId = (ids: unknown, id: string): boolean => Array.isArray(ids) && ids.includes(id)
const workFindingStates = new Set<ReviewFindingRecord['state']>(['pending', 'accepted'])
const contextFindingStates = new Set<ReviewFindingRecord['state']>(['rejected', 'deferred'])

const assertAllWorkFindingsReported = (
  acceptedFindings: ReviewFindingRecord[],
  output: FixerOutput,
): void => {
  const reported = new Set([
    ...output.fixedFindings.map((finding) => finding.id),
    ...output.notFixedFindings.map((finding) => finding.id),
  ])
  const missing = acceptedFindings
    .map((finding) => finding.id)
    .filter((findingId) => !reported.has(findingId))

  if (missing.length > 0) {
    throw new Error(`Fixer output did not report finding(s): ${missing.join(', ')}`)
  }
}

export const getEffectiveFixerAgentConfig = (project: ProjectConfig): EffectiveFixerAgentConfig => {
  const fixerAgent = project.review.fix.agent
  const reviewAgent = project.review.agent
  return {
    harness: fixerAgent?.harness ?? 'codex',
    model: fixerAgent?.model ?? reviewAgent.model ?? project.review.llm.model,
    thinkingLevel:
      fixerAgent?.thinking_level ?? reviewAgent.thinking_level ?? project.review.llm.thinking_level,
    timeoutMs: fixerAgent?.timeout_ms ?? reviewAgent.timeout_ms,
  }
}

export const selectFixerFindings = (input: {
  batch: FixBatchRecord
  findings: ReviewFindingRecord[]
}): {
  acceptedFindings: ReviewFindingRecord[]
  contextFindings: ReviewFindingRecord[]
} => {
  const acceptedFindings = input.findings.filter(
    (finding) =>
      workFindingStates.has(finding.state) &&
      includesId(input.batch.acceptedFindingIds, finding.id),
  )
  const acceptedIds = new Set(acceptedFindings.map((finding) => finding.id))
  const contextFindings = input.findings.filter(
    (finding) => !acceptedIds.has(finding.id) && contextFindingStates.has(finding.state),
  )

  return { acceptedFindings, contextFindings }
}

export const runFixerAgent = async (input: RunFixerAgentInput): Promise<RunFixerAgentResult> => {
  const harnesses = { ...createDefaultFixerHarnesses(), ...input.harnesses }
  const agentConfig = getEffectiveFixerAgentConfig(input.project)
  const harness = harnesses[agentConfig.harness]
  if (!harness) {
    throw new Error(`Fixer harness not available: ${agentConfig.harness}`)
  }

  const { acceptedFindings, contextFindings } = selectFixerFindings({
    batch: input.batch,
    findings: input.findings,
  })
  if (acceptedFindings.length === 0) {
    throw new Error(`Fix batch ${input.batch.id} has no accepted findings to run`)
  }

  const workspace = input.project.review.fix.workspace
  const prompt = buildFixerPrompt({
    projectKey: input.project.key,
    mrIid: input.batch.mrIid,
    acceptedFindings,
    contextFindings,
    checks: workspace?.checks ?? [],
  })
  const result = await harness.invoke({
    workspace: input.workspace,
    sessionDir: resolve(input.sessionDir, `fixer-${agentConfig.harness}`),
    model: agentConfig.model,
    thinkingLevel: agentConfig.thinkingLevel,
    instructions: buildFixerInstructions(),
    prompt,
    timeoutMs: agentConfig.timeoutMs,
  })

  if (!result.success) {
    throw new Error(`${agentConfig.harness} fixer failed: ${result.error}`)
  }

  const output = parseFixerOutput(result.output)
  assertAllWorkFindingsReported(acceptedFindings, output)

  return {
    output,
    rawOutput: result.output,
    harness: agentConfig.harness,
    model: agentConfig.model,
    durationMs: result.durationMs,
    logs: result.logs,
  }
}
