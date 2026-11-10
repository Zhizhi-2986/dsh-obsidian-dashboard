import { fail, type FailResult } from '../shared/rpc-contract.ts'
import type { KnowledgeSourceConfig, SourceRootIdentity } from '../shared/settings-contract.ts'
import { failure } from './failure.ts'
import { sourceRootIdentityMatches } from './source-path.ts'

export function hasRootIdentity(identity: SourceRootIdentity | undefined): identity is SourceRootIdentity {
  return identity !== undefined && identity.dev !== '' && identity.ino !== ''
}

export async function sourceRootFailure(source: KnowledgeSourceConfig): Promise<FailResult | null> {
  if (!hasRootIdentity(source.rootIdentity)) {
    return fail('OUTSIDE_SOURCE', 'source root identity is not pinned; remove and re-add this source')
  }
  try {
    return await sourceRootIdentityMatches(source.path, source.rootIdentity)
      ? null
      : fail('OUTSIDE_SOURCE', 'configured source root identity changed; remove and re-add this source')
  } catch (error) {
    return failure(error, fail('IO', 'failed to verify configured source root'))
  }
}
