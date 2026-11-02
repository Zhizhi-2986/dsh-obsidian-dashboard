function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/giu, ':')
}

/** Build DSH's native session-scoped file resource address. */
export function sessionFileAddress(sessionId: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/gu, '/').replace(/^(?:\.\/)+/u, '')
  const encodedPath = normalized.split('/').map(encodeSegment).join('/')
  return `dsh-resource://file/session/${encodeSegment(sessionId)}/${encodedPath}`
}
