import { hashBody } from '@/lib/hash'

export type ReviewProvider = 'gitlab' | 'github'
export type ReviewThreadKind = 'inline' | 'summary_note' | 'summary_finding' | 'conversation'
export type ReviewSubjectType = 'line' | 'file' | 'general'
export type ReviewThreadStatus = 'open' | 'resolved' | 'archived'
export type ReviewMessageAuthorType = 'agent' | 'human' | 'system'
export type ReviewMessageDirection = 'outbound' | 'inbound'

export const normalizeReviewMessageBody = (body: string): string => body.trim().replace(/\s+/g, ' ')

export const buildInlineThreadFingerprint = (file: string, line: number, body: string): string =>
  `${file}:${line}:${hashBody(body)}`

export const buildInlineThreadFingerprintFromHash = (
  file: string,
  line: number,
  bodyHash: string,
): string => `${file}:${line}:${bodyHash}`

export const buildSummaryFindingThreadFingerprint = (identifier: string): string =>
  `summary_finding:${identifier}`
