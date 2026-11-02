/** Proposal inbox persistence (drafts + state) in the plugin data dir.
 *
 * The inbox survives plugin hot reloads (settings edits restart the fiber):
 * items are stored as a JSON file with atomic rename, same convention as
 * native DSH plugins (credentials-local writes $DSH_HOME/.credentials.yaml).
 * The proposal *content* is also the review draft for review-before-write.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { MAX_INBOX_ITEMS, type InboxItem, type ProposeInput } from '../shared/rpc-contract.ts'
export class InboxStore {
  readonly #file: string

  constructor(dataDir: string) {
    this.#file = path.join(dataDir, 'inbox.json')
  }

  async #ensure(): Promise<void> {
    await fs.mkdir(path.dirname(this.#file), { recursive: true })
  }

  async list(): Promise<InboxItem[]> {
    await this.#ensure()
    try {
      const raw = await fs.readFile(this.#file, 'utf8')
      return JSON.parse(raw) as InboxItem[]
    } catch {
      return []
    }
  }

  /** Append a proposal; trims the oldest dismissed items over the cap. */
  async add(input: ProposeInput): Promise<InboxItem> {
    const items = await this.list()
    const item: InboxItem = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      kind: input.kind,
      title: input.title,
      sourceId: input.sourceId,
      targetPath: input.targetPath,
      body: input.body,
      status: 'pending',
      baseVersion: null,
      conflictMessage: null,
    }
    items.push(item)
    // Keep at most MAX_INBOX_ITEMS; drop oldest resolved items first.
    while (items.length > MAX_INBOX_ITEMS) {
      const stale = items.findIndex((entry) => entry.status !== 'pending')
      items.splice(stale >= 0 ? stale : 0, 1)
    }
    await this.#write(items)
    return item
  }

  async update(id: string, patch: Partial<Omit<InboxItem, 'id'>>): Promise<InboxItem | null> {
    const items = await this.list()
    const index = items.findIndex((entry) => entry.id === id)
    if (index < 0) return null
    items[index] = { ...items[index], ...patch, id }
    await this.#write(items)
    return items[index]
  }

  async #write(items: InboxItem[]): Promise<void> {
    await this.#ensure()
    const tmp = `${this.#file}.tmp`
    await fs.writeFile(tmp, JSON.stringify(items, null, 2), 'utf8')
    await fs.rename(tmp, this.#file)
  }
}
