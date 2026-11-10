/** Knowledge-source configuration persisted independently of plugin settings. */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { KnowledgeSourceConfig } from '../shared/settings-contract.ts'
import { ensurePrivateDirectory, ensurePrivateFile, writePrivateFile } from './private-storage.ts'

export class KnowledgeSourceStore {
  readonly #file: string

  constructor(dataDir: string) {
    this.#file = path.join(dataDir, 'sources.json')
  }

  async load(legacySources: readonly KnowledgeSourceConfig[]): Promise<KnowledgeSourceConfig[]> {
    await ensurePrivateDirectory(path.dirname(this.#file))
    await ensurePrivateFile(this.#file)
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
    await ensurePrivateDirectory(path.dirname(this.#file))
    await writePrivateFile(this.#file, JSON.stringify(sources, null, 2))
  }
}

function isKnowledgeSourceConfig(value: unknown): value is KnowledgeSourceConfig {
  if (typeof value !== 'object' || value === null) return false
  const source = value as Record<string, unknown>
  return typeof source.id === 'string' && source.id.length > 0 &&
    typeof source.name === 'string' && source.name.length > 0 &&
    typeof source.path === 'string' && source.path.length > 0 &&
    (source.kind === 'vault' || source.kind === 'folder') &&
    (source.rootIdentity === undefined || (
      typeof source.rootIdentity === 'object' && source.rootIdentity !== null &&
      typeof (source.rootIdentity as Record<string, unknown>).dev === 'string' &&
      typeof (source.rootIdentity as Record<string, unknown>).ino === 'string'
    )) &&
    Array.isArray(source.include) && source.include.every((entry) => typeof entry === 'string') &&
    Array.isArray(source.exclude) && source.exclude.every((entry) => typeof entry === 'string')
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
