import { eq } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { serviceRuntime } from '@/db/schema'

export type ServiceRuntimeRecord = InferSelectModel<typeof serviceRuntime>
export type ServiceRuntimeMode = ServiceRuntimeRecord['mode']

const RUNTIME_ID = 'singleton'

export const getServiceRuntimeMode = async (): Promise<ServiceRuntimeMode> => {
  const db = getDb()
  const [row] = await db
    .select({ mode: serviceRuntime.mode })
    .from(serviceRuntime)
    .where(eq(serviceRuntime.id, RUNTIME_ID))
    .limit(1)

  return row?.mode ?? 'running'
}

export type ServiceDrainOwner = 'operator'

export const setServiceRuntimeMode = async (
  mode: ServiceRuntimeMode,
  drainedBy: ServiceDrainOwner | null = null,
): Promise<void> => {
  const db = getDb()
  const values = { mode, drainedBy: mode === 'draining' ? drainedBy : null, updatedAt: new Date() }
  await db
    .insert(serviceRuntime)
    .values({ id: RUNTIME_ID, ...values })
    .onConflictDoUpdate({ target: serviceRuntime.id, set: values })
}

export const clearLeftoverShutdownDrain = async (): Promise<boolean> => {
  const db = getDb()
  const [row] = await db
    .select({ mode: serviceRuntime.mode, drainedBy: serviceRuntime.drainedBy })
    .from(serviceRuntime)
    .where(eq(serviceRuntime.id, RUNTIME_ID))
    .limit(1)
  if (row?.mode !== 'draining' || row.drainedBy === 'operator') {
    return false
  }
  await setServiceRuntimeMode('running')
  return true
}
