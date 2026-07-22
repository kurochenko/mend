import { and, eq } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { mrStatusNotes } from '@/db/schema'

export type MrStatusNoteRecord = InferSelectModel<typeof mrStatusNotes>

type SyncAction = 'create' | 'update' | 'none'

const hashBody = (body: string): string => Bun.hash(body).toString(16)

export const getMrStatusNote = async (
  projectKey: string,
  mrIid: number,
): Promise<MrStatusNoteRecord | null> => {
  const db = getDb()
  const [row] = await db
    .select()
    .from(mrStatusNotes)
    .where(and(eq(mrStatusNotes.projectKey, projectKey), eq(mrStatusNotes.mrIid, mrIid)))
    .limit(1)

  return row ?? null
}

export const upsertDesiredMrStatusNote = async (params: {
  projectKey: string
  mrIid: number
  renderedBody: string
}): Promise<MrStatusNoteRecord> => {
  const db = getDb()
  const now = new Date()
  const renderedBodyHash = hashBody(params.renderedBody)
  const existing = await getMrStatusNote(params.projectKey, params.mrIid)

  if (!existing) {
    const [created] = await db
      .insert(mrStatusNotes)
      .values({
        id: crypto.randomUUID(),
        projectKey: params.projectKey,
        mrIid: params.mrIid,
        noteId: null,
        renderedBody: params.renderedBody,
        renderedBodyHash,
        syncAction: 'create',
        lastSyncedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()

    if (!created) {
      throw new Error(
        `Failed to create status note state for ${params.projectKey} MR !${params.mrIid}`,
      )
    }

    return created
  }

  const bodyChanged = existing.renderedBodyHash !== renderedBodyHash
  const syncAction: SyncAction = bodyChanged
    ? existing.noteId
      ? 'update'
      : 'create'
    : existing.noteId
      ? (existing.syncAction as SyncAction)
      : 'create'

  const [updated] = await db
    .update(mrStatusNotes)
    .set({
      renderedBody: params.renderedBody,
      renderedBodyHash,
      syncAction,
      updatedAt: now,
    })
    .where(eq(mrStatusNotes.id, existing.id))
    .returning()

  if (!updated) {
    throw new Error(
      `Failed to update status note state for ${params.projectKey} MR !${params.mrIid}`,
    )
  }

  return updated
}

export const markMrStatusNoteSynced = async (params: {
  id: string
  noteId: number
}): Promise<MrStatusNoteRecord> => {
  const db = getDb()
  const [updated] = await db
    .update(mrStatusNotes)
    .set({
      noteId: params.noteId,
      syncAction: 'none',
      lastSyncedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(mrStatusNotes.id, params.id))
    .returning()

  if (!updated) {
    throw new Error(`Failed to mark status note ${params.id} synced`)
  }

  return updated
}

export const markMrStatusNoteForCreate = async (id: string): Promise<MrStatusNoteRecord> => {
  const db = getDb()
  const [updated] = await db
    .update(mrStatusNotes)
    .set({
      noteId: null,
      syncAction: 'create',
      updatedAt: new Date(),
    })
    .where(eq(mrStatusNotes.id, id))
    .returning()

  if (!updated) {
    throw new Error(`Failed to mark status note ${id} for create`)
  }

  return updated
}
