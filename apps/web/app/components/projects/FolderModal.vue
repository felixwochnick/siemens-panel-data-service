<script setup lang="ts">
import type { FolderProject, FolderScanResult, StartAnalysisResponse } from '~~/shared/types/api'

// Projekte aus dem Projektordner wählen und einreihen (POST /api/analyses { folderPaths })
const emit = defineEmits<{ close: [result?: StartAnalysisResponse] }>()
const { t, te, locale } = useI18n()
const { errorText } = useLabels()
const { isAdmin } = useAuth()
const toast = useToast()

const { data, status, error, refresh } = useFetch<FolderScanResult>('/api/folder/projects', { key: 'folder-projects', server: false })

const search = ref('')
const changedOnly = ref(false)
const selected = ref<Set<string>>(new Set())
const starting = ref(false)

const errorCode = computed(() => (error.value as { data?: { message?: string } } | null)?.data?.message ?? null)
const notConfigured = computed(() => errorCode.value === 'folder_not_configured')

/** wartet oder läuft schon: nicht erneut wählbar */
const isOpen = (item: FolderProject) => item.project?.latestStatus === 'queued' || item.project?.latestStatus === 'running'

const items = computed(() => {
  const needle = search.value.trim().toLocaleLowerCase('de')
  return (data.value?.items ?? []).filter(item => (!needle || item.path.toLocaleLowerCase('de').includes(needle)) && (!changedOnly.value || item.changed))
})
const selectable = computed(() => items.value.filter(item => !isOpen(item)))
const allSelected = computed(() => selectable.value.length > 0 && selectable.value.every(item => selected.value.has(item.path)))

function toggle(path: string, value: boolean) {
  const next = new Set(selected.value)
  if (value) next.add(path)
  else next.delete(path)
  selected.value = next
}

function toggleAll(value: boolean) {
  const next = new Set(selected.value)
  for (const item of selectable.value) {
    if (value) next.add(item.path)
    else next.delete(item.path)
  }
  selected.value = next
}

function stateOf(item: FolderProject) {
  if (isOpen(item)) return { label: t(`analysisStatus.${item.project!.latestStatus}`), color: 'info' as const }
  if (!item.project) return { label: t('projects.folder.new'), color: 'primary' as const }
  if (item.changed) return { label: t('projects.folder.changed'), color: 'warning' as const }
  return { label: t('projects.folder.upToDate'), color: 'success' as const }
}

const skipText = (code: string) => (te(`folderSkips.${code}`) ? t(`folderSkips.${code}`) : code)
const skipReason = (code: string) => (te(`errors.${code}`) ? t(`errors.${code}`) : code)

async function start() {
  if (!selected.value.size) return
  starting.value = true
  try {
    const result = await $fetch<StartAnalysisResponse>('/api/analyses', { method: 'POST', body: { folderPaths: [...selected.value] } })
    toast.add({
      title: t('projects.folder.queued', { queued: result.queued.length, skipped: result.skipped.length }),
      description: result.skipped.length ? result.skipped.map(skip => `${skip.target}: ${skipReason(skip.code)}`).join('\n') : undefined,
      color: result.queued.length ? 'success' : 'warning',
      icon: result.queued.length ? 'siemens:circle-checkmark' : 'siemens:circle-warning',
    })
    emit('close', result)
  }
  catch (failure) {
    toast.add({ title: errorText(failure), color: 'error', icon: 'siemens:circle-error' })
  }
  finally {
    starting.value = false
  }
}
</script>

