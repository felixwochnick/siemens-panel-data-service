<script setup lang="ts">
import { ANALYSIS_STAGES } from '~~/shared/types/api'
import type { AnalysisEventInfo, AnalysisInfo, LogLevel, Paged } from '~~/shared/types/api'

const { t, locale } = useI18n()
const { analysisError, stageText } = useLabels()
const { isAdmin } = useAuth()
const route = useRoute()
const confirm = useConfirmModal()
const { run: remove, pending: removing } = useApiAction()
const mounted = useMounted()
const now = useNow({ interval: 1000 })

const id = computed(() => Number(route.params.id))
const PAGE = 500
// Obergrenze der API je Abruf
const MAX_EVENTS = 5000
const level = ref<LogLevel>('debug')
const limit = ref(PAGE)
watch(level, () => (limit.value = PAGE))

const { data: analysis, error, refresh } = await useFetch<AnalysisInfo>(() => `/api/analyses/${id.value}`, { key: `analysis-${id.value}` })
const { data: events, status: eventStatus, refresh: refreshEvents } = await useFetch<Paged<AnalysisEventInfo>>(() => `/api/analyses/${id.value}/events`, {
  key: `analysis-events-${id.value}`,
  query: { level, limit },
  default: () => ({ items: [], total: 0 }),
})

useSeoMeta({ title: () => t('analysis.title', { id: id.value }) })

// Live: solange die Analyse wartet oder läuft alle 2 s Status, Stufe und Ereignisse nachladen
const open = computed(() => analysis.value?.status === 'queued' || analysis.value?.status === 'running')
const { pause, resume } = useIntervalFn(() => Promise.all([refresh(), refreshEvents()]), 2000, { immediate: false })
watch(open, (value, before) => {
  if (value) resume()
  else {
    pause()
    // Abschließende Ereignisse (Ergebnisse gespeichert, erfolgreich) noch holen
    if (before) void refreshEvents()
  }
})
onMounted(() => {
  if (open.value) resume()
})
onBeforeUnmount(pause)

const duration = computed(() => {
  const a = analysis.value
  if (!a?.startedAt) return ''
  if (a.finishedAt) return formatDuration(durationBetween(a.startedAt, a.finishedAt))
  return mounted.value ? formatDuration(now.value.getTime() - new Date(a.startedAt).getTime()) : ''
})

const stageIndex = computed(() => (analysis.value?.stage ? ANALYSIS_STAGES.indexOf(analysis.value.stage) : -1))

const levelItems = computed(() => (['debug', 'info', 'warn', 'error'] as const).map(value => ({
  label: value === 'debug' ? t('analysis.allLevels') : t(`analysis.minLevel.${value}`),
  value,
})))

async function deleteAnalysis() {
  const confirmed = await confirm({
    title: t('project.deleteAnalysisTitle'),
    question: t('project.deleteAnalysisQuestion', { id: id.value }),
    confirmLabel: t('common.delete'),
    danger: true,
  })
  if (!confirmed || !analysis.value) return
  const projectId = analysis.value.projectId
  const deleted = await remove(() => $fetch(`/api/analyses/${id.value}`, { method: 'DELETE' }), { success: t('project.analysisDeleted') })
  if (deleted) await navigateTo(`/projects/${projectId}`)
}

const notFound = computed(() => (error.value as { statusCode?: number } | null)?.statusCode === 404)
</script>

