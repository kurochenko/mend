import { and, desc, eq, gt, isNotNull } from 'drizzle-orm'
import { z } from 'zod'
import { invokeCodexReview } from '@/agents/codex-harness'
import { invokePiReview } from '@/agents/pi-harness'
import type { ReviewAgentRunConfig } from '@/agents/review-harness'
import type { AppConfig, ImprovementsConfig } from '@/config'
import { getDb } from '@/db/client'
import {
  getLatestDigestAtForProject,
  listOpenClustersForProject,
  upsertImprovementCluster,
  type ImprovementEvidenceEntry,
  type OpenClusterSummary,
} from '@/db/improvement-proposals'
import { improvementProposalTypeValues, reviewFindings, reviewThreads } from '@/db/schema'
import { asRecord, extractJson } from '@/lib/json'
import { toErrorMessage } from '@/lib/errors'

const MAX_FINDINGS = 60
const EXCERPT_MAX_CHARS = 200

export interface MinerFinding {
  findingId: string
  path: string | null
  decisionReason: string
  category: string
}

const clusterSchema = z.object({
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be kebab-case'),
  title: z.string().min(1),
  proposal_type: z.enum(improvementProposalTypeValues),
  body: z.string().min(1),
  matched_finding_ids: z.array(z.string().min(1)).min(1),
})

const minerOutputSchema = z.object({
  clusters: z.array(clusterSchema),
})

export type MinerCluster = z.infer<typeof clusterSchema>

export const parseMinerOutput = (output: string): MinerCluster[] =>
  minerOutputSchema.parse(extractJson(output)).clusters

const firstSentence = (value: string): string => {
  const normalized = value.trim().replace(/\s+/g, ' ')
  const sentenceEnd = normalized.search(/[.!?](?:\s|$)/)
  const sentence = sentenceEnd >= 0 ? normalized.slice(0, sentenceEnd + 1) : normalized
  if (sentence.length <= EXCERPT_MAX_CHARS) {
    return sentence
  }
  return `${sentence.slice(0, EXCERPT_MAX_CHARS - 3)}...`
}

const findingCategory = (metadata: unknown): string => {
  const record = asRecord(metadata)
  if (record.kind === 'finding') {
    return typeof asRecord(record.finding).category === 'string'
      ? (asRecord(record.finding).category as string)
      : 'uncategorized'
  }
  if (record.kind === 'inline_comment') {
    return 'inline_comment'
  }
  return 'uncategorized'
}

const loadFindingsForProject = async (
  projectKey: string,
  since: Date | null,
): Promise<MinerFinding[]> => {
  const db = getDb()
  const conditions = [
    eq(reviewFindings.projectKey, projectKey),
    eq(reviewFindings.state, 'resolved'),
    isNotNull(reviewFindings.decisionReason),
  ]
  if (since) {
    conditions.push(gt(reviewFindings.decidedAt, since))
  }

  const rows = await db
    .select({
      findingId: reviewFindings.id,
      path: reviewThreads.path,
      decisionReason: reviewFindings.decisionReason,
      metadata: reviewFindings.metadata,
    })
    .from(reviewFindings)
    .innerJoin(reviewThreads, eq(reviewFindings.threadId, reviewThreads.id))
    .where(and(...conditions))
    .orderBy(desc(reviewFindings.decidedAt), desc(reviewFindings.updatedAt))
    .limit(MAX_FINDINGS)

  return rows
    .filter((row): row is typeof row & { decisionReason: string } =>
      Boolean(row.decisionReason?.trim()),
    )
    .map((row) => ({
      findingId: row.findingId,
      path: row.path,
      decisionReason: row.decisionReason,
      category: findingCategory(row.metadata),
    }))
}

const MINER_INSTRUCTIONS = [
  'You are a code-review improvement miner.',
  'Your job is to cluster recurring implementer mistakes from confirmed review findings into improvement proposals for the implementer side.',
  'Prefer tooling proposals expressible as deterministic guards: a scripts/review.ts regex diff-police rule, an eslint/biome rule, or a dependency-cruiser rule. Tooling kills a class permanently at zero prompt cost.',
  'Otherwise prefer instructions: concrete AGENTS.md or skill-file wording changes.',
  'Otherwise use process: workflow changes such as pre-push self-review or test scaffolds.',
  'Extend existing open clusters by returning their exact slug rather than inventing near-duplicates.',
  'Do not call tools. Use only provided context.',
  'Return only JSON, no prose.',
].join('\n')

const buildMinerPrompt = (params: {
  openClusters: OpenClusterSummary[]
  findings: MinerFinding[]
}): string => {
  const openClusterLines =
    params.openClusters.length > 0
      ? params.openClusters.map(
          (cluster) =>
            `- slug=${cluster.clusterSlug} occurrences=${cluster.occurrenceCount} title="${cluster.title}"`,
        )
      : ['(none)']

  const findingLines = params.findings.map(
    (finding) =>
      `- id=${finding.findingId} category=${finding.category} path=${finding.path ?? '(project)'} reason="${firstSentence(finding.decisionReason)}"`,
  )

  return [
    'Cluster the following confirmed review findings into recurring mistake classes and propose one remediation per cluster.',
    '',
    'Existing open clusters (extend these by reusing their exact slug when a finding matches):',
    ...openClusterLines,
    '',
    'Confirmed findings:',
    ...findingLines,
    '',
    'Return JSON with this exact schema:',
    '```json',
    '{',
    '  "clusters": [',
    '    {',
    '      "slug": "kebab-case-stable",',
    '      "title": "short title",',
    '      "proposal_type": "tooling" | "instructions" | "process",',
    '      "body": "proposed rule or wording text",',
    '      "matched_finding_ids": ["finding-id"]',
    '    }',
    '  ]',
    '}',
    '```',
    'Output ONLY JSON.',
  ].join('\n')
}

