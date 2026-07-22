const mrLocks = new Map<string, Promise<void>>()

export const mrLockKey = (projectKey: string, mrIid: number): string => `${projectKey}:${mrIid}`

export const mrIidFromLockKey = (key: string): number => {
  const parts = key.split(':')
  const mrIid = Number.parseInt(parts[1] ?? '', 10)
  if (!Number.isInteger(mrIid) || mrIid <= 0) {
    throw new Error(`Invalid MR lock key: ${key}`)
  }
  return mrIid
}

export const withMrLock = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
  const current = mrLocks.get(key) ?? Promise.resolve()
  let release: (() => void) | undefined
  const next = new Promise<void>((resolve) => {
    release = resolve
  })

  const queued = current.then(() => next)
  mrLocks.set(key, queued)
  await current

  try {
    return await fn()
  } finally {
    release?.()
    if (mrLocks.get(key) === queued) {
      mrLocks.delete(key)
    }
  }
}
