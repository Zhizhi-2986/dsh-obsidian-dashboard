import { fail, type FailResult } from '../shared/rpc-contract.ts'

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function failure(error: unknown, fallback: FailResult): FailResult {
  switch (errorCode(error)) {
    case 'FS_NOT_FOUND': return fail('NOT_FOUND', 'path not found')
    case 'FS_STALE_VERSION':
    case 'FS_NOT_OBSERVED': return fail('CONFLICT', 'file changed on disk; reload it before saving')
    case 'FS_SANDBOX_DENIED': {
      if (errorMessage(error).includes('read-only mode')) return fail('READ_ONLY', 'writes are disabled by the current read-only sandbox mode')
      return fail('SANDBOX_DENIED',
        'the workspace sandbox denied the write. If the target lives outside ' +
        'the current workspace, switch to the workspace that contains it, or grant ' +
        'the session a wider file-sandbox mode, then retry.')
    }
    case 'EACCES':
    case 'EPERM':
    case 'FS_PERMISSION_DENIED': return fail('PERMISSION_DENIED', 'permission denied for this knowledge source')
    case 'FS_TOO_LARGE':
    case 'INBOX_TOO_LARGE': return fail('TOO_LARGE', 'file or inbox exceeds the configured size limit')
    case 'FS_NOT_TEXT': return fail('INVALID', 'file is not valid UTF-8 text')
    case 'FS_AMBIGUOUS_EDIT': return fail('CONFLICT', 'target resolution is ambiguous; reload it')
    default: return fallback
  }
}

export { errorMessage }
