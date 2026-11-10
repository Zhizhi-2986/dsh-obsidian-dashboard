import { createElement, type ReactElement, type ReactNode } from 'react'
import type { DocLink } from '../shared/rpc-contract.ts'

const tokenPattern = /(!?\[[^\]]*\]\([^)]+\)|\[\[[^\]]+\]\]|`[^`]+`|\*\*[^*]+\*\*)/gu
const safeProtocols = new Set(['http:', 'https:', 'mailto:'])

function plainInlineText(text: string): string {
  const chunks: string[] = []
  let cursor = 0
  for (const match of text.matchAll(tokenPattern)) {
    const token = match[0]
    const index = match.index ?? 0
    if (index > cursor) chunks.push(text.slice(cursor, index))
    if (token.startsWith('![')) {
      const alt = token.slice(2, token.indexOf(']('))
      chunks.push(`Image: ${alt || 'embedded image'}`)
    } else if (token.startsWith('[[')) {
      const [target, alias] = token.slice(2, -2).split('|', 2)
      chunks.push(alias?.trim() || target.trim())
    } else if (token.startsWith('`')) {
      chunks.push(token.slice(1, -1))
    } else if (token.startsWith('**')) {
      chunks.push(token.slice(2, -2))
    } else {
      const closeLabel = token.indexOf('](')
      chunks.push(token.slice(1, closeLabel))
    }
    cursor = index + token.length
  }
  if (cursor < text.length) chunks.push(text.slice(cursor))
  return chunks.join('')
}

function uniqueHeadingId(baseId: string, used: Set<string>): string {
  let candidate = baseId
  let suffix = 1
  while (used.has(candidate)) candidate = `${baseId}-${suffix++}`
  used.add(candidate)
  return candidate
}

export function slugHeading(value: string): string {
  return value.trim().toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^\p{L}\p{N}_ -]/gu, '')
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
}

function safeHref(value: string): string | null {
  try {
    const url = new URL(value)
    return safeProtocols.has(url.protocol.toLowerCase()) ? url.href : null
  } catch {
    return null
  }
}

