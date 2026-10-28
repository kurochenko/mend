import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { closeDb, initDb } from '@/db/client'
import { getReviewRun } from '@/db/review-runs'
import { createReviewProvider } from '@/integrations/provider/client'
import type { ChangeRequestDetails } from '@/integrations/provider/types'
import { toErrorMessage } from '@/lib/errors'
import { assertCommitSha } from '@/lib/exec'
import { mrReviewInputSchema, type MrReviewInput } from '@/lib/review-run-input'
import type { ReviewRunSource } from '@/db/review-runs'
import {
  benchmarkExpectationSchema,
  scoreBenchmarkCase,
  type BenchmarkCase,
  type BenchmarkCaseScore,
  type BenchmarkExpectation,
} from '@/mastra/review/eval/scoring'
import type { PostStepOutput } from '@/mastra/review/run-result'
import { executeMrReview } from '@/mastra/run-mr-review'
import { loadConfig } from '@/config'
import { createMastra } from '@/mastra/index'

const printUsage = (): void => {
  console.log('Usage: bun run replay <project-key> <mr-iid>')
  console.log('   or: bun run replay --run <review-run-id>')
  console.log(
    '   or: bun run replay --benchmark <config.json> [--out <report.json>] [--compare <baseline.json>] [--json]',
  )
  console.log('   or: bun run replay --help')
}

const benchmarkCaseSchema = z
  .object({
    name: z.string(),
    projectKey: z.string(),
    mrIid: z.number().int().positive(),
    commitSha: z
      .string()
      .refine(
        (value) => {
          try {
            assertCommitSha(value)
            return true
          } catch {
            return false
          }
        },
        { message: 'Invalid commit SHA' },
      )
      .optional(),
    expectation: benchmarkExpectationSchema.optional(),
    expectationPath: z.string().optional(),
  })
  .strict()

const benchmarkConfigFileSchema = z
  .object({
    cases: z.array(benchmarkCaseSchema),
  })
  .strict()

type BenchmarkConfigFile = z.infer<typeof benchmarkConfigFileSchema>

type ResolvedBenchmarkCase = BenchmarkCase & { expectation: BenchmarkExpectation }

interface BenchmarkOptions {
  configPath: string
  outPath?: string
  comparePath?: string
  json: boolean
}

type ReplayCommand =
  | { kind: 'help' }
  | { kind: 'invalid' }
  | { kind: 'run'; runId: string }
  | { kind: 'benchmark'; options: BenchmarkOptions }
  | { kind: 'mr'; projectKey: string; mrIid: number }

interface BenchmarkReport {
  generatedAt: string
  cases: BenchmarkCaseScore[]
  aggregate: BenchmarkAggregate
  overallScore: number
  passed: number
  failed: number
}

interface HarnessAggregate {
  recall: number
  matchedExpected: number
  totalExpected: number
  falsePositiveHits: number
  unmatchedItems: number
}

interface BenchmarkAggregate extends HarnessAggregate {
  comparison?: HarnessAggregate
}

interface ReplayExecution {
  reviewRunId: string
  workflowRunId?: string
  output: PostStepOutput
}

