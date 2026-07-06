import type { GitHubProjectConfig } from '@/config'
import { ProviderApiError } from '@/integrations/provider/error'
import { toErrorMessage } from '@/lib/errors'

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504])
const MAX_RETRIES = 3
const BASE_DELAY_MS = 1000
const DEFAULT_TIMEOUT_MS = 15_000

export interface GitHubApiOptions {
  maxRetries?: number
}

export const githubApiBase = (project: GitHubProjectConfig): string => {
  const url = new URL(project.url)
  if (url.hostname === 'github.com') {
    return 'https://api.github.com'
  }

  return `${url.origin}/api/v3`
}

export const githubGraphqlBase = (project: GitHubProjectConfig): string => {
  const url = new URL(project.url)
  if (url.hostname === 'github.com') {
    return 'https://api.github.com/graphql'
  }

  return `${url.origin}/api/graphql`
}

export const splitRepo = (repo: string): { owner: string; name: string } => {
  const [owner, name] = repo.split('/')
  if (!owner || !name) {
    throw new Error(`Invalid GitHub repo: ${repo}`)
  }

  return { owner, name }
}

const retryDelay = (attempt: number, res: Response): number => {
  const retryAfter = res.headers.get('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (!Number.isNaN(seconds)) {
      return seconds * 1000
    }
  }

  return BASE_DELAY_MS * 2 ** (attempt - 1)
}

const isRetryable = (res: Response): boolean => {
  if (RETRYABLE_STATUSES.has(res.status)) {
    return true
  }

  return (
    res.status === 403 &&
    (res.headers.has('retry-after') || res.headers.get('x-ratelimit-remaining') === '0')
  )
}

const fetchWithTimeout = async (
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`GitHub API request timed out after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export const githubApi = async (
  project: GitHubProjectConfig,
  path: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  options?: GitHubApiOptions,
): Promise<Response> => {
  const url = `${githubApiBase(project)}${path}`
  const method = init?.method ?? 'GET'
  const maxRetries = options?.maxRetries ?? MAX_RETRIES
  const headers = {
    Authorization: `Bearer ${project.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    ...init?.headers,
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response

    try {
      res = await fetchWithTimeout(url, { ...init, headers }, timeoutMs)
    } catch (error) {
      if (attempt === maxRetries) {
        throw new Error(`GitHub API request failed ${method} ${path}: ${toErrorMessage(error)}`)
      }
      await Bun.sleep(BASE_DELAY_MS * 2 ** attempt)
      continue
    }

    if (res.ok) {
      return res
    }

    if (!isRetryable(res) || attempt === maxRetries) {
      const body = await res.text()
      throw new ProviderApiError({
        message: `GitHub API ${res.status} ${method} ${path}: ${body}`,
        status: res.status,
        method,
      })
    }

    await Bun.sleep(retryDelay(attempt + 1, res))
  }

  throw new Error('unreachable')
}

export const githubPaginated = async <T>(
  project: GitHubProjectConfig,
  path: string,
  parse: (value: unknown) => T[],
): Promise<T[]> => {
  const out: T[] = []
  let nextPath: string | null = path

  while (nextPath) {
    const res = await githubApi(project, nextPath)
    out.push(...parse(await res.json()))
    const link = res.headers.get('link')
    const next = link
      ?.split(',')
      .map((part) => part.trim())
      .find((part) => part.includes('rel="next"'))
    const match = next?.match(/<([^>]+)>/)
    nextPath = match ? `${new URL(match[1]!).pathname}${new URL(match[1]!).search}` : null
  }

  return out
}
