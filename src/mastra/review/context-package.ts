import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, relative, resolve } from 'node:path'
import { assertSafeGitRef, execGit } from '@/lib/exec'
import { toErrorMessage } from '@/lib/errors'

export interface ReviewFileStat {
  file: string
  added: number
  deleted: number
}

export interface ReviewContextDiagnostic {
  analyzer: 'changed-symbol-callers' | 'tests-touching-changed-code'
  stage: string
  message: string
}

export interface ChangedSymbolCallerSite {
  file: string
  line: number
}

export interface ChangedSymbolCaller {
  file: string
  symbol: string
  sites: ChangedSymbolCallerSite[]
  hiddenSiteCount: number
}

export interface TestsTouchingChangedCode {
  testReferences: Array<{ testFile: string; references: string[] }>
  changedFilesWithoutTestReferences: string[]
}

export interface ReviewContextPackage {
  baseRef: string
  changedFiles: string[]
  fileStats: ReviewFileStat[]
  diffExcerpt: string
  diffTruncated: boolean
  diffIncompleteFiles: string[]
  maxDiffChars: number
  changedSymbolCallers: ChangedSymbolCaller[]
  testsTouchingChangedCode: TestsTouchingChangedCode | null
  diagnostics: ReviewContextDiagnostic[]
}

interface BuildContextOptions {
  worktreePath: string
  targetBranch: string
  baseRef?: string
  maxDiffChars?: number
  maxFiles?: number
}

