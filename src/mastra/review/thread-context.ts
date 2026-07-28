import type { ProviderThread, ProviderThreadMessage } from '@/integrations/provider/types'
import {
  buildInlineThreadFingerprintFromHash,
  type ReviewSubjectType,
  type ReviewThreadKind,
} from '@/lib/review-threads'
import { parseMendMarkers } from '@/mastra/review/markers'

export interface ReviewThreadContext {
  threadKind: ReviewThreadKind
  subjectType: ReviewSubjectType
  path: string | null
  line: number | null
  findingFingerprint: string | null
}

export interface PersistableThread {
  thread: ProviderThread
  firstNote: ProviderThreadMessage
  firstNoteRunId: string | null
  context: ReviewThreadContext
}

export const findLatestHumanReply = (thread: ProviderThread): ProviderThreadMessage | null => {
  const firstNote = thread.messages[0]
  if (!firstNote) {
    return null
  }

  for (let index = thread.messages.length - 1; index > 0; index--) {
    const message = thread.messages[index]
    if (message && message.system !== true && message.author.id !== firstNote.author.id) {
      return message
    }
  }

  return null
}

export const deriveThreadContext = (thread: ProviderThread): ReviewThreadContext => {
  const firstNote = thread.messages[0]
  if (!firstNote) {
    return {
      threadKind: 'conversation',
      subjectType: 'general',
      path: null,
      line: null,
      findingFingerprint: null,
    }
  }

  const markers = parseMendMarkers(firstNote.body)
  if (markers.summaryFinding) {
    return {
      threadKind: 'summary_finding',
      subjectType: markers.summaryFinding.line
        ? 'line'
        : markers.summaryFinding.path
          ? 'file'
          : 'general',
      path: markers.summaryFinding.path ?? null,
      line: markers.summaryFinding.line ?? null,
      findingFingerprint: markers.summaryFinding.fingerprint,
    }
  }

  if (markers.inline) {
    return {
      threadKind: 'inline',
      subjectType: 'line',
      path: markers.inline.file,
      line: markers.inline.line,
      findingFingerprint: buildInlineThreadFingerprintFromHash(
        markers.inline.file,
        markers.inline.line,
        markers.inline.bodyHash,
      ),
    }
  }

  if (markers.isSummary) {
    return {
      threadKind: 'summary_note',
      subjectType: 'general',
      path: null,
      line: null,
      findingFingerprint: `summary:${thread.id}`,
    }
  }

  const path = firstNote.position?.path ?? firstNote.position?.oldPath ?? null
  const line = firstNote.position?.line ?? firstNote.position?.oldLine ?? null
  if (path) {
    return {
      threadKind: 'inline',
      subjectType: line ? 'line' : 'file',
      path,
      line,
      findingFingerprint: null,
    }
  }

  return {
    threadKind: 'conversation',
    subjectType: 'general',
    path: null,
    line: null,
    findingFingerprint: null,
  }
}

export const getThreadStatus = (thread: ProviderThread): 'open' | 'resolved' => {
  const firstNote = thread.messages[0]
  if (!firstNote?.resolvable) {
    return 'open'
  }

  return firstNote.resolved ? 'resolved' : 'open'
}

export const collectPersistableThreads = (
  threads: ProviderThread[],
  reviewRunId?: string,
): PersistableThread[] => {
  const out: PersistableThread[] = []

  for (const thread of threads) {
    const firstNote = thread.messages[0]
    if (!firstNote) {
      continue
    }

    const markers = parseMendMarkers(firstNote.body)
    if (reviewRunId && markers.runId !== reviewRunId) {
      continue
    }

    const context = deriveThreadContext(thread)
    if (
      context.threadKind !== 'inline' &&
      context.threadKind !== 'summary_finding' &&
      context.threadKind !== 'summary_note'
    ) {
      continue
    }

    out.push({
      thread,
      firstNote,
      firstNoteRunId: markers.runId ?? null,
      context,
    })
  }

  return out
}