export interface HarnessInvokeResult {
  success: boolean
  output: string
  error?: string
}

type HarnessInvoker = (config: ReviewAgentRunConfig) => Promise<HarnessInvokeResult>

export interface ImprovementMinerDependencies {
  listProjectKeys: (config: AppConfig) => string[]
  getLatestDigestAtForProject: typeof getLatestDigestAtForProject
  listOpenClustersForProject: typeof listOpenClustersForProject
  loadFindingsForProject: typeof loadFindingsForProject
  upsertImprovementCluster: typeof upsertImprovementCluster
  invokeCodex: HarnessInvoker
  invokePi: HarnessInvoker
}

const defaultDependencies: ImprovementMinerDependencies = {
  listProjectKeys: (config) => [...config.projects.keys()],
  getLatestDigestAtForProject,
  listOpenClustersForProject,
  loadFindingsForProject,
  upsertImprovementCluster,
  invokeCodex: invokeCodexReview,
  invokePi: invokePiReview,
}

export interface ImprovementDigestProjectSummary {
  projectKey: string
  clustersCreated: number
  clustersExtended: number
  findingsExamined: number
}

export interface RunImprovementDigestOptions {
  projectKeys?: string[]
  sessionDir?: string
  dependencies?: Partial<ImprovementMinerDependencies>
}

const buildEvidence = (
  cluster: MinerCluster,
  findingsById: Map<string, MinerFinding>,
): ImprovementEvidenceEntry[] =>
  cluster.matched_finding_ids
    .map((findingId) => findingsById.get(findingId))
    .filter((finding): finding is MinerFinding => finding !== undefined)
    .map((finding) => ({
      findingId: finding.findingId,
      path: finding.path,
      excerpt: firstSentence(finding.decisionReason),
    }))

const digestProject = async (params: {
  config: ImprovementsConfig
  projectKey: string
  sessionDir: string
  deps: ImprovementMinerDependencies
}): Promise<ImprovementDigestProjectSummary | null> => {
  const { config, projectKey, sessionDir, deps } = params
  const since = await deps.getLatestDigestAtForProject(projectKey)
  const findings = await deps.loadFindingsForProject(projectKey, since)
  if (findings.length === 0) {
    return null
  }

  const openClusters = await deps.listOpenClustersForProject(projectKey)
  const agentInput: ReviewAgentRunConfig = {
    cwd: process.cwd(),
    sessionDir,
    model: config.agent.model,
    thinkingLevel: config.agent.thinking_level,
    instructions: MINER_INSTRUCTIONS,
    prompt: buildMinerPrompt({ openClusters, findings }),
    timeoutMs: config.agent.timeout_ms,
    toolMode: 'none',
  }

  const result =
    config.agent.harness === 'codex'
      ? await deps.invokeCodex(agentInput)
      : await deps.invokePi(agentInput)

  if (!result.success) {
    console.error(`[improvements] harness failed for ${projectKey}: ${result.error ?? 'unknown'}`)
    return null
  }

  let clusters: MinerCluster[]
  try {
    clusters = parseMinerOutput(result.output)
  } catch (error) {
    console.error(
      `[improvements] failed to parse miner output for ${projectKey}: ${toErrorMessage(error)}`,
    )
    return null
  }

  const findingsById = new Map(findings.map((finding) => [finding.findingId, finding]))
  const digestAt = new Date()
  let clustersCreated = 0
  let clustersExtended = 0

  for (const cluster of clusters) {
    const evidence = buildEvidence(cluster, findingsById)
    if (evidence.length === 0) {
      continue
    }
    const { created } = await deps.upsertImprovementCluster({
      projectKey,
      clusterSlug: cluster.slug,
      title: cluster.title,
      proposalType: cluster.proposal_type,
      body: cluster.body,
      evidence,
      digestAt,
    })
    if (created) {
      clustersCreated += 1
    } else {
      clustersExtended += 1
    }
  }

  return {
    projectKey,
    clustersCreated,
    clustersExtended,
    findingsExamined: findings.length,
  }
}

export const runImprovementDigest = async (
  config: AppConfig,
  options: RunImprovementDigestOptions = {},
): Promise<ImprovementDigestProjectSummary[]> => {
  const deps = { ...defaultDependencies, ...options.dependencies }
  const sessionDir = options.sessionDir ?? 'sessions'
  const projectKeys = options.projectKeys ?? deps.listProjectKeys(config)
  const summaries: ImprovementDigestProjectSummary[] = []

  for (const projectKey of projectKeys) {
    const summary = await digestProject({
      config: config.improvements,
      projectKey,
      sessionDir,
      deps,
    })
    if (summary) {
      summaries.push(summary)
    }
  }

  return summaries
}
