/** Serialize independent operations that share one logical resource key. */
export async function withKeyedLock<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  locks.set(key, current)
  await previous
  try {
    return await task()
  } finally {
    release()
    if (locks.get(key) === current) locks.delete(key)
  }
}
