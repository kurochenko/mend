import { describe, expect, test } from 'bun:test'
import type { AppConfig } from '@/config'
import type {
  ImprovementProposalRecord,
  OpenClusterSummary,
  UpsertImprovementClusterParams,
  UpsertImprovementClusterResult,
} from '@/db/improvement-proposals'
import type { ReviewAgentResult } from '@/agents/review-harness'
import {
  parseMinerOutput,
  runImprovementDigest,
  type ImprovementMinerDependencies,
  type MinerFinding,
} from '@/mastra/improvements/miner'

const baseConfig: AppConfig = {
  env: {
    PORT: 3147,
    DATABASE_URL: 'postgres://mend:mend@localhost:5434/mend',
    PROJECTS_CONFIG: 'mend.yml',
    RECORD_WEBHOOKS: false,
  },
  projects: new Map(),
  improvements: {
    enabled: true,
    interval_days: 7,
    agent: {
      harness: 'codex',
      model: 'gpt-5.5',
      thinking_level: 'low',
      timeout_ms: 120_000,
    },
  },
}

const okResult = (output: string): ReviewAgentResult => ({
  harness: 'codex',
  model: 'gpt-5.5',
  success: true,
  output,
  durationMs: 1,
})

const makeFinding = (findingId: string, path: string | null): MinerFinding => ({
  findingId,
  path,
  decisionReason: `A real bug at ${path ?? 'project'}. More detail.`,
  category: 'bug',
})

interface FakeStore {
  clusters: Map<string, ImprovementProposalRecord>
  upsertCalls: UpsertImprovementClusterParams[]
}

const makeDeps = (params: {
  findings: MinerFinding[]
  openClusters?: OpenClusterSummary[]
  output: string
  success?: boolean
  store?: FakeStore
}): { deps: Partial<ImprovementMinerDependencies>; store: FakeStore } => {
  const store: FakeStore = params.store ?? { clusters: new Map(), upsertCalls: [] }

  const deps: Partial<ImprovementMinerDependencies> = {
    getLatestDigestAtForProject: async () => null,
    listOpenClustersForProject: async () => params.openClusters ?? [],
    loadFindingsForProject: async () => params.findings,
    invokeCodex: async () =>
      params.success === false
        ? {
            harness: 'codex',
            model: 'gpt-5.5',
            success: false,
            output: '',
            durationMs: 1,
            error: 'boom',
          }
        : okResult(params.output),
    upsertImprovementCluster: async (
      upsert: UpsertImprovementClusterParams,
    ): Promise<UpsertImprovementClusterResult> => {
      store.upsertCalls.push(upsert)
      const key = `${upsert.projectKey}:${upsert.clusterSlug}`
      const existing = store.clusters.get(key)
      const now = new Date()
      if (!existing) {
        const record: ImprovementProposalRecord = {
          id: `id-${store.clusters.size + 1}`,
          projectKey: upsert.projectKey,
          clusterSlug: upsert.clusterSlug,
          title: upsert.title,
          proposalType: upsert.proposalType,
          body: upsert.body,
          evidence: upsert.evidence,
          occurrenceCount: upsert.evidence.length,
          status: 'proposed',
          lastDigestAt: upsert.digestAt,
          createdAt: now,
          updatedAt: now,
        }
        store.clusters.set(key, record)
        return { record, created: true }
      }
      const existingEvidence = Array.isArray(existing.evidence) ? existing.evidence : []
      const seen = new Set(
        existingEvidence.map((entry) => (entry as { findingId: string }).findingId),
      )
      const newEvidence = upsert.evidence.filter((entry) => !seen.has(entry.findingId))
      const updated: ImprovementProposalRecord = {
        ...existing,
        title: upsert.title,
        proposalType: upsert.proposalType,
        body: upsert.body,
        evidence: [...existingEvidence, ...newEvidence],
        occurrenceCount: existing.occurrenceCount + newEvidence.length,
        lastDigestAt: upsert.digestAt,
        updatedAt: now,
      }
      store.clusters.set(key, updated)
      return { record: updated, created: false }
    },
  }

  return { deps, store }
}

const configWithProjects = (keys: string[]): AppConfig => ({
  ...baseConfig,
  projects: new Map(keys.map((key) => [key, {} as never])),
})

