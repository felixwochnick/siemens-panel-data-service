// Gemeinsames für Netzwerkfehler von tedious (SQL Server) und fetch (OIDC)

/** Fehlercodes von Node/OpenSSL, wenn das Zertifikat der Gegenstelle nicht akzeptiert wird */
export const TLS_CERT_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'CERT_REVOKED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
])

/** Die Verbindung kommt nicht zustande, obwohl der Name aufgelöst wurde */
export const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'EPIPE', 'EADDRNOTAVAIL'])
export const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA', 'EAI_FAIL', 'ENODATA'])
export const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ETIMEOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'])

/** Alle `code`-Werte entlang der Ursachenkette; ein AggregateError (mehrere Adressen) zählt mit */
export function causeCodes(error: unknown, depth = 0): string[] {
  if (!error || typeof error !== 'object' || depth > 5) return []
  const { code, cause, errors } = error as { code?: unknown, cause?: unknown, errors?: unknown }
  const found: string[] = typeof code === 'string' ? [code] : []
  found.push(...causeCodes(cause, depth + 1))
  if (Array.isArray(errors)) for (const inner of errors) found.push(...causeCodes(inner, depth + 1))
  return found
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
