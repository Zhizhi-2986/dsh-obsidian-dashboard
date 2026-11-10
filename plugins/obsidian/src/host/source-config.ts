import type { KnowledgeSourceConfig, ObsidianSettings } from '../shared/settings-contract.ts'

export function assertUniqueSourceIds(config: ObsidianSettings): void {
  const ids = config.knowledgeSources.map((source) => source.id)
  if (new Set(ids).size !== ids.length) throw new Error('duplicate knowledge source ids in configuration')
}

export function sameSourceIndexingConfig(
  left: ObsidianSettings['knowledgeSources'][number],
  right: ObsidianSettings['knowledgeSources'][number],
): boolean {
  return left.path === right.path && left.kind === right.kind &&
    sameRootIdentity(left.rootIdentity, right.rootIdentity) &&
    sameStrings(left.include, right.include) && sameStrings(left.exclude, right.exclude)
}

function sameRootIdentity(left: KnowledgeSourceConfig['rootIdentity'], right: KnowledgeSourceConfig['rootIdentity']): boolean {
  return left?.dev === right?.dev && left?.ino === right?.ino
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
