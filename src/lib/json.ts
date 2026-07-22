export const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

const parseIfJson = (candidate: string): unknown | null => {
  try {
    return JSON.parse(candidate)
  } catch {
    return null
  }
}

const extractFromFences = (output: string): unknown | null => {
  const fenceRegex = /```([^\n`]*)\n?([\s\S]*?)```/g
  const candidates: Array<{ lang: string; body: string }> = []

  for (const match of output.matchAll(fenceRegex)) {
    const lang = (match[1] ?? '').trim().toLowerCase()
    const body = (match[2] ?? '').trim()
    if (body.length === 0) {
      continue
    }
    candidates.push({ lang, body })
  }

  const ordered = [
    ...candidates.filter((candidate) => candidate.lang === 'json' || candidate.lang === 'jsonc'),
    ...candidates.filter((candidate) => candidate.lang !== 'json' && candidate.lang !== 'jsonc'),
  ]

  for (const candidate of ordered) {
    const parsed = parseIfJson(candidate.body)
    if (parsed !== null) {
      return parsed
    }
  }

  return null
}

const findBalancedObjectRanges = (output: string): Array<{ start: number; end: number }> => {
  const ranges: Array<{ start: number; end: number }> = []

  for (let start = output.indexOf('{'); start !== -1; start = output.indexOf('{', start + 1)) {
    let depth = 0
    let inString = false
    let escape = false

    for (let index = start; index < output.length; index += 1) {
      const char = output[index]

      if (escape) {
        escape = false
        continue
      }

      if (char === '\\') {
        escape = true
        continue
      }

      if (char === '"') {
        inString = !inString
        continue
      }

      if (inString) {
        continue
      }

      if (char === '{') {
        depth += 1
        continue
      }

      if (char === '}') {
        depth -= 1
        if (depth === 0) {
          ranges.push({ start, end: index })
          break
        }
      }
    }
  }

  return ranges
}

export const extractJson = (output: string): unknown => {
  const direct = parseIfJson(output.trim())
  if (direct !== null) {
    return direct
  }

  const ranges = findBalancedObjectRanges(output).sort((left, right) => {
    const leftSize = left.end - left.start
    const rightSize = right.end - right.start
    if (leftSize !== rightSize) {
      return rightSize - leftSize
    }

    return right.start - left.start
  })

  for (const range of ranges) {
    const parsed = parseIfJson(output.slice(range.start, range.end + 1))
    if (parsed !== null) {
      return parsed
    }
  }

  const fenced = extractFromFences(output)
  if (fenced !== null) {
    return fenced
  }

  throw new Error('No JSON object found in output')
}
