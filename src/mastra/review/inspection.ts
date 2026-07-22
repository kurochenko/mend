import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'
import type { ReviewAgentResult } from '@/agents/review-harness'
import { partitionReviewScopeFiles } from '@/mastra/review/file-filter'

const normalizeInspectedPath = (cwd: string, rawPath: string): string => {
  let normalized = rawPath.trim()
  if (!normalized) {
    return ''
  }

  if (isAbsolute(normalized)) {
    normalized = relative(cwd, normalized)
  }

  normalized = normalized.replaceAll('\\', '/').replace(/^\.\//, '')
  return normalized
}

export const extractInspectedFilesFromSession = (
  sessionFile: string | undefined,
  cwd: string,
): string[] => {
  if (!sessionFile || !existsSync(sessionFile)) {
    return []
  }

  const content = readFileSync(sessionFile, 'utf-8')
  const inspected = new Set<string>()

  for (const line of content.split('\n')) {
    if (!line.trim()) {
      continue
    }

    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }

    if (!event || typeof event !== 'object') {
      continue
    }

    const message = (event as { message?: unknown }).message
    if (!message || typeof message !== 'object') {
      continue
    }

    const role = (message as { role?: unknown }).role
    if (role !== 'assistant') {
      continue
    }

    const contentBlocks = (message as { content?: unknown }).content
    if (!Array.isArray(contentBlocks)) {
      continue
    }

    for (const block of contentBlocks) {
      if (!block || typeof block !== 'object') {
        continue
      }

      const typedBlock = block as {
        type?: unknown
        name?: unknown
        arguments?: {
          path?: unknown
          filePath?: unknown
        }
      }

      if (typedBlock.type !== 'toolCall' || typedBlock.name !== 'read') {
        continue
      }

      const rawPath =
        typeof typedBlock.arguments?.path === 'string'
          ? typedBlock.arguments.path
          : typeof typedBlock.arguments?.filePath === 'string'
            ? typedBlock.arguments.filePath
            : ''

      const normalizedPath = normalizeInspectedPath(cwd, rawPath)
      if (normalizedPath) {
        inspected.add(normalizedPath)
      }
    }
  }

  return [...inspected].sort((a, b) => a.localeCompare(b))
}

export const mergeUniqueSorted = (a: string[], b: string[]): string[] => {
  const merged = new Set<string>(a)
  for (const value of b) {
    merged.add(value)
  }
  return [...merged].sort((left, right) => left.localeCompare(right))
}

export interface EnforceFileInspectionInput {
  reviewResult: ReviewAgentResult
  worktreePath: string
  changedFiles: string[]
  prompt: string
  retryReview: (prompt: string) => Promise<ReviewAgentResult>
}

export interface EnforceFileInspectionResult {
  reviewResult: ReviewAgentResult
  inspectedFiles: string[]
  inspectedChangedFiles: string[]
  inspectedChangedFileCount: number
  inspectedChangedFileCoverage: number
  templateWarnings: string[]
}

const summarizeMissingFiles = (files: string[]): string => {
  const samples = files.slice(0, 12)
  const suffix = files.length > samples.length ? ', ...' : ''
  return `${samples.join(', ')}${suffix}`
}

export const enforceFileInspection = async (
  input: EnforceFileInspectionInput,
): Promise<EnforceFileInspectionResult> => {
  const { worktreePath, changedFiles, prompt, retryReview } = input
  let { reviewResult } = input
  const templateWarnings: string[] = []

  const { includedFiles: requiredChangedFiles, excludedFiles: excludedChangedFiles } =
    partitionReviewScopeFiles(changedFiles)

  if (excludedChangedFiles.length > 0) {
    const samples = excludedChangedFiles.slice(0, 6)
    const suffix = excludedChangedFiles.length > samples.length ? ', ...' : ''
    templateWarnings.push(
      `inspection excluded generated or lock files (${excludedChangedFiles.length}/${changedFiles.length}): ${samples.join(', ')}${suffix}`,
    )
  }

  const changedFileSet = new Set(requiredChangedFiles)
  let inspectedFiles = mergeUniqueSorted(
    reviewResult.inspectedFiles ?? [],
    extractInspectedFilesFromSession(reviewResult.sessionFile, worktreePath),
  )
  let inspectedChangedFiles = inspectedFiles.filter((file) => changedFileSet.has(file))
  let missingChangedFiles = requiredChangedFiles.filter(
    (file) => !inspectedChangedFiles.includes(file),
  )

  if (missingChangedFiles.length > 0) {
    templateWarnings.push(
      `inspection incomplete after pass 1: ${inspectedChangedFiles.length}/${requiredChangedFiles.length}; retrying`,
    )

    const retryPrompt = [
      prompt,
      '',
      'Inspection retry required.',
      'Please prioritize these changed files before final output if they are relevant to behavior, correctness, tests, or runtime/build/deploy impact:',
      ...missingChangedFiles.map((file) => `- ${file}`),
      '',
      'After reviewing any additional relevant files, provide the final JSON output again.',
    ].join('\n')

    const retryResult = await retryReview(retryPrompt)

    if (!retryResult.success) {
      templateWarnings.push(
        `inspection retry failed; proceeding with partial coverage (${inspectedChangedFiles.length}/${requiredChangedFiles.length}): ${retryResult.error}`,
      )
    } else {
      reviewResult = retryResult

      const retryInspectedFiles = mergeUniqueSorted(
        retryResult.inspectedFiles ?? [],
        extractInspectedFilesFromSession(retryResult.sessionFile, worktreePath),
      )
      inspectedFiles = mergeUniqueSorted(inspectedFiles, retryInspectedFiles)
      inspectedChangedFiles = inspectedFiles.filter((file) => changedFileSet.has(file))
      missingChangedFiles = requiredChangedFiles.filter(
        (file) => !inspectedChangedFiles.includes(file),
      )
    }
  }

  if (missingChangedFiles.length > 0) {
    templateWarnings.push(
      `inspection remained partial after retry (${inspectedChangedFiles.length}/${requiredChangedFiles.length}, total changed ${changedFiles.length}). Missing sample: ${summarizeMissingFiles(missingChangedFiles)}`,
    )
  }

  const inspectedChangedFileCount = inspectedChangedFiles.length
  const inspectedChangedFileCoverage =
    requiredChangedFiles.length === 0
      ? 1
      : Number((inspectedChangedFileCount / requiredChangedFiles.length).toFixed(3))

  return {
    reviewResult,
    inspectedFiles,
    inspectedChangedFiles,
    inspectedChangedFileCount,
    inspectedChangedFileCoverage,
    templateWarnings,
  }
}
