import { and, desc, eq, inArray } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  improvementProposals,
  type ImprovementProposalStatus,
  type ImprovementProposalType,
} from '@/db/schema'

export type ImprovementProposalRecord = InferSelectModel<typeof improvementProposals>

export interface ImprovementEvidenceEntry {
  findingId: string
  path: string | null
  excerpt: string
}

const openStatuses: ImprovementProposalStatus[] = ['proposed', 'accepted']

export interface OpenClusterSummary {
  clusterSlug: string
  title: string
  occurrenceCount: number
}

export const listOpenClustersForProject = async (
  projectKey: string,
): Promise<OpenClusterSummary[]> => {
  const db = getDb()
  const rows = await db
    .select({
      clusterSlug: improvementProposals.clusterSlug,
      title: improvementProposals.title,
      occurrenceCount: improvementProposals.occurrenceCount,
    })
    .from(improvementProposals)
    .where(
      and(
        eq(improvementProposals.projectKey, projectKey),
        inArray(improvementProposals.status, openStatuses),
      ),
    )
    .orderBy(desc(improvementProposals.occurrenceCount))

  return rows
}

export const getLatestDigestAt = async (): Promise<Date | null> => {
  const db = getDb()
  const [row] = await db
    .select({ lastDigestAt: improvementProposals.lastDigestAt })
    .from(improvementProposals)
    .orderBy(desc(improvementProposals.lastDigestAt))
    .limit(1)

  return row?.lastDigestAt ?? null
}

export const getLatestDigestAtForProject = async (projectKey: string): Promise<Date | null> => {
  const db = getDb()
  const [row] = await db
    .select({ lastDigestAt: improvementProposals.lastDigestAt })
    .from(improvementProposals)
    .where(eq(improvementProposals.projectKey, projectKey))
    .orderBy(desc(improvementProposals.lastDigestAt))
    .limit(1)

  return row?.lastDigestAt ?? null
}

export interface UpsertImprovementClusterParams {
  projectKey: string
  clusterSlug: string
  title: string
  proposalType: ImprovementProposalType
  body: string
  evidence: ImprovementEvidenceEntry[]
  digestAt: Date
}

export interface UpsertImprovementClusterResult {
  record: ImprovementProposalRecord
  created: boolean
}

export const upsertImprovementCluster = async (
  params: UpsertImprovementClusterParams,
): Promise<UpsertImprovementClusterResult> => {
  const db = getDb()
  const now = new Date()

  const [existing] = await db
    .select()
    .from(improvementProposals)
    .where(
      and(
        eq(improvementProposals.projectKey, params.projectKey),
        eq(improvementProposals.clusterSlug, params.clusterSlug),
      ),
    )
    .limit(1)

  if (!existing) {
    const [inserted] = await db
      .insert(improvementProposals)
      .values({
        id: crypto.randomUUID(),
        projectKey: params.projectKey,
        clusterSlug: params.clusterSlug,
        title: params.title,
        proposalType: params.proposalType,
        body: params.body,
        evidence: params.evidence,
        occurrenceCount: params.evidence.length,
        status: 'proposed',
        lastDigestAt: params.digestAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning()

    if (!inserted) {
      throw new Error(
        `Failed to insert improvement cluster ${params.projectKey}:${params.clusterSlug}`,
      )
    }

    return { record: inserted, created: true }
  }

  const existingEvidence = Array.isArray(existing.evidence)
    ? (existing.evidence as ImprovementEvidenceEntry[])
    : []
  const seen = new Set(existingEvidence.map((entry) => entry.findingId))
  const newEvidence = params.evidence.filter((entry) => !seen.has(entry.findingId))
  const mergedEvidence = [...existingEvidence, ...newEvidence]

  const [updated] = await db
    .update(improvementProposals)
    .set({
      title: params.title,
      proposalType: params.proposalType,
      body: params.body,
      evidence: mergedEvidence,
      occurrenceCount: existing.occurrenceCount + newEvidence.length,
      lastDigestAt: params.digestAt,
      updatedAt: now,
    })
    .where(eq(improvementProposals.id, existing.id))
    .returning()

  if (!updated) {
    throw new Error(
      `Failed to update improvement cluster ${params.projectKey}:${params.clusterSlug}`,
    )
  }

  return { record: updated, created: false }
}

export const listImprovementProposals = async (params: {
  status?: ImprovementProposalStatus
}): Promise<ImprovementProposalRecord[]> => {
  const db = getDb()
  const query = db.select().from(improvementProposals)
  const rows = params.status
    ? await query
        .where(eq(improvementProposals.status, params.status))
        .orderBy(desc(improvementProposals.occurrenceCount))
    : await query.orderBy(desc(improvementProposals.occurrenceCount))

  return rows
}

export const findImprovementProposalsByIdPrefix = async (
  prefix: string,
): Promise<ImprovementProposalRecord[]> => {
  const db = getDb()
  const rows = await db.select().from(improvementProposals)
  return rows.filter((row) => row.id.startsWith(prefix))
}

export const setImprovementProposalStatus = async (params: {
  id: string
  status: ImprovementProposalStatus
}): Promise<ImprovementProposalRecord | null> => {
  const db = getDb()
  const [row] = await db
    .update(improvementProposals)
    .set({ status: params.status, updatedAt: new Date() })
    .where(eq(improvementProposals.id, params.id))
    .returning()

  return row ?? null
}
