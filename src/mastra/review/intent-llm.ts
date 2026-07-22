import { z } from 'zod'
import { invokeCodexReview } from '@/agents/codex-harness'
import { invokePiReview } from '@/agents/pi-harness'
import type { ReviewAgentHarnessId } from '@/agents/review-harness'
import { extractJson } from '@/lib/json'
import { reviewIntents, type ReviewIntent } from '@/mastra/review/intents'

const intentSchema = z.enum(reviewIntents)

const intentClassifierOutputSchema = z.object({
  intent: intentSchema,
  confidence: z.number().min(0).max(1),
  rationale: z.array(z.string()).min(1),
  secondaryIntents: z.array(intentSchema).default([]),
})

export interface LlmIntentInput {
  title: string
  description: string
  labels: string[]
  sourceBranch: string
  targetBranch: string
  changedFiles: string[]
}

export interface LlmIntentConfig {
  harness: Extract<ReviewAgentHarnessId, 'pi' | 'codex'>
  cwd: string
  sessionDir: string
  model: string
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high'
  timeoutMs: number
}

export interface LlmIntentResult {
  intent: ReviewIntent
  confidence: number
  rationale: string[]
  secondaryIntents: ReviewIntent[]
}

const INTENT_CLASSIFIER_INSTRUCTIONS = [
  'You are a merge request intent classifier.',
  'Determine review intent from MR metadata and changed files.',
  'Do not call tools. Use only provided context.',
  'Return only JSON, no prose.',
].join('\n')

const buildIntentPrompt = (input: LlmIntentInput): string => {
  const changedFiles = input.changedFiles.slice(0, 250)
  const labels = input.labels.length > 0 ? input.labels : ['(none)']

  return [
    'Classify the primary review intent for this merge request.',
    '',
    'Possible intents:',
    '- style_refactor: visual/layout/design/tailwind/refactor/decomposition work',
    '- feature: new user/system behavior or flow',
    '- bugfix: correcting wrong behavior or regression',
    '- security_sensitive: auth/authz/secrets/injection/security boundary changes',
    '- mixed: truly mixed or unclear cases',
    '',
    'MR Metadata:',
    `- Title: ${input.title}`,
    `- Description: ${input.description || '(none provided)'}`,
    `- Labels: ${labels.join(', ')}`,
    `- Source branch: ${input.sourceBranch}`,
    `- Target branch: ${input.targetBranch}`,
    '',
    'Changed files:',
    ...changedFiles.map((file) => `- ${file}`),
    '',
    'Return JSON with this exact schema:',
    '```json',
    '{',
    '  "intent": "style_refactor" | "feature" | "bugfix" | "security_sensitive" | "mixed",',
    '  "confidence": 0.0,',
    '  "rationale": ["short reason", "short reason"],',
    '  "secondaryIntents": ["feature" | "bugfix" | "style_refactor" | "security_sensitive" | "mixed"]',
    '}',
    '```',
    'Output ONLY JSON.',
  ].join('\n')
}

export const parseLlmIntentOutput = (output: string): LlmIntentResult => {
  const parsed = intentClassifierOutputSchema.parse(extractJson(output))
  const secondaryIntents = Array.from(
    new Set(parsed.secondaryIntents.filter((intent) => intent !== parsed.intent)),
  )
  return {
    intent: parsed.intent,
    confidence: parsed.confidence,
    rationale: parsed.rationale,
    secondaryIntents,
  }
}

export const classifyMrIntentWithLlm = async (
  input: LlmIntentInput,
  config: LlmIntentConfig,
): Promise<LlmIntentResult> => {
  const agentInput = {
    cwd: config.cwd,
    sessionDir: config.sessionDir,
    model: config.model,
    thinkingLevel: config.thinkingLevel,
    instructions: INTENT_CLASSIFIER_INSTRUCTIONS,
    prompt: buildIntentPrompt(input),
    timeoutMs: config.timeoutMs,
    toolMode: 'none' as const,
  }

  const result =
    config.harness === 'codex'
      ? await invokeCodexReview(agentInput)
      : await invokePiReview(agentInput)

  if (!result.success) {
    throw new Error(`LLM intent classification failed: ${result.error}`)
  }

  return parseLlmIntentOutput(result.output)
}
