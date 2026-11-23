<script setup lang="ts">
import type { AnalysisInfo, ProjectDetail, StartAnalysisResponse } from '~~/shared/types/api'

const { t, locale } = useI18n()
const { analysisError, stageText } = useLabels()
const { isAdmin } = useAuth()
const route = useRoute()
const router = useRouter()
const confirm = useConfirmModal()
const { run: start, pending: starting } = useApiAction()
const { run: remove, pending: removing } = useApiAction()

const id = computed(() => Number(route.params.id))
const { data: project, error, refresh } = await useFetch<ProjectDetail>(() => `/api/projects/${id.value}`, { key: `project-${id.value}` })

useSeoMeta({ title: () => project.value?.name ?? t('projects.title') })

const openAnalysis = computed(() => {
  const latest = project.value?.latestAnalysis
  return latest && (latest.status === 'queued' || latest.status === 'running') ? latest : null
})

// Solange eine Analyse wartet oder läuft, alle 3 s nachsehen (Stufe, Ergebnis)
const { pause, resume } = useIntervalFn(() => refresh(), 3000, { immediate: false })
watch(openAnalysis, value => (value ? resume() : pause()))
onMounted(() => {
  if (openAnalysis.value) resume()
})
onBeforeUnmount(pause)

// Gewählter Stand: ?analysis=<id> (nur erfolgreiche haben Ergebnisse), sonst der aktuelle
const selected = computed<AnalysisInfo | null>(() => {
  const wanted = Number(route.query.analysis)
  const found = project.value?.analyses.find(analysis => analysis.id === wanted && analysis.status === 'succeeded')
  return found ?? project.value?.currentAnalysis ?? null
})

const whenOf = (analysis: AnalysisInfo) => formatDateTime(analysis.finishedAt ?? analysis.startedAt ?? analysis.queuedAt, locale.value)

// Auswahl der Stände mit Ergebnissen (Kopf der Tabellen)
const versionItems = computed(() => (project.value?.analyses ?? [])
  .filter(analysis => analysis.status === 'succeeded')
  .map(analysis => ({
    label: `#${analysis.id} · ${whenOf(analysis)}${analysis.isCurrent ? ` (${t('project.current')})` : ''}`,
    value: analysis.id,
  })))

function chooseVersion(value: unknown) {
  const analysis = project.value?.analyses.find(entry => entry.id === Number(value))
  if (analysis) select(analysis)
}

function select(analysis: AnalysisInfo) {
  if (analysis.status !== 'succeeded') return navigateTo(`/analyses/${analysis.id}`)
  router.replace({ query: { ...route.query, analysis: analysis.isCurrent ? undefined : String(analysis.id) } })
}

async function reanalyze() {
  const result = await start(() => $fetch<StartAnalysisResponse>('/api/analyses', { method: 'POST', body: { projectId: id.value } }), {
    success: t('project.queued'),
  })
  if (result) await refresh()
}

async function deleteProject() {
  const confirmed = await confirm({
    title: t('project.deleteTitle'),
    question: t('project.deleteQuestion', { name: project.value?.name ?? '' }),
    confirmLabel: t('common.delete'),
    danger: true,
  })
  if (!confirmed) return
  const deleted = await remove(() => $fetch(`/api/projects/${id.value}`, { method: 'DELETE' }), { success: t('project.deleted') })
  if (deleted) await navigateTo('/projects')
}

async function deleteAnalysis(analysis: AnalysisInfo) {
  const confirmed = await confirm({
    title: t('project.deleteAnalysisTitle'),
    question: t('project.deleteAnalysisQuestion', { id: analysis.id }),
    confirmLabel: t('common.delete'),
    danger: true,
  })
  if (!confirmed) return
  await remove(() => $fetch(`/api/analyses/${analysis.id}`, { method: 'DELETE' }), { success: t('project.analysisDeleted') })
  if (String(analysis.id) === route.query.analysis) await router.replace({ query: { ...route.query, analysis: undefined } })
  await refresh()
}

const notFound = computed(() => (error.value as { statusCode?: number } | null)?.statusCode === 404)
</script>

