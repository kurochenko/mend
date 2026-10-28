import { z } from 'zod'
import type { ComparisonResult } from '@/mastra/review/comparison'
import type { PostStepOutput } from '@/mastra/review/run-result'
import {
  reviewFindingSchema,
  type ReviewFinding,
  type ReviewOutputV2,
} from '@/mastra/review/schema'

export type ReviewCategory = ReviewFinding['category']

const safePattern = (pattern: string): RegExp => new RegExp(pattern, 'i')

const isValidPattern = (pattern: string): boolean => {
  try {
    safePattern(pattern)
    return true
  } catch {
    return false
  }
}

const patternSchema = z.string().min(1).refine(isValidPattern, {
  error: 'pattern must be a valid regular expression',
})

const countSchema = z.number().int().nonnegative()

const expectedFindingSchema = z
  .object({
    id: z.string().min(1),
    fileGlob: z.string().min(1).optional(),
    lineRange: z.object({ from: z.number().int(), to: z.number().int() }).strict().optional(),
    category: reviewFindingSchema.shape.category.optional(),
    pattern: patternSchema,
    note: z.string().optional(),
  })
  .strict()

const forbiddenFindingSchema = z
  .object({
    id: z.string().min(1),
    fileGlob: z.string().min(1).optional(),
    pattern: patternSchema,
    note: z.string().optional(),
  })
  .strict()

export const benchmarkExpectationSchema = z
  .object({
    minFindings: countSchema.optional(),
    maxFindings: countSchema.optional(),
    minInlineComments: countSchema.optional(),
    maxInlineComments: countSchema.optional(),
    requiredCategories: z.array(reviewFindingSchema.shape.category).optional(),
    maxSkippedInline: countSchema.optional(),
    expectedFindings: z.array(expectedFindingSchema).optional(),
    forbiddenFindings: z.array(forbiddenFindingSchema).optional(),
    expectedResolutionVerdicts: z
      .never({
        error:
          'expectedResolutionVerdicts is not supported: benchmark cases replay in initial mode, so there are no previous findings to verify',
      })
      .optional(),
  })
  .strict()

export type ExpectedFinding = z.infer<typeof expectedFindingSchema>
export type ForbiddenFinding = z.infer<typeof forbiddenFindingSchema>
export type BenchmarkExpectation = z.infer<typeof benchmarkExpectationSchema>

export interface BenchmarkCase {
  name: string
  projectKey: string
  mrIid: number
  commitSha?: string
  expectation?: BenchmarkExpectation
  expectationPath?: string
}

export interface ReviewItemMatch {
  expectationId: string
  itemId: string
  title: string
  file: string | null
  line: number | null
}

export interface FalsePositiveHit {
  forbiddenId: string
  itemId: string
  title: string
  file: string | null
  line: number | null
}

export interface UnmatchedReviewItem {
  itemId: string
  title: string
  file: string | null
  line: number | null
}

export interface CountDiagnostics {
  checks: Record<string, boolean>
  findings: number
  inlineComments: number
  skippedInline: number
  categories: ReviewCategory[]
}

export interface ReviewExpectationScore {
  recall: number
  matchedExpected: number
  totalExpected: number
  falsePositiveHits: FalsePositiveHit[]
  unmatchedItems: UnmatchedReviewItem[]
  matched: ReviewItemMatch[]
  missedExpected: string[]
  diagnostics: CountDiagnostics
  passed: boolean
}

export interface HarnessBenchmarkScore extends ReviewExpectationScore {
  harness: 'primary' | 'comparison'
  comparisonHarness?: string
  comparisonStatus?: 'success' | 'failed'
}

export interface BenchmarkCaseScore {
  name: string
  projectKey: string
  mrIid: number
  score: number
  passed: boolean
  checks: Record<string, boolean>
  primary: HarnessBenchmarkScore
  comparison?: HarnessBenchmarkScore
  output: {
    assessment: string
    findings: number
    inlineComments: number
    skippedInline: number
    categories: ReviewCategory[]
  }
}

