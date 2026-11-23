import { describe, expect, it } from 'vitest'
import { safeRedirectPath } from '../shared/utils/redirect'
import { isDynamicRequest, isSessionlessRequest } from '../server/utils/request'

describe('safeRedirectPath', () => {
  it('erlaubt nur relative Pfade der App', () => {
    expect(safeRedirectPath('/locations/1?tab=a')).toBe('/locations/1?tab=a')
    expect(safeRedirectPath('https://evil.example')).toBe('/')
    expect(safeRedirectPath('//evil.example')).toBe('/')
    expect(safeRedirectPath('/\\evil.example')).toBe('/')
    expect(safeRedirectPath('/ok\nSet-Cookie: x')).toBe('/')
    expect(safeRedirectPath(undefined, '/start')).toBe('/start')
    expect(safeRedirectPath(['/a'])).toBe('/')
  })
})

describe('isDynamicRequest', () => {
  it('unterscheidet Seiten/API von statischen Dateien', () => {
    expect(isDynamicRequest('/')).toBe(true)
    expect(isDynamicRequest('/locations/abc')).toBe(true)
    expect(isDynamicRequest('/api/locations')).toBe(true)
    expect(isDynamicRequest('/api/_auth/session')).toBe(true)
    expect(isDynamicRequest('/_nuxt/entry.js')).toBe(false)
    expect(isDynamicRequest('/__nuxt_error')).toBe(false)
    expect(isDynamicRequest('/fonts/siemens-sans-pro.woff2')).toBe(false)
    expect(isDynamicRequest('/favicon.svg')).toBe(false)
  })
})

describe('isSessionlessRequest', () => {
  it('Programm-Endpunkte bekommen keine Sitzung, Seiten und API der Oberfläche schon', () => {
    for (const path of ['/mcp', '/mcp?x=1', '/oauth/register', '/oauth/token', '/oauth/revoke?a=b', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server'])
      expect(isSessionlessRequest(path), path).toBe(true)
    for (const path of ['/', '/oauth/authorize?client_id=x', '/api/oauth/authorize', '/api/mcp/connections', '/assistants', '/mcpx', '/oauth/tokens', '/auth/login'])
      expect(isSessionlessRequest(path), path).toBe(false)
  })
})
