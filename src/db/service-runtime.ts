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

export const setServiceRuntimeMode = async (mode: ServiceRuntimeMode): Promise<void> => {
  const db = getDb()
  await db
    .insert(serviceRuntime)
    .values({
      id: RUNTIME_ID,
      mode,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: serviceRuntime.id,
      set: {
        mode,
        updatedAt: new Date(),
      },
    })
}
