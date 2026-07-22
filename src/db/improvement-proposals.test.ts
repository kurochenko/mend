import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { closeDb, getDb, initDb } from '@/db/client'
import {
  findImprovementProposalsByIdPrefix,
  getLatestDigestAt,
  getLatestDigestAtForProject,
  listImprovementProposals,
  listOpenClustersForProject,
  setImprovementProposalStatus,
  upsertImprovementCluster,
  type ImprovementEvidenceEntry,
} from '@/db/improvement-proposals'
import { improvementProposals } from '@/db/schema'

const testDatabaseUrl = process.env.TEST_DATABASE_URL

const projectKey = 'improvement-proposals-test'

const deleteTestRows = async () => {
  const db = getDb()
  await db.delete(improvementProposals).where(eq(improvementProposals.projectKey, projectKey))
}

const evidence = (findingId: string): ImprovementEvidenceEntry => ({
  findingId,
  path: 'src/a.ts',
  excerpt: `reason for ${findingId}`,
})

if (!testDatabaseUrl) {
  describe.skip('improvement proposal persistence', () => {
    test('requires TEST_DATABASE_URL', () => {})
  })
} else {
  describe('improvement proposal persistence', () => {
    beforeAll(async () => {
      await initDb(testDatabaseUrl)
    })

    afterAll(async () => {
      await closeDb()
    })

    beforeEach(async () => {
      await deleteTestRows()
    })

    test('inserts a new cluster with occurrence count from evidence', async () => {
      const digestAt = new Date('2026-07-01T00:00:00Z')
      const { record, created } = await upsertImprovementCluster({
        projectKey,
        clusterSlug: 'raw-error-surface',
        title: 'Raw errors',
        proposalType: 'tooling',
        body: 'Guard it',
        evidence: [evidence('f1'), evidence('f2')],
        digestAt,
      })

      expect(created).toBe(true)
      expect(record.status).toBe('proposed')
      expect(record.occurrenceCount).toBe(2)
      expect(record.lastDigestAt?.getTime()).toBe(digestAt.getTime())
    })

    test('extends an existing cluster, merging only new evidence', async () => {
      await upsertImprovementCluster({
        projectKey,
        clusterSlug: 'raw-error-surface',
        title: 'Raw errors',
        proposalType: 'tooling',
        body: 'Guard it',
        evidence: [evidence('f1')],
        digestAt: new Date('2026-07-01T00:00:00Z'),
      })

      const secondDigest = new Date('2026-07-08T00:00:00Z')
      const { record, created } = await upsertImprovementCluster({
        projectKey,
        clusterSlug: 'raw-error-surface',
        title: 'Raw errors extended',
        proposalType: 'instructions',
        body: 'Document it',
        evidence: [evidence('f1'), evidence('f2')],
        digestAt: secondDigest,
      })

      expect(created).toBe(false)
      expect(record.occurrenceCount).toBe(2)
      expect(record.title).toBe('Raw errors extended')
      expect(record.proposalType).toBe('instructions')
      expect(record.lastDigestAt?.getTime()).toBe(secondDigest.getTime())
      const evidenceIds = (record.evidence as ImprovementEvidenceEntry[]).map((e) => e.findingId)
      expect(evidenceIds).toEqual(['f1', 'f2'])
    })

    test('enforces unique (project, cluster_slug)', async () => {
      const db = getDb()
      await upsertImprovementCluster({
        projectKey,
        clusterSlug: 'dup-slug',
        title: 'A',
        proposalType: 'tooling',
        body: 'b',
        evidence: [evidence('f1')],
        digestAt: new Date(),
      })

      const insertDuplicate = async () => {
        await db.insert(improvementProposals).values({
          id: crypto.randomUUID(),
          projectKey,
          clusterSlug: 'dup-slug',
          title: 'B',
          proposalType: 'process',
          body: 'c',
          evidence: [],
          occurrenceCount: 0,
          status: 'proposed',
          lastDigestAt: null,
        })
      }

      await expect(insertDuplicate()).rejects.toThrow()
    })

    test('lists open clusters and transitions status', async () => {
      const { record } = await upsertImprovementCluster({
        projectKey,
        clusterSlug: 'open-cluster',
        title: 'Open',
        proposalType: 'tooling',
        body: 'b',
        evidence: [evidence('f1')],
        digestAt: new Date(),
      })

      const openBefore = await listOpenClustersForProject(projectKey)
      expect(openBefore.map((c) => c.clusterSlug)).toContain('open-cluster')

      const dismissed = await setImprovementProposalStatus({ id: record.id, status: 'dismissed' })
      expect(dismissed?.status).toBe('dismissed')

      const openAfter = await listOpenClustersForProject(projectKey)
      expect(openAfter.map((c) => c.clusterSlug)).not.toContain('open-cluster')
    })

    test('reports latest digest timestamps', async () => {
      const older = new Date('2026-07-01T00:00:00Z')
      const newer = new Date('2026-07-05T00:00:00Z')
      await upsertImprovementCluster({
        projectKey,
        clusterSlug: 'a',
        title: 'A',
        proposalType: 'tooling',
        body: 'b',
        evidence: [evidence('f1')],
        digestAt: older,
      })
      await upsertImprovementCluster({
        projectKey,
        clusterSlug: 'b',
        title: 'B',
        proposalType: 'tooling',
        body: 'b',
        evidence: [evidence('f2')],
        digestAt: newer,
      })

      const perProject = await getLatestDigestAtForProject(projectKey)
      expect(perProject?.getTime()).toBe(newer.getTime())

      const global = await getLatestDigestAt()
      expect(global).not.toBeNull()
      expect((global as Date).getTime()).toBeGreaterThanOrEqual(newer.getTime())
    })

    test('filters by status and resolves by id prefix', async () => {
      const { record } = await upsertImprovementCluster({
        projectKey,
        clusterSlug: 'prefix-cluster',
        title: 'Prefix',
        proposalType: 'tooling',
        body: 'b',
        evidence: [evidence('f1')],
        digestAt: new Date(),
      })

      const proposed = await listImprovementProposals({ status: 'proposed' })
      expect(proposed.some((row) => row.id === record.id)).toBe(true)

      const dismissedList = await listImprovementProposals({ status: 'dismissed' })
      expect(dismissedList.some((row) => row.id === record.id)).toBe(false)

      const byPrefix = await findImprovementProposalsByIdPrefix(record.id.slice(0, 8))
      expect(byPrefix.some((row) => row.id === record.id)).toBe(true)
    })
  })
}
