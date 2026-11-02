const MAX_SOURCE_ID_LENGTH = 64

/** Derive a stable, schema-safe source id without colliding with existing ids. */
export function uniqueSourceId(name: string, existingIds: readonly string[]): string {
  const base = name.toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, MAX_SOURCE_ID_LENGTH) || 'source'
  const occupied = new Set(existingIds)
  if (!occupied.has(base)) return base

  for (let suffix = 2; ; suffix += 1) {
    const tail = `-${suffix}`
    const candidate = `${base.slice(0, MAX_SOURCE_ID_LENGTH - tail.length)}${tail}`
    if (!occupied.has(candidate)) return candidate
  }
}
