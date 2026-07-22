import { and, desc, eq, isNotNull, ne } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { reviewFindings, reviewThreads } from '@/db/schema'
import { toErrorMessage } from '@/lib/errors'

export interface BugHistoryFinding {
  path: string | null
  decisionReason: string
}

export interface BugHistoryStore {
  listResolvedProjectFindings(params: {
    projectKey: string
    excludeMrIid: number
    limit: number
  }): Promise<BugHistoryFinding[]>
}

const DEFAULT_LIMIT = 15
const MAX_REASON_CHARS = 140

const defaultBugHistoryStore: BugHistoryStore = {
  listResolvedProjectFindings: async (params) => {
    const db = getDb()
    const rows = await db
      .select({
        path: reviewThreads.path,
        decisionReason: reviewFindings.decisionReason,
      })
      .from(reviewFindings)
      .innerJoin(reviewThreads, eq(reviewFindings.threadId, reviewThreads.id))
      .where(
        and(
          eq(reviewFindings.projectKey, params.projectKey),
          eq(reviewFindings.state, 'resolved'),
          isNotNull(reviewFindings.decisionReason),
          ne(reviewFindings.mrIid, params.excludeMrIid),
        ),
      )
      .orderBy(desc(reviewFindings.decidedAt), desc(reviewFindings.updatedAt))
      .limit(params.limit)

    return rows
      .filter((row): row is BugHistoryFinding => Boolean(row.decisionReason?.trim()))
      .map((row) => ({
        path: row.path,
        decisionReason: row.decisionReason,
      }))
  },
}

const firstSentence = (value: string): string => {
  const normalized = value.trim().replace(/\s+/g, ' ')
  const sentenceEnd = normalized.search(/[.!?](?:\s|$)/)
  const sentence = sentenceEnd >= 0 ? normalized.slice(0, sentenceEnd + 1) : normalized
  if (sentence.length <= MAX_REASON_CHARS) {
    return sentence
  }
  return `${sentence.slice(0, MAX_REASON_CHARS - 3)}...`
}

export const buildBugHistoryPromptSection = async (
  params: {
    projectKey: string
    mrIid: number
    limit?: number
  },
  deps: { store?: BugHistoryStore } = {},
): Promise<string | null> => {
  const store = deps.store ?? defaultBugHistoryStore
  try {
    const findings = await store.listResolvedProjectFindings({
      projectKey: params.projectKey,
      excludeMrIid: params.mrIid,
      limit: params.limit ?? DEFAULT_LIMIT,
    })
    const lines = findings
      .filter((finding) => finding.decisionReason.trim().length > 0)
      .map((finding) => `- [${finding.path ?? 'project'}] ${firstSentence(finding.decisionReason)}`)

    if (lines.length === 0) {
      return null
    }

    return ['## Bugs previously shipped in this project', '', ...lines].join('\n')
  } catch (error) {
    console.warn(`[review] bug history unavailable: ${toErrorMessage(error)}`)
    return null
  }
}
