import { fileURLToPath } from 'node:url'

// Ordner mit Punkt (.well-known) scannt Nitro nicht; die Metadaten-Handler werden deshalb einzeln eingetragen
const handler = (name: string) => fileURLToPath(new URL(`./server/handlers/${name}`, import.meta.url))

// Gemeinsamer Server-Layer aller PDS-Monorepos: SQL Server, Migrationen, OIDC-Anmeldung (Entra ID/Dex), Sessions
export default defineNuxtConfig({
  modules: ['nuxt-auth-utils', '@nuxtjs/i18n'],

  runtimeConfig: {
    // mssql://user:pass@host:1433/datenbank?trustServerCertificate=true
    databaseUrl: '',
    oidc: {
      // Entra ID: https://login.microsoftonline.com/<tenant-id>/v2.0
      issuer: '',
      clientId: '',
      clientSecret: '',
      scopes: 'openid profile email',
      // Claim mit Rollen/Gruppen (Entra: App-Rollen in "roles"; Dex: "groups")
      rolesClaim: 'roles',
      // Kommagetrennte Werte, die Plattform-Admin bedeuten
      adminRoles: 'Admin',
    },
    mcp: {
      // true ⇒ nur Admins dürfen KI-Assistenten (MCP) zulassen (Zustimmungsseite); NUXT_MCP_ADMIN_ONLY
      adminOnly: false,
      // Dauer einer Verbindung in Sekunden; 0 ⇒ wie die Sitzung (endet spätestens mit ihr). NUXT_MCP_CONNECTION_SECONDS
      connectionSeconds: 0,
    },
    requestGuard: {
      // Pfade (exakt), die größere Bodies annehmen und ihre Grenze selbst prüfen (z. B. Hochladen von Dateien)
      largeBodyPaths: [] as string[],
    },
    session: {
      name: 'pds-session',
      // Arbeitstag: danach meldet Entra-SSO meist ohne Eingabe neu an
      maxAge: 60 * 60 * 12,
      // NUXT_SESSION_COOKIE_SECURE=false nur, wenn die App ausschließlich per HTTP erreichbar ist
      cookie: { secure: true, sameSite: 'lax' as const },
    },
    public: {
      // Öffentliche URL der App (Redirect-URI = <appUrl>/auth/callback)
      appUrl: 'http://localhost:3000',
      oidcProviderName: 'Microsoft',
      // KI-Assistenten (MCP) per OAuth anbinden; aus ⇒ alle zugehörigen Endpunkte und Seiten antworten 404
      mcpEnabled: false,
    },
  },

  // Die Zustimmungsseite darf nie eingebettet werden (Clickjacking), auch ohne vorgelagerten Proxy
  routeRules: {
    '/oauth/authorize': { headers: { 'x-frame-options': 'DENY', 'content-security-policy': 'frame-ancestors \'none\'' } },
  },

  // node:sqlite ist ein Node-Modul, das die Bündelung (noch) nicht als eingebaut kennt: ausdrücklich extern lassen
  nitro: {
    rollupConfig: { external: ['node:sqlite'] },
  },

  // `/**` deckt den Pfad der Ressource ab (RFC 9728/8414 hängen sie an den .well-known-Pfad an)
  serverHandlers: [
    { route: '/.well-known/oauth-protected-resource', handler: handler('oauth-protected-resource.ts'), method: 'get' },
    { route: '/.well-known/oauth-protected-resource/**', handler: handler('oauth-protected-resource.ts'), method: 'get' },
    { route: '/.well-known/oauth-authorization-server', handler: handler('oauth-authorization-server.ts'), method: 'get' },
    { route: '/.well-known/oauth-authorization-server/**', handler: handler('oauth-authorization-server.ts'), method: 'get' },
  ],

  i18n: {
    locales: [
      { code: 'de', file: 'de.json' },
      { code: 'en', file: 'en.json' },
    ],
  },
})