const TS_JS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'])
const TEST_FILE_PATTERN = /(^|\/)__tests__\/|(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/
const EXPORT_SYMBOL_PATTERN =
  /^export\s+(?:const|function|class|interface|type)\s+([A-Za-z_$][\w$]*)/gm
const MAX_SYMBOLS = 30
const MAX_SYMBOL_SITES = 5
const MAX_SYMBOL_GREP_MATCHES = 40
const MAX_TEST_REFERENCES = 30

const normalizePath = (path: string): string => path.replaceAll('\\', '/').replace(/^\.\//, '')

const isTsJsFile = (file: string): boolean => TS_JS_EXTENSIONS.has(extname(file))

const looksLikeTsJsProject = (worktreePath: string): boolean =>
  existsSync(resolve(worktreePath, 'package.json')) ||
  existsSync(resolve(worktreePath, 'tsconfig.json'))

const resolveInsideWorktree = (worktreePath: string, file: string): string | null => {
  const root = resolve(worktreePath)
  const absolute = resolve(root, file)
  const rel = relative(root, absolute)
  if (rel === '' || rel.startsWith('..') || resolve(rel) === rel) {
    return null
  }
  return absolute
}

const extractExportedSymbols = async (
  worktreePath: string,
  changedFiles: string[],
  diagnostics: ReviewContextDiagnostic[],
): Promise<Array<{ file: string; symbol: string }>> => {
  const symbols: Array<{ file: string; symbol: string }> = []
  const seen = new Set<string>()

  for (const file of changedFiles) {
    if (symbols.length >= MAX_SYMBOLS || !isTsJsFile(file)) {
      continue
    }
    const absolute = resolveInsideWorktree(worktreePath, file)
    if (!absolute || !existsSync(absolute)) {
      continue
    }

    try {
      const contents = await readFile(absolute, 'utf8')
      for (const match of contents.matchAll(EXPORT_SYMBOL_PATTERN)) {
        const symbol = match[1]
        if (!symbol) {
          continue
        }
        const key = `${file}\u0000${symbol}`
        if (seen.has(key)) {
          continue
        }
        seen.add(key)
        symbols.push({ file, symbol })
        if (symbols.length >= MAX_SYMBOLS) {
          break
        }
      }
    } catch (error) {
      diagnostics.push({
        analyzer: 'changed-symbol-callers',
        stage: 'read-symbols',
        message: `${file}: ${toErrorMessage(error)}`,
      })
    }
  }

  return symbols
}

const parseGitGrepLine = (line: string): ChangedSymbolCallerSite | null => {
  const match = /^([^:\n]+):(\d+):/.exec(line)
  if (!match?.[1] || !match[2]) {
    return null
  }
  const lineNumber = Number.parseInt(match[2], 10)
  if (!Number.isFinite(lineNumber)) {
    return null
  }
  return { file: normalizePath(match[1]), line: lineNumber }
}

const gitGrepSymbol = async (
  worktreePath: string,
  symbol: string,
  excludedFiles: Set<string>,
  diagnostics: ReviewContextDiagnostic[],
): Promise<ChangedSymbolCallerSite[]> => {
  try {
    const pathOutput = await execGit(['grep', '-l', '-w', '-e', symbol, '--', '.'], worktreePath)
    const paths = pathOutput
      .split('\n')
      .map((line) => normalizePath(line.trim()))
      .filter((file) => file.length > 0 && !excludedFiles.has(file))
      .slice(0, MAX_SYMBOL_GREP_MATCHES)
    if (paths.length === 0) {
      return []
    }

    const output = await execGit(
      ['grep', '-n', '-w', '-m', '1', '-e', symbol, '--', ...paths],
      worktreePath,
    )
    return output
      .split('\n')
      .map((line) => parseGitGrepLine(line))
      .filter((site): site is ChangedSymbolCallerSite => site !== null)
  } catch (error) {
    const message = toErrorMessage(error)
    if (!message.includes('exit 1')) {
      diagnostics.push({
        analyzer: 'changed-symbol-callers',
        stage: 'git-grep',
        message: `${symbol}: ${message}`,
      })
    }
    return []
  }
}

export const collectChangedSymbolCallers = async (params: {
  worktreePath: string
  changedFiles: string[]
  diagnostics?: ReviewContextDiagnostic[]
}): Promise<ChangedSymbolCaller[]> => {
  const diagnostics = params.diagnostics ?? []
  if (!looksLikeTsJsProject(params.worktreePath)) {
    return []
  }

  const changed = new Set(params.changedFiles.map(normalizePath))
  const symbols = await extractExportedSymbols(
    params.worktreePath,
    params.changedFiles,
    diagnostics,
  )
  const callers: ChangedSymbolCaller[] = []

  for (const entry of symbols) {
    const sites = await gitGrepSymbol(params.worktreePath, entry.symbol, changed, diagnostics)
    const uniqueSites = new Map<string, ChangedSymbolCallerSite>()
    for (const site of sites) {
      uniqueSites.set(`${site.file}:${site.line}`, site)
    }
    const orderedSites = [...uniqueSites.values()].sort(
      (left, right) => left.file.localeCompare(right.file) || left.line - right.line,
    )
    if (orderedSites.length === 0) {
      continue
    }
    callers.push({
      ...entry,
      sites: orderedSites.slice(0, MAX_SYMBOL_SITES),
      hiddenSiteCount: Math.max(0, orderedSites.length - MAX_SYMBOL_SITES),
    })
  }

  return callers
}

const changedFileReferenceTokens = (file: string): string[] => {
  const normalized = normalizePath(file)
  const withoutExtension = normalized.replace(/\.[^.]+$/, '')
  const basename = withoutExtension.split('/').at(-1)
  return [
    ...new Set(
      [normalized, withoutExtension, basename].filter((value): value is string => Boolean(value)),
    ),
  ]
}

const collectTestFiles = async (
  worktreePath: string,
  diagnostics: ReviewContextDiagnostic[],
): Promise<string[]> => {
  try {
    const output = await execGit(['ls-files'], worktreePath)
    return output
      .split('\n')
      .map((line) => normalizePath(line.trim()))
      .filter((file) => file.length > 0 && TEST_FILE_PATTERN.test(file) && isTsJsFile(file))
  } catch (error) {
    diagnostics.push({
      analyzer: 'tests-touching-changed-code',
      stage: 'ls-files',
      message: toErrorMessage(error),
    })
    return []
  }
}

const buildSymbolsByFile = async (params: {
  worktreePath: string
  changedFiles: string[]
  symbols: ChangedSymbolCaller[]
  diagnostics: ReviewContextDiagnostic[]
}): Promise<Map<string, string[]>> => {
  const symbolsByFile = new Map<string, string[]>()
  for (const caller of params.symbols) {
    const current = symbolsByFile.get(caller.file) ?? []
    symbolsByFile.set(caller.file, [...current, caller.symbol])
  }
  for (const exported of await extractExportedSymbols(
    params.worktreePath,
    params.changedFiles,
    params.diagnostics,
  )) {
    const current = symbolsByFile.get(exported.file) ?? []
    if (!current.includes(exported.symbol)) {
      symbolsByFile.set(exported.file, [...current, exported.symbol])
    }
  }
  return symbolsByFile
}

const referencesForChangedFile = (
  contents: string,
  file: string,
  symbolTokens: string[],
): string[] => {
  const fileTokens = changedFileReferenceTokens(file)
  const matchedTokens = [...fileTokens, ...symbolTokens].filter((token) => contents.includes(token))
  if (matchedTokens.length === 0) {
    return []
  }
  return [file, ...symbolTokens.filter((symbol) => contents.includes(symbol))]
}

const collectTestReferencesFromContents = (params: {
  contents: string
  changedFiles: string[]
  symbolsByFile: Map<string, string[]>
}): { references: string[]; referencedFiles: string[] } => {
  const references = new Set<string>()
  const referencedFiles: string[] = []
  for (const file of params.changedFiles) {
    const matched = referencesForChangedFile(
      params.contents,
      file,
      params.symbolsByFile.get(file) ?? [],
    )
    if (matched.length === 0) {
      continue
    }
    referencedFiles.push(file)
    for (const reference of matched) {
      references.add(reference)
    }
  }
  return {
    references: [...references],
    referencedFiles,
  }
}

export const collectTestsTouchingChangedCode = async (params: {
  worktreePath: string
  changedFiles: string[]
  symbols: ChangedSymbolCaller[]
  diagnostics?: ReviewContextDiagnostic[]
}): Promise<TestsTouchingChangedCode | null> => {
  const diagnostics = params.diagnostics ?? []
  if (!looksLikeTsJsProject(params.worktreePath)) {
    return null
  }

  const changedFiles = params.changedFiles.filter(isTsJsFile).map(normalizePath)
  if (changedFiles.length === 0) {
    return null
  }

  const symbolsByFile = await buildSymbolsByFile({
    worktreePath: params.worktreePath,
    changedFiles,
    diagnostics,
    symbols: params.symbols,
  })

  const referencesByTest = new Map<string, Set<string>>()
  const referencedChangedFiles = new Set<string>()
  const testFiles = await collectTestFiles(params.worktreePath, diagnostics)

  for (const testFile of testFiles.slice(0, MAX_TEST_REFERENCES * 8)) {
    const absolute = resolveInsideWorktree(params.worktreePath, testFile)
    if (!absolute) {
      continue
    }
    try {
      const contents = await readFile(absolute, 'utf8')
      const testReferences = collectTestReferencesFromContents({
        contents,
        changedFiles,
        symbolsByFile,
      })
      if (testReferences.references.length > 0) {
        const references = referencesByTest.get(testFile) ?? new Set<string>()
        for (const reference of testReferences.references) {
          references.add(reference)
        }
        referencesByTest.set(testFile, references)
      }
      for (const file of testReferences.referencedFiles) {
        referencedChangedFiles.add(file)
      }
    } catch (error) {
      diagnostics.push({
        analyzer: 'tests-touching-changed-code',
        stage: 'read-test',
        message: `${testFile}: ${toErrorMessage(error)}`,
      })
    }
  }

  return {
    testReferences: [...referencesByTest.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .slice(0, MAX_TEST_REFERENCES)
      .map(([testFile, references]) => ({
        testFile,
        references: [...references].sort((left, right) => left.localeCompare(right)),
      })),
    changedFilesWithoutTestReferences: changedFiles.filter(
      (file) => !referencedChangedFiles.has(file),
    ),
  }
}

const collectRetrievalDiagnostics = (contextPackage: {
  changedSymbolCallers: ChangedSymbolCaller[]
  testsTouchingChangedCode: TestsTouchingChangedCode | null
  diagnostics: ReviewContextDiagnostic[]
}): void => {
  contextPackage.diagnostics.push({
    analyzer: 'changed-symbol-callers',
    stage: 'summary',
    message: `${contextPackage.changedSymbolCallers.length} changed symbols with external callers`,
  })
  if (contextPackage.testsTouchingChangedCode) {
    contextPackage.diagnostics.push({
      analyzer: 'tests-touching-changed-code',
      stage: 'summary',
      message: `${contextPackage.testsTouchingChangedCode.testReferences.length} tests, ${contextPackage.testsTouchingChangedCode.changedFilesWithoutTestReferences.length} changed files without test references`,
    })
  }
}

const parseNumstat = (value: string): ReviewFileStat[] => {
  if (!value) {
    return []
  }

  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [rawAdded, rawDeleted, ...rest] = line.split('\t')
      const file = rest.join('\t')
      const added = rawAdded === '-' ? 0 : Number.parseInt(rawAdded ?? '0', 10)
      const deleted = rawDeleted === '-' ? 0 : Number.parseInt(rawDeleted ?? '0', 10)
      return {
        file,
        added: Number.isFinite(added) ? added : 0,
        deleted: Number.isFinite(deleted) ? deleted : 0,
      }
    })
}

const parseDiffSections = (diff: string): Array<{ file: string; start: number; end: number }> => {
  const matches = Array.from(diff.matchAll(/^diff --git a\/(?:.+?) b\/(.+)$/gm))

  return matches.map((match, index) => ({
    file: match[1] ?? '',
    start: match.index ?? 0,
    end: matches[index + 1]?.index ?? diff.length,
  }))
}

const findDiffIncompleteFiles = (
  diff: string,
  changedFiles: string[],
  maxDiffChars: number,
): string[] => {
  if (diff.length <= maxDiffChars) {
    return []
  }

  const sections = parseDiffSections(diff)
  if (sections.length === 0) {
    return changedFiles
  }

  const incomplete = new Set<string>()
  for (const file of changedFiles) {
    const section = sections.find((candidate) => candidate.file === file)
    if (!section || section.end > maxDiffChars) {
      incomplete.add(file)
    }
  }

  return [...incomplete]
}

export const buildReviewContextPackage = async (
  options: BuildContextOptions,
): Promise<ReviewContextPackage> => {
  const maxDiffChars = options.maxDiffChars ?? 48_000
  const maxFiles = options.maxFiles ?? 300
  const baseRef = assertSafeGitRef(options.baseRef ?? options.targetBranch, 'diff base ref')
  const base = `${baseRef}...HEAD`

  const [nameOnlyOut, numstatOut, fullDiffOut] = await Promise.all([
    execGit(['diff', '--name-only', base], options.worktreePath),
    execGit(['diff', '--numstat', base], options.worktreePath),
    execGit(['diff', base], options.worktreePath),
  ])

  const fileStats = parseNumstat(numstatOut).slice(0, maxFiles)
  const changedFiles = (
    nameOnlyOut
      ? nameOnlyOut
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      : fileStats.map((entry) => entry.file)
  ).slice(0, maxFiles)

  const diffTruncated = fullDiffOut.length > maxDiffChars
  const diffExcerpt = diffTruncated ? fullDiffOut.slice(0, maxDiffChars) : fullDiffOut
  const diffIncompleteFiles = findDiffIncompleteFiles(fullDiffOut, changedFiles, maxDiffChars)
  const diagnostics: ReviewContextDiagnostic[] = []
  let changedSymbolCallers: ChangedSymbolCaller[] = []
  let testsTouchingChangedCode: TestsTouchingChangedCode | null = null

  try {
    changedSymbolCallers = await collectChangedSymbolCallers({
      worktreePath: options.worktreePath,
      changedFiles,
      diagnostics,
    })
  } catch (error) {
    diagnostics.push({
      analyzer: 'changed-symbol-callers',
      stage: 'unexpected',
      message: toErrorMessage(error),
    })
  }

  try {
    testsTouchingChangedCode = await collectTestsTouchingChangedCode({
      worktreePath: options.worktreePath,
      changedFiles,
      symbols: changedSymbolCallers,
      diagnostics,
    })
  } catch (error) {
    diagnostics.push({
      analyzer: 'tests-touching-changed-code',
      stage: 'unexpected',
      message: toErrorMessage(error),
    })
  }

  collectRetrievalDiagnostics({
    changedSymbolCallers,
    testsTouchingChangedCode,
    diagnostics,
  })

  return {
    baseRef,
    changedFiles,
    fileStats,
    diffExcerpt,
    diffTruncated,
    diffIncompleteFiles,
    maxDiffChars,
    changedSymbolCallers,
    testsTouchingChangedCode,
    diagnostics,
  }
}