interface ReviewItem {
  id: string
  title: string
  text: string
  category?: ReviewCategory
  files: string[]
  lines: Array<{ file: string; line: number }>
}

interface ExpectedPair {
  expectedIndex: number
  itemIndex: number
  score: number
}

const lineTolerance = 3

const inRange = (
  value: number,
  minValue: number | undefined,
  maxValue: number | undefined,
): boolean => {
  if (minValue !== undefined && value < minValue) {
    return false
  }
  if (maxValue !== undefined && value > maxValue) {
    return false
  }
  return true
}

const normalizePath = (value: string): string => value.replace(/^\.\//, '')

const escapeRegExp = (value: string): string => value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')

const globToRegExp = (glob: string): RegExp => {
  let source = '^'
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]
    if (char === undefined) {
      continue
    }
    const next = glob[index + 1]
    if (char === '*' && next === '*') {
      source += '.*'
      index++
      continue
    }
    if (char === '*') {
      source += '[^/]*'
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    source += escapeRegExp(char)
  }
  source += '$'
  return new RegExp(source)
}

const matchesGlob = (fileGlob: string, file: string): boolean =>
  globToRegExp(normalizePath(fileGlob)).test(normalizePath(file))

const findingFiles = (finding: ReviewFinding): string[] => {
  const files = finding.files ?? []
  const evidenceFiles = finding.evidence
    .filter((item) => item.type === 'file_line')
    .map((item) => item.file)
  return Array.from(new Set([...files, ...evidenceFiles].map(normalizePath)))
}

const findingLines = (finding: ReviewFinding): Array<{ file: string; line: number }> =>
  finding.evidence
    .filter((item) => item.type === 'file_line')
    .map((item) => ({ file: normalizePath(item.file), line: item.line }))

const reviewItemsFromOutput = (output: ReviewOutputV2): ReviewItem[] => {
  const findings = output.findings.map((finding) => ({
    id: `finding:${finding.id}`,
    title: finding.title,
    text: `${finding.title}\n${finding.body}`,
    category: finding.category,
    files: findingFiles(finding),
    lines: findingLines(finding),
  }))

  const inlineComments = output.inlineComments.map((comment, index) => ({
    id: `inline:${index + 1}`,
    title: comment.body.split('\n')[0] ?? comment.body,
    text: comment.body,
    files: [normalizePath(comment.file)],
    lines: [{ file: normalizePath(comment.file), line: comment.line }],
  }))

  return [...findings, ...inlineComments]
}

const itemPrimaryFile = (item: ReviewItem): string | null =>
  item.lines[0]?.file ?? item.files[0] ?? null

const itemPrimaryLine = (item: ReviewItem): number | null => item.lines[0]?.line ?? null

const itemSummary = (item: ReviewItem): UnmatchedReviewItem => ({
  itemId: item.id,
  title: item.title,
  file: itemPrimaryFile(item),
  line: itemPrimaryLine(item),
})

const fileGlobMatches = (fileGlob: string | undefined, file: string | undefined): boolean => {
  if (!fileGlob) {
    return true
  }
  return file !== undefined && matchesGlob(fileGlob, file)
}

const lineMatches = (item: ReviewItem, expected: ExpectedFinding): boolean => {
  if (!expected.lineRange) {
    return true
  }

  const minLine = expected.lineRange.from - lineTolerance
  const maxLine = expected.lineRange.to + lineTolerance

  return item.lines.some(
    (line) =>
      fileGlobMatches(expected.fileGlob, line.file) && line.line >= minLine && line.line <= maxLine,
  )
}

