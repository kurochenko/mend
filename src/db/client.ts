import { sql } from 'drizzle-orm'
import postgres, { type Sql } from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'

import { toErrorMessage } from '@/lib/errors'

let sqlClient: Sql | null = null
let db: ReturnType<typeof drizzle> | null = null

export const initDb = async (connectionString: string): Promise<void> => {
  if (db) throw new Error('Database already initialized')
  sqlClient = postgres(connectionString)
  db = drizzle(sqlClient)
  try {
    await db.execute(sql`SELECT 1`)
  } catch (error) {
    const reason = toErrorMessage(error)
    sqlClient = null
    db = null
    throw new Error(`Database connection failed: ${reason}`)
  }
}

export const getDb = () => {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.')
  }
  return db
}

export const closeDb = async (): Promise<void> => {
  if (!sqlClient) {
    return
  }

  await sqlClient.end()
  sqlClient = null
  db = null
}
