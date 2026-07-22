const LOCK_FILES = new Set(['bun.lock', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'])

const GENERATED_FILE_SUFFIX = /\.gen\.[a-z0-9]+$/i
const OPENAPI_SPEC_FILE = /^openapi\/.*\.(json|ya?ml)$/i
const SNAPSHOT_FILE = /(^|\/)(__snapshots__\/.*|.*\.snap)$/i

const normalizePath = (file: string): string =>
  file.trim().replaceAll('\\', '/').replace(/^\.\//, '')

export const isExcludedFromReviewScope = (file: string): boolean => {
  const normalized = normalizePath(file)
  if (!normalized) {
    return true
  }

  if (LOCK_FILES.has(normalized)) {
    return true
  }

  if (normalized.includes('/generated/') || normalized.startsWith('generated/')) {
    return true
  }

  if (GENERATED_FILE_SUFFIX.test(normalized)) {
    return true
  }

  if (OPENAPI_SPEC_FILE.test(normalized)) {
    return true
  }

  if (SNAPSHOT_FILE.test(normalized)) {
    return true
  }

  return false
}

export interface PartitionedReviewScopeFiles {
  includedFiles: string[]
  excludedFiles: string[]
}

export const partitionReviewScopeFiles = (files: string[]): PartitionedReviewScopeFiles => {
  const includedFiles: string[] = []
  const excludedFiles: string[] = []
  const seen = new Set<string>()

  for (const file of files) {
    const normalized = normalizePath(file)
    if (!normalized || seen.has(normalized)) {
      continue
    }
    seen.add(normalized)

    if (isExcludedFromReviewScope(normalized)) {
      excludedFiles.push(normalized)
    } else {
      includedFiles.push(normalized)
    }
  }

  return {
    includedFiles,
    excludedFiles,
  }
}