describe('parseMinerOutput', () => {
  test('parses a valid clusters payload', () => {
    const clusters = parseMinerOutput(
      JSON.stringify({
        clusters: [
          {
            slug: 'raw-error-surface',
            title: 'Raw provider errors surfaced to UI',
            proposal_type: 'tooling',
            body: 'Add a scripts/review.ts regex',
            matched_finding_ids: ['f1', 'f2'],
          },
        ],
      }),
    )
    expect(clusters).toHaveLength(1)
    expect(clusters[0]?.slug).toBe('raw-error-surface')
    expect(clusters[0]?.proposal_type).toBe('tooling')
  })

  test('rejects non-kebab slug', () => {
    expect(() =>
      parseMinerOutput(
        JSON.stringify({
          clusters: [
            {
              slug: 'Not Kebab',
              title: 't',
              proposal_type: 'tooling',
              body: 'b',
              matched_finding_ids: ['f1'],
            },
          ],
        }),
      ),
    ).toThrow()
  })

  test('rejects invalid proposal type', () => {
    expect(() =>
      parseMinerOutput(
        JSON.stringify({
          clusters: [
            {
              slug: 'ok-slug',
              title: 't',
              proposal_type: 'nonsense',
              body: 'b',
              matched_finding_ids: ['f1'],
            },
          ],
        }),
      ),
    ).toThrow()
  })

  test('throws on non-JSON output', () => {
    expect(() => parseMinerOutput('not json at all')).toThrow()
  })
})

describe('runImprovementDigest', () => {
  test('creates new clusters and reports summary', async () => {
    const findings = [makeFinding('f1', 'src/a.ts'), makeFinding('f2', 'src/b.ts')]
    const output = JSON.stringify({
      clusters: [
        {
          slug: 'raw-error-surface',
          title: 'Raw errors',
          proposal_type: 'tooling',
          body: 'Guard it',
          matched_finding_ids: ['f1', 'f2'],
        },
      ],
    })
    const { deps, store } = makeDeps({ findings, output })

    const summaries = await runImprovementDigest(configWithProjects(['demo']), {
      dependencies: deps,
    })

    expect(summaries).toEqual([
      { projectKey: 'demo', clustersCreated: 1, clustersExtended: 0, findingsExamined: 2 },
    ])
    const stored = store.clusters.get('demo:raw-error-surface')
    expect(stored?.occurrenceCount).toBe(2)
    const evidence = (stored?.evidence ?? []) as Array<{ findingId: string }>
    expect(evidence.map((e) => e.findingId)).toEqual(['f1', 'f2'])
  })

  test('extends an existing cluster and merges only new evidence', async () => {
    const store: FakeStore = { clusters: new Map(), upsertCalls: [] }
    const firstRun = makeDeps({
      findings: [makeFinding('f1', 'src/a.ts')],
      output: JSON.stringify({
        clusters: [
          {
            slug: 'raw-error-surface',
            title: 'Raw errors',
            proposal_type: 'tooling',
            body: 'Guard it',
            matched_finding_ids: ['f1'],
          },
        ],
      }),
      store,
    })
    await runImprovementDigest(configWithProjects(['demo']), { dependencies: firstRun.deps })

    const secondRun = makeDeps({
      findings: [makeFinding('f1', 'src/a.ts'), makeFinding('f2', 'src/b.ts')],
      openClusters: [{ clusterSlug: 'raw-error-surface', title: 'Raw errors', occurrenceCount: 1 }],
      output: JSON.stringify({
        clusters: [
          {
            slug: 'raw-error-surface',
            title: 'Raw errors extended',
            proposal_type: 'tooling',
            body: 'Guard it better',
            matched_finding_ids: ['f1', 'f2'],
          },
        ],
      }),
      store,
    })
    const summaries = await runImprovementDigest(configWithProjects(['demo']), {
      dependencies: secondRun.deps,
    })

    expect(summaries[0]?.clustersExtended).toBe(1)
    expect(summaries[0]?.clustersCreated).toBe(0)
    const stored = store.clusters.get('demo:raw-error-surface')
    expect(stored?.occurrenceCount).toBe(2)
    expect(stored?.title).toBe('Raw errors extended')
  })

  test('skips projects with no findings silently', async () => {
    const { deps, store } = makeDeps({ findings: [], output: '{}' })
    const summaries = await runImprovementDigest(configWithProjects(['demo']), {
      dependencies: deps,
    })
    expect(summaries).toEqual([])
    expect(store.upsertCalls).toHaveLength(0)
  })

  test('aborts the project digest on parse failure without writing', async () => {
    const { deps, store } = makeDeps({
      findings: [makeFinding('f1', 'src/a.ts')],
      output: 'garbage not json',
    })
    const summaries = await runImprovementDigest(configWithProjects(['demo']), {
      dependencies: deps,
    })
    expect(summaries).toEqual([])
    expect(store.upsertCalls).toHaveLength(0)
  })

  test('aborts on harness failure without writing', async () => {
    const { deps, store } = makeDeps({
      findings: [makeFinding('f1', 'src/a.ts')],
      output: '',
      success: false,
    })
    const summaries = await runImprovementDigest(configWithProjects(['demo']), {
      dependencies: deps,
    })
    expect(summaries).toEqual([])
    expect(store.upsertCalls).toHaveLength(0)
  })
})
