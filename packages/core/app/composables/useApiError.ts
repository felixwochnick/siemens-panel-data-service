/** Übersetzt Fehler vom Server (createError({ message: '<code>' })) über errors.<code> */
export function useApiError() {
  const { t, te } = useI18n()

  return (error: unknown): string => {
    const err = error as { statusCode?: number, status?: number, data?: { message?: string }, statusMessage?: string }
    const code = err?.data?.message ?? err?.statusMessage
    if ((err?.statusCode ?? err?.status) === 401) return t('errors.unauthorized')
    if (code && /^[a-z_]+$/.test(code) && te(`errors.${code}`)) return t(`errors.${code}`)
    return t('errors.unknown')
  }
}