const parseMrIid = (value: string): number => {
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid mr-iid: ${value}`)
  }
  return parsed
}

export const buildReplayInputFromMr = (params: {
  projectKey: string
  mrIid: number
  mr: ChangeRequestDetails
  commitSha?: string
}): MrReviewInput => {
  const requestedCommitSha =
    params.commitSha === undefined ? params.mr.sha : assertCommitSha(params.commitSha)

  return {
    projectKey: params.projectKey,
    mrIid: params.mrIid,
    title: params.mr.title,
    description: params.mr.description,
    labels: params.mr.labels,
    sourceBranch: params.mr.sourceBranch,
    targetBranch: params.mr.targetBranch,
    url: params.mr.url,
    commitSha: requestedCommitSha,
    reviewMode: 'initial',
    previousReviewedSha: null,
    previousRunId: null,
  }
}

const executeReplayFromMr = async (
  projectKey: string,
  mrIid: number,
  options?: { commitSha?: string; source?: ReviewRunSource },
): Promise<ReplayExecution> => {
  const config = loadConfig()
  const project = config.projects.get(projectKey)
  if (!project) {
    throw new Error(`Unknown project: ${projectKey}`)
  }

  const mastra = createMastra(config)
  const provider = createReviewProvider(project)
  const mr = await provider.fetchChangeRequest(mrIid)
  const input = buildReplayInputFromMr({
    projectKey,
    mrIid,
    mr,
    commitSha: options?.commitSha,
  })

  const execution = await executeMrReview({
    mastra,
    source: options?.source ?? 'replay_iid',
    input,
  })

  if (execution.workflowResult.status !== 'success' || !execution.output) {
    throw new Error(
      `Run ${execution.reviewRunId} failed with status ${execution.workflowResult.status}`,
    )
  }

  return {
    reviewRunId: execution.reviewRunId,
    workflowRunId: execution.workflowRunId,
    output: execution.output,
  }
}

const printReplayOutput = (output: PostStepOutput): void => {
  console.log(`MR: ${output.projectKey}!${output.mrIid}`)
  console.log(`Commit: ${output.commitSha}`)
  console.log(`Assessment: ${output.assessment}`)
  console.log(`Findings: ${output.findings.length}`)
  console.log(`Inline comments: ${output.inlineComments.length}`)
  console.log(`Posted inline: ${output.posted}`)
  console.log(`Skipped inline: ${output.skipped}`)
  console.log(`Skipped reasons: ${JSON.stringify(output.postDiagnostics.skippedInlineReasons)}`)
}

const runReplayFromMr = async (projectKey: string, mrIid: number): Promise<void> => {
  const execution = await executeReplayFromMr(projectKey, mrIid)

  console.log(`Run: ${execution.reviewRunId}`)
  console.log(`Workflow run: ${execution.workflowRunId ?? '-'}`)
  printReplayOutput(execution.output)
}

const runReplayFromRun = async (runId: string): Promise<void> => {
  const config = loadConfig()
  const mastra = createMastra(config)
  const previousRun = await getReviewRun(runId)

  if (!previousRun) {
    throw new Error(`Run not found: ${runId}`)
  }

  const parsed = mrReviewInputSchema.safeParse(previousRun.input)
  if (!parsed.success) {
    throw new Error(`Run ${runId} has invalid input payload`)
  }

  const input = {
    ...parsed.data,
    commitSha: parsed.data.commitSha ?? previousRun.commitSha ?? undefined,
  }

  const execution = await executeMrReview({
    mastra,
    source: 'replay_run',
    input,
  })

  if (execution.workflowResult.status !== 'success' || !execution.output) {
    console.error(
      `Run ${execution.reviewRunId} failed with status ${execution.workflowResult.status}`,
    )
    process.exitCode = 1
    return
  }

  console.log(`Run: ${execution.reviewRunId}`)
  console.log(`Workflow run: ${execution.workflowRunId ?? '-'}`)
  console.log(`Replay of: ${runId}`)
  printReplayOutput(execution.output)
}

const isHelpArg = (arg: string): boolean => arg === '--help' || arg === '-h'

const requireOptionValue = (args: string[], index: number, option: string): string => {
  const value = args[index + 1]
  if (!value || value.startsWith('-')) {
    throw new Error(`Missing value for ${option}`)
  }
  return value
}

const parseBenchmarkArgs = (args: string[]): BenchmarkOptions => {
  const configPath = args[1]
  if (!configPath || configPath.startsWith('-')) {
    throw new Error('Missing benchmark config path')
  }

  let outPath: string | undefined
  let comparePath: string | undefined
  let json = false

  for (let i = 2; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--out') {
      outPath = requireOptionValue(args, i, arg)
      i++
      continue
    }
    if (arg === '--compare') {
      comparePath = requireOptionValue(args, i, arg)
      i++
      continue
    }
    if (arg === '--json') {
      json = true
      continue
    }
    throw new Error(`Unknown benchmark arg: ${arg}`)
  }

  return { configPath, outPath, comparePath, json }
}

export const parseReplayArgs = (args: string[]): ReplayCommand => {
  if (args.some(isHelpArg)) {
    return { kind: 'help' }
  }
  const [first, second] = args
  if (first === '--benchmark') {
    return { kind: 'benchmark', options: parseBenchmarkArgs(args) }
  }
  if (first === '--run') {
    return second && args.length === 2 ? { kind: 'run', runId: second } : { kind: 'invalid' }
  }
  if (!first || !second || args.length !== 2 || first.startsWith('-')) {
    return { kind: 'invalid' }
  }
  return { kind: 'mr', projectKey: first, mrIid: parseMrIid(second) }
}

export const loadBenchmarkConfig = async (configPath: string): Promise<BenchmarkConfigFile> => {
  const configDir = dirname(configPath)
  if (!existsSync(configDir)) {
    throw new Error(`Benchmark config directory not found: ${configDir}`)
  }
  const configFile = Bun.file(configPath)
  if (!(await configFile.exists())) {
    throw new Error(`Benchmark config not found: ${configPath}`)
  }

  const parsed = benchmarkConfigFileSchema.safeParse(await configFile.json())
  if (!parsed.success) {
    throw new Error(`Invalid benchmark config ${configPath}:\n${z.prettifyError(parsed.error)}`)
  }
  if (parsed.data.cases.length === 0) {
    throw new Error('Benchmark config must include at least one case')
  }

  return parsed.data
}

const benchmarkExpectationPath = (testCase: BenchmarkCase, configPath: string): string => {
  if (!testCase.expectationPath) {
    return join('fixtures', 'expectations', `${testCase.name}.json`)
  }
  return isAbsolute(testCase.expectationPath)
    ? testCase.expectationPath
    : join(dirname(configPath), testCase.expectationPath)
}

const loadBenchmarkExpectation = async (
  testCase: BenchmarkCase,
  configPath: string,
): Promise<BenchmarkExpectation> => {
  if (testCase.expectation) {
    return testCase.expectation
  }

  const expectationPath = benchmarkExpectationPath(testCase, configPath)
  const expectationFile = Bun.file(expectationPath)
  if (!(await expectationFile.exists())) {
    throw new Error(`Missing expectation for benchmark case ${testCase.name}: ${expectationPath}`)
  }
  let raw: unknown
  try {
    raw = await expectationFile.json()
  } catch (error) {
    throw new Error(
      `Invalid JSON in expectation for benchmark case ${testCase.name}: ${expectationPath}`,
      { cause: error },
    )
  }
  const parsed = benchmarkExpectationSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(
      `Invalid expectation for benchmark case ${testCase.name} (${expectationPath}):\n${z.prettifyError(parsed.error)}`,
    )
  }
  return parsed.data
}

export const loadBenchmarkSuite = async (configPath: string): Promise<ResolvedBenchmarkCase[]> => {
  const configFile = await loadBenchmarkConfig(configPath)
  const results = await Promise.allSettled(
    configFile.cases.map(async (testCase) => ({
      ...testCase,
      expectation: await loadBenchmarkExpectation(testCase, configPath),
    })),
  )
  const errors = results.flatMap((result) =>
    result.status === 'rejected' ? [toErrorMessage(result.reason)] : [],
  )
  if (errors.length > 0) {
    throw new Error(`Benchmark expectations are invalid:\n${errors.join('\n')}`)
  }
  return results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
}

const computeOverallScore = (cases: BenchmarkCaseScore[]): number => {
  if (cases.length === 0) {
    return 0
  }
  const total = cases.reduce((sum, item) => sum + item.score, 0)
  return Math.round(total / cases.length)
}

const aggregateHarness = (scores: BenchmarkCaseScore['primary'][]): HarnessAggregate => {
  const matchedExpected = scores.reduce((sum, item) => sum + item.matchedExpected, 0)
  const totalExpected = scores.reduce((sum, item) => sum + item.totalExpected, 0)
  return {
    recall: totalExpected === 0 ? 1 : matchedExpected / totalExpected,
    matchedExpected,
    totalExpected,
    falsePositiveHits: scores.reduce((sum, item) => sum + item.falsePositiveHits.length, 0),
    unmatchedItems: scores.reduce((sum, item) => sum + item.unmatchedItems.length, 0),
  }
}

const aggregateScores = (cases: BenchmarkCaseScore[]): BenchmarkAggregate => {
  const comparisonScores = cases.flatMap((item) => (item.comparison ? [item.comparison] : []))
  return {
    ...aggregateHarness(cases.map((item) => item.primary)),
    comparison: comparisonScores.length === 0 ? undefined : aggregateHarness(comparisonScores),
  }
}

const buildBenchmarkReport = (
  scores: BenchmarkCaseScore[],
  generatedAt: Date,
): BenchmarkReport => ({
  generatedAt: generatedAt.toISOString(),
  cases: scores,
  aggregate: aggregateScores(scores),
  overallScore: computeOverallScore(scores),
  passed: scores.filter((item) => item.passed).length,
  failed: scores.filter((item) => !item.passed).length,
})

const formatRatio = (value: number): string => `${Math.round(value * 100)}%`

const printHarnessScore = (label: string, score: BenchmarkCaseScore['primary']): void => {
  console.log(
    `- ${label}: ${score.passed ? 'passed' : 'failed'}, recall ${formatRatio(score.recall)} (${score.matchedExpected}/${score.totalExpected}), false positives ${score.falsePositiveHits.length}, unmatched ${score.unmatchedItems.length}`,
  )
  const failedChecks = Object.entries(score.diagnostics.checks)
    .filter(([, passed]) => !passed)
    .map(([check]) => check)
  if (failedChecks.length > 0) {
    console.log(`  failed checks: ${failedChecks.join(', ')}`)
  }
  if (score.missedExpected.length > 0) {
    console.log(`  missed: ${score.missedExpected.join(', ')}`)
  }
  if (score.falsePositiveHits.length > 0) {
    console.log(
      `  false positives: ${score.falsePositiveHits
        .map((item) => `${item.forbiddenId}:${item.title}`)
        .join('; ')}`,
    )
  }
  if (score.unmatchedItems.length > 0) {
    console.log(`  unmatched: ${score.unmatchedItems.map((item) => item.title).join('; ')}`)
  }
}

const printBenchmarkDelta = (current: BenchmarkReport, baseline: BenchmarkReport): void => {
  const deltaOverall = current.overallScore - baseline.overallScore
  console.log(`Delta overall: ${deltaOverall >= 0 ? '+' : ''}${deltaOverall}`)

  const baselineByName = new Map(baseline.cases.map((item) => [item.name, item]))
  for (const currentCase of current.cases) {
    const baseCase = baselineByName.get(currentCase.name)
    if (!baseCase) {
      continue
    }
    const delta = currentCase.score - baseCase.score
    console.log(
      `- ${currentCase.name}: ${delta >= 0 ? '+' : ''}${delta} (${baseCase.score} -> ${currentCase.score})`,
    )
  }
}

const runBenchmarkCase = async (params: {
  testCase: ResolvedBenchmarkCase
  json: boolean
}): Promise<BenchmarkCaseScore> => {
  const { testCase, json } = params
  if (!json) {
    console.log(
      `Running benchmark case: ${testCase.name} (${testCase.projectKey}!${testCase.mrIid})`,
    )
  }
  const execution = await executeReplayFromMr(testCase.projectKey, testCase.mrIid, {
    commitSha: testCase.commitSha,
    source: 'replay_benchmark',
  })
  const score = scoreBenchmarkCase(testCase, execution.output)
  if (!json) {
    printHarnessScore('primary', score.primary)
    if (score.comparison) {
      printHarnessScore(
        `comparison:${score.comparison.comparisonHarness ?? 'unknown'}`,
        score.comparison,
      )
    }
  }
  return score
}

const printBenchmarkSummary = (report: BenchmarkReport): void => {
  console.log(
    `Benchmark primary recall: ${formatRatio(report.aggregate.recall)} (${report.aggregate.matchedExpected}/${report.aggregate.totalExpected})`,
  )
  console.log(`Benchmark primary false positives: ${report.aggregate.falsePositiveHits}`)
  console.log(`Benchmark primary unmatched: ${report.aggregate.unmatchedItems}`)
  if (report.aggregate.comparison) {
    console.log(
      `Benchmark comparison recall: ${formatRatio(report.aggregate.comparison.recall)} (${report.aggregate.comparison.matchedExpected}/${report.aggregate.comparison.totalExpected})`,
    )
    console.log(
      `Benchmark comparison false positives: ${report.aggregate.comparison.falsePositiveHits}`,
    )
    console.log(`Benchmark comparison unmatched: ${report.aggregate.comparison.unmatchedItems}`)
  }
  console.log(`Benchmark passed: ${report.passed}`)
  console.log(`Benchmark failed: ${report.failed}`)
}

const runBenchmark = async (
  options: BenchmarkOptions,
  cases: ResolvedBenchmarkCase[],
): Promise<void> => {
  const { outPath, comparePath, json } = options
  const scores: BenchmarkCaseScore[] = []

  for (const testCase of cases) {
    scores.push(await runBenchmarkCase({ testCase, json }))
  }

  const report = buildBenchmarkReport(scores, new Date())

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    printBenchmarkSummary(report)
  }

  if (outPath) {
    await Bun.write(outPath, JSON.stringify(report, null, 2))
    if (!json) {
      console.log(`Wrote benchmark report: ${outPath}`)
    }
  }

  if (comparePath && !json) {
    const baseline = (await Bun.file(comparePath).json()) as BenchmarkReport
    printBenchmarkDelta(report, baseline)
  }

  if (report.failed > 0) {
    process.exitCode = 1
  }
}

const routeConsoleToStderr = (): void => {
  console.log = console.error
  console.info = console.error
  console.debug = console.error
}

const main = async (): Promise<void> => {
  const command = parseReplayArgs(Bun.argv.slice(2))

  if (command.kind === 'help') {
    printUsage()
    return
  }
  if (command.kind === 'invalid') {
    printUsage()
    process.exitCode = 1
    return
  }

  if (command.kind === 'benchmark') {
    if (command.options.json) {
      routeConsoleToStderr()
    }
    const cases = await loadBenchmarkSuite(command.options.configPath)
    const config = loadConfig()
    await initDb(config.env.DATABASE_URL)
    await runBenchmark(command.options, cases)
    return
  }

  const config = loadConfig()
  await initDb(config.env.DATABASE_URL)

  if (command.kind === 'run') {
    await runReplayFromRun(command.runId)
    return
  }

  await runReplayFromMr(command.projectKey, command.mrIid)
}

if (import.meta.main) {
  main()
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
    .finally(async () => {
      await closeDb()
    })
}
