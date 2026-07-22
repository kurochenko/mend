import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { closeDb, getDb, initDb } from '@/db/client'
import { setServiceRuntimeMode } from '@/db/service-runtime'

export const connectTestDb = async (databaseUrl: string): Promise<void> => {
  await initDb(databaseUrl)
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
}

export const truncateReviewFlowTables = async (): Promise<void> => {
  await getDb().execute(sql`
    TRUNCATE TABLE
      review_memory_events,
      review_memory_entries,
      review_findings,
      review_messages,
      review_threads,
      mr_fix_batches,
      mr_status_notes,
      mr_review_queue,
      review_runs,
      service_runtime
    RESTART IDENTITY CASCADE
  `)
  await setServiceRuntimeMode('running')
}

export const disconnectTestDb = async (): Promise<void> => {
  await closeDb()
}
