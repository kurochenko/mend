import type { Discussion, DiscussionNote } from '@/integrations/gitlab/discussions'
import {
  buildInlineThreadFingerprintFromHash,
  type ReviewSubjectType,
  type ReviewThreadKind,
} from '@/lib/review-threads'
import { parseMendMarkers } from '@/mastra/review/markers'

const readPositionString = (position: unknown, key: 'new_path' | 'old_path'): string | null => {
  if (!position || typeof position !== 'object') {
    return null
  }

  const value = (position as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

const readPositionLine = (position: unknown): number | null => {
  if (!position || typeof position !== 'object') {
    return null
  }

  const record = position as Record<string, unknown>
  for (const key of ['new_line', 'old_line']) {
    const value = record[key]
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
      return value
    }
  }

  return null
}

export interface ReviewThreadContext {
  threadKind: ReviewThreadKind
  subjectType: ReviewSubjectType
  path: string | null
  line: number | null
  findingFingerprint: string | null
}

export interface PersistableGitLabDiscussion {
  discussion: Discussion
  firstNote: DiscussionNote
  firstNoteRunId: string | null
  context: ReviewThreadContext
}

export const findLatestHumanReply = (discussion: Discussion): DiscussionNote | null => {
  const firstNote = discussion.notes[0]
  if (!firstNote) {
    return null
  }

  for (let index = discussion.notes.length - 1; index > 0; index--) {
    const note = discussion.notes[index]
    if (note && note.system !== true && note.author.id !== firstNote.author.id) {
      return note
    }
  }

  return null
}

export const deriveThreadContext = (discussion: Discussion): ReviewThreadContext => {
  const firstNote = discussion.notes[0]
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
      findingFingerprint: `summary:${discussion.id}`,
    }
  }

  const path =
    readPositionString(firstNote.position, 'new_path') ??
    readPositionString(firstNote.position, 'old_path')
  const line = readPositionLine(firstNote.position)
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

export const getDiscussionStatus = (discussion: Discussion): 'open' | 'resolved' => {
  const firstNote = discussion.notes[0]
  if (!firstNote?.resolvable) {
    return 'open'
  }

  return firstNote.resolved ? 'resolved' : 'open'
}

export const collectPersistableGitLabDiscussions = (
  discussions: Discussion[],
  reviewRunId?: string,
): PersistableGitLabDiscussion[] => {
  const out: PersistableGitLabDiscussion[] = []

  for (const discussion of discussions) {
    const firstNote = discussion.notes[0]
    if (!firstNote) {
      continue
    }

    const markers = parseMendMarkers(firstNote.body)
    if (reviewRunId && markers.runId !== reviewRunId) {
      continue
    }

    const context = deriveThreadContext(discussion)
    if (
      context.threadKind !== 'inline' &&
      context.threadKind !== 'summary_finding' &&
      context.threadKind !== 'summary_note'
    ) {
      continue
    }

    out.push({
      discussion,
      firstNote,
      firstNoteRunId: markers.runId ?? null,
      context,
    })
  }

  return out
}
