import { Hono } from 'hono'
import type { AppConfig } from '@/config'
import { listReviewRuns } from '@/db/review-runs'
import { renderEvalsDashboardPage } from '@/server/evals-dashboard-render'

const MAX_LIMIT = 1000
const DEFAULT_LIMIT = 250

export const createEvalsDashboardRoute = (config: AppConfig): Hono => {
  const route = new Hono()

  route.get('/', async (c) => {
    const projectFilter = c.req.query('project') ?? null
    const rawLimit = Number.parseInt(c.req.query('limit') ?? '', 10)
    const limit = Number.isInteger(rawLimit)
      ? Math.min(Math.max(rawLimit, 1), MAX_LIMIT)
      : DEFAULT_LIMIT

    const runs = await listReviewRuns({
      projectKey: projectFilter || undefined,
      limit,
    })

    const html = renderEvalsDashboardPage({
      runs,
      projectFilter,
      knownProjects: [...config.projects.keys()].sort((a, b) => a.localeCompare(b)),
      limit,
      maxLimit: MAX_LIMIT,
    })

    c.header('Content-Type', 'text/html; charset=utf-8')
    return c.body(html)
  })

  return route
}
