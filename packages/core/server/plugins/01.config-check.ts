// Fehlkonfiguration früh und verständlich melden statt erst beim ersten Login (500)
export default defineNitroPlugin(() => {
  if (import.meta.dev) return
  const config = useRuntimeConfig()
  const problems: string[] = []
  if (typeof config.appSecret !== 'string' || config.appSecret.length < 32) problems.push('NUXT_APP_SECRET muss mindestens 32 Zeichen lang sein')
  if (!config.databaseUrl) problems.push('NUXT_DATABASE_URL fehlt')
  if (!config.oidc.issuer || !config.oidc.clientId) problems.push('NUXT_OIDC_ISSUER und NUXT_OIDC_CLIENT_ID fehlen')
  if (problems.length) {
    console.error(`[config] ${problems.join('; ')}`)
    process.exit(1)
  }
})
