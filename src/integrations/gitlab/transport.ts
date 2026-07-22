import type { ProjectConfig } from '@/config'
import { toErrorMessage } from '@/lib/errors'

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504])
const MAX_RETRIES = 3
const BASE_DELAY_MS = 1000
const DEFAULT_TIMEOUT_MS = 15_000

export interface GitLabApiOptions {
  maxRetries?: number
}

const retryDelay = (attempt: number, res: Response): number => {
  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after')
    if (retryAfter) {
      const seconds = Number(retryAfter)
      if (!Number.isNaN(seconds)) {
        return seconds * 1000
      }
    }
  }

  return BASE_DELAY_MS * 2 ** (attempt - 1)
}

const buildProjectApiUrl = (project: ProjectConfig, path: string): string => {
  const base = new URL(project.url).origin
  const encodedProjectId = encodeURIComponent(project.project_id)
  return `${base}/api/v4/projects/${encodedProjectId}${path}`
}

const buildGlobalApiUrl = (project: ProjectConfig, path: string): string => {
  const base = new URL(project.url).origin
  return `${base}/api/v4${path}`
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
      throw new Error(`GitLab API request timed out after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export const gitlabApi = async (
  project: ProjectConfig,
  path: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  options?: GitLabApiOptions,
): Promise<Response> => {
  const url = buildProjectApiUrl(project, path)
  const method = init?.method ?? 'GET'
  const maxRetries = options?.maxRetries ?? MAX_RETRIES

  const headers = {
    'PRIVATE-TOKEN': project.token,
    'Content-Type': 'application/json',
    ...init?.headers,
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response

    try {
      res = await fetchWithTimeout(url, { ...init, headers }, timeoutMs)
    } catch (error) {
      if (attempt === maxRetries) {
        throw new Error(`GitLab API request failed ${method} ${path}: ${toErrorMessage(error)}`)
      }
      const delay = BASE_DELAY_MS * 2 ** attempt
      await Bun.sleep(delay)
      continue
    }

    if (res.ok) {
      return res
    }

    if (!RETRYABLE_STATUSES.has(res.status) || attempt === maxRetries) {
      const body = await res.text()
      throw new Error(`GitLab API ${res.status} ${method} ${path}: ${body}`)
    }

    const delay = retryDelay(attempt + 1, res)
    await Bun.sleep(delay)
  }

  throw new Error('unreachable')
}

export const gitlabApiGlobal = async (
  project: ProjectConfig,
  path: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  options?: GitLabApiOptions,
): Promise<Response> => {
  const url = buildGlobalApiUrl(project, path)
  const method = init?.method ?? 'GET'
  const maxRetries = options?.maxRetries ?? MAX_RETRIES

  const headers = {
    'PRIVATE-TOKEN': project.token,
    'Content-Type': 'application/json',
    ...init?.headers,
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response

    try {
      res = await fetchWithTimeout(url, { ...init, headers }, timeoutMs)
    } catch (error) {
      if (attempt === maxRetries) {
        throw new Error(`GitLab API request failed ${method} ${path}: ${toErrorMessage(error)}`)
      }
      const delay = BASE_DELAY_MS * 2 ** attempt
      await Bun.sleep(delay)
      continue
    }

    if (res.ok) {
      return res
    }

    if (!RETRYABLE_STATUSES.has(res.status) || attempt === maxRetries) {
      const body = await res.text()
      throw new Error(`GitLab API ${res.status} ${method} ${path}: ${body}`)
    }

    const delay = retryDelay(attempt + 1, res)
    await Bun.sleep(delay)
  }

  throw new Error('unreachable')
}
