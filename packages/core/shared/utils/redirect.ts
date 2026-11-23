/**
 * Erlaubt nach dem Login nur Ziele innerhalb der App (relativer Pfad),
 * damit /auth/login?redirect=… nicht für Weiterleitungen nach außen missbraucht werden kann.
 */
export function safeRedirectPath(target: unknown, fallback = '/'): string {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//') || target.includes('\\'))
    return fallback
  // Steuerzeichen (z. B. Zeilenumbrüche) ausschließen
  if ([...target].some(c => c.charCodeAt(0) < 0x20)) return fallback
  return target
}
