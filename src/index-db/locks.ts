const INDEX_LOCKS = new Map<string, Promise<void>>()

export const withPathLock = async <T>(path: string, action: () => Promise<T>): Promise<T> => {
  const previous = INDEX_LOCKS.get(path) ?? Promise.resolve()
  let release = () => {}
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  INDEX_LOCKS.set(path, previous.then(() => current))

  await previous
  try {
    return await action()
  } finally {
    release()
    if (INDEX_LOCKS.get(path) === current) {
      INDEX_LOCKS.delete(path)
    }
  }
}
