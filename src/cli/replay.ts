import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { closeDb, initDb } from '@/db/client'
import { getReviewRun } from '@/db/review-runs'
import { fetchMr, type MrDetails } from '@/integrations/gitlab/mr'
import { assertCommitSha } from '@/lib/exec'
import { mrReviewInputSchema, type MrReviewInput } from '@/lib/review-run-input'
import type { ReviewRunSource } from '@/db/review-runs'
import {
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
}

const reviewCategorySchema = z.enum([
  'correctness',
  'architecture',
  'duplication',
  'convention',
  'dead_code',
  'performance',
  'security',
  'testing',
])

const resolutionVerdictStatusSchema = z.enum([
  'fixed',
  'not_fixed',
  'partially_fixed',
  'cannot_determine',
])

const benchmarkExpectationSchema: z.ZodType<BenchmarkExpectation> = z
  .object({
    minFindings: z.number().optional(),
    maxFindings: z.number().optional(),
    minInlineComments: z.number().optional(),
    maxInlineComments: z.number().optional(),
    requiredCategories: z.array(reviewCategorySchema).optional(),
    maxSkippedInline: z.number().optional(),
    expectedFindings: z
      .array(
        z.object({
          id: z.string(),
          fileGlob: z.string(),
          lineRange: z.object({ from: z.number(), to: z.number() }).optional(),
          category: reviewCategorySchema.optional(),
          pattern: z.string(),
          note: z.string().optional(),
        }),
      )
      .optional(),
    forbiddenFindings: z
      .array(
        z.object({
          id: z.string(),
          fileGlob: z.string().optional(),
          pattern: z.string(),
          note: z.string().optional(),
        }),
      )
      .optional(),
    expectedResolutionVerdicts: z
      .array(
        z.object({
          previousFindingRef: z.string(),
          status: resolutionVerdictStatusSchema,
        }),
      )
      .optional(),
  })
  .strict()

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

interface BenchmarkReport {
  generatedAt: string
  cases: BenchmarkCaseScore[]
  aggregate: BenchmarkAggregate
  overallScore: number
  passed: number
  failed: number
}

interface BenchmarkAggregate {
  recall: number
  matchedExpected: number
  totalExpected: number
  falsePositiveHits: number
  unmatchedItems: number
  verdictAccuracy: number | null
  verdictCorrect: number
  verdictExpected: number
  comparison?: {
    recall: number
    matchedExpected: number
    totalExpected: number
    falsePositiveHits: number
    unmatchedItems: number
    verdictAccuracy: number | null
    verdictCorrect: number
    verdictExpected: number
  }
}

interface ReplayExecution {
  reviewRunId: string
  workflowRunId?: string
  output: PostStepOutput
}

