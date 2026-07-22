import { stripAllMendMarkers } from '@/server/review-conversation-markers'

export const DEFAULT_REJECT_REASON = 'Rejected by human triage.'

export type ReviewTriageCommand =
  | { kind: 'accept' }
  | { kind: 'reject'; reason: string }
  | { kind: 'defer'; reason: string }
  | { kind: 'invalid_defer' }
  | { kind: 'fix_accepted'; force: boolean }

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const uniqueAliases = (botUsername: string): string[] => [
  ...new Set(['mend', botUsername.toLowerCase()].filter((value) => value.length > 0)),
]

export const parseReviewTriageCommand = (
  body: string,
  botUsername: string,
): ReviewTriageCommand | null => {
  const aliases = uniqueAliases(botUsername).map(escapeRegExp).join('|')
  const pattern = new RegExp(
    `(^|[^a-z0-9_.-])@(?:${aliases})\\s+(accept|reject|defer|fix\\s+accepted(?:\\s+anyway)?)(?=\\s|$)([^\\n\\r]*)`,
    'i',
  )
  const match = stripAllMendMarkers(body).match(pattern)
  if (!match) {
    return null
  }

  const rawCommand = match[2]
  if (!rawCommand) {
    return null
  }

  const command = rawCommand.toLowerCase().replace(/\s+/g, ' ').trim()
  const detail = match[3]?.trim() ?? ''

  switch (command) {
    case 'accept':
      return { kind: 'accept' }
    case 'reject':
      return { kind: 'reject', reason: detail || DEFAULT_REJECT_REASON }
    case 'defer':
      return detail ? { kind: 'defer', reason: detail } : { kind: 'invalid_defer' }
    case 'fix accepted':
      return { kind: 'fix_accepted', force: false }
    case 'fix accepted anyway':
      return { kind: 'fix_accepted', force: true }
    default:
      return null
  }
}
