import { toErrorMessage } from '@/lib/errors'
import { assertSafeGitRef, execGit } from '@/lib/exec'

export type DiffBaseParams = {
  worktreePath: string
  reviewMode: 'initial' | 'update'
  previousReviewedSha: string | null
  targetBranch: string
  diffRefs: {
    base_sha: string
    head_sha: string
    start_sha: string
  }
}

export type DiffBaseResult = {
  baseRef: string
  warnings: string[]
}

const refExists = async (cwd: string, ref: string): Promise<boolean> => {
  try {
    await execGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd)
    return true
  } catch {
    return false
  }
}

const fetchOrigin = async (cwd: string): Promise<void> => {
  await execGit(['fetch', 'origin', '--prune'], cwd)
}

const isAncestor = async (
  cwd: string,
  ancestorRef: string,
  descendantRef: string,
): Promise<boolean> => {
  if (!(await refExists(cwd, ancestorRef)) || !(await refExists(cwd, descendantRef))) {
    return false
  }

  try {
    await execGit(['merge-base', '--is-ancestor', ancestorRef, descendantRef], cwd)
    return true
  } catch {
    return false
  }
}

const dedupeRefs = (refs: string[]): string[] => {
  const out: string[] = []
  const seen = new Set<string>()
  for (const ref of refs) {
    const trimmed = ref.trim()
    if (!trimmed || seen.has(trimmed)) {
      continue
    }
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

const sanitizeCandidates = (refs: string[]): { valid: string[]; warnings: string[] } => {
  const valid: string[] = []
  const warnings: string[] = []

  for (const candidate of refs) {
    try {
      valid.push(assertSafeGitRef(candidate, 'diff-base candidate'))
    } catch (error) {
      const message = toErrorMessage(error)
      warnings.push(`ignored invalid diff-base candidate "${candidate}": ${message}`)
    }
  }

  return { valid, warnings }
}

export const resolveDiffBaseRef = async (params: DiffBaseParams): Promise<DiffBaseResult> => {
  const rawCandidates = dedupeRefs([
    params.diffRefs.start_sha,
    params.diffRefs.base_sha,
    params.targetBranch,
  ])
  const { valid: candidates, warnings } = sanitizeCandidates(rawCandidates)

  if (params.reviewMode === 'update' && params.previousReviewedSha) {
    const previousReviewedSha = params.previousReviewedSha
    try {
      const safePreviousReviewedSha = assertSafeGitRef(previousReviewedSha, 'previous reviewed SHA')
      const safeHeadSha = assertSafeGitRef(params.diffRefs.head_sha, 'MR head SHA')

      if (await isAncestor(params.worktreePath, safePreviousReviewedSha, safeHeadSha)) {
        candidates.unshift(safePreviousReviewedSha)
      } else {
        warnings.push(
          `previous reviewed SHA ${safePreviousReviewedSha} is not an ancestor of MR head ${safeHeadSha}; using MR diff refs instead`,
        )
      }
    } catch (error) {
      warnings.push(
        `ignored invalid previous reviewed SHA "${previousReviewedSha}": ${toErrorMessage(error)}`,
      )
    }
  }

  if (candidates.length === 0) {
    throw new Error('Unable to resolve diff base ref: no valid candidates')
  }

  for (const candidate of candidates) {
    if (await refExists(params.worktreePath, candidate)) {
      if (candidate !== candidates[0]) {
        warnings.push(`diff base fallback used: selected ${candidate} (preferred ${candidates[0]})`)
      }
      return { baseRef: candidate, warnings }
    }
  }

  warnings.push('diff base refs missing locally, fetching origin --prune before retry')
  await fetchOrigin(params.worktreePath)

  for (const candidate of candidates) {
    if (await refExists(params.worktreePath, candidate)) {
      if (candidate !== candidates[0]) {
        warnings.push(
          `diff base fallback used after fetch: selected ${candidate} (preferred ${candidates[0]})`,
        )
      }
      return { baseRef: candidate, warnings }
    }
  }

  throw new Error(`Unable to resolve diff base ref from candidates: ${candidates.join(', ')}`)
}
