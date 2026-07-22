export interface DiffLine {
  old_line?: number
  new_line?: number
}

export type DiffMap = Map<string, Map<number, DiffLine>>

const DIFF_HEADER_RE = /^diff --git a\/(.+) b\/(.+)$/
const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

export const parseDiff = (diffOutput: string): DiffMap => {
  const result: DiffMap = new Map()
  let currentFile: string | null = null
  let oldLine = 0
  let newLine = 0

  for (const line of diffOutput.split('\n')) {
    const headerMatch = line.match(DIFF_HEADER_RE)
    if (headerMatch) {
      currentFile = headerMatch[2]!
      if (!result.has(currentFile)) {
        result.set(currentFile, new Map())
      }
      continue
    }

    const hunkMatch = line.match(HUNK_RE)
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1]!, 10)
      newLine = parseInt(hunkMatch[2]!, 10)
      continue
    }

    if (!currentFile) continue

    const fileMap = result.get(currentFile)!

    if (line.startsWith('+') && !line.startsWith('+++')) {
      fileMap.set(newLine, { new_line: newLine })
      newLine++
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      oldLine++
    } else if (line.startsWith(' ') || line === '') {
      fileMap.set(newLine, {
        old_line: oldLine,
        new_line: newLine,
      })
      oldLine++
      newLine++
    }
  }

  return result
}

export const lookupPosition = (diffMap: DiffMap, file: string, line: number): DiffLine | null => {
  const fileMap = diffMap.get(file)
  if (!fileMap) return null
  return fileMap.get(line) ?? null
}
