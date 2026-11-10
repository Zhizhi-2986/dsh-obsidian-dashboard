/** Minimal, dependency-free Markdown note parser for dsh-obsidian.
 *
 * Parses what a knowledge workspace needs without a full Markdown engine:
 *  - YAML frontmatter (shallow: `key: value` lines, inline arrays, quoted values)
 *  - headings (`#`, `##`, ...) for structure and title fallback
 *  - Obsidian-style inner links `[[target]]`, `[[target|alias]]`, `[[#heading]]`
 *  - hashtags `#tag` (word-boundary, not inside links/code fences)
 *  - plain-text extraction for FTS indexing
 *
 * Feed the result to `buildDocumentIndex` (host/indexer.ts).
 */

export interface ParsedFrontmatter {
  readonly values: ReadonlyMap<string, string>
  readonly raw: string
}

export interface ParsedLink {
  readonly raw: string
  /** Link target with alias stripped. */
  readonly target: string
  readonly alias: string | null
}

export interface ParsedNote {
  readonly frontmatter: ParsedFrontmatter
  readonly headings: readonly string[]
  readonly tags: readonly string[]
  readonly links: readonly ParsedLink[]
  /** Full text with frontmatter/links/tags removed, suitable for FTS. */
  readonly text: string
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
const HEADING_RE = /^#{1,6}\s+(.+)$/gmu
const LINK_RE = /\[\[([^\[\]\n]+?)\]\]/gu
const TAG_RE = /(?:^|[\s(>"'`])(#([\p{L}\p{N}_/.-]*[\p{L}\p{N}_/]))/gu
/** Block guards inside which tags and links are not parsed. */
const FENCE_RE = /^```[\s\S]*?^```$/gmu

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

/** Parse a shallow YAML-ish frontmatter block (subset sufficient for notes). */
export function parseFrontmatter(block: string): ParsedFrontmatter {
  const values = new Map<string, string>()
  for (const rawLine of block.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim()
    if (!/^[\p{L}\p{N}_-]+$/u.test(key)) continue
    let value = line.slice(colon + 1).trim()
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value
        .slice(1, -1)
        .split(',')
        .map((part) => unquote(part))
        .filter((part) => part !== '')
        .join(' ')
    } else {
      value = unquote(value)
    }
    values.set(key, value)
  }
  return { values, raw: block }
}

/** Split a link target into `target` and optional `|alias`. */
export function splitLinkTarget(raw: string): { target: string; alias: string | null } {
  const pipe = raw.indexOf('|')
  if (pipe < 0) return { target: raw.trim(), alias: null }
  return { target: raw.slice(0, pipe).trim(), alias: raw.slice(pipe + 1).trim() }
}

/** Resolve an inner link target to a vault file path (relative to vault root).
 *
 *  - `[[note]]`        → `note.md` (or literal `note` if it exists)
 *  - `[[dir/note]]`    → `dir/note.md`
 *  - `[[note|alias]]`  → alias-free form of the above
 *  - `[[note#heading]]`→ link to heading inside `note.md`
 *  - external targets (`http://`, `#`, `/`) are not resolved
 */
export function resolveLinkTarget(target: string, knownPaths: ReadonlySet<string>): string | null {
  const clean = target.trim()
  if (clean === '' || clean.startsWith('#') || clean.startsWith('/')) return null
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(clean)) return null // scheme (http:, obsidian:...)
  const hash = clean.indexOf('#')
  const withoutHeading = hash >= 0 ? clean.slice(0, hash) : clean
  const withMd = withoutHeading.endsWith('.md') ? withoutHeading : `${withoutHeading}.md`
  if (knownPaths.has(withMd)) return withMd
  if (knownPaths.has(withoutHeading)) return withoutHeading
  return null
}

/** Parse one note body. `plainifyLinks` controls whether inner links are
 *  removed from the FTS text (default true: link text is not body content). */
export function parseNote(markdown: string): ParsedNote {
  let body = markdown
  const fmMatch = FRONTMATTER_RE.exec(markdown)
  let frontmatter: ParsedFrontmatter = { values: new Map(), raw: '' }
  if (fmMatch !== null) {
    frontmatter = parseFrontmatter(fmMatch[1])
    body = markdown.slice(fmMatch[0].length)
  }

  const headings: string[] = []
  const headingRe = new RegExp(HEADING_RE.source, HEADING_RE.flags)
  for (const match of body.matchAll(headingRe)) headings.push(match[1].trim())

  const tags: string[] = []
  const linkTargets: ParsedLink[] = []
  const fences: Array<[number, number]> = []
  const fenceRe = new RegExp(FENCE_RE.source, FENCE_RE.flags)
  for (const match of body.matchAll(fenceRe)) fences.push([match.index, match.index + match[0].length])

  const isInFence = (index: number): boolean =>
    fences.some(([start, end]) => index >= start && index < end)

  const linkRe = new RegExp(LINK_RE.source, LINK_RE.flags)
  for (const match of body.matchAll(linkRe)) {
    if (isInFence(match.index)) continue
    const raw = match[1]
    const { target, alias } = splitLinkTarget(raw)
    linkTargets.push({ raw, target, alias })
  }

  const tagRe = new RegExp(TAG_RE.source, TAG_RE.flags)
  for (const match of body.matchAll(tagRe)) {
    if (isInFence(match.index)) continue
    const tag = match[2]
    if (tag !== '' && !tags.includes(tag)) tags.push(tag)
  }

  // Plain text for FTS: retain source line boundaries so search citations can
  // point back to the original file, including when frontmatter is removed.
  const frontmatterLineOffset = fmMatch?.[0].match(/\n/gu)?.length ?? 0
  let text = `${'\n'.repeat(frontmatterLineOffset)}${body}`
    .replace(LINK_RE, '')
    .replace(HEADING_RE, ' ')
    .replace(/[#*_`>~|-]/gu, ' ')
    .replace(/[\t\f\v ]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .trimEnd()

  return { frontmatter, headings, tags, links: linkTargets, text }
}

/** Best-effort note title: #1 heading → frontmatter title → file stem. */
export function noteTitleOf(parsed: ParsedNote, fileStem: string): string {
  for (const heading of parsed.headings) {
    if (heading !== '') return heading
  }
  const title = parsed.frontmatter.values.get('title')
  if (title !== undefined && title !== '') return title
  return fileStem
}

/** Digest of a note for the indexer. */
export interface NoteDigest {
  readonly title: string
  readonly tags: readonly string[]
  readonly links: readonly ParsedLink[]
  readonly headings: readonly string[]
  readonly text: string
  readonly frontmatter: ParsedFrontmatter
}

export function digestNote(markdown: string, fileStem: string): NoteDigest {
  const parsed = parseNote(markdown)
  return {
    title: noteTitleOf(parsed, fileStem),
    tags: parsed.tags,
    links: parsed.links,
    headings: parsed.headings,
    text: parsed.text,
    frontmatter: parsed.frontmatter,
  }
}
