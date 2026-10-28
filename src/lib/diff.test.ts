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

  it('treats hunk lines starting with -- or ++ as removed and added content', () => {
    const diff = [
      'diff --git a/db/query.sql b/db/query.sql',
      '--- a/db/query.sql',
      '+++ b/db/query.sql',
      '@@ -1,3 +1,4 @@',
      '--- legacy comment',
      '+++counter',
      '+select 1;',
      ' select 2;',
      ' select 3;',
      'diff --git a/src/next.ts b/src/next.ts',
      '--- a/src/next.ts',
      '+++ b/src/next.ts',
      '@@ -5,2 +5,2 @@',
      ' const keep = 1',
      '-const removed = 2',
      '+const added = 2',
    ].join('\n')

    const map = parseDiff(diff)

    expect(lookupPosition(map, 'db/query.sql', 1)).toEqual({ new_line: 1 })
    expect(lookupPosition(map, 'db/query.sql', 2)).toEqual({ new_line: 2 })
    expect(lookupPosition(map, 'db/query.sql', 3)).toEqual({ old_line: 2, new_line: 3 })
    expect(lookupPosition(map, 'db/query.sql', 4)).toEqual({ old_line: 3, new_line: 4 })
    expect(lookupPosition(map, 'src/next.ts', 5)).toEqual({ old_line: 5, new_line: 5 })
    expect(lookupPosition(map, 'src/next.ts', 6)).toEqual({ new_line: 6 })
  })

  it('ignores no-newline markers inside a hunk', () => {
    const diff = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,2 +1,2 @@',
      ' first',
      '-second',
      '\\ No newline at end of file',
      '+changed',
      '\\ No newline at end of file',
    ].join('\n')

    const map = parseDiff(diff)

    expect(lookupPosition(map, 'a.txt', 1)).toEqual({ old_line: 1, new_line: 1 })
    expect(lookupPosition(map, 'a.txt', 2)).toEqual({ new_line: 2 })
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
