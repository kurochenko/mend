import { Hono } from 'hono'
import { listImprovementProposals } from '@/db/improvement-proposals'
import { renderImprovementsDashboardPage } from '@/server/improvements-dashboard-render'

export const createImprovementsDashboardRoute = (): Hono => {
  const route = new Hono()

  route.get('/', async (c) => {
    const proposals = await listImprovementProposals({})
    const html = renderImprovementsDashboardPage({ proposals })
    c.header('Content-Type', 'text/html; charset=utf-8')
    return c.body(html)
  })

  return route
}
