// Seiten nur für Admins (definePageMeta({ admin: true })): Nicht-Admins bekommen die Fehlerseite „Kein Zugriff“ statt
// eines leeren Formulars; die API verlangt die Rolle ohnehin
export default defineNuxtRouteMiddleware((to) => {
  if (!to.meta.admin) return
  // Der Server hat die Fehlerseite schon gerendert: beim Hydrieren nicht noch einmal abbrechen
  const nuxtApp = useNuxtApp()
  if (import.meta.client && nuxtApp.isHydrating && nuxtApp.payload.error) return
  const { loggedIn, user } = useUserSession()
  if (loggedIn.value && !user.value?.isAdmin) return abortNavigation(createError({ statusCode: 403, statusMessage: 'forbidden' }))
})