<template>
  <UDashboardPanel id="project">
    <template #header>
      <UDashboardNavbar :title="project?.name ?? t('projects.title')">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template
          v-if="project"
          #right
        >
          <UButton
            v-if="isAdmin"
            color="error"
            variant="outline"
            icon="siemens:delete"
            :label="t('common.delete')"
            :ui="{ label: 'hidden md:inline' }"
            :aria-label="t('common.delete')"
            :loading="removing"
            :disabled="openAnalysis?.status === 'running'"
            data-testid="project-delete"
            @click="deleteProject"
          />
          <UButton
            icon="siemens:refresh"
            :label="t('project.reanalyze')"
            :ui="{ label: 'hidden sm:inline' }"
            :aria-label="t('project.reanalyze')"
            :loading="starting"
            :disabled="!!openAnalysis"
            data-testid="project-reanalyze"
            @click="reanalyze"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div>
        <UButton
          color="tertiary"
          icon="siemens:arrow-left"
          :label="t('project.back')"
          to="/projects"
          class="-ml-3"
        />
      </div>

      <EmptyState
        v-if="error"
        :icon="notFound ? 'siemens:search' : 'siemens:circle-error'"
        :title="notFound ? t('project.notFound') : t('errors.unknown')"
      />

      <div
        v-else-if="project"
        class="flex min-w-0 flex-col gap-6"
      >
        <!-- Kopf -->
        <UPageCard
          variant="outline"
          :ui="{ container: 'gap-y-3' }"
          data-testid="project-header"
        >
          <div class="flex flex-wrap items-center gap-2">
            <UBadge
              :label="t(`projectSources.${project.source}`)"
              :icon="project.source === 'upload' ? 'siemens:upload' : 'siemens:folder'"
              color="neutral"
              variant="subtle"
            />
            <UBadge
              :label="`.${project.fileKind}`"
              color="neutral"
              variant="outline"
            />
            <AnalysesStatusBadge
              v-if="project.latestAnalysis"
              :status="project.latestAnalysis.status"
            />
          </div>
          <dl class="grid grid-cols-2 gap-x-6 gap-y-2 text-sm lg:grid-cols-4">
            <div
              v-if="project.path"
              class="col-span-2"
            >
              <dt class="text-muted">
                {{ t('project.path') }}
              </dt>
              <dd
                class="break-all"
                data-testid="project-path"
              >
                {{ project.path }}
              </dd>
            </div>
            <div>
              <dt class="text-muted">
                {{ t('project.sourceModified') }}
              </dt>
              <dd>{{ formatDateTime(project.sourceModified, locale) || '–' }}</dd>
            </div>
            <div>
              <dt class="text-muted">
                {{ t('project.created') }}
              </dt>
              <dd>
                {{ formatDateTime(project.createdAt, locale) }}<template v-if="project.createdBy">
                  · {{ project.createdBy }}
                </template>
              </dd>
            </div>
          </dl>

          <!-- Offene Analyse -->
          <div
            v-if="openAnalysis"
            class="flex flex-wrap items-center justify-between gap-3 border border-info/40 bg-info/5 p-3"
            data-testid="project-open-analysis"
          >
            <div class="flex min-w-0 items-center gap-3">
              <AnalysesStatusBadge :status="openAnalysis.status" />
              <span class="text-sm">
                <template v-if="openAnalysis.status === 'running'">{{ stageText(openAnalysis.stage) }}</template>
                <template v-else>{{ t('project.waiting') }}</template>
              </span>
            </div>
            <UButton
              color="secondary"
              size="sm"
              icon="siemens:arrow-right"
              :label="t('project.openAnalysis')"
              :to="`/analyses/${openAnalysis.id}`"
            />
          </div>
        </UPageCard>

        <!-- Ergebnisse des gewählten Stands -->
        <section
          class="flex min-w-0 flex-col gap-3"
          data-testid="project-results"
        >
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <h2 class="text-lg font-semibold">
              {{ t('project.results') }}
            </h2>
            <div
              v-if="selected"
              class="flex w-full flex-wrap items-center gap-2 sm:w-auto"
            >
              <span
                class="text-sm"
                :class="selected.isCurrent ? 'text-muted' : 'font-semibold text-warning'"
                data-testid="project-selected-version"
              >{{ selected.isCurrent ? t('project.showingCurrent', { id: selected.id, at: whenOf(selected) }) : t('project.showingOlder', { id: selected.id, at: whenOf(selected) }) }}</span>
              <USelect
                v-if="versionItems.length > 1"
                :model-value="selected.id"
                :items="versionItems"
                value-key="value"
                size="sm"
                class="w-full sm:w-64"
                :aria-label="t('project.chooseVersion')"
                data-testid="project-version-select"
                @update:model-value="chooseVersion"
              />
              <UButton
                v-if="!selected.isCurrent"
                color="tertiary"
                size="sm"
                icon="siemens:undo"
                :label="t('project.backToCurrent')"
                @click="router.replace({ query: { ...route.query, analysis: undefined } })"
              />
            </div>
          </div>
          <ResultsResultTabs
            v-if="selected"
            :analysis="selected"
            :project-name="project.name"
          />
          <EmptyState
            v-else
            icon="siemens:hourglass"
            :title="t('project.noResults')"
            :description="openAnalysis ? t('project.noResultsRunning') : t('project.noResultsHint')"
          />
        </section>

        <!-- Stände -->
        <section class="flex flex-col gap-3">
          <h2 class="text-lg font-semibold">
            {{ t('project.versions') }}
            <span class="text-sm font-normal text-muted">({{ project.analyses.length }})</span>
          </h2>
          <ul
            v-if="project.analyses.length"
            class="max-h-72 divide-y divide-default overflow-auto border border-default"
            data-testid="project-versions"
          >
            <li
              v-for="analysis in project.analyses"
              :key="analysis.id"
              class="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:gap-3"
              :class="selected?.id === analysis.id ? 'bg-(--ui-primary)/8' : ''"
              data-testid="project-version"
              :data-status="analysis.status"
              :data-selected="selected?.id === analysis.id"
            >
              <button
                type="button"
                class="flex min-w-0 flex-1 cursor-pointer flex-col items-start gap-0.5 text-left"
                :aria-current="selected?.id === analysis.id ? 'true' : undefined"
                @click="select(analysis)"
              >
                <span class="flex flex-wrap items-center gap-2">
                  <span class="font-semibold tabular-nums">#{{ analysis.id }}</span>
                  <AnalysesStatusBadge
                    :status="analysis.status"
                    size="sm"
                  />
                  <UBadge
                    v-if="analysis.isCurrent"
                    :label="t('project.current')"
                    color="primary"
                    variant="subtle"
                    size="sm"
                  />
                  <span class="text-sm text-muted">{{ whenOf(analysis) }}</span>
                </span>
                <span class="text-xs text-muted">
                  {{ t(`analysisTrigger.${analysis.trigger}`) }}<template v-if="analysis.triggeredBy"> · {{ analysis.triggeredBy }}</template>
                  <template v-if="analysis.counts"> · {{ t('projects.countsShort', { connections: analysis.counts.connections, cables: analysis.counts.cables }) }}</template>
                </span>
                <span
                  v-if="analysis.errorCode"
                  class="text-xs text-error"
                >{{ analysisError(analysis.errorCode) }}</span>
              </button>
              <div class="flex shrink-0 items-center gap-1">
                <UButton
                  color="tertiary"
                  size="sm"
                  icon="siemens:document-information"
                  :label="t('project.details')"
                  :to="`/analyses/${analysis.id}`"
                />
                <UButton
                  v-if="isAdmin && analysis.status !== 'running' && !analysis.isCurrent"
                  color="error"
                  variant="ghost"
                  size="sm"
                  square
                  icon="siemens:delete"
                  :aria-label="t('project.deleteAnalysisTitle')"
                  @click="deleteAnalysis(analysis)"
                />
              </div>
            </li>
          </ul>
          <p
            v-else
            class="text-sm text-muted"
          >
            {{ t('project.noVersions') }}
          </p>
        </section>
      </div>
    </template>
  </UDashboardPanel>
</template>
