<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import { PROJECT_SORTS, PROJECT_SOURCES } from '~~/shared/types/api'
import type { AnalysisInfo, Paged, ProjectInfo, ProjectSort, ProjectSource, StartAnalysisResponse } from '~~/shared/types/api'
import { ProjectsFolderModal, ProjectsUploadModal } from '#components'

const { t, locale } = useI18n()
const { analysisError, stageText } = useLabels()
const route = useRoute()
const router = useRouter()
const overlay = useOverlay()

useSeoMeta({ title: () => t('projects.title') })

const PAGE_SIZE = 25
const queryText = (value: unknown) => (typeof value === 'string' ? value : '')
// Suche, Quelle, Sortierung und Seite stehen in der Adresse (Zurück-Knopf, Lesezeichen)
const search = ref(queryText(route.query.search))
const searchDebounced = refDebounced(search, 300)
const source = ref<ProjectSource | 'all'>((PROJECT_SOURCES as readonly string[]).includes(queryText(route.query.source)) ? route.query.source as ProjectSource : 'all')
const sort = ref<ProjectSort>((PROJECT_SORTS as readonly string[]).includes(queryText(route.query.sort)) ? route.query.sort as ProjectSort : 'name')
const page = ref(Math.max(1, Number(route.query.page) || 1))
watch([searchDebounced, source, sort], () => (page.value = 1))
watch([searchDebounced, source, sort, page], () => {
  router.replace({
    query: {
      search: searchDebounced.value || undefined,
      source: source.value === 'all' ? undefined : source.value,
      sort: sort.value === 'name' ? undefined : sort.value,
      page: page.value > 1 ? String(page.value) : undefined,
    },
  })
})

// Expliziter Schlüssel: der automatische hasht die Refs im query-Objekt (Server ≠ Browser → Daten verworfen)
const { data, status: loadStatus, refresh } = await useFetch<Paged<ProjectInfo>>('/api/projects', {
  key: 'projects',
  query: {
    search: computed(() => searchDebounced.value.trim() || undefined),
    source: computed(() => (source.value === 'all' ? undefined : source.value)),
    sort,
    page,
    pageSize: PAGE_SIZE,
  },
  default: () => ({ items: [], total: 0 }),
})

// Läuft oder wartet etwas, Liste nachziehen
const busy = computed(() => data.value.items.some(p => p.latestAnalysis?.status === 'queued' || p.latestAnalysis?.status === 'running'))
const { pause, resume } = useIntervalFn(() => refresh(), () => (busy.value ? 3000 : 30_000), { immediate: false })
onMounted(resume)
onBeforeUnmount(pause)

const sourceItems = computed(() => [
  { label: t('projects.allSources'), value: 'all' },
  ...PROJECT_SOURCES.map(value => ({ label: t(`projectSources.${value}`), value })),
])
const sortItems = computed(() => PROJECT_SORTS.map(value => ({ label: t(`projects.sorts.${value}`), value })))
const filtered = computed(() => !!searchDebounced.value.trim() || source.value !== 'all')

const columns = computed<TableColumn<ProjectInfo>[]>(() => [
  { accessorKey: 'name', header: t('projects.columns.name') },
  { accessorKey: 'source', header: t('projects.columns.source'), meta: { class: { th: 'hidden md:table-cell', td: 'hidden md:table-cell' } } },
  { id: 'current', header: t('projects.columns.current'), meta: { class: { th: 'hidden lg:table-cell', td: 'hidden lg:table-cell' } } },
  { id: 'status', header: t('projects.columns.status') },
])

function openProject(_event: Event, row: { original: ProjectInfo }) {
  navigateTo(`/projects/${row.original.id}`)
}

async function openUpload() {
  const analysis = await overlay.create(ProjectsUploadModal, { destroyOnClose: true }).open() as AnalysisInfo | undefined
  if (analysis) await navigateTo(`/projects/${analysis.projectId}`)
}

async function openFolder() {
  const result = await overlay.create(ProjectsFolderModal, { destroyOnClose: true }).open() as StartAnalysisResponse | undefined
  if (!result) return
  // Ein einzelnes Projekt gleich öffnen, sonst die Liste aktualisieren
  if (result.queued.length === 1) await navigateTo(`/projects/${result.queued[0]!.projectId}`)
  else await refresh()
}

// Aus der Übersicht oder per Lesezeichen: /projects?upload=1 öffnet den Dialog
onMounted(() => {
  if (route.query.upload) void openUpload()
})
</script>

