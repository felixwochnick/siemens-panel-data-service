// Jede Seite verlangt eine Anmeldung, außer sie setzt definePageMeta({ public: true })
export default defineNuxtRouteMiddleware((to) => {
  const { loggedIn } = useUserSession()
  if (to.path === '/login' && loggedIn.value) return navigateTo(safeRedirectPath(to.query.redirect))
  if (to.meta.public || loggedIn.value) return
  return navigateTo({ path: '/login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } })
})
