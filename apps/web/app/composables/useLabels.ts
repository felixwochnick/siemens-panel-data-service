import type { AnalysisEventInfo, AuditEntry } from '~~/shared/types/api'

/**
 * Texte zu Codes vom Server mit Rückfall auf den Code: Server und Worker können neuere Codes kennen als die
 * Oberfläche – dann bleibt der Code sichtbar statt eines leeren Texts.
 */
export function useLabels() {
  const { t, te } = useI18n()

  const settingLabel = (path: string) => (te(`settings.fields.${path}`) ? t(`settings.fields.${path}`) : path)
  const issueText = (code: string) => (te(`settingsIssues.${code}`) ? t(`settingsIssues.${code}`) : code)
  /** Fehler einer Analyse (ANALYSIS_ERROR_CODES) */
  const analysisError = (code: string | null) => (!code ? '' : te(`analysisEvents.${code}`) ? t(`analysisEvents.${code}`) : code)
  const stageText = (stage: string | null) => (!stage ? '' : te(`analysisStage.${stage}`) ? t(`analysisStage.${stage}`) : stage)

  /** Ereignis einer Analyse als Satz in der Sprache der Oberfläche (Parameter übersetzt, wo sie Codes sind) */
  const eventText = (event: Pick<AnalysisEventInfo, 'code' | 'params'>) => {
    const values: Record<string, string | number> = {}
    for (const [key, value] of Object.entries(event.params ?? {})) {
      if (key === 'trigger' && typeof value === 'string') values[key] = te(`analysisTrigger.${value}`) ? t(`analysisTrigger.${value}`) : value
      else if (key === 'code' && typeof value === 'string' && event.code !== 'worker_log') values[key] = analysisError(value)
      else values[key] = value
    }
    const key = `analysisEvents.${event.code}`
    if (!te(key)) return [event.code, ...Object.entries(event.params ?? {}).map(([k, v]) => `${k}=${v}`)].join(' ')
    return t(key, values)
  }

  const auditText = (entry: Pick<AuditEntry, 'action' | 'details'>) => {
    const details = entry.details ?? {}
    switch (entry.action) {
      case 'settings_updated': {
        const changed = Array.isArray(details.changed) ? details.changed.map(path => settingLabel(String(path))) : []
        return changed.length && changed.length <= 3 ? t('audit.settings_updated_fields', { fields: changed.join(', ') }) : t('audit.settings_updated')
      }
      case 'scheduler_toggled':
        return t(details.enabled ? 'audit.scheduler_toggled_on' : 'audit.scheduler_toggled_off')
      case 'project_uploaded':
      case 'analysis_started':
      case 'analysis_deleted':
      case 'project_deleted':
      case 'worker_restarted':
        return t(`audit.${entry.action}`, details as Record<string, string | number>)
      default:
        return t('audit.unknown', { action: entry.action })
    }
  }

  /**
   * Fehler einer API-Antwort (ofetch oder eigener XHR) als Text unter errors.<code>, mit den Werten aus `data`
   * (z. B. maxMb bei upload_too_large)
   */
  const errorText = (error: unknown): string => {
    const err = error as { statusCode?: number, status?: number, statusMessage?: string, data?: { message?: string, data?: Record<string, unknown> } } | null
    const status = err?.statusCode ?? err?.status
    if (status === 401) return t('errors.unauthorized')
    const code = err?.data?.message ?? err?.statusMessage
    if (code && /^[a-z_]+$/.test(code) && te(`errors.${code}`)) {
      const params = Object.fromEntries(Object.entries(err?.data?.data ?? {}).filter(([, value]) => typeof value === 'string' || typeof value === 'number')) as Record<string, string | number>
      return t(`errors.${code}`, params)
    }
    if (status === 403) return t('errors.forbidden')
    if (status === 404) return t('errors.not_found')
    return t('errors.unknown')
  }

  return { settingLabel, issueText, analysisError, stageText, eventText, auditText, errorText }
}
