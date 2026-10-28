const AUTH_FAILURE_PATTERNS = [
  /\b401 Unauthorized\b/,
  /"status(?:Code)?":\s*401\b/,
  /^401 \{.*"authentication_error"/m,
  /\bAPI error \(401\)/,
  /\bNo API key found for\b/,
]

export const isAuthFailure = (output: string): boolean =>
  AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(output))

const errorEventText = (event: unknown): string | null => {
  if (!event || typeof event !== 'object') {
    return null
  }

  const { type, error, message } = event as { type?: unknown; error?: unknown; message?: unknown }
  if (type !== 'error' && type !== 'turn.failed') {
    return null
  }

  const detail = error ?? message
  if (typeof detail === 'string') {
    return detail
  }
  if (!detail || typeof detail !== 'object') {
    return null
  }

  const detailMessage = (detail as { message?: unknown }).message
  return typeof detailMessage === 'string' ? detailMessage : JSON.stringify(detail)
}

export const extractErrorEventText = (jsonl: string): string =>
  jsonl
    .split('\n')
    .flatMap((line) => {
      try {
        const text = errorEventText(JSON.parse(line))
        return text === null ? [] : [text]
      } catch {
        return []
      }
    })
    .join('\n')

export const authFailureMessage = (harnessName: string, model: string, loginHint: string): string =>
  `${harnessName} is not authenticated for model ${model}; ${loginHint} as the user running Mend`
