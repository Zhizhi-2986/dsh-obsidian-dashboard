/** Proposal inbox persistence (drafts + state) in the plugin data dir.
 *
 * The inbox survives plugin hot reloads (settings edits restart the fiber):
 * items are stored as a JSON file with atomic rename, same convention as
 * native DSH plugins (credentials-local writes $DSH_HOME/.credentials.yaml).
 * The proposal *content* is also the review draft for review-before-write.
 */

import { createReadStream } from 'node:fs'
import * as path from 'node:path'
import { MAX_INBOX_SERIALIZED_BYTES, MAX_INBOX_STORAGE_BYTES } from '../shared/constants.ts'
import { ensurePrivateDirectory, ensurePrivateFile, writePrivateFile } from './private-storage.ts'
import { MAX_INBOX_ITEMS, type InboxItem, type ProposeInput } from '../shared/rpc-contract.ts'

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined
}

function inboxTooLargeError(): Error & { code: string } {
  return Object.assign(new Error('Inbox exceeds its serialized size limit'), { code: 'INBOX_TOO_LARGE' })
}

const mutationQueues = new Map<string, Promise<void>>()

export interface InboxStoreOptions {
  readonly maxStorageBytes?: number
}

export class InboxStore {
  readonly #file: string
  readonly #maxStorageBytes: number

  constructor(dataDir: string, options: InboxStoreOptions = {}) {
    this.#file = path.join(dataDir, 'inbox.json')
    this.#maxStorageBytes = options.maxStorageBytes ?? MAX_INBOX_STORAGE_BYTES
  }

  async #ensure(): Promise<void> {
    await ensurePrivateDirectory(path.dirname(this.#file))
  }

  list(): Promise<InboxItem[]> {
    return this.#mutate(() => this.#read())
  }

  async #read(): Promise<InboxItem[]> {
    await this.#ensure()
    await ensurePrivateFile(this.#file)
    const chunks: string[] = []
    let bytesRead = 0
    const stream = createReadStream(this.#file, { encoding: 'utf8', highWaterMark: 64 * 1024 })
    try {
      for await (const chunk of stream) {
        const text = String(chunk)
        bytesRead += Buffer.byteLength(text, 'utf8')
        if (bytesRead > this.#maxStorageBytes) throw inboxTooLargeError()
        chunks.push(text)
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return []
      throw error
    }
    const raw = chunks.join('')

    let value: unknown[]
    try {
      const parsedValue: unknown = JSON.parse(raw)
      if (!Array.isArray(parsedValue)) throw new Error('inbox data must be an array')
      value = parsedValue
    } catch (error) {
      throw new Error('inbox data could not be parsed', { cause: error })
    }
    if (value.length > MAX_INBOX_ITEMS) throw inboxTooLargeError()
    const parsed = value as Array<InboxItem & { baselineContent?: string; agentId?: string | null; rebasedFrom?: string | null; revision?: number }>

    let migrated = false
    const items = parsed.map((item) => {
      const hasBaseline = typeof item.baselineContent === 'string'
      const hasAgentId = item.agentId === null || typeof item.agentId === 'string'
      const hasRebasedFrom = item.rebasedFrom === null || typeof item.rebasedFrom === 'string'
      const hasRevision = Number.isInteger(item.revision) && (item.revision as number) >= 1
      if (hasBaseline && hasAgentId && hasRebasedFrom && hasRevision) return item as InboxItem
      migrated = true
      return {
        ...item,
        revision: hasRevision ? item.revision! : 1,
        agentId: hasAgentId ? item.agentId! : null,
        rebasedFrom: hasRebasedFrom ? item.rebasedFrom! : null,
        baselineContent: hasBaseline ? item.baselineContent! : '',
        ...(!hasBaseline && item.kind !== 'create' ? {
          status: item.status === 'pending' ? 'conflicted' as const : item.status,
          baseVersion: null,
          conflictMessage: item.status === 'pending'
            ? 'This proposal predates review snapshots; create a new proposal to review it safely.'
            : item.conflictMessage,
        } : {}),
      }
    })
    if (migrated) await this.#write(items)
    return items
  }

  /** Append a proposal; trims the oldest resolved items over the cap. */
  async add(
    input: ProposeInput,
    baselineContent = '',
    baseVersion: string | null = null,
    agentId: string | null = null,
    rebasedFrom: string | null = null,
  ): Promise<InboxItem | null> {
    return this.#mutate(async () => {
      const items = await this.#read()
      const item: InboxItem = {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        revision: 1,
        kind: input.kind,
        title: input.title,
        sourceId: input.sourceId,
        targetPath: input.targetPath,
        agentId,
        rebasedFrom,
        body: input.body,
        baselineContent,
        status: 'pending',
        baseVersion,
        conflictMessage: null,
      }
      items.push(item)
      while (items.length > MAX_INBOX_ITEMS || Buffer.byteLength(JSON.stringify(items, null, 2), 'utf8') > MAX_INBOX_SERIALIZED_BYTES) {
        const referencedIds = new Set(items.map((entry) => entry.rebasedFrom).filter((id): id is string => id !== null))
        const stale = items.findIndex((entry) => entry.status !== 'pending' && !referencedIds.has(entry.id))
        if (stale < 0) return null
        items.splice(stale, 1)
      }
      await this.#write(items)
      return item
    })
  }

  async update(id: string, patch: Partial<Omit<InboxItem, 'id' | 'revision'>>): Promise<InboxItem | null> {
    return this.#mutate(async () => {
      const items = await this.#read()
      const index = items.findIndex((entry) => entry.id === id)
      if (index < 0) return null
      items[index] = { ...items[index], ...patch, id, revision: items[index]!.revision + 1 }
      await this.#write(items)
      return items[index]
    })
  }

  #mutate<T>(mutation: () => Promise<T>): Promise<T> {
    const previous = mutationQueues.get(this.#file) ?? Promise.resolve()
    const result = previous.then(mutation, mutation)
    const settled = result.then(() => undefined, () => undefined)
    mutationQueues.set(this.#file, settled)
    void settled.then(() => {
      if (mutationQueues.get(this.#file) === settled) mutationQueues.delete(this.#file)
    })
    return result
  }

  async #write(items: InboxItem[]): Promise<void> {
    if (items.length > MAX_INBOX_ITEMS) throw inboxTooLargeError()
    const serialized = JSON.stringify(items, null, 2)
    if (Buffer.byteLength(serialized, 'utf8') > this.#maxStorageBytes) throw inboxTooLargeError()
    await this.#ensure()
    await writePrivateFile(this.#file, serialized)
  }
}
