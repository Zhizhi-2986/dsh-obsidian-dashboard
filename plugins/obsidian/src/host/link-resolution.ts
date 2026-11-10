export function resolveAgainstKnown(target: string, alias: string | null, known: ReadonlySet<string>): string | null {
  for (const candidate of [target, alias]) {
    if (candidate === null) continue
    const clean = candidate.trim()
    if (clean === '' || clean.startsWith('#') || clean.startsWith('/')) continue
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(clean)) continue
    const hash = clean.indexOf('#')
    const withoutHeading = hash >= 0 ? clean.slice(0, hash) : clean
    const withMd = withoutHeading.endsWith('.md') ? withoutHeading : `${withoutHeading}.md`
    if (known.has(withMd)) return withMd
    if (known.has(withoutHeading)) return withoutHeading
  }
  return null
}
