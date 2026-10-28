import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildReplayInputFromMr,
  loadBenchmarkConfig,
  loadBenchmarkSuite,
  parseReplayArgs,
} from '@/cli/replay'
import type { ChangeRequestDetails } from '@/integrations/provider/types'

const historicalSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const liveSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

const mrDetails: ChangeRequestDetails = {
  title: 'Fix checkout',
  description: 'Historical MR',
  labels: ['bug'],
  sourceBranch: 'feature/fix-checkout',
  targetBranch: 'main',
  url: 'https://gitlab.example.com/group/project/-/merge_requests/7',
  sha: liveSha,
}

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mend-replay-test-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const writeJson = async (name: string, value: unknown): Promise<string> => {
  const path = join(dir, name)
  await Bun.write(path, JSON.stringify(value))
  return path
}

const benchmarkCase = (name: string, expectationPath: string) => ({
  name,
  projectKey: 'demo',
  mrIid: 7,
  expectationPath,
})

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
  test('parses production benchmark cases with commitSha pins', async () => {
    const config = await loadBenchmarkConfig('fixtures/benchmarks/production-v1.json')

    expect(config.cases).toHaveLength(6)
    expect(config.cases.every((testCase) => testCase.commitSha?.length === 40)).toBe(true)
  })

  test('rejects bad benchmark commitSha values', async () => {
    const configPath = await writeJson('benchmark.json', {
      cases: [
        {
          name: 'bad-sha',
          projectKey: 'demo',
          mrIid: 7,
          commitSha: 'abc1234',
        },
      ],
    })

    await expect(loadBenchmarkConfig(configPath)).rejects.toThrow('Invalid benchmark config')
  })

  test('reports a clear error for a missing benchmark directory', async () => {
    const configPath = join(dir, 'fixtures', 'benchmarks', 'production-v1.json')

    await expect(loadBenchmarkConfig(configPath)).rejects.toThrow(
      'Benchmark config directory not found',
    )
  })
})

describe('parseReplayArgs', () => {
  test.each([[['--help']], [['-h']], [['--benchmark', 'suite.json', '--help']], [['demo', '-h']]])(
    'returns help for %p',
    (args) => {
      expect(parseReplayArgs(args)).toEqual({ kind: 'help' })
    },
  )

  test('parses benchmark options', () => {
    expect(
      parseReplayArgs(['--benchmark', 'suite.json', '--out', 'report.json', '--json']),
    ).toEqual({
      kind: 'benchmark',
      options: {
        configPath: 'suite.json',
        outPath: 'report.json',
        comparePath: undefined,
        json: true,
      },
    })
  })

  test('rejects benchmark options without values', () => {
    expect(() => parseReplayArgs(['--benchmark', 'suite.json', '--out'])).toThrow(
      'Missing value for --out',
    )
    expect(() => parseReplayArgs(['--benchmark', '--json'])).toThrow(
      'Missing benchmark config path',
    )
  })

  test('parses run and mr replays', () => {
    expect(parseReplayArgs(['--run', 'run-1'])).toEqual({ kind: 'run', runId: 'run-1' })
    expect(parseReplayArgs(['demo', '7'])).toEqual({ kind: 'mr', projectKey: 'demo', mrIid: 7 })
    expect(parseReplayArgs([])).toEqual({ kind: 'invalid' })
    expect(parseReplayArgs(['--run'])).toEqual({ kind: 'invalid' })
  })
})

describe('loadBenchmarkSuite', () => {
  test('resolves and validates expectation files relative to the config', async () => {
    await writeJson('good.json', { expectedFindings: [{ id: 'a', pattern: 'await' }] })
    const configPath = await writeJson('suite.json', {
      cases: [benchmarkCase('good', 'good.json')],
    })

    const cases = await loadBenchmarkSuite(configPath)

    expect(cases.map((item) => item.expectation)).toEqual([
      { expectedFindings: [{ id: 'a', pattern: 'await' }] },
    ])
  })

  test('reports every missing or invalid expectation before any review runs', async () => {
    await writeJson('verdicts.json', {
      expectedResolutionVerdicts: [{ previousFindingRef: 'prev-1', status: 'fixed' }],
    })
    await writeJson('bad-regex.json', { expectedFindings: [{ id: 'a', pattern: '(' }] })
    const configPath = await writeJson('suite.json', {
      cases: [
        benchmarkCase('verdicts', 'verdicts.json'),
        benchmarkCase('bad-regex', 'bad-regex.json'),
        benchmarkCase('missing', 'missing.json'),
      ],
    })

    const error = await loadBenchmarkSuite(configPath).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('verdicts')
    expect(message).toContain('initial mode')
    expect(message).toContain('bad-regex')
    expect(message).toContain('valid regular expression')
    expect(message).toContain('Missing expectation for benchmark case missing')
  })

  test('rejects inline resolution verdict expectations in the config', async () => {
    const configPath = await writeJson('suite.json', {
      cases: [
        {
          name: 'inline',
          projectKey: 'demo',
          mrIid: 7,
          expectation: {
            expectedResolutionVerdicts: [{ previousFindingRef: 'prev-1', status: 'fixed' }],
          },
        },
      ],
    })

    await expect(loadBenchmarkSuite(configPath)).rejects.toThrow('initial mode')
  })
})