function inlineNodes(text: string, links: readonly DocLink[], onNavigate?: (path: string, fragment?: string) => void): ReactNode[] {
  const nodes: ReactNode[] = []
  let cursor = 0
  for (const match of text.matchAll(tokenPattern)) {
    const token = match[0]
    const index = match.index ?? 0
    if (index > cursor) nodes.push(text.slice(cursor, index))
    const key = `${index}:${token}`
    if (token.startsWith('![')) {
      const alt = token.slice(2, token.indexOf(']('))
      nodes.push(createElement('span', { key, title: 'Images are not loaded in the knowledge reader', style: styles.imagePlaceholder }, `Image: ${alt || 'embedded image'}`))
    } else if (token.startsWith('[[')) {
      const raw = token.slice(2, -2)
      const [target, alias] = raw.split('|', 2)
      const normalizedTarget = target.trim()
      const hash = normalizedTarget.indexOf('#')
      const fragment = hash >= 0 ? normalizedTarget.slice(hash + 1).trim() : undefined
      const resolved = links.find((link) => link.target === normalizedTarget && link.resolvedPath !== null)
      nodes.push(resolved && onNavigate
        ? createElement('button', { key, type: 'button', onClick: () => onNavigate(resolved.resolvedPath!, fragment), style: styles.wikiLink }, alias?.trim() || target.trim())
        : createElement('span', { key, title: 'Linked note was not found', style: styles.missingLink }, alias?.trim() || target.trim()))
    } else if (token.startsWith('`')) {
      nodes.push(createElement('code', { key, style: styles.inlineCode }, token.slice(1, -1)))
    } else if (token.startsWith('**')) {
      nodes.push(createElement('strong', { key }, token.slice(2, -2)))
    } else {
      const image = token.startsWith('!')
      const labelStart = image ? 2 : 1
      const closeLabel = token.indexOf('](')
      const label = token.slice(labelStart, closeLabel)
      const href = token.slice(closeLabel + 2, -1).trim()
      const safe = safeHref(href)
      nodes.push(safe
        ? createElement('a', { key, href: safe, rel: 'noreferrer', ...(safe.startsWith('mailto:') ? {} : { target: '_blank' }) }, label)
        : createElement('span', { key, title: 'Unsupported or unsafe link protocol' }, label))
    }
    cursor = index + token.length
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

function isTableDivider(line: string): boolean {
  return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/u.test(line)
}

function cells(line: string): string[] {
  return line.trim().replace(/^\||\|$/gu, '').split('|').map((cell) => cell.trim())
}

export interface MarkdownViewProps {
  readonly content: string
  readonly links?: readonly DocLink[]
  readonly onNavigate?: (path: string, fragment?: string) => void
}

/** A deliberately small React renderer: source is rendered as text, never as HTML. */
export function MarkdownView({ content, links = [], onNavigate }: MarkdownViewProps): ReactElement {
  const lines = content.split(/\r?\n/u)
  const blocks: ReactNode[] = []
  let index = 0
  let key = 0
  const headingIds = new Set<string>()

  while (index < lines.length) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()
    if (trimmed === '') { index += 1; continue }

    if (trimmed.startsWith('```')) {
      const code: string[] = []
      index += 1
      while (index < lines.length && !(lines[index] ?? '').trim().startsWith('```')) {
        code.push(lines[index] ?? '')
        index += 1
      }
      if (index < lines.length) index += 1
      blocks.push(createElement('pre', { key: key++, style: styles.pre }, createElement('code', null, code.join('\n'))))
      continue
    }

    const heading = /^(#{1,6})\s+(.+)$/u.exec(trimmed)
    if (heading) {
      const level = heading[1]!.length
      const baseId = slugHeading(plainInlineText(heading[2]!)) || 'heading'
      const id = uniqueHeadingId(baseId, headingIds)
      blocks.push(createElement(`h${level}`, { key: key++, id, style: styles.heading }, inlineNodes(heading[2]!, links, onNavigate)))
      index += 1
      continue
    }

    if (/^([-*_])(?:\s*\1){2,}\s*$/u.test(trimmed)) {
      blocks.push(createElement('hr', { key: key++, style: styles.rule }))
      index += 1
      continue
    }

    if (trimmed.startsWith('>')) {
      const quote: string[] = []
      while (index < lines.length && (lines[index] ?? '').trim().startsWith('>')) {
        quote.push((lines[index] ?? '').trim().replace(/^>\s?/u, ''))
        index += 1
      }
      const quoteParagraphs = quote.map((text, quoteIndex) => createElement('p', { key: quoteIndex }, ...inlineNodes(text, links, onNavigate)))
      blocks.push(createElement('blockquote', { key: key++, style: styles.quote }, ...quoteParagraphs))
      continue
    }

    if (trimmed.startsWith('|') && index + 1 < lines.length && isTableDivider(lines[index + 1] ?? '')) {
      const header = cells(line)
      index += 2
      const rows: string[][] = []
      while (index < lines.length && (lines[index] ?? '').trim().startsWith('|')) {
        rows.push(cells(lines[index] ?? ''))
        index += 1
      }
      blocks.push(createElement('table', { key: key++, style: styles.table },
        createElement('thead', null, createElement('tr', null, ...header.map((cell, i) => createElement('th', { key: i, style: styles.cell }, inlineNodes(cell, links, onNavigate))))),
        createElement('tbody', null, ...rows.map((row, rowIndex) => createElement('tr', { key: rowIndex }, ...row.map((cell, i) => createElement('td', { key: i, style: styles.cell }, inlineNodes(cell, links, onNavigate))))))))
      continue
    }

    const listMatch = /^\s*([-*+] |\d+\. )(.*)$/u.exec(line)
    if (listMatch) {
      const ordered = /^\d+\./u.test(listMatch[1]!)
      const items: ReactNode[] = []
      while (index < lines.length) {
        const current = /^\s*([-*+] |\d+\. )(.*)$/u.exec(lines[index] ?? '')
        if (!current || /^\d+\./u.test(current[1]!) !== ordered) break
        items.push(createElement('li', { key: items.length }, inlineNodes(current[2]!, links, onNavigate)))
        index += 1
      }
      blocks.push(createElement(ordered ? 'ol' : 'ul', { key: key++, style: styles.list }, ...items))
      continue
    }

    const paragraph: string[] = [trimmed]
    index += 1
    while (index < lines.length && (lines[index] ?? '').trim() !== '' && !/^(#{1,6}\s|>|```|\s*[-*+] |\s*\d+\. |\|)/u.test(lines[index] ?? '')) {
      paragraph.push((lines[index] ?? '').trim())
      index += 1
    }
    blocks.push(createElement('p', { key: key++, style: styles.paragraph }, inlineNodes(paragraph.join(' '), links, onNavigate)))
  }

  return createElement('article', { className: 'dsh-obsidian-markdown', style: styles.article }, ...blocks)
}

const styles: Record<string, object> = {
  article: { lineHeight: 1.75, overflowWrap: 'anywhere', padding: '12px 16px' },
  heading: { lineHeight: 1.35, margin: '1.2em 0 0.55em' },
  paragraph: { margin: '0 0 0.9em', whiteSpace: 'pre-wrap' },
  list: { paddingInlineStart: 24, margin: '0 0 1em' },
  pre: { overflowX: 'auto', padding: 12, borderRadius: 8, background: 'rgba(127,127,127,0.1)', whiteSpace: 'pre' },
  inlineCode: { padding: '1px 4px', borderRadius: 4, background: 'rgba(127,127,127,0.14)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  quote: { margin: '1em 0', padding: '0.2em 1em', borderLeft: '3px solid rgba(127,127,127,0.35)', opacity: 0.85 },
  rule: { border: 0, borderTop: '1px solid rgba(127,127,127,0.25)', margin: '1.4em 0' },
  table: { borderCollapse: 'collapse', width: '100%', margin: '1em 0' },
  cell: { padding: '7px 9px', textAlign: 'left', borderBottom: '1px solid rgba(127,127,127,0.2)' },
  imagePlaceholder: { display: 'inline-block', padding: '3px 8px', border: '1px dashed rgba(127,127,127,0.4)', borderRadius: 5, opacity: 0.75 },
  wikiLink: { border: 0, padding: 0, background: 'none', color: 'var(--dsh-color-text-link, #6885a1)', textDecoration: 'underline', textDecorationStyle: 'dashed', cursor: 'pointer', font: 'inherit' },
  missingLink: { opacity: 0.72, textDecoration: 'underline dotted' },
}
