import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { closeDb, getDb, initDb } from '@/db/client'
import { serviceRuntime } from '@/db/schema'
import {
  clearLeftoverShutdownDrain,
  getServiceRuntimeMode,
  setServiceRuntimeMode,
} from '@/db/service-runtime'

const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? ''

describe.skipIf(testDatabaseUrl === '')('service runtime drains', () => {
  beforeAll(async () => {
    await initDb(testDatabaseUrl)
  })

  beforeEach(async () => {
    await getDb().delete(serviceRuntime)
  })

  afterAll(async () => {
    await getDb().delete(serviceRuntime)
    await closeDb()
  })

  test('clears a drain left by a shutdown that did not record an owner', async () => {
    await getDb()
      .insert(serviceRuntime)
      .values({ id: 'singleton', mode: 'draining', updatedAt: new Date() })

    expect(await clearLeftoverShutdownDrain()).toBe(true)
    expect(await getServiceRuntimeMode()).toBe('running')
  })

  test('keeps an operator drain across restarts until resumed', async () => {
    await setServiceRuntimeMode('draining', 'operator')

    expect(await clearLeftoverShutdownDrain()).toBe(false)
    expect(await getServiceRuntimeMode()).toBe('draining')

    await setServiceRuntimeMode('running')
    await setServiceRuntimeMode('draining')
    expect(await clearLeftoverShutdownDrain()).toBe(true)
  })

  test('does nothing while the service is running', async () => {
    await setServiceRuntimeMode('running')

    expect(await clearLeftoverShutdownDrain()).toBe(false)
  })
})