const expectedMatchScore = (item: ReviewItem, expected: ExpectedFinding): number | null => {
  const fileMatches =
    expected.fileGlob === undefined
      ? item.files.length > 0
      : item.files.some((file) => fileGlobMatches(expected.fileGlob, file))
  const evidenceFileMatches = item.lines.some((line) =>
    fileGlobMatches(expected.fileGlob, line.file),
  )
  if (expected.fileGlob !== undefined && !fileMatches && !evidenceFileMatches) {
    return null
  }
  if (expected.category && item.category !== expected.category) {
    return null
  }
  if (!lineMatches(item, expected)) {
    return null
  }
  if (!safePattern(expected.pattern).test(item.text)) {
    return null
  }

  const lineScore = expected.lineRange
    ? Math.max(
        ...item.lines
          .filter((line) => fileGlobMatches(expected.fileGlob, line.file))
          .map((line) => {
            if (!expected.lineRange) {
              return 0
            }
            if (line.line >= expected.lineRange.from && line.line <= expected.lineRange.to) {
              return 30
            }
            return 30 - Math.min(lineTolerance, Math.abs(line.line - expected.lineRange.from))
          }),
      )
    : 0
  const categoryScore = expected.category ? 10 : 0
  const fileScore = fileMatches ? 5 : 0
  return 100 + lineScore + categoryScore + fileScore
}

const forbiddenMatchesItem = (item: ReviewItem, forbidden: ForbiddenFinding): boolean => {
  if (forbidden.fileGlob) {
    const hasFile = item.files.some((file) => matchesGlob(forbidden.fileGlob ?? '', file))
    const hasLineFile = item.lines.some((line) => matchesGlob(forbidden.fileGlob ?? '', line.file))
    if (!hasFile && !hasLineFile) {
      return false
    }
  }
  return safePattern(forbidden.pattern).test(item.text)
}

export const matchExpectedFindings = (
  output: ReviewOutputV2,
  expectedFindings: ExpectedFinding[],
): {
  matched: ReviewItemMatch[]
  missedExpected: string[]
  matchedItemIds: Set<string>
} => {
  const items = reviewItemsFromOutput(output)
  const pairs: ExpectedPair[] = []

  for (const [expectedIndex, expected] of expectedFindings.entries()) {
    for (const [itemIndex, item] of items.entries()) {
      const score = expectedMatchScore(item, expected)
      if (score !== null) {
        pairs.push({ expectedIndex, itemIndex, score })
      }
    }
  }

  pairs.sort(
    (left, right) =>
      right.score - left.score ||
      left.expectedIndex - right.expectedIndex ||
      left.itemIndex - right.itemIndex,
  )

  const usedExpected = new Set<number>()
  const usedItems = new Set<number>()
  const matched: ReviewItemMatch[] = []

  for (const pair of pairs) {
    if (usedExpected.has(pair.expectedIndex) || usedItems.has(pair.itemIndex)) {
      continue
    }
    usedExpected.add(pair.expectedIndex)
    usedItems.add(pair.itemIndex)
    const expected = expectedFindings[pair.expectedIndex]
    const item = items[pair.itemIndex]
    if (!expected || !item) {
      continue
    }
    matched.push({
      expectationId: expected.id,
      itemId: item.id,
      title: item.title,
      file: itemPrimaryFile(item),
      line: itemPrimaryLine(item),
    })
  }

  return {
    matched,
    missedExpected: expectedFindings
      .filter((_, index) => !usedExpected.has(index))
      .map((expected) => expected.id),
    matchedItemIds: new Set(matched.map((item) => item.itemId)),
  }
}

const uniqueCategories = (output: ReviewOutputV2): ReviewCategory[] =>
  Array.from(new Set(output.findings.map((finding) => finding.category)))

