import { createHash, timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'

const digest = (value: string): Buffer => createHash('sha256').update(value).digest()

const presentedSecret = (authorization: string | undefined): string | null => {
  const [scheme, credentials] = authorization?.split(' ', 2) ?? []
  if (!credentials) {
    return null
  }
  if (scheme?.toLowerCase() === 'bearer') {
    return credentials
  }
  if (scheme?.toLowerCase() === 'basic') {
    const decoded = Buffer.from(credentials, 'base64').toString('utf8')
    const separator = decoded.indexOf(':')
    return separator === -1 ? null : decoded.slice(separator + 1)
  }
  return null
}

export const createDashboardAuth =
  (token: string | undefined): MiddlewareHandler =>
  async (c, next) => {
    if (!token) {
      return c.text('Not Found', 404)
    }
    const secret = presentedSecret(c.req.header('authorization'))
    if (!secret || !timingSafeEqual(digest(secret), digest(token))) {
      c.header('WWW-Authenticate', 'Basic realm="Mend", charset="UTF-8"')
      return c.text('Unauthorized', 401)
    }
    await next()
  }
