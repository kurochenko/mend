import { describe, expect, it } from 'bun:test'
import { lookupPosition, parseDiff } from '@/lib/diff'

describe('parseDiff and lookupPosition', () => {
  it('maps added and context lines for inline positioning', () => {
    const diff = [
      'diff --git a/src/example.ts b/src/example.ts',
      '--- a/src/example.ts',
      '+++ b/src/example.ts',
      '@@ -1,3 +1,4 @@',
      ' const a = 1',
      '+const b = 2',
      ' const c = 3',
    ].join('\n')

    const map = parseDiff(diff)

    expect(lookupPosition(map, 'src/example.ts', 1)).toEqual({ old_line: 1, new_line: 1 })
    expect(lookupPosition(map, 'src/example.ts', 2)).toEqual({ new_line: 2 })
    expect(lookupPosition(map, 'src/example.ts', 3)).toEqual({ old_line: 2, new_line: 3 })
  })

  it('does not map removed lines or lines outside the diff hunk', () => {
    const diff = [
      'diff --git a/src/example.ts b/src/example.ts',
      '--- a/src/example.ts',
      '+++ b/src/example.ts',
      '@@ -10,3 +10,3 @@',
      ' const keep = 1',
      '-const removed = 2',
      '+const added = 2',
    ].join('\n')

    const map = parseDiff(diff)

    expect(lookupPosition(map, 'src/example.ts', 9)).toBeNull()
    expect(lookupPosition(map, 'src/example.ts', 10)).toEqual({ old_line: 10, new_line: 10 })
    expect(lookupPosition(map, 'src/example.ts', 11)).toEqual({ new_line: 11 })
    expect(lookupPosition(map, 'src/example.ts', 12)).toBeNull()
  })

  it('returns null for files not present in diff', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1,2 @@',
      '+const a = 1',
    ].join('\n')

    const map = parseDiff(diff)
    expect(lookupPosition(map, 'src/missing.ts', 1)).toBeNull()
  })
})
