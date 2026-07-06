import {
  markMrStatusNoteForCreate,
  markMrStatusNoteSynced,
  upsertDesiredMrStatusNote,
} from '@/db/status-notes'
import { ProviderApiError } from '@/integrations/provider/error'
import type { ReviewProvider } from '@/integrations/provider/client'
import { toErrorMessage } from '@/lib/errors'
import { buildStatusNoteBody, STATUS_MARKER, type StatusNoteInput } from '@/server/status-note-body'

export interface StatusNoteSyncDependencies {
  provider: ReviewProvider
  buildStatusNoteBody: typeof buildStatusNoteBody
  upsertDesiredMrStatusNote: typeof upsertDesiredMrStatusNote
  markMrStatusNoteSynced: typeof markMrStatusNoteSynced
  markMrStatusNoteForCreate: typeof markMrStatusNoteForCreate
}

type StatusNoteSyncDependencyInput = Pick<StatusNoteSyncDependencies, 'provider'> &
  Partial<Omit<StatusNoteSyncDependencies, 'provider'>>

const defaultDependencies: Omit<StatusNoteSyncDependencies, 'provider'> = {
  buildStatusNoteBody,
  upsertDesiredMrStatusNote,
  markMrStatusNoteSynced,
  markMrStatusNoteForCreate,
}

const isRecoverableStatusNoteUpdateFailure = (error: unknown): boolean => {
  return (
    error instanceof ProviderApiError &&
    error.method === 'PUT' &&
    (error.status === 404 || error.status === 403)
  )
}

export const listExistingStatusNotes = async (
  provider: ReviewProvider,
  mrIid: number,
): Promise<Array<{ id: number }>> => {
  const currentUser = await provider.fetchCurrentUser()
  const notes = await provider.listNotes(mrIid)
  return notes.filter(
    (note) => note.body.includes(STATUS_MARKER) && note.author?.id === currentUser.id,
  )
}

export const upsertStatusNote = async (params: {
  input: StatusNoteInput
  dependencies: StatusNoteSyncDependencyInput
}): Promise<void> => {
  const dependencies = { ...defaultDependencies, ...params.dependencies }
  const { input } = params
  const body = await dependencies.buildStatusNoteBody(input)
  let state = await dependencies.upsertDesiredMrStatusNote({
    projectKey: input.event.projectKey,
    mrIid: input.event.mrIid,
    renderedBody: body,
  })

  if (state.noteId !== null) {
    try {
      await dependencies.provider.updateNote(input.event.mrIid, state.noteId, body)
      await dependencies.markMrStatusNoteSynced({
        id: state.id,
        noteId: state.noteId,
      })
      return
    } catch (error) {
      if (!isRecoverableStatusNoteUpdateFailure(error)) {
        throw error
      }
      console.warn(
        `[status-note] status note ${state.noteId} update rejected for ${input.event.projectKey} MR !${input.event.mrIid}; recreating note`,
      )
      state = await dependencies.markMrStatusNoteForCreate(state.id)
    }
  }

  const existingNotes = await listExistingStatusNotes(dependencies.provider, input.event.mrIid)
  const [canonicalNote, ...duplicateNotes] = [...existingNotes].sort(
    (left, right) => right.id - left.id,
  )

  if (canonicalNote) {
    await dependencies.provider.updateNote(input.event.mrIid, canonicalNote.id, body)
    await Promise.all(
      duplicateNotes.map(async (note) => {
        try {
          await dependencies.provider.deleteNote(input.event.mrIid, note.id)
        } catch (error) {
          console.warn(
            `[status-note] failed to delete duplicate status note ${note.id} for ${input.event.projectKey} MR !${input.event.mrIid}: ${toErrorMessage(error)}`,
          )
        }
      }),
    )
    await dependencies.markMrStatusNoteSynced({
      id: state.id,
      noteId: canonicalNote.id,
    })
    return
  }

  const createdNote = await dependencies.provider.createNote(input.event.mrIid, body)
  await dependencies.markMrStatusNoteSynced({
    id: state.id,
    noteId: createdNote.id,
  })
}

export const syncStatusNote = async (params: {
  input: StatusNoteInput
  dependencies: StatusNoteSyncDependencyInput
}): Promise<boolean> => {
  try {
    await upsertStatusNote(params)
    return true
  } catch (error) {
    console.error(
      `[status-note] failed to sync ${params.input.event.projectKey} MR !${params.input.event.mrIid}:`,
      error,
    )
    return false
  }
}
