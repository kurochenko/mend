export interface DiffLine {
  old_line?: number
  new_line?: number
}

export type DiffMap = Map<string, Map<number, DiffLine>>

const DIFF_HEADER_RE = /^diff --git a\/(.+) b\/(.+)$/
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

interface HunkState {
  fileMap: Map<number, DiffLine>
  oldLine: number
  newLine: number
  oldRemaining: number
  newRemaining: number
}

const parseHunkCount = (value: string | undefined): number =>
  value === undefined ? 1 : parseInt(value, 10)

const isHunkOpen = (hunk: HunkState | null): hunk is HunkState =>
  hunk !== null && (hunk.oldRemaining > 0 || hunk.newRemaining > 0)

const consumeHunkLine = (hunk: HunkState, line: string): boolean => {
  if (line.startsWith('+')) {
    hunk.fileMap.set(hunk.newLine, { new_line: hunk.newLine })
    hunk.newLine++
    hunk.newRemaining--
    return true
  }

  if (line.startsWith('-')) {
    hunk.oldLine++
    hunk.oldRemaining--
    return true
  }

  if (line.startsWith(' ') || line === '') {
    hunk.fileMap.set(hunk.newLine, { old_line: hunk.oldLine, new_line: hunk.newLine })
    hunk.oldLine++
    hunk.newLine++
    hunk.oldRemaining--
    hunk.newRemaining--
    return true
  }

  return line.startsWith('\\')
}

export const parseDiff = (diffOutput: string): DiffMap => {
  const result: DiffMap = new Map()
  let fileMap: Map<number, DiffLine> | null = null
  let hunk: HunkState | null = null

  for (const line of diffOutput.split('\n')) {
    if (isHunkOpen(hunk) && consumeHunkLine(hunk, line)) {
      continue
    }

    const headerMatch = line.match(DIFF_HEADER_RE)
    if (headerMatch) {
      const file = headerMatch[2]!
      fileMap = result.get(file) ?? new Map<number, DiffLine>()
      result.set(file, fileMap)
      hunk = null
      continue
    }

    const hunkMatch = line.match(HUNK_RE)
    if (hunkMatch && fileMap) {
      hunk = {
        fileMap,
        oldLine: parseInt(hunkMatch[1]!, 10),
        oldRemaining: parseHunkCount(hunkMatch[2]),
        newLine: parseInt(hunkMatch[3]!, 10),
        newRemaining: parseHunkCount(hunkMatch[4]),
      }
    }
  }

  return result
}

export const lookupPosition = (diffMap: DiffMap, file: string, line: number): DiffLine | null => {
  const fileMap = diffMap.get(file)
  if (!fileMap) return null
  return fileMap.get(line) ?? null
}
