import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { buildReplayInputFromMr, loadBenchmarkConfig } from '@/cli/replay'
import type { MrDetails } from '@/integrations/gitlab/mr'

const historicalSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const liveSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

const mrDetails: MrDetails = {
  title: 'Fix checkout',
  description: 'Historical MR',
  labels: ['bug'],
  sourceBranch: 'feature/fix-checkout',
  targetBranch: 'main',
  url: 'https://gitlab.example.com/group/project/-/merge_requests/7',
  sha: liveSha,
}

describe('buildReplayInputFromMr', () => {
  test('threads benchmark commitSha into initial review input', () => {
    const input = buildReplayInputFromMr({
      projectKey: 'demo',
      mrIid: 7,
      mr: mrDetails,
      commitSha: historicalSha,
    })

    expect(input.commitSha).toBe(historicalSha)
    expect(input.reviewMode).toBe('initial')
    expect(input.previousReviewedSha).toBeNull()
    expect(input.previousRunId).toBeNull()
  })

  test('uses live MR sha when no commitSha override is provided', () => {
    const input = buildReplayInputFromMr({
      projectKey: 'demo',
      mrIid: 7,
      mr: mrDetails,
    })

    expect(input.commitSha).toBe(liveSha)
    expect(input.reviewMode).toBe('initial')
  })

  test('rejects non-full commitSha overrides before replay execution', () => {
    expect(() =>
      buildReplayInputFromMr({
        projectKey: 'demo',
        mrIid: 7,
        mr: mrDetails,
        commitSha: 'abc1234',
      }),
    ).toThrow('Invalid commit SHA')
  })
})

describe('loadBenchmarkConfig', () => {
  let tmp: string | null = null

  afterEach(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true })
      tmp = null
    }
  })

  test('parses production benchmark cases with commitSha pins', async () => {
    const config = await loadBenchmarkConfig('fixtures/benchmarks/production-v1.json')

    expect(config.cases).toHaveLength(6)
    expect(config.cases.every((testCase) => testCase.commitSha?.length === 40)).toBe(true)
  })

  test('rejects bad benchmark commitSha values', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'mend-replay-test-'))
    const configPath = join(tmp, 'benchmark.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        cases: [
          {
            name: 'bad-sha',
            projectKey: 'demo',
            mrIid: 7,
            commitSha: 'abc1234',
          },
        ],
      }),
    )

    await expect(loadBenchmarkConfig(configPath)).rejects.toThrow('Invalid benchmark config')
  })

  test('reports a clear error for a missing benchmark directory', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'mend-replay-test-'))
    const configPath = join(tmp, 'fixtures', 'benchmarks', 'production-v1.json')

    await expect(loadBenchmarkConfig(configPath)).rejects.toThrow(
      'Benchmark config directory not found',
    )
  })
})
