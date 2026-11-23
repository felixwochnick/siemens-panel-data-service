// Browser-Titel „<Seite> · Panel Data Service“, damit Tabs und Lesezeichen die App erkennen lassen
export default defineNuxtPlugin((nuxtApp) => {
  const { t } = nuxtApp.$i18n
  useHead({ titleTemplate: title => (title ? `${title} · ${t('app.name')}` : t('app.name')) })
})
