export function useAuth() {
  const { user, loggedIn, clear, fetch } = useUserSession()

  async function logout() {
    await $fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
    await clear()
    await navigateTo('/login')
  }

  return {
    user,
    loggedIn,
    isAdmin: computed(() => !!user.value?.isAdmin),
    refresh: fetch,
    logout,
  }
}
