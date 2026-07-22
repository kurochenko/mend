import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { ReviewAgentResult } from '@/agents/review-harness'
import { enforceFileInspection } from '@/mastra/review/inspection'

const createSessionFile = (cwd: string, name: string, readPaths: string[]): string => {
  const filePath = join(cwd, `${name}.jsonl`)
  const lines = readPaths.map((path) =>
    JSON.stringify({
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            name: 'read',
            arguments: { path },
          },
        ],
      },
    }),
  )
  writeFileSync(filePath, lines.join('\n'))
  return filePath
}

const createReviewResult = (sessionFile: string): ReviewAgentResult => ({
  harness: 'pi',
  model: 'test-model',
  success: true,
  output: '{}',
  durationMs: 1,
  sessionFile,
})

describe('enforceFileInspection', () => {
  it('ignores generated, snapshot, and lock files in inspection requirements', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mend-inspection-'))

    try {
      const initialSession = createSessionFile(cwd, 'initial', ['src/feature/handler.ts'])
      let retryCalled = false

      const result = await enforceFileInspection({
        reviewResult: createReviewResult(initialSession),
        worktreePath: cwd,
        changedFiles: [
          'src/feature/handler.ts',
          'bun.lock',
          'src/http/__snapshots__/index.test.ts.snap',
          'src/http/generated/v3/core/types.gen.ts',
          'openapi/loan-case-v3.json',
        ],
        prompt: 'review',
        retryReview: async () => {
          retryCalled = true
          return createReviewResult(initialSession)
        },
      })

      expect(retryCalled).toBe(false)
      expect(result.inspectedChangedFileCount).toBe(1)
      expect(result.inspectedChangedFileCoverage).toBe(1)
      expect(
        result.templateWarnings.some((warning) =>
          warning.includes('inspection excluded generated or lock files'),
        ),
      ).toBe(true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('proceeds with warnings when review-scope files remain unread after retry', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mend-inspection-'))

    try {
      const initialSession = createSessionFile(cwd, 'initial', [])
      const retrySession = createSessionFile(cwd, 'retry', [])

      const result = await enforceFileInspection({
        reviewResult: createReviewResult(initialSession),
        worktreePath: cwd,
        changedFiles: ['src/feature/handler.ts', 'src/http/generated/v3/core/types.gen.ts'],
        prompt: 'review',
        retryReview: async () => createReviewResult(retrySession),
      })

      expect(result.inspectedChangedFileCount).toBe(0)
      expect(result.inspectedChangedFileCoverage).toBe(0)
      expect(
        result.templateWarnings.some((warning) =>
          warning.includes('inspection remained partial after retry'),
        ),
      ).toBe(true)
      expect(
        result.templateWarnings.some((warning) => warning.includes('src/feature/handler.ts')),
      ).toBe(true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('accepts inspected files reported directly by the harness', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mend-inspection-'))

    try {
      let retryCalled = false

      const result = await enforceFileInspection({
        reviewResult: {
          ...createReviewResult(''),
          inspectedFiles: ['src/feature/handler.ts'],
        },
        worktreePath: cwd,
        changedFiles: ['src/feature/handler.ts'],
        prompt: 'review',
        retryReview: async () => {
          retryCalled = true
          return createReviewResult('')
        },
      })

      expect(retryCalled).toBe(false)
      expect(result.inspectedChangedFileCount).toBe(1)
      expect(result.inspectedChangedFileCoverage).toBe(1)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('keeps the initial review result when inspection retry fails', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mend-inspection-'))

    try {
      const initialSession = createSessionFile(cwd, 'initial', ['src/feature/handler.ts'])

      const result = await enforceFileInspection({
        reviewResult: createReviewResult(initialSession),
        worktreePath: cwd,
        changedFiles: ['src/feature/handler.ts', 'src/feature/secondary.ts'],
        prompt: 'review',
        retryReview: async () => ({
          harness: 'pi',
          model: 'test-model',
          success: false,
          output: '',
          durationMs: 1,
          sessionFile: undefined,
          error: 'timeout',
        }),
      })

      expect(result.reviewResult.sessionFile).toBe(initialSession)
      expect(result.inspectedChangedFileCount).toBe(1)
      expect(result.inspectedChangedFileCoverage).toBe(0.5)
      expect(
        result.templateWarnings.some((warning) =>
          warning.includes('inspection retry failed; proceeding with partial coverage'),
        ),
      ).toBe(true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
