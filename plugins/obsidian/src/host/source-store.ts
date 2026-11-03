/** Knowledge-source configuration persisted independently of plugin settings. */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { KnowledgeSourceConfig } from '../shared/settings-contract.ts'

export class KnowledgeSourceStore {
  readonly #file: string

  constructor(dataDir: string) {
    this.#file = path.join(dataDir, 'sources.json')
  }

  async load(legacySources: readonly KnowledgeSourceConfig[]): Promise<KnowledgeSourceConfig[]> {
    await fs.mkdir(path.dirname(this.#file), { recursive: true })
    try {
      const raw = await fs.readFile(this.#file, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed) || !parsed.every(isKnowledgeSourceConfig)) {
        throw new Error('invalid knowledge source store')
      }
      return parsed
    } catch (error) {
      if (!isMissingFile(error)) throw error
      const initial = [...legacySources]
      await this.save(initial)
      return initial
    }
  }

  async save(sources: readonly KnowledgeSourceConfig[]): Promise<void> {
    await fs.mkdir(path.dirname(this.#file), { recursive: true })
    const temporary = `${this.#file}.tmp`
    await fs.writeFile(temporary, JSON.stringify(sources, null, 2), 'utf8')
    await fs.rename(temporary, this.#file)
  }
}

function isKnowledgeSourceConfig(value: unknown): value is KnowledgeSourceConfig {
  if (typeof value !== 'object' || value === null) return false
  const source = value as Record<string, unknown>
  return typeof source.id === 'string' && source.id.length > 0 &&
    typeof source.name === 'string' && source.name.length > 0 &&
    typeof source.path === 'string' && source.path.length > 0 &&
    (source.kind === 'vault' || source.kind === 'folder') &&
    Array.isArray(source.include) && source.include.every((entry) => typeof entry === 'string') &&
    Array.isArray(source.exclude) && source.exclude.every((entry) => typeof entry === 'string')
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
