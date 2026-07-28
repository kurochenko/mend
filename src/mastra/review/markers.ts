import { hashBody } from '@/lib/hash'
import { buildDraftRunMarker, hasDraftRunMarker } from '@/lib/review-draft-marker'

const SUMMARY_MARKER = '<!-- mend:summary -->'
const INLINE_MARKER_PREFIX = '<!-- mend:inline:'
const SUMMARY_FINDING_MARKER_PREFIX = '<!-- mend:summary-finding '

const DRAFT_RUN_MARKER_RE = /<!-- mend:draft-run:([^\s]+) -->/
const INLINE_MARKER_RE = /<!-- mend:inline:(.+):(\d+):([a-f0-9]{8}) -->/
const SUMMARY_FINDING_MARKER_RE = /<!-- mend:summary-finding (.+?) -->/

export interface SummaryFindingMarker {
  fingerprint: string
  previousFindingId: string
  path?: string
  line?: number
}

const buildInlineMarker = (file: string, line: number, bodyHash: string): string =>
  `${INLINE_MARKER_PREFIX}${file}:${line}:${bodyHash} -->`

const buildSummaryFindingMarker = (marker: SummaryFindingMarker): string =>
  `${SUMMARY_FINDING_MARKER_PREFIX}${JSON.stringify(marker)} -->`

export const isCurrentRunDraft = (body: string, reviewRunId: string): boolean =>
  body.includes(buildDraftRunMarker(reviewRunId))

export const isMendDraft = (body: string): boolean => hasDraftRunMarker(body)

export const appendInlineMarkers = (
  body: string,
  reviewRunId: string,
  file: string,
  line: number,
): string => {
  const bodyHash = hashBody(body)
  return [body, '', buildInlineMarker(file, line, bodyHash), buildDraftRunMarker(reviewRunId)].join(
    '\n',
  )
}

export const appendSummaryMarkers = (body: string, reviewRunId: string): string =>
  [body, '', SUMMARY_MARKER, buildDraftRunMarker(reviewRunId)].join('\n')

export const appendSummaryFindingMarkers = (
  body: string,
  reviewRunId: string,
  marker: SummaryFindingMarker,
): string =>
  [body, '', buildSummaryFindingMarker(marker), buildDraftRunMarker(reviewRunId)].join('\n')

export interface ParsedMendMarkers {
  runId: string | undefined
  inline: { file: string; line: number; bodyHash: string } | undefined
  summaryFinding: SummaryFindingMarker | undefined
  isSummary: boolean
}

const parseSummaryFindingMarker = (value: string | undefined): SummaryFindingMarker | undefined => {
  if (!value) {
    return undefined
  }

  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object') {
      return undefined
    }

    const record = parsed as Record<string, unknown>
    if (typeof record.fingerprint !== 'string' || typeof record.previousFindingId !== 'string') {
      return undefined
    }

    return {
      fingerprint: record.fingerprint,
      previousFindingId: record.previousFindingId,
      path: typeof record.path === 'string' ? record.path : undefined,
      line:
        typeof record.line === 'number' && Number.isInteger(record.line) && record.line > 0
          ? record.line
          : undefined,
    }
  } catch {
    return undefined
  }
}

export const parseMendMarkers = (body: string): ParsedMendMarkers => {
  const runMatch = DRAFT_RUN_MARKER_RE.exec(body)
  const inlineMatch = INLINE_MARKER_RE.exec(body)
  const summaryFindingMatch = SUMMARY_FINDING_MARKER_RE.exec(body)

  return {
    runId: runMatch?.[1],
    inline:
      inlineMatch && inlineMatch[1] && inlineMatch[2] && inlineMatch[3]
        ? { file: inlineMatch[1], line: Number(inlineMatch[2]), bodyHash: inlineMatch[3] }
        : undefined,
    summaryFinding: parseSummaryFindingMarker(summaryFindingMatch?.[1]),
    isSummary: body.includes(SUMMARY_MARKER),
  }
}