<template>
  <UDashboardPanel id="projects">
    <template #header>
      <UDashboardNavbar :title="t('projects.title')">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <UButton
            color="secondary"
            icon="siemens:folder-open"
            :label="t('projects.folder.button')"
            :ui="{ label: 'hidden sm:inline' }"
            :aria-label="t('projects.folder.button')"
            data-testid="projects-folder"
            @click="openFolder"
          />
          <UButton
            icon="siemens:upload"
            :label="t('projects.upload.button')"
            :ui="{ label: 'hidden sm:inline' }"
            :aria-label="t('projects.upload.button')"
            data-testid="projects-upload"
            @click="openUpload"
          />
        </template>
      </UDashboardNavbar>
      <UDashboardToolbar>
        <div class="flex w-full min-w-0 flex-wrap items-center gap-2 py-1">
          <UInput
            v-model="search"
            icon="siemens:search"
            :placeholder="t('projects.search')"
            :aria-label="t('projects.search')"
            class="w-full sm:w-72"
            data-testid="projects-search"
          />
          <USelect
            v-model="source"
            :items="sourceItems"
            value-key="value"
            class="w-[calc(50%-0.25rem)] sm:w-44"
            :aria-label="t('projects.columns.source')"
            data-testid="projects-source"
          />
          <USelect
            v-model="sort"
            :items="sortItems"
            value-key="value"
            class="w-[calc(50%-0.25rem)] sm:w-52"
            :aria-label="t('projects.sort')"
            data-testid="projects-sort"
          />
        </div>
      </UDashboardToolbar>
    </template>

    <template #body>
      <EmptyState
        v-if="!data.items.length && loadStatus !== 'pending'"
        icon="siemens:folder-open"
        :title="filtered ? t('projects.emptyFiltered') : t('projects.empty')"
        :description="filtered ? undefined : t('projects.emptyHint')"
        data-testid="projects-empty"
      >
        <template v-if="!filtered">
          <UButton
            icon="siemens:upload"
            :label="t('projects.upload.button')"
            @click="openUpload"
          />
          <UButton
            color="secondary"
            icon="siemens:folder-open"
            :label="t('projects.folder.button')"
            @click="openFolder"
          />
        </template>
      </EmptyState>

      <template v-else>
        <UTable
          :data="data.items"
          :columns="columns"
          :loading="loadStatus === 'pending'"
          class="cursor-pointer"
          data-testid="projects-table"
          @select="openProject"
        >
          <template #name-cell="{ row }">
            <div class="flex min-w-0 flex-col">
              <NuxtLink
                :to="`/projects/${row.original.id}`"
                class="truncate font-semibold text-(--ui-color-siemens) hover:underline"
                data-testid="project-link"
                @click.stop
              >{{ row.original.name }}</NuxtLink>
              <span
                v-if="row.original.path"
                class="max-w-[60vw] truncate text-xs text-muted md:max-w-md"
                :title="row.original.path"
              >{{ row.original.path }}</span>
            </div>
          </template>
          <template #source-cell="{ row }">
            <UBadge
              :label="t(`projectSources.${row.original.source}`)"
              :icon="row.original.source === 'upload' ? 'siemens:upload' : 'siemens:folder'"
              color="neutral"
              variant="subtle"
            />
          </template>
          <template #current-cell="{ row }">
            <div
              v-if="row.original.currentAnalysis"
              class="flex flex-col text-sm"
            >
              <span class="whitespace-nowrap">{{ formatDateTime(row.original.currentAnalysis.finishedAt, locale) }}</span>
              <span
                v-if="row.original.currentAnalysis.counts"
                class="text-xs text-muted"
              >{{ t('projects.countsShort', { connections: row.original.currentAnalysis.counts.connections, cables: row.original.currentAnalysis.counts.cables }) }}</span>
            </div>
            <span
              v-else
              class="text-sm text-muted"
            >–</span>
          </template>
          <template #status-cell="{ row }">
            <div
              v-if="row.original.latestAnalysis"
              class="flex flex-col items-start gap-1"
            >
              <AnalysesStatusBadge :status="row.original.latestAnalysis.status" />
              <span
                v-if="row.original.latestAnalysis.status === 'running' && row.original.latestAnalysis.stage"
                class="text-xs text-muted"
              >{{ stageText(row.original.latestAnalysis.stage) }}</span>
              <span
                v-else-if="row.original.latestAnalysis.errorCode"
                class="max-w-56 truncate text-xs text-error"
                :title="analysisError(row.original.latestAnalysis.errorCode)"
              >{{ analysisError(row.original.latestAnalysis.errorCode) }}</span>
            </div>
          </template>
        </UTable>

        <div
          v-if="data.total > PAGE_SIZE"
          class="flex justify-center"
        >
          <UPagination
            v-model:page="page"
            :total="data.total"
            :items-per-page="PAGE_SIZE"
          />
        </div>
      </template>
    </template>
  </UDashboardPanel>
</template>
