const projectRepoLocks = new Map<string, Promise<void>>()

export const withProjectRepoLock = async <T>(
  projectKey: string,
  action: () => Promise<T>,
): Promise<T> => {
  const previous = projectRepoLocks.get(projectKey) ?? Promise.resolve()
  let release: () => void = () => {}
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const next = previous.then(
    () => current,
    () => current,
  )

  projectRepoLocks.set(projectKey, next)

  await previous.catch(() => {})

  try {
    return await action()
  } finally {
    release()
    if (projectRepoLocks.get(projectKey) === next) {
      projectRepoLocks.delete(projectKey)
    }
  }
}