<template>
  <UModal
    :title="t('projects.folder.title')"
    :description="data?.folder ? t('projects.folder.description', { folder: data.folder }) : t('projects.folder.descriptionEmpty')"
    :ui="{ content: 'sm:max-w-3xl', footer: 'justify-between gap-2', description: 'break-all' }"
  >
    <template #body>
      <div
        class="flex flex-col gap-3"
        data-testid="folder-dialog"
      >
        <div
          v-if="status === 'pending' || status === 'idle'"
          class="flex items-center gap-2 text-sm text-muted"
        >
          <UIcon
            name="siemens:refresh"
            class="size-5 animate-spin"
          />
          {{ t('projects.folder.scanning') }}
        </div>

        <EmptyState
          v-else-if="notConfigured"
          icon="siemens:folder"
          :title="t('projects.folder.notConfigured')"
          :description="isAdmin ? t('projects.folder.notConfiguredAdmin') : t('projects.folder.notConfiguredUser')"
          data-testid="folder-not-configured"
        >
          <UButton
            v-if="isAdmin"
            color="secondary"
            icon="siemens:settings"
            :label="t('app.nav.settings')"
            to="/settings#folder"
            @click="emit('close')"
          />
        </EmptyState>

        <UAlert
          v-else-if="error"
          color="error"
          variant="subtle"
          icon="siemens:circle-error"
          :title="errorText(error)"
          :actions="[{ label: t('app.refresh'), color: 'secondary', onClick: () => refresh() }]"
        />

        <template v-else-if="data">
          <div class="flex flex-wrap items-center gap-3">
            <UInput
              v-model="search"
              icon="siemens:search"
              :placeholder="t('projects.folder.search')"
              :aria-label="t('projects.folder.search')"
              class="w-full sm:w-72"
              data-testid="folder-search"
            />
            <USwitch
              v-model="changedOnly"
              :label="t('projects.folder.changedOnly')"
            />
          </div>

          <EmptyState
            v-if="!items.length"
            icon="siemens:search"
            :title="data.items.length ? t('projects.folder.noMatches') : t('projects.folder.empty')"
          />
          <div
            v-else
            class="max-h-[50vh] overflow-auto border border-default"
          >
            <div class="sticky top-0 z-10 flex items-center gap-3 border-b border-default bg-elevated px-3 py-2">
              <UCheckbox
                :model-value="allSelected"
                :disabled="!selectable.length"
                :label="t('projects.folder.selectAll', { count: selectable.length })"
                data-testid="folder-select-all"
                @update:model-value="toggleAll($event === true)"
              />
            </div>
            <ul class="divide-y divide-default">
              <li
                v-for="item in items"
                :key="item.path"
                class="flex items-start gap-3 px-3 py-2"
                :class="isOpen(item) ? 'opacity-70' : ''"
                data-testid="folder-item"
                :data-path="item.path"
              >
                <UCheckbox
                  :model-value="selected.has(item.path)"
                  :disabled="isOpen(item)"
                  :aria-label="item.path"
                  class="mt-0.5"
                  @update:model-value="toggle(item.path, $event === true)"
                />
                <div class="min-w-0 flex-1">
                  <p class="font-semibold break-all">
                    {{ item.name }}
                  </p>
                  <p class="text-xs break-all text-muted">
                    {{ item.path }}
                  </p>
                  <p class="text-xs text-muted">
                    {{ t('projects.folder.modified', { at: formatDateTime(item.sourceModified, locale) }) }}
                  </p>
                </div>
                <div class="flex shrink-0 flex-col items-end gap-1">
                  <UBadge
                    :label="stateOf(item).label"
                    :color="stateOf(item).color"
                    variant="subtle"
                    size="sm"
                  />
                  <UBadge
                    :label="`.${item.fileKind}`"
                    color="neutral"
                    variant="outline"
                    size="sm"
                  />
                </div>
              </li>
            </ul>
          </div>

          <UCollapsible
            v-if="data.skipped.length"
            class="text-sm"
          >
            <UButton
              color="tertiary"
              size="sm"
              icon="siemens:circle-warning"
              trailing-icon="siemens:chevron-down"
              :label="t('projects.folder.skipped', { count: data.skipped.length })"
              class="-ml-3"
            />
            <template #content>
              <ul
                class="mt-1 flex flex-col gap-1 text-xs text-muted"
                data-testid="folder-skipped"
              >
                <li
                  v-for="skip in data.skipped"
                  :key="skip.path"
                  class="break-all"
                >
                  {{ skip.path }}: {{ skipText(skip.code) }}
                </li>
              </ul>
            </template>
          </UCollapsible>
        </template>
      </div>
    </template>
    <template #footer>
      <span class="text-sm text-muted">{{ t('projects.folder.selected', { count: selected.size }) }}</span>
      <div class="flex gap-2">
        <UButton
          color="tertiary"
          :label="t('common.cancel')"
          @click="emit('close')"
        />
        <UButton
          icon="siemens:play"
          :label="t('projects.folder.start')"
          :loading="starting"
          :disabled="!selected.size"
          data-testid="folder-start"
          @click="start"
        />
      </div>
    </template>
  </UModal>
</template>
