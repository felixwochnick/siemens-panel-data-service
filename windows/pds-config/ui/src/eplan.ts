// Prüfung des Kontonamens für den EPLAN-Worker wie `Account::parse` in pds-common (eplan.rs), für eine
// Rückmeldung schon beim Tippen. Maßgeblich bleibt die Prüfung in Rust.

export type AccountProblem = 'missing' | 'noDomain' | 'builtin' | 'managed' | 'invalid'

const MAX_LENGTH = 256
// Nicht erlaubt in Benutzer- und Domänennamen (SAM-Regeln)
const FORBIDDEN = /["/\\[\]:;|=,+*?<>@]/
// Auch in der deutschen Schreibweise von Windows
const BUILTIN_DOMAINS = [
  'nt authority', 'nt-autorität', 'nt service', 'builtin', 'vordefiniert',
  'iis apppool', 'nt virtual machine', 'window manager', 'font driver host',
]
const BUILTIN_NAMES = [
  'localsystem', 'localservice', 'networkservice', 'system',
  'lokales system', 'lokaler dienst', 'netzwerkdienst',
]

function userProblem(user: string): AccountProblem | null {
  if (!user || user.trim() !== user || FORBIDDEN.test(user) || /^[. ]+$/.test(user)) return 'invalid'
  return null
}

function domainProblem(domain: string): AccountProblem | null {
  if (!domain || /\s/.test(domain) || FORBIDDEN.test(domain)) return 'invalid'
  if (/^[.-]|[.-]$|\.\./.test(domain)) return 'invalid'
  return null
}

/** `null`, wenn der Name als `DOMÄNE\Benutzer`, `.\Benutzer` oder `benutzer@domäne` taugt */
export function accountProblem(input: string): AccountProblem | null {
  const text = input.trim()
  if (!text) return 'missing'
  // eslint-disable-next-line no-control-regex
  if ([...text].length > MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(text)) return 'invalid'
  const lower = text.toLowerCase()
  const bare = lower.startsWith('.\\') ? lower.slice(2) : lower
  if (BUILTIN_NAMES.includes(bare)) return 'builtin'

  const slash = text.indexOf('\\')
  if (slash >= 0) {
    const domain = text.slice(0, slash)
    const user = text.slice(slash + 1)
    if (domain !== '.') {
      if (BUILTIN_DOMAINS.includes(domain.toLowerCase())) return 'builtin'
      const problem = domainProblem(domain)
      if (problem) return problem
    }
    const problem = userProblem(user)
    if (problem) return problem
    return user.endsWith('$') ? 'managed' : null
  }

  const at = text.lastIndexOf('@')
  if (at >= 0) {
    const user = text.slice(0, at)
    const problem = userProblem(user) ?? domainProblem(text.slice(at + 1))
    if (problem) return problem
    return user.endsWith('$') ? 'managed' : null
  }
  return 'noDomain'
}