const countDiagnostics = (
  expectation: BenchmarkExpectation,
  output: PostStepOutput | ReviewOutputV2,
): CountDiagnostics => {
  const categories = uniqueCategories(output)
  const findingsRange = inRange(
    output.findings.length,
    expectation.minFindings,
    expectation.maxFindings,
  )
  const inlineRange = inRange(
    output.inlineComments.length,
    expectation.minInlineComments,
    expectation.maxInlineComments,
  )
  const skipped = 'skipped' in output ? output.skipped : 0
  const skippedInlineLimit =
    expectation.maxSkippedInline === undefined ? true : skipped <= expectation.maxSkippedInline
  const requiredCategories = expectation.requiredCategories ?? []
  const requiredCategoriesCheck =
    requiredCategories.length === 0
      ? true
      : requiredCategories.every((category) => categories.includes(category))

  return {
    checks: {
      findingsRange,
      inlineRange,
      skippedInlineLimit,
      requiredCategories: requiredCategoriesCheck,
    },
    findings: output.findings.length,
    inlineComments: output.inlineComments.length,
    skippedInline: skipped,
    categories,
  }
}

export const scoreReviewOutput = (
  expectation: BenchmarkExpectation,
  output: PostStepOutput | ReviewOutputV2,
): ReviewExpectationScore => {
  const expectedFindings = expectation.expectedFindings ?? []
  const forbiddenFindings = expectation.forbiddenFindings ?? []
  const { matched, missedExpected, matchedItemIds } = matchExpectedFindings(
    output,
    expectedFindings,
  )
  const items = reviewItemsFromOutput(output)
  const falsePositiveHits = items.flatMap((item) =>
    forbiddenFindings
      .filter((forbidden) => forbiddenMatchesItem(item, forbidden))
      .map((forbidden) => ({
        forbiddenId: forbidden.id,
        ...itemSummary(item),
      })),
  )
  const forbiddenItemIds = new Set(falsePositiveHits.map((hit) => hit.itemId))
  const unmatchedItems = items
    .filter((item) => !matchedItemIds.has(item.id) && !forbiddenItemIds.has(item.id))
    .map(itemSummary)
  const recall = expectedFindings.length === 0 ? 1 : matched.length / expectedFindings.length
  const diagnostics = countDiagnostics(expectation, output)
  const countChecksPassed = Object.values(diagnostics.checks).every(Boolean)

  return {
    recall,
    matchedExpected: matched.length,
    totalExpected: expectedFindings.length,
    falsePositiveHits,
    unmatchedItems,
    matched,
    missedExpected,
    diagnostics,
    passed: recall === 1 && falsePositiveHits.length === 0 && countChecksPassed,
  }
}

const scoreComparison = (
  expectation: BenchmarkExpectation,
  comparisonResult: ComparisonResult,
): HarnessBenchmarkScore | undefined => {
  if (!comparisonResult) {
    return undefined
  }
  if (comparisonResult.status !== 'success' || !comparisonResult.review) {
    return {
      ...scoreReviewOutput(expectation, {
        version: 'v2',
        assessment: 'needs_discussion',
        summary: 'comparison harness failed',
        findings: [],
        inlineComments: [],
        resolutionVerdicts: [],
      }),
      harness: 'comparison',
      comparisonHarness: comparisonResult.harness,
      comparisonStatus: comparisonResult.status,
      passed: false,
    }
  }
  return {
    ...scoreReviewOutput(expectation, comparisonResult.review),
    harness: 'comparison',
    comparisonHarness: comparisonResult.harness,
    comparisonStatus: comparisonResult.status,
  }
}

export const scoreBenchmarkCase = (
  testCase: BenchmarkCase,
  output: PostStepOutput,
): BenchmarkCaseScore => {
  const expectation = testCase.expectation ?? {}
  const primary = {
    ...scoreReviewOutput(expectation, output),
    harness: 'primary' as const,
  }
  const comparison = scoreComparison(expectation, output.comparisonResult)

  return {
    name: testCase.name,
    projectKey: testCase.projectKey,
    mrIid: testCase.mrIid,
    score: Math.round(primary.recall * 100),
    passed: primary.passed,
    checks: primary.diagnostics.checks,
    primary,
    comparison,
    output: {
      assessment: output.assessment,
      findings: output.findings.length,
      inlineComments: output.inlineComments.length,
      skippedInline: output.skipped,
      categories: primary.diagnostics.categories,
    },
  }
}
