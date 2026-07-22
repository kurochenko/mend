const CONVERSATION_MARKER_PREFIX = '<!-- mend:conversation '
const MARKER_MAX_AGE_MS = 24 * 60 * 60 * 1000

export interface ScopeClarificationMarker {
  type: 'scope_clarification'
  intent: 'dismissal'
  createdAt: string
}

export type ReviewConversationMarker = ScopeClarificationMarker

export const appendReviewConversationMarker = (
  body: string,
  marker: Omit<ReviewConversationMarker, 'createdAt'>,
): string => {
  const stamped = { ...marker, createdAt: new Date().toISOString() }
  return `${CONVERSATION_MARKER_PREFIX}${JSON.stringify(stamped)} -->\n${body}`
}

export const parseReviewConversationMarker = (body: string): ReviewConversationMarker | null => {
  const match = body.match(/<!-- mend:conversation (.+?) -->/)
  const rawMarker = match?.[1]
  if (!rawMarker) {
    return null
  }

  try {
    const parsed = JSON.parse(rawMarker)
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.type === 'scope_clarification' &&
      parsed.intent === 'dismissal'
    ) {
      if (typeof parsed.createdAt !== 'string') {
        return null
      }

      const age = Date.now() - new Date(parsed.createdAt).getTime()
      if (age > MARKER_MAX_AGE_MS) {
        return null
      }

      return parsed as ScopeClarificationMarker
    }
  } catch (error) {
    console.warn(`[markers] failed to parse conversation marker: ${error}`)
    return null
  }

  return null
}

export const stripAllMendMarkers = (body: string): string =>
  body.replace(/<!-- mend:[\s\S]*?-->/g, '').trim()

export const stripReviewConversationMarker = (body: string): string =>
  body.replace(/<!-- mend:conversation .+? -->\s*/s, '').trim()