<template>
  <UDashboardPanel id="analysis">
    <template #header>
      <UDashboardNavbar :title="analysis ? `${analysis.projectName} · #${analysis.id}` : t('analysis.title', { id })">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template
          v-if="analysis && isAdmin && analysis.status !== 'running' && !analysis.isCurrent"
          #right
        >
          <UButton
            color="error"
            variant="outline"
            icon="siemens:delete"
            :label="t('common.delete')"
            :ui="{ label: 'hidden sm:inline' }"
            :aria-label="t('common.delete')"
            :loading="removing"
            data-testid="analysis-delete"
            @click="deleteAnalysis"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div>
        <UButton
          color="tertiary"
          icon="siemens:arrow-left"
          :label="analysis ? t('analysis.backToProject', { name: analysis.projectName }) : t('project.back')"
          :to="analysis ? `/projects/${analysis.projectId}` : '/projects'"
          class="-ml-3 max-w-full"
          :ui="{ label: 'truncate' }"
        />
      </div>

      <EmptyState
        v-if="error"
        :icon="notFound ? 'siemens:search' : 'siemens:circle-error'"
        :title="notFound ? t('analysis.notFound') : t('errors.unknown')"
      />

      <div
        v-else-if="analysis"
        class="flex min-w-0 flex-col gap-6"
      >
        <UPageCard
          variant="outline"
          :ui="{ container: 'gap-y-4' }"
          data-testid="analysis-summary"
        >
          <div class="flex flex-wrap items-center gap-3">
            <AnalysesStatusBadge
              :status="analysis.status"
              size="lg"
            />
            <UBadge
              v-if="analysis.isCurrent"
              :label="t('project.current')"
              color="primary"
              variant="subtle"
            />
            <span
              v-if="open"
              class="text-sm text-muted"
            >{{ t('analysis.live') }}</span>
          </div>

          <!-- Stufe (live) -->
          <div
            v-if="analysis.status === 'running'"
            class="flex flex-col gap-1"
            data-testid="analysis-stage"
          >
            <p class="text-sm">
              <span class="text-muted">{{ t('analysis.stage') }}:</span>
              <span class="font-semibold">{{ stageText(analysis.stage) || '–' }}</span>
            </p>
            <UProgress
              :model-value="stageIndex + 1"
              :max="ANALYSIS_STAGES.length"
              size="sm"
            />
          </div>

          <dl class="grid grid-cols-2 gap-x-6 gap-y-2 text-sm lg:grid-cols-4">
            <div>
              <dt class="text-muted">
                {{ t('analysis.trigger') }}
              </dt>
              <dd>
                {{ t(`analysisTrigger.${analysis.trigger}`) }}<template v-if="analysis.triggeredBy">
                  · {{ analysis.triggeredBy }}
                </template>
              </dd>
            </div>
            <div>
              <dt class="text-muted">
                {{ t('analysis.queued') }}
              </dt>
              <dd>{{ formatDateTime(analysis.queuedAt, locale, { seconds: true }) }}</dd>
            </div>
            <div>
              <dt class="text-muted">
                {{ t('analysis.started') }}
              </dt>
              <dd>{{ formatDateTime(analysis.startedAt, locale, { seconds: true }) || '–' }}</dd>
            </div>
            <div>
              <dt class="text-muted">
                {{ t('analysis.finished') }}
              </dt>
              <dd>
                {{ formatDateTime(analysis.finishedAt, locale, { seconds: true }) || '–' }}
                <span
                  v-if="duration"
                  class="text-muted tabular-nums"
                >({{ duration }})</span>
              </dd>
            </div>
            <div v-if="analysis.eplanProjectName">
              <dt class="text-muted">
                {{ t('analysis.eplanProject') }}
              </dt>
              <dd class="break-all">
                {{ analysis.eplanProjectName }}
              </dd>
            </div>
            <div v-if="analysis.sourceModified">
              <dt class="text-muted">
                {{ t('project.sourceModified') }}
              </dt>
              <dd>{{ formatDateTime(analysis.sourceModified, locale) }}</dd>
            </div>
            <div v-if="analysis.eplanVersion || analysis.workerVersion">
              <dt class="text-muted">
                {{ t('analysis.versions') }}
              </dt>
              <dd class="break-all">
                <template v-if="analysis.eplanVersion">
                  EPLAN {{ analysis.eplanVersion }}
                </template>
                <template v-if="analysis.workerVersion">
                  · {{ t('analysis.worker') }} {{ analysis.workerVersion }}
                </template>
              </dd>
            </div>
          </dl>

          <UAlert
            v-if="analysis.errorCode"
            :color="analysis.status === 'aborted' ? 'warning' : 'error'"
            variant="subtle"
            :icon="analysis.status === 'aborted' ? 'siemens:stop' : 'siemens:circle-error'"
            :title="analysisError(analysis.errorCode)"
            data-testid="analysis-error"
          >
            <template
              v-if="analysis.errorDetail"
              #description
            >
              <pre class="mt-1 max-h-48 overflow-auto font-mono text-xs break-all whitespace-pre-wrap">{{ analysis.errorDetail }}</pre>
            </template>
          </UAlert>

          <AnalysesCounts
            v-if="analysis.counts"
            :counts="analysis.counts"
          />
        </UPageCard>

        <!-- Ereignisse -->
        <section class="flex flex-col gap-3">
          <div class="flex flex-wrap items-end justify-between gap-3">
            <h2 class="text-lg font-semibold">
              {{ t('analysis.events') }}
              <span class="text-sm font-normal text-muted">({{ events.total }})</span>
            </h2>
            <USelect
              v-model="level"
              :items="levelItems"
              value-key="value"
              class="w-full sm:w-52"
              :aria-label="t('analysis.level')"
              data-testid="event-level"
            />
          </div>
          <AnalysesEventList
            v-if="events.items.length"
            :events="events.items"
          />
          <p
            v-else
            class="text-sm text-muted"
          >
            {{ level !== 'debug' ? t('analysis.noEventsFiltered') : t('analysis.noEvents') }}
          </p>
          <div
            v-if="events.items.length < events.total"
            class="flex items-center justify-center gap-3"
          >
            <span class="text-sm text-muted">{{ t('analysis.showing', { shown: events.items.length, total: events.total }) }}</span>
            <UButton
              v-if="limit < MAX_EVENTS"
              color="secondary"
              :label="t('analysis.loadMore')"
              :loading="eventStatus === 'pending'"
              @click="limit = Math.min(limit + PAGE, MAX_EVENTS)"
            />
          </div>
        </section>

        <!-- Ergebnisse -->
        <section
          v-if="analysis.status === 'succeeded'"
          class="flex min-w-0 flex-col gap-3"
          data-testid="analysis-results"
        >
          <h2 class="text-lg font-semibold">
            {{ t('project.results') }}
          </h2>
          <ResultsResultTabs
            :analysis="analysis"
            :project-name="analysis.projectName"
          />
        </section>
      </div>
    </template>
  </UDashboardPanel>
</template>
