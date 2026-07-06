import type { ProjectConfig } from '@/config'
import {
  listReviewFindingsForMr,
  updateReviewFindingState,
  type ReviewFindingRecord,
} from '@/db/review-findings'
import { upsertReviewMessage } from '@/db/review-threads'
import { createReviewProvider } from '@/integrations/provider/client'
import type { ProviderThreadMessage } from '@/integrations/provider/types'
import { parseProviderTimestamp } from '@/lib/timestamps'
import type { FixerOutput } from '@/mastra/fix/schema'

export interface ApplyFixerFindingStatesInput {
  project: ProjectConfig
  projectKey: string
  mrIid: number
  fixerOutput: FixerOutput
  dependencies?: Partial<FixerFindingStateDependencies>
}

export interface FixerFindingStateDependencies {
  listFindings(params: { projectKey: string; mrIid: number }): Promise<ReviewFindingRecord[]>
  updateFinding(params: {
    id: string
    state: ReviewFindingRecord['state']
    decisionReason?: string | null
    decidedByExternalId?: string | null
    decidedByName?: string | null
  }): Promise<ReviewFindingRecord | null>
  reply(params: {
    project: ProjectConfig
    mrIid: number
    providerThreadId: string
    body: string
  }): Promise<ProviderThreadMessage>
  storeReply(params: { finding: ReviewFindingRecord; reply: ProviderThreadMessage }): Promise<void>
}

const defaultDependencies: FixerFindingStateDependencies = {
  listFindings: listReviewFindingsForMr,
  updateFinding: updateReviewFindingState,
  reply: async (params) =>
    await createReviewProvider(params.project).replyToThread(
      params.mrIid,
      params.providerThreadId,
      params.body,
    ),
  storeReply: async (params) => {
    await upsertReviewMessage({
      threadId: params.finding.threadId,
      provider: 'gitlab',
      reviewRunId: params.finding.reviewRunId,
      authorType: 'agent',
      authorExternalId: `${params.reply.author.id}`,
      authorName: params.reply.author.username,
      direction: 'outbound',
      body: params.reply.body,
      providerMessageId: params.reply.id,
      providerParentMessageId: null,
      providerUrl: params.reply.url ?? null,
      rawProviderData: params.reply.raw,
      providerCreatedAt: parseProviderTimestamp(params.reply.createdAt),
      providerUpdatedAt: parseProviderTimestamp(params.reply.updatedAt),
    })
  },
}

const mergeDependencies = (
  dependencies: Partial<FixerFindingStateDependencies> | undefined,
): FixerFindingStateDependencies => ({
  ...defaultDependencies,
  ...dependencies,
})

const byId = (findings: ReviewFindingRecord[]): Map<string, ReviewFindingRecord> =>
  new Map(findings.map((finding) => [finding.id, finding]))

const validateFindingIds = (
  knownFindings: Map<string, ReviewFindingRecord>,
  fixedIds: Set<string>,
  notFixedIds: Set<string>,
): void => {
  for (const id of fixedIds) {
    if (notFixedIds.has(id)) {
      throw new Error(`Fixer reported finding ${id} as both fixed and not fixed`)
    }

    if (!knownFindings.has(id)) {
      throw new Error(`Fixer reported unknown fixed finding ${id}`)
    }
  }

  for (const id of notFixedIds) {
    if (!knownFindings.has(id)) {
      throw new Error(`Fixer reported unknown not-fixed finding ${id}`)
    }
  }
}

const notFixedReplyBody = (reason: string): string =>
  `Mend fixer could not fix this finding: ${reason}`

export const applyFixerFindingStates = async (
  input: ApplyFixerFindingStatesInput,
): Promise<void> => {
  const dependencies = mergeDependencies(input.dependencies)
  const findings = byId(
    await dependencies.listFindings({
      projectKey: input.projectKey,
      mrIid: input.mrIid,
    }),
  )
  const fixedIds = new Set(input.fixerOutput.fixedFindings.map((finding) => finding.id))
  const notFixedIds = new Set(input.fixerOutput.notFixedFindings.map((finding) => finding.id))

  validateFindingIds(findings, fixedIds, notFixedIds)

  for (const fixed of input.fixerOutput.fixedFindings) {
    await dependencies.updateFinding({
      id: fixed.id,
      state: 'fixed',
      decisionReason: fixed.summary,
      decidedByExternalId: null,
      decidedByName: 'Mend fixer',
    })
  }

  for (const notFixed of input.fixerOutput.notFixedFindings) {
    const finding = findings.get(notFixed.id)
    if (!finding) {
      throw new Error(`Fixer reported unknown not-fixed finding ${notFixed.id}`)
    }

    await dependencies.updateFinding({
      id: notFixed.id,
      state: 'not_fixed',
      decisionReason: notFixed.reason,
      decidedByExternalId: null,
      decidedByName: 'Mend fixer',
    })

    const reply = await dependencies.reply({
      project: input.project,
      mrIid: input.mrIid,
      providerThreadId: finding.providerThreadId,
      body: notFixedReplyBody(notFixed.reason),
    })

    await dependencies.storeReply({ finding, reply })
  }
}