const parseMrIid = (value: string): number => {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid mr-iid: ${value}`)
  }
  return parsed
}

export const buildReplayInputFromMr = (params: {
  projectKey: string
  mrIid: number
  mr: MrDetails
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
  const mr = await fetchMr(project, mrIid)
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
  console.log(`Template: ${output.reviewTemplateId} (${output.reviewTemplateSource})`)
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

const parseBenchmarkArgs = (
  args: string[],
): {
  configPath: string
  outPath?: string
  comparePath?: string
  json: boolean
} => {
  const configPath = args[1]
  if (!configPath) {
    throw new Error('Missing benchmark config path')
  }

  let outPath: string | undefined
  let comparePath: string | undefined
  let json = false

  for (let i = 2; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--out') {
      outPath = args[i + 1]
      i++
      continue
    }
    if (arg === '--compare') {
      comparePath = args[i + 1]
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
    throw new Error(`Invalid benchmark config ${configPath}: ${parsed.error.message}`)
  }
  if (parsed.data.cases.length === 0) {
    throw new Error('Benchmark config must include at least one case')
  }

  return parsed.data
}

const loadBenchmarkExpectation = async (
  testCase: BenchmarkCase,
  configPath: string,
): Promise<BenchmarkExpectation> => {
  if (testCase.expectation) {
    return testCase.expectation
  }

  const configDir = dirname(configPath)
  const expectationPath = testCase.expectationPath
    ? isAbsolute(testCase.expectationPath)
      ? testCase.expectationPath
      : join(configDir, testCase.expectationPath)
    : join('fixtures', 'expectations', `${testCase.name}.json`)
  const expectationFile = Bun.file(expectationPath)
  if (!(await expectationFile.exists())) {
    throw new Error(`Missing expectation for benchmark case ${testCase.name}: ${expectationPath}`)
  }
  return (await expectationFile.json()) as BenchmarkExpectation
}

const computeOverallScore = (cases: BenchmarkCaseScore[]): number => {
  if (cases.length === 0) {
    return 0
  }
  const total = cases.reduce((sum, item) => sum + item.score, 0)
  return Math.round(total / cases.length)
}

const aggregateScores = (cases: BenchmarkCaseScore[]): BenchmarkAggregate => {
  const matchedExpected = cases.reduce((sum, item) => sum + item.primary.matchedExpected, 0)
  const totalExpected = cases.reduce((sum, item) => sum + item.primary.totalExpected, 0)
  const verdictCorrect = cases.reduce((sum, item) => sum + item.primary.verdicts.correct, 0)
  const verdictExpected = cases.reduce((sum, item) => sum + item.primary.verdicts.expected, 0)
  const comparisonCases = cases.filter((item) => item.comparison)
  const comparisonMatchedExpected = comparisonCases.reduce(
    (sum, item) => sum + (item.comparison?.matchedExpected ?? 0),
    0,
  )
  const comparisonTotalExpected = comparisonCases.reduce(
    (sum, item) => sum + (item.comparison?.totalExpected ?? 0),
    0,
  )
  const comparisonVerdictCorrect = comparisonCases.reduce(
    (sum, item) => sum + (item.comparison?.verdicts.correct ?? 0),
    0,
  )
  const comparisonVerdictExpected = comparisonCases.reduce(
    (sum, item) => sum + (item.comparison?.verdicts.expected ?? 0),
    0,
  )

  return {
    recall: totalExpected === 0 ? 1 : matchedExpected / totalExpected,
    matchedExpected,
    totalExpected,
    falsePositiveHits: cases.reduce((sum, item) => sum + item.primary.falsePositiveHits.length, 0),
    unmatchedItems: cases.reduce((sum, item) => sum + item.primary.unmatchedItems.length, 0),
    verdictAccuracy: verdictExpected === 0 ? null : verdictCorrect / verdictExpected,
    verdictCorrect,
    verdictExpected,
    comparison:
      comparisonCases.length === 0
        ? undefined
        : {
            recall:
              comparisonTotalExpected === 0
                ? 1
                : comparisonMatchedExpected / comparisonTotalExpected,
            matchedExpected: comparisonMatchedExpected,
            totalExpected: comparisonTotalExpected,
            falsePositiveHits: comparisonCases.reduce(
              (sum, item) => sum + (item.comparison?.falsePositiveHits.length ?? 0),
              0,
            ),
            unmatchedItems: comparisonCases.reduce(
              (sum, item) => sum + (item.comparison?.unmatchedItems.length ?? 0),
              0,
            ),
            verdictAccuracy:
              comparisonVerdictExpected === 0
                ? null
                : comparisonVerdictCorrect / comparisonVerdictExpected,
            verdictCorrect: comparisonVerdictCorrect,
            verdictExpected: comparisonVerdictExpected,
          },
  }
}

const formatRatio = (value: number): string => `${Math.round(value * 100)}%`

const printHarnessScore = (label: string, score: BenchmarkCaseScore['primary']): void => {
  console.log(
    `- ${label}: recall ${formatRatio(score.recall)} (${score.matchedExpected}/${score.totalExpected}), false positives ${score.falsePositiveHits.length}, unmatched ${score.unmatchedItems.length}, verdict accuracy ${
      score.verdictAccuracy === null ? '-' : formatRatio(score.verdictAccuracy)
    }`,
  )
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
  testCase: BenchmarkCase
  configPath: string
  json: boolean
}): Promise<BenchmarkCaseScore> => {
  const { testCase, configPath, json } = params
  if (!json) {
    console.log(
      `Running benchmark case: ${testCase.name} (${testCase.projectKey}!${testCase.mrIid})`,
    )
  }
  const execution = await executeReplayFromMr(testCase.projectKey, testCase.mrIid, {
    commitSha: testCase.commitSha,
    source: 'replay_benchmark',
  })
  const expectation = await loadBenchmarkExpectation(testCase, configPath)
  const score = scoreBenchmarkCase({ ...testCase, expectation }, execution.output)
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

const runBenchmark = async (args: string[]): Promise<void> => {
  const { configPath, outPath, comparePath, json } = parseBenchmarkArgs(args)
  const configFile = await loadBenchmarkConfig(configPath)

  const scores: BenchmarkCaseScore[] = []

  for (const testCase of configFile.cases) {
    scores.push(await runBenchmarkCase({ testCase, configPath, json }))
  }

  const report: BenchmarkReport = {
    generatedAt: new Date().toISOString(),
    cases: scores,
    aggregate: aggregateScores(scores),
    overallScore: computeOverallScore(scores),
    passed: scores.filter((item) => item.passed).length,
    failed: scores.filter((item) => !item.passed).length,
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(
      `Benchmark primary recall: ${formatRatio(report.aggregate.recall)} (${report.aggregate.matchedExpected}/${report.aggregate.totalExpected})`,
    )
    console.log(`Benchmark primary false positives: ${report.aggregate.falsePositiveHits}`)
    console.log(`Benchmark primary unmatched: ${report.aggregate.unmatchedItems}`)
    console.log(
      `Benchmark primary verdict accuracy: ${
        report.aggregate.verdictAccuracy === null
          ? '-'
          : formatRatio(report.aggregate.verdictAccuracy)
      }`,
    )
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

  if (outPath) {
    await Bun.write(outPath, JSON.stringify(report, null, 2))
    if (!json) {
      console.log(`Wrote benchmark report: ${outPath}`)
    }
  }

  if (comparePath) {
    const baseline = (await Bun.file(comparePath).json()) as BenchmarkReport
    if (!json) {
      printBenchmarkDelta(report, baseline)
    }
  }
}

const main = async (): Promise<void> => {
  const args = Bun.argv.slice(2)

  if (args.length === 0) {
    printUsage()
    process.exitCode = 1
    return
  }

  const config = loadConfig()
  await initDb(config.env.DATABASE_URL)

  if (args[0] === '--run') {
    const runId = args[1]
    if (!runId || args.length !== 2) {
      printUsage()
      process.exitCode = 1
      return
    }
    await runReplayFromRun(runId)
    return
  }

  if (args[0] === '--benchmark') {
    await runBenchmark(args)
    return
  }

  if (args.length !== 2) {
    printUsage()
    process.exitCode = 1
    return
  }

  const projectKey = args[0]
  const rawMrIid = args[1]
  if (!projectKey || !rawMrIid) {
    printUsage()
    process.exitCode = 1
    return
  }
  await runReplayFromMr(projectKey, parseMrIid(rawMrIid))
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
