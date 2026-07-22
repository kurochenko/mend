export interface Context7LookupInput {
  query: string
  library?: string
  limit?: number
  apiKey?: string
  signal?: AbortSignal
}

export interface Context7LookupResultItem {
  title: string
  url: string
  snippet: string
}

export interface Context7LookupResult {
  query: string
  library?: string
  libraryId: string
  count: number
  results: Context7LookupResultItem[]
}

interface Context7LibraryMatch {
  id: string
}

interface Context7DocRecord {
  title?: unknown
  content?: unknown
  snippet?: unknown
  source?: unknown
  url?: unknown
}

import { asRecord } from '@/lib/json'

const CONTEXT7_BASE_URL = 'https://context7.com'

const normalizeResult = (result: Context7DocRecord): Context7LookupResultItem => {
  const record = asRecord(result)
  return {
    title: typeof record.title === 'string' ? record.title : 'Untitled',
    url:
      typeof record.source === 'string'
        ? record.source
        : typeof record.url === 'string'
          ? record.url
          : '',
    snippet:
      typeof record.snippet === 'string'
        ? record.snippet
        : typeof record.content === 'string'
          ? record.content
          : '',
  }
}

const buildAuthHeaders = (apiKey?: string): Record<string, string> => {
  const headers: Record<string, string> = {}
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
  }
  return headers
}

const readResponseBody = async (response: Response): Promise<string> => {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

const resolveLibraryId = async (
  query: string,
  library: string | undefined,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<string> => {
  if (library?.startsWith('/')) {
    return library
  }

  const libraryName = library ?? query
  const searchUrl = new URL('/api/v2/libs/search', CONTEXT7_BASE_URL)
  searchUrl.searchParams.set('query', query)
  searchUrl.searchParams.set('libraryName', libraryName)

  const response = await fetch(searchUrl, { headers, signal })
  if (!response.ok) {
    const body = await readResponseBody(response)
    throw new Error(
      `Context7 library search failed: ${response.status} ${response.statusText} ${body}`,
    )
  }

  const payload = await response.json()
  const matches = Array.isArray(payload) ? (payload as Context7LibraryMatch[]) : []
  const first = matches[0]
  if (!first?.id || typeof first.id !== 'string') {
    throw new Error(`No Context7 library match found for "${libraryName}"`)
  }

  return first.id
}

const fetchContext = async (
  query: string,
  libraryId: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<Context7DocRecord[]> => {
  const contextUrl = new URL('/api/v2/context', CONTEXT7_BASE_URL)
  contextUrl.searchParams.set('query', query)
  contextUrl.searchParams.set('libraryId', libraryId)

  const response = await fetch(contextUrl, { headers, signal })
  if (!response.ok) {
    const body = await readResponseBody(response)
    throw new Error(
      `Context7 context fetch failed: ${response.status} ${response.statusText} ${body}`,
    )
  }

  const payload = await response.json()
  return Array.isArray(payload) ? (payload as Context7DocRecord[]) : []
}

export const lookupContext7 = async (input: Context7LookupInput): Promise<Context7LookupResult> => {
  const query = input.query.trim()
  if (!query) {
    throw new Error('Context7 query is required')
  }

  const limit = input.limit ?? 5
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`Invalid Context7 limit: ${String(input.limit)}`)
  }

  const apiKey = input.apiKey ?? process.env.CONTEXT7_API_KEY
  const headers = buildAuthHeaders(apiKey)
  const libraryId = await resolveLibraryId(query, input.library, headers, input.signal)
  const docs = await fetchContext(query, libraryId, headers, input.signal)
  const results = docs.map(normalizeResult).slice(0, limit)

  return {
    query,
    library: input.library,
    libraryId,
    count: results.length,
    results,
  }
}
