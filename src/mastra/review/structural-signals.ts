import { existsSync, realpathSync, rmSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { cruise } from 'dependency-cruiser'
import extractDepcruiseOptions from 'dependency-cruiser/config-utl/extract-depcruise-options'
import type {
  ICruiseOptions,
  ICruiseResult,
  IReporterOutput,
  IRuleSummary,
} from 'dependency-cruiser'
import type { ReviewFileStat } from '@/mastra/review/context-package'
import { assertSafeGitRef, execGit } from '@/lib/exec'
import { toErrorMessage } from '@/lib/errors'

const DEFAULT_CRUISE_TIMEOUT_MS = 30_000
const DEFAULT_MAX_MODULES = 2_000
const DEFAULT_RENDER_MAX_CHARS = 4_000
const LARGE_FILE_LINE_THRESHOLD = 400
const LARGE_ADDED_LINE_THRESHOLD = 300
const FAN_IN_THRESHOLD = 10
const FAN_IN_LIMIT = 5
const RULE_VIOLATION_LIMIT = 10
const CYCLE_LIMIT = 8
const BROKEN_DOC_REFERENCE_LIMIT = 12
const QUALITY_GATE_WEAKENING_LIMIT = 12
const CRUISE_CONFIG_FILES = [
  '.dependency-cruiser.cjs',
  '.dependency-cruiser.js',
  '.dependency-cruiser.json',
]
const QUALITY_GATE_FILE_PATTERNS = [
  /^\.gitlab-ci\.yml$/,
  /^\.eslintrc(?:\..*)?$/,
  /^eslint\.config\..*$/,
  /^biome\.json.*$/,
  /^\.dependency-cruiser\..*$/,
  /^lefthook\.yml$/,
  /^scripts\/review\..*$/,
  /^knip\..*$/,
  /^tsconfig.*$/,
]
const QUALITY_GATE_WEAKENING_TOKENS = [
  'exclude',
  'ignore',
  'disable',
  'skip',
  'allow',
  '--max-warnings',
  'pathExclude',
]

export interface StructuralSignalsBudget {
  cruiseTimeoutMs?: number
  maxModules?: number
  renderMaxChars?: number
}

export interface CollectStructuralSignalsParams {
  worktreePath: string
  diffBaseRef: string
  changedFiles: string[]
  fileStats: ReviewFileStat[]
  budget?: StructuralSignalsBudget
}

export interface StructuralSignalDiagnostic {
  analyzer: 'generic' | 'dependency-cruiser'
  stage: string
  message: string
}

export interface StructuralCycleSignal {
  modules: string[]
}

export interface StructuralFanInSignal {
  file: string
  dependents: number
}

export interface StructuralRuleViolationSignal {
  ruleName: string
  severity: string
  comment: string | null
  from: string
  to: string | null
}

export interface StructuralSignals {
  generic: {
    fileSizeOutliers: Array<{ file: string; totalLines: number }>
    largeChangeConcentration: Array<{ file: string; added: number }>
    brokenDocReferences: Array<{ file: string; reference: string }>
    qualityGateWeakening: Array<{ file: string; token: string }>
    fileChangeSummary: {
      newFiles: number
      modifiedFiles: number
      deletedFiles: number
      renamedFiles: number
      otherFiles: number
    }
  }
  dependencyCruiser: {
    enabled: boolean
    skippedReason: string | null
    configSource: 'repo' | 'fallback' | null
    configPath: string | null
    headModuleCount: number | null
    baseModuleCount: number | null
    baseComparison: 'diff' | 'changed-files-fallback' | 'skipped'
    introducedCycles: StructuralCycleSignal[]
    changedFileCycles: StructuralCycleSignal[]
    fanIn: StructuralFanInSignal[]
    ruleViolations: StructuralRuleViolationSignal[]
  }
  diagnostics: StructuralSignalDiagnostic[]
}

interface CruiseConfig {
  options: ICruiseOptions
  source: 'repo' | 'fallback'
  path: string | null
  ruleComments: Map<string, string>
}

const emptySignals = (): StructuralSignals => ({
  generic: {
    fileSizeOutliers: [],
    largeChangeConcentration: [],
    brokenDocReferences: [],
    qualityGateWeakening: [],
    fileChangeSummary: {
      newFiles: 0,
      modifiedFiles: 0,
      deletedFiles: 0,
      renamedFiles: 0,
      otherFiles: 0,
    },
  },
  dependencyCruiser: {
    enabled: false,
    skippedReason: null,
    configSource: null,
    configPath: null,
    headModuleCount: null,
    baseModuleCount: null,
    baseComparison: 'skipped',
    introducedCycles: [],
    changedFileCycles: [],
    fanIn: [],
    ruleViolations: [],
  },
  diagnostics: [],
})

const normalizeModulePath = (value: string): string =>
  value.replaceAll('\\', '/').replace(/^\.\//, '')

const isInside = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

const resolveChangedPath = (worktreePath: string, file: string): string | null => {
  const absolute = resolve(worktreePath, file)
  return isInside(resolve(worktreePath), absolute) ? absolute : null
}

const realpathOrResolved = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

const normalizeCruisePath = (worktreePath: string, value: string): string => {
  const root = realpathOrResolved(resolve(worktreePath))
  const normalizedValue = normalizeModulePath(value)
  const normalizedRoot = normalizeModulePath(root).replace(/^\//, '')
  const embeddedRootIndex = normalizedValue.indexOf(`${normalizedRoot}/`)
  if (embeddedRootIndex >= 0) {
    return normalizedValue.slice(embeddedRootIndex + normalizedRoot.length + 1)
  }

  const currentRelativeAbsolute = realpathOrResolved(resolve(process.cwd(), value))
  if (isInside(root, currentRelativeAbsolute)) {
    return normalizeModulePath(relative(root, currentRelativeAbsolute))
  }

  const worktreeRelativeAbsolute = realpathOrResolved(resolve(root, value))
  if (isInside(root, worktreeRelativeAbsolute)) {
    return normalizeModulePath(relative(root, worktreeRelativeAbsolute))
  }

  return normalizeModulePath(value)
}

const normalizeCruiseResultPaths = (
  result: ICruiseResult,
  worktreePath: string,
): ICruiseResult => ({
  ...result,
  modules: result.modules.map((module) => ({
    ...module,
    source: normalizeCruisePath(worktreePath, module.source),
    dependents: module.dependents.map((dependent) => normalizeCruisePath(worktreePath, dependent)),
    dependencies: module.dependencies.map((dependency) => ({
      ...dependency,
      resolved: normalizeCruisePath(worktreePath, dependency.resolved),
      cycle: dependency.cycle?.map((entry) => ({
        ...entry,
        name: normalizeCruisePath(worktreePath, entry.name),
      })),
    })),
  })),
})

const lineCount = (contents: string): number => {
  if (contents.length === 0) {
    return 0
  }
  return contents.split(/\r\n|\r|\n/).length
}

const parseNameStatus = (output: string): StructuralSignals['generic']['fileChangeSummary'] => {
  const summary = {
    newFiles: 0,
    modifiedFiles: 0,
    deletedFiles: 0,
    renamedFiles: 0,
    otherFiles: 0,
  }

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (!line) {
      continue
    }
    const status = line.split('\t')[0] ?? ''
    if (status.startsWith('A')) {
      summary.newFiles += 1
    } else if (status.startsWith('M')) {
      summary.modifiedFiles += 1
    } else if (status.startsWith('D')) {
      summary.deletedFiles += 1
    } else if (status.startsWith('R')) {
      summary.renamedFiles += 1
    } else {
      summary.otherFiles += 1
    }
  }

  return summary
}

const stripReferenceSuffix = (reference: string): string => {
  const withoutHash = reference.split('#')[0] ?? ''
  return withoutHash.split('?')[0] ?? ''
}

const isExternalDocReference = (reference: string): boolean =>
  /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(reference) || reference.startsWith('//')

const markdownLinkReferences = (contents: string): string[] =>
  [...contents.matchAll(/\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)]
    .map((match) => match[1])
    .filter((reference): reference is string => Boolean(reference))

const inlineRepoPathReferences = (contents: string): string[] =>
  [
    ...contents.matchAll(
      /(?<![:\w.-])(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+(?:#[A-Za-z0-9_.-]+)?/g,
    ),
  ].map((match) => match[0])

const resolveDocReference = (
  worktreePath: string,
  file: string,
  reference: string,
): string | null => {
  if (isExternalDocReference(reference)) {
    return null
  }
  const stripped = stripReferenceSuffix(reference)
  if (!stripped || stripped.includes('*')) {
    return null
  }
  if (stripped.startsWith('/')) {
    return resolve(worktreePath, `.${stripped}`)
  }
  if (stripped.startsWith('./') || stripped.startsWith('../')) {
    return resolve(worktreePath, dirname(file), stripped)
  }
  return resolve(worktreePath, stripped)
}

const collectBrokenDocReferences = async (
  params: CollectStructuralSignalsParams,
  diagnostics: StructuralSignalDiagnostic[],
): Promise<Array<{ file: string; reference: string }>> => {
  const broken: Array<{ file: string; reference: string }> = []
  const seen = new Set<string>()
  for (const file of params.changedFiles.filter((changedFile) => changedFile.endsWith('.md'))) {
    const absolute = resolveChangedPath(params.worktreePath, file)
    if (!absolute || !existsSync(absolute)) {
      continue
    }
    try {
      const contents = await readFile(absolute, 'utf8')
      const references = [
        ...markdownLinkReferences(contents),
        ...inlineRepoPathReferences(contents),
      ]
      for (const reference of references) {
        const target = resolveDocReference(params.worktreePath, file, reference)
        if (!target || existsSync(target)) {
          continue
        }
        const key = `${file}\u0000${reference}`
        if (seen.has(key)) {
          continue
        }
        seen.add(key)
        broken.push({ file, reference })
        if (broken.length >= BROKEN_DOC_REFERENCE_LIMIT) {
          return broken
        }
      }
    } catch (error) {
      diagnostics.push({
        analyzer: 'generic',
        stage: 'doc-references',
        message: `${file}: ${toErrorMessage(error)}`,
      })
    }
  }
  return broken
}

const isQualityGateFile = (file: string): boolean =>
  QUALITY_GATE_FILE_PATTERNS.some((pattern) => pattern.test(normalizeModulePath(file)))

const parseQualityGateWeakening = (diff: string): Array<{ file: string; token: string }> => {
  const weakening: Array<{ file: string; token: string }> = []
  const seen = new Set<string>()
  let currentFile: string | null = null

  for (const line of diff.split('\n')) {
    const gitMatch = /^diff --git a\/(?:.+?) b\/(.+)$/.exec(line)
    if (gitMatch?.[1]) {
      currentFile = normalizeModulePath(gitMatch[1])
      continue
    }
    if (
      !currentFile ||
      !isQualityGateFile(currentFile) ||
      !line.startsWith('+') ||
      line.startsWith('+++')
    ) {
      continue
    }
    const lowerLine = line.toLowerCase()
    for (const token of QUALITY_GATE_WEAKENING_TOKENS) {
      if (!lowerLine.includes(token.toLowerCase())) {
        continue
      }
      const key = `${currentFile}\u0000${token}`
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      weakening.push({ file: currentFile, token })
      if (weakening.length >= QUALITY_GATE_WEAKENING_LIMIT) {
        return weakening
      }
    }
  }

  return weakening
}

const collectGenericSignals = async (
  params: CollectStructuralSignalsParams,
  diagnostics: StructuralSignalDiagnostic[],
): Promise<StructuralSignals['generic']> => {
  const fileSizeOutliers: Array<{ file: string; totalLines: number }> = []
  const brokenDocReferences = await collectBrokenDocReferences(params, diagnostics)
  const largeChangeConcentration = params.fileStats
    .filter((stat) => stat.added > LARGE_ADDED_LINE_THRESHOLD)
    .map((stat) => ({ file: stat.file, added: stat.added }))

  for (const file of params.changedFiles) {
    const absolute = resolveChangedPath(params.worktreePath, file)
    if (!absolute || !existsSync(absolute)) {
      continue
    }

    try {
      const totalLines = lineCount(await readFile(absolute, 'utf8'))
      if (totalLines > LARGE_FILE_LINE_THRESHOLD) {
        fileSizeOutliers.push({ file, totalLines })
      }
    } catch (error) {
      diagnostics.push({
        analyzer: 'generic',
        stage: 'line-count',
        message: `${file}: ${toErrorMessage(error)}`,
      })
    }
  }

  let fileChangeSummary = emptySignals().generic.fileChangeSummary
  let qualityGateWeakening: Array<{ file: string; token: string }> = []
  try {
    const safeBase = assertSafeGitRef(params.diffBaseRef, 'diff base ref')
    const [nameStatus, diff] = await Promise.all([
      execGit(['diff', '--name-status', `${safeBase}...HEAD`], params.worktreePath),
      execGit(['diff', `${safeBase}...HEAD`], params.worktreePath),
    ])
    fileChangeSummary = parseNameStatus(nameStatus)
    qualityGateWeakening = parseQualityGateWeakening(diff)
  } catch (error) {
    diagnostics.push({
      analyzer: 'generic',
      stage: 'name-status',
      message: toErrorMessage(error),
    })
  }

  return {
    fileSizeOutliers,
    largeChangeConcentration,
    brokenDocReferences,
    qualityGateWeakening,
    fileChangeSummary,
  }
}

const looksLikeJsTsProject = (worktreePath: string): boolean =>
  existsSync(resolve(worktreePath, 'package.json')) ||
  existsSync(resolve(worktreePath, 'tsconfig.json'))

const findCruiseConfigPath = (worktreePath: string): string | null => {
  for (const file of CRUISE_CONFIG_FILES) {
    const candidate = resolve(worktreePath, file)
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

interface NamedCruiseRule {
  name?: string
  comment?: string
}

const ruleName = (rule: NamedCruiseRule): string | null =>
  typeof rule.name === 'string' && rule.name.length > 0 ? rule.name : null

const buildRuleCommentMap = (rules: NamedCruiseRule[]): Map<string, string> => {
  const comments = new Map<string, string>()
  for (const rule of rules) {
    const name = ruleName(rule)
    if (name && typeof rule.comment === 'string' && rule.comment.length > 0) {
      comments.set(name, rule.comment)
    }
  }
  return comments
}

const loadCruiseConfig = async (worktreePath: string): Promise<CruiseConfig> => {
  const configPath = findCruiseConfigPath(worktreePath)
  if (configPath) {
    const options = await extractDepcruiseOptions(configPath)
    return {
      options: {
        ...options,
        baseDir: worktreePath,
        outputType: undefined,
        outputTo: undefined,
      },
      source: 'repo',
      path: normalizeModulePath(relative(worktreePath, configPath)),
      ruleComments: buildRuleCommentMap([
        ...(options.ruleSet?.forbidden ?? []),
        ...(options.ruleSet?.required ?? []),
        ...(options.ruleSet?.allowed ?? []),
      ]),
    }
  }

  const fallbackRule = {
    name: 'no-circular',
    comment: 'Circular dependencies make dependency direction harder to reason about.',
    severity: 'error' as const,
    from: {},
    to: {
      circular: true,
    },
  }

  return {
    options: {
      baseDir: worktreePath,
      validate: true,
      ruleSet: {
        forbidden: [fallbackRule],
      },
      doNotFollow: {
        path: '(^|/)node_modules/',
      },
      exclude:
        '(^|/)(node_modules|dist|build|coverage|\\.git|\\.next|\\.nuxt|\\.svelte-kit|\\.turbo|\\.cache|vendor)(/|$)',
      tsPreCompilationDeps: true,
    },
    source: 'fallback',
    path: null,
    ruleComments: buildRuleCommentMap([fallbackRule]),
  }
}

const reporterOutputToCruiseResult = (output: IReporterOutput): ICruiseResult => {
  if (typeof output.output === 'string') {
    return JSON.parse(output.output) as ICruiseResult
  }
  return output.output
}

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> => {
  let timer: Timer | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

const runCruise = async (
  worktreePath: string,
  config: CruiseConfig,
  timeoutMs: number,
): Promise<ICruiseResult> => {
  const result = await withTimeout(
    cruise(['.'], {
      ...config.options,
      baseDir: worktreePath,
      outputType: undefined,
      outputTo: undefined,
    }),
    timeoutMs,
    'dependency-cruiser',
  )
  return normalizeCruiseResultPaths(reporterOutputToCruiseResult(result), worktreePath)
}

const canonicalCycleModules = (modules: string[]): string[] => {
  const cleaned = modules.map(normalizeModulePath).filter(Boolean)
  const open =
    cleaned.length > 1 && cleaned[0] === cleaned[cleaned.length - 1]
      ? cleaned.slice(0, -1)
      : cleaned
  if (open.length <= 1) {
    return open
  }

  const rotations = open.map((_, index) => [...open.slice(index), ...open.slice(0, index)])
  const reversed = [...open].reverse()
  const reverseRotations = reversed.map((_, index) => [
    ...reversed.slice(index),
    ...reversed.slice(0, index),
  ])
  const sorted = [...rotations, ...reverseRotations]
    .map((cycle) => ({ cycle, key: cycle.join('\u0000') }))
    .sort((left, right) => left.key.localeCompare(right.key))
  return sorted[0]?.cycle ?? open
}

export const cycleKey = (cycle: StructuralCycleSignal): string =>
  canonicalCycleModules(cycle.modules).join('\u0000')

export const diffCycleSets = (
  headCycles: StructuralCycleSignal[],
  baseCycles: StructuralCycleSignal[],
): StructuralCycleSignal[] => {
  const baseKeys = new Set(baseCycles.map(cycleKey))
  return headCycles.filter((cycle) => !baseKeys.has(cycleKey(cycle)))
}

const cycleFromDependency = (
  source: string,
  resolved: string,
  cycle: Array<{ name: string }> | undefined,
): StructuralCycleSignal | null => {
  const modules = cycle && cycle.length > 0 ? cycle.map((entry) => entry.name) : [source, resolved]
  const canonical = canonicalCycleModules(modules)
  return canonical.length > 1 ? { modules: canonical } : null
}

export const extractCyclesFromCruiseResult = (result: ICruiseResult): StructuralCycleSignal[] => {
  const byKey = new Map<string, StructuralCycleSignal>()
  for (const module of result.modules) {
    for (const dependency of module.dependencies) {
      if (!dependency.circular) {
        continue
      }
      const cycle = cycleFromDependency(module.source, dependency.resolved, dependency.cycle)
      if (cycle) {
        byKey.set(cycleKey(cycle), cycle)
      }
    }
  }
  return [...byKey.values()].sort((left, right) => cycleKey(left).localeCompare(cycleKey(right)))
}

const changedFileSet = (changedFiles: string[]): Set<string> =>
  new Set(changedFiles.map(normalizeModulePath))

const cycleTouchesChangedFile = (cycle: StructuralCycleSignal, changed: Set<string>): boolean =>
  cycle.modules.some((module) => changed.has(normalizeModulePath(module)))

export const extractFanInSignals = (
  result: Pick<ICruiseResult, 'modules'>,
  changedFiles: string[],
  threshold = FAN_IN_THRESHOLD,
  limit = FAN_IN_LIMIT,
): StructuralFanInSignal[] => {
  const changed = changedFileSet(changedFiles)
  return result.modules
    .filter((module) => changed.has(normalizeModulePath(module.source)))
    .map((module) => ({
      file: normalizeModulePath(module.source),
      dependents: module.dependents.length,
    }))
    .filter((entry) => entry.dependents >= threshold)
    .sort(
      (left, right) => right.dependents - left.dependents || left.file.localeCompare(right.file),
    )
    .slice(0, limit)
}

const firstRule = (rules: IRuleSummary[] | undefined): IRuleSummary | null => rules?.[0] ?? null

export const extractRuleViolations = (
  result: ICruiseResult,
  changedFiles: string[],
  ruleComments: Map<string, string>,
): StructuralRuleViolationSignal[] => {
  const changed = changedFileSet(changedFiles)
  const violations = new Map<string, StructuralRuleViolationSignal>()

  for (const module of result.modules) {
    const moduleSource = normalizeModulePath(module.source)
    const moduleRule = firstRule(module.rules)
    if (moduleRule && changed.has(moduleSource)) {
      const violation = {
        ruleName: moduleRule.name,
        severity: moduleRule.severity,
        comment: ruleComments.get(moduleRule.name) ?? null,
        from: moduleSource,
        to: null,
      }
      violations.set(`${violation.ruleName}\u0000${violation.from}\u0000`, violation)
    }

    for (const dependency of module.dependencies) {
      const dependencyRule = firstRule(dependency.rules)
      const resolved = normalizeModulePath(dependency.resolved)
      if (!dependencyRule || (!changed.has(moduleSource) && !changed.has(resolved))) {
        continue
      }
      const violation = {
        ruleName: dependencyRule.name,
        severity: dependencyRule.severity,
        comment: ruleComments.get(dependencyRule.name) ?? null,
        from: moduleSource,
        to: resolved,
      }
      violations.set(`${violation.ruleName}\u0000${violation.from}\u0000${violation.to}`, violation)
    }
  }

  return [...violations.values()]
    .sort(
      (left, right) =>
        left.ruleName.localeCompare(right.ruleName) ||
        left.from.localeCompare(right.from) ||
        (left.to ?? '').localeCompare(right.to ?? ''),
    )
    .slice(0, RULE_VIOLATION_LIMIT)
}

const createBaseWorktree = async (worktreePath: string, diffBaseRef: string): Promise<string> => {
  const safeBase = assertSafeGitRef(diffBaseRef, 'diff base ref')
  const baseWorktree = await mkdtemp(resolve(tmpdir(), 'mend-structural-base-'))
  rmSync(baseWorktree, { recursive: true, force: true })
  await execGit(['worktree', 'add', '--detach', baseWorktree, safeBase], worktreePath)
  return baseWorktree
}

const removeBaseWorktree = async (
  headWorktreePath: string,
  baseWorktreePath: string,
  diagnostics: StructuralSignalDiagnostic[],
): Promise<void> => {
  try {
    await execGit(['worktree', 'remove', baseWorktreePath, '--force'], headWorktreePath)
  } catch (error) {
    diagnostics.push({
      analyzer: 'dependency-cruiser',
      stage: 'base-worktree-cleanup',
      message: toErrorMessage(error),
    })
    rmSync(baseWorktreePath, { recursive: true, force: true })
  }
}

const loadCruiseConfigOrDiagnostic = async (
  worktreePath: string,
  diagnostics: StructuralSignalDiagnostic[],
): Promise<CruiseConfig | null> => {
  try {
    return await loadCruiseConfig(worktreePath)
  } catch (error) {
    diagnostics.push({
      analyzer: 'dependency-cruiser',
      stage: 'config',
      message: toErrorMessage(error),
    })
    return null
  }
}

const runCruiseOrDiagnostic = async (params: {
  worktreePath: string
  config: CruiseConfig
  timeoutMs: number
  stage: string
  diagnostics: StructuralSignalDiagnostic[]
}): Promise<ICruiseResult | null> => {
  try {
    return await runCruise(params.worktreePath, params.config, params.timeoutMs)
  } catch (error) {
    params.diagnostics.push({
      analyzer: 'dependency-cruiser',
      stage: params.stage,
      message: toErrorMessage(error),
    })
    return null
  }
}

const truncateCruiseResult = (
  result: ICruiseResult,
  maxModules: number,
  stage: string,
  diagnostics: StructuralSignalDiagnostic[],
): ICruiseResult => {
  if (result.modules.length <= maxModules) {
    return result
  }

  diagnostics.push({
    analyzer: 'dependency-cruiser',
    stage,
    message: `module count ${result.modules.length} exceeded budget ${maxModules}; processing first ${maxModules}`,
  })
  return {
    ...result,
    modules: result.modules.slice(0, maxModules),
  }
}

const collectBaseCycles = async (params: {
  headWorktreePath: string
  diffBaseRef: string
  timeoutMs: number
  maxModules: number
  diagnostics: StructuralSignalDiagnostic[]
}): Promise<{
  cycles: StructuralCycleSignal[] | null
  moduleCount: number | null
  comparison: StructuralSignals['dependencyCruiser']['baseComparison']
}> => {
  let baseWorktree: string | null = null
  try {
    baseWorktree = await createBaseWorktree(params.headWorktreePath, params.diffBaseRef)
    const baseConfig = await loadCruiseConfig(baseWorktree)
    const rawBase = await runCruise(baseWorktree, baseConfig, params.timeoutMs)
    const base = truncateCruiseResult(rawBase, params.maxModules, 'base', params.diagnostics)
    return {
      cycles: extractCyclesFromCruiseResult(base),
      moduleCount: base.modules.length,
      comparison: 'diff',
    }
  } catch (error) {
    params.diagnostics.push({
      analyzer: 'dependency-cruiser',
      stage: 'base',
      message: toErrorMessage(error),
    })
    return {
      cycles: null,
      moduleCount: null,
      comparison: 'changed-files-fallback',
    }
  } finally {
    if (baseWorktree) {
      await removeBaseWorktree(params.headWorktreePath, baseWorktree, params.diagnostics)
    }
  }
}

const collectDependencyCruiserSignals = async (
  params: CollectStructuralSignalsParams,
  diagnostics: StructuralSignalDiagnostic[],
): Promise<StructuralSignals['dependencyCruiser']> => {
  const empty = emptySignals().dependencyCruiser
  if (!looksLikeJsTsProject(params.worktreePath)) {
    return {
      ...empty,
      skippedReason: 'root package.json or tsconfig.json not found',
    }
  }

  const config = await loadCruiseConfigOrDiagnostic(params.worktreePath, diagnostics)
  if (!config) {
    return {
      ...empty,
      enabled: true,
      skippedReason: 'config load failed',
    }
  }

  const timeoutMs = params.budget?.cruiseTimeoutMs ?? DEFAULT_CRUISE_TIMEOUT_MS
  const maxModules = params.budget?.maxModules ?? DEFAULT_MAX_MODULES
  const rawHead = await runCruiseOrDiagnostic({
    worktreePath: params.worktreePath,
    config,
    timeoutMs,
    stage: 'head',
    diagnostics,
  })
  if (!rawHead) {
    return {
      ...empty,
      enabled: true,
      skippedReason: 'head analysis failed',
      configSource: config.source,
      configPath: config.path,
    }
  }

  const head = truncateCruiseResult(rawHead, maxModules, 'head', diagnostics)
  const headCycles = extractCyclesFromCruiseResult(head)
  const base = await collectBaseCycles({
    headWorktreePath: params.worktreePath,
    diffBaseRef: params.diffBaseRef,
    timeoutMs,
    maxModules,
    diagnostics,
  })

  const changed = changedFileSet(params.changedFiles)
  const introducedCycles = base.cycles
    ? diffCycleSets(headCycles, base.cycles).slice(0, CYCLE_LIMIT)
    : []
  const changedFileCycles = base.cycles
    ? []
    : headCycles.filter((cycle) => cycleTouchesChangedFile(cycle, changed)).slice(0, CYCLE_LIMIT)

  return {
    enabled: true,
    skippedReason: null,
    configSource: config.source,
    configPath: config.path,
    headModuleCount: head.modules.length,
    baseModuleCount: base.moduleCount,
    baseComparison: base.comparison,
    introducedCycles,
    changedFileCycles,
    fanIn: extractFanInSignals(head, params.changedFiles),
    ruleViolations:
      config.source === 'repo'
        ? extractRuleViolations(head, params.changedFiles, config.ruleComments)
        : [],
  }
}

export const collectStructuralSignals = async (
  params: CollectStructuralSignalsParams,
): Promise<StructuralSignals> => {
  const signals = emptySignals()
  try {
    signals.generic = await collectGenericSignals(params, signals.diagnostics)
  } catch (error) {
    signals.diagnostics.push({
      analyzer: 'generic',
      stage: 'unexpected',
      message: toErrorMessage(error),
    })
  }

  try {
    signals.dependencyCruiser = await collectDependencyCruiserSignals(params, signals.diagnostics)
  } catch (error) {
    signals.diagnostics.push({
      analyzer: 'dependency-cruiser',
      stage: 'unexpected',
      message: toErrorMessage(error),
    })
  }

  return signals
}

const formatCycle = (cycle: StructuralCycleSignal): string =>
  `${cycle.modules.join(' -> ')} -> ${cycle.modules[0]}`

const pushBudgetedLine = (lines: string[], line: string, maxChars: number): boolean => {
  const next = [...lines, line].join('\n')
  if (next.length > maxChars) {
    return false
  }
  lines.push(line)
  return true
}

const hasNotableStructuralSignals = (signals: StructuralSignals): boolean =>
  signals.dependencyCruiser.introducedCycles.length > 0 ||
  signals.generic.brokenDocReferences.length > 0 ||
  signals.generic.qualityGateWeakening.length > 0 ||
  signals.dependencyCruiser.changedFileCycles.length > 0 ||
  signals.dependencyCruiser.ruleViolations.length > 0 ||
  signals.dependencyCruiser.fanIn.length > 0 ||
  signals.generic.fileSizeOutliers.length > 0 ||
  signals.generic.largeChangeConcentration.length > 0

const structuralSignalLines = (signals: StructuralSignals): string[] => [
  ...signals.dependencyCruiser.introducedCycles.map(
    (cycle) => `- Introduced dependency cycle: ${formatCycle(cycle)}`,
  ),
  ...signals.generic.brokenDocReferences.map(
    (reference) =>
      `- Broken doc reference: ${reference.file} references missing ${reference.reference}`,
  ),
  ...signals.generic.qualityGateWeakening.map(
    (weakening) =>
      `- This MR modifies its own quality gates: ${weakening.file} adds ${weakening.token} — verify the weakening is justified.`,
  ),
  ...signals.dependencyCruiser.changedFileCycles.map(
    (cycle) =>
      `- Dependency cycle involving changed files (base analysis unavailable; may pre-date this MR): ${formatCycle(cycle)}`,
  ),
  ...signals.dependencyCruiser.ruleViolations.map((violation) => {
    const target = violation.to ? ` -> ${violation.to}` : ''
    const comment = violation.comment ? `; rule comment: ${violation.comment}` : ''
    return `- Repo dependency rule ${violation.ruleName} (${violation.severity}): ${violation.from}${target}${comment}`
  }),
  ...signals.dependencyCruiser.fanIn.map(
    (fanIn) => `- Blast radius: ${fanIn.file} is imported by ${fanIn.dependents} modules.`,
  ),
  ...signals.generic.fileSizeOutliers.map(
    (outlier) => `- Size outlier: ${outlier.file} has ${outlier.totalLines} total lines.`,
  ),
  ...signals.generic.largeChangeConcentration.map(
    (concentration) =>
      `- Large-change concentration: ${concentration.file} adds ${concentration.added} lines.`,
  ),
]

export const renderStructuralSignals = (
  signals: StructuralSignals | null | undefined,
  maxChars = DEFAULT_RENDER_MAX_CHARS,
): string | null => {
  if (!signals) {
    return null
  }

  if (!hasNotableStructuralSignals(signals)) {
    return null
  }

  const lines = [
    '## Structural signals',
    '',
    "Computed by static analysis of this MR's worktree — treat as factual input; verify relevance before reporting.",
  ]

  for (const line of structuralSignalLines(signals)) {
    if (!pushBudgetedLine(lines, line, maxChars)) {
      return lines.join('\n')
    }
  }

  return lines.join('\n')
}
