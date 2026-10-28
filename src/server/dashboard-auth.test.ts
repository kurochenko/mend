import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { createDashboardAuth } from '@/server/dashboard-auth'

const TOKEN = 'a-dashboard-token-that-is-long-enough'

const makeApp = (token: string | undefined) => {
  const app = new Hono()
  app.use('/evals/*', createDashboardAuth(token))
  app.get('/evals', (c) => c.text('dashboard'))
  return app
}

const basic = (username: string, password: string): string =>
  `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`

describe('createDashboardAuth', () => {
  it('hides dashboards when no token is configured', async () => {
    const response = await makeApp(undefined).request('/evals', {
      headers: { authorization: basic('mend', '') },
    })
    expect(response.status).toBe(404)
  })

  it('challenges requests without valid credentials', async () => {
    const app = makeApp(TOKEN)
    for (const authorization of [
      undefined,
      basic('mend', 'wrong'),
      `Bearer wrong`,
      `Basic not-base64-with-colon`,
    ]) {
      const response = await app.request('/evals', {
        headers: authorization ? { authorization } : {},
      })
      expect(response.status).toBe(401)
      expect(response.headers.get('www-authenticate')).toContain('Basic realm="Mend"')
    }
  })

  it('serves dashboards for the configured token over basic or bearer auth', async () => {
    const app = makeApp(TOKEN)
    for (const authorization of [basic('anyone', TOKEN), `Bearer ${TOKEN}`]) {
      const response = await app.request('/evals', { headers: { authorization } })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('dashboard')
    }
  })
})
