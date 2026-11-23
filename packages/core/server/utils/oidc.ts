import type { H3Event } from 'h3'
import * as client from 'openid-client'
import { deriveSecret } from 'nuxt/server'

interface FlowState {
  codeVerifier?: string
  state?: string
  nonce?: string
  redirect?: string
}

let configPromise: Promise<client.Configuration> | undefined

/** OIDC-Discovery (einmal pro Prozess, bei Fehler erneut versucht) */
export function useOidcConfig(): Promise<client.Configuration> {
  const { oidc } = useRuntimeConfig()
  if (!oidc.issuer || !oidc.clientId) throw createError({ statusCode: 500, message: 'oidc_not_configured' })
  const issuer = new URL(oidc.issuer)
  // http-Issuer (Dex in der Entwicklung) nur im Dev-Modus erlauben
  const insecure = issuer.protocol === 'http:' && import.meta.dev
  configPromise ??= client.discovery(issuer, oidc.clientId, oidc.clientSecret || undefined, undefined, {
    execute: insecure ? [client.allowInsecureRequests] : [],
  }).catch((error) => {
    configPromise = undefined
    throw error
  })
  return configPromise
}

export function redirectUri(): string {
  return new URL('/auth/callback', useRuntimeConfig().public.appUrl).href
}

/** Kurzlebiger, versiegelter Zustand des Login-Flows (PKCE-Verifier, state, nonce, Ziel) */
async function useFlowSession(event: H3Event) {
  // h3-Session (die Handler sind h3-Handler); Schlüssel aus NUXT_APP_SECRET abgeleitet
  return useSession<FlowState>(event, {
    password: await deriveSecret('pds-core:oidc-flow'),
    name: 'pds-oidc',
    maxAge: 600,
    cookie: { path: '/auth', sameSite: 'lax', httpOnly: true, secure: useRuntimeConfig().public.appUrl.startsWith('https:') },
  })
}

/** Startet den Login beim Identity-Provider */
export async function startOidcLogin(event: H3Event, redirect: string) {
  const config = await useOidcConfig()
  const codeVerifier = client.randomPKCECodeVerifier()
  const state = client.randomState()
  const nonce = client.randomNonce()
  const flow = await useFlowSession(event)
  await flow.update({ codeVerifier, state, nonce, redirect })

  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri(),
    scope: useRuntimeConfig().oidc.scopes,
    code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
    state,
    nonce,
  })
  return sendRedirect(event, url.href)
}

/** Verarbeitet den Rückruf: Code einlösen, Token prüfen, Claims liefern */
export async function finishOidcLogin(event: H3Event): Promise<{ claims: Record<string, unknown>, redirect: string, issuer: string }> {
  const config = await useOidcConfig()
  const flow = await useFlowSession(event)
  const { codeVerifier, state, nonce, redirect } = flow.data
  await flow.clear()
  if (!codeVerifier || !state || !nonce) throw createError({ statusCode: 400, message: 'login_expired' })

  // Callback-URL so rekonstruieren, wie sie beim IdP registriert ist (hinter dem Proxy stimmt der Host sonst nicht)
  const current = new URL(redirectUri())
  current.search = getRequestURL(event).search

  const tokens = await client.authorizationCodeGrant(config, current, {
    pkceCodeVerifier: codeVerifier,
    expectedState: state,
    expectedNonce: nonce,
    idTokenExpected: true,
  })
  let claims: Record<string, unknown> = { ...tokens.claims() }

  // Fehlen Name oder Rollen im ID-Token, ergänzt der UserInfo-Endpunkt sie
  const { oidc } = useRuntimeConfig()
  if ((claims[oidc.rolesClaim] === undefined || !claims.name) && config.serverMetadata().userinfo_endpoint) {
    try {
      const info = await client.fetchUserInfo(config, tokens.access_token, claims.sub as string)
      claims = { ...info, ...claims }
    }
    catch {
      // UserInfo ist optional (Entra liefert für Graph-Tokens keine Antwort an Dritte)
    }
  }

  return { claims, redirect: safeRedirectPath(redirect), issuer: config.serverMetadata().issuer }
}
