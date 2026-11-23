<script setup lang="ts">
import type { LogsInfo, LogTail } from '~~/shared/types/api'

definePageMeta({ admin: true })

const { t, locale } = useI18n()
const { errorText } = useLabels()

useSeoMeta({ title: () => t('logs.title') })

const { data: info } = await useFetch<LogsInfo>('/api/logs', { key: 'logs' })

const files = computed(() => info.value?.files ?? [])
// app.log enthält die Analysen – als Vorauswahl am nützlichsten
const selected = ref<string | undefined>(files.value.find(f => f.name === 'app.log')?.name ?? files.value[0]?.name)
const lineCount = ref(200)
const filter = ref('')
const filterDebounced = refDebounced(filter, 300)
const autoRefresh = ref(false)

const { data: tail, status, error, refresh } = await useFetch<LogTail>('/api/logs/tail', {
  key: 'log-tail',
  query: { name: selected, lines: lineCount, filter: filterDebounced },
  immediate: !!selected.value,
  watch: [selected, lineCount, filterDebounced],
})

const { pause, resume } = useIntervalFn(() => refresh(), 3000, { immediate: false })
watch(autoRefresh, value => (value ? resume() : pause()))
onBeforeUnmount(pause)

const fileItems = computed(() => files.value.map(f => ({ label: f.name, value: f.name })))
const lineItems = [100, 200, 500, 1000, 2000].map(n => ({ label: String(n), value: n }))
const downloadUrl = computed(() => (selected.value ? `/api/logs/download?name=${encodeURIComponent(selected.value)}` : undefined))

// Neueste Zeilen sichtbar: nach dem Laden ans Ende scrollen
const output = ref<HTMLElement | null>(null)
watch(() => tail.value?.lines, async () => {
  await nextTick()
  if (output.value) output.value.scrollTop = output.value.scrollHeight
}, { flush: 'post' })
</script>

<template>
  <UDashboardPanel id="logs">
    <template #header>
      <UDashboardNavbar :title="t('logs.title')">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template
          v-if="info?.configured && files.length"
          #right
        >
          <UButton
            color="tertiary"
            icon="siemens:refresh"
            square
            :aria-label="t('app.refresh')"
            :loading="status === 'pending'"
            @click="refresh()"
          />
          <UButton
            color="secondary"
            icon="siemens:download"
            :label="t('logs.download')"
            :ui="{ label: 'hidden sm:inline' }"
            :aria-label="t('logs.download')"
            :to="downloadUrl"
            external
            download
            data-testid="log-download"
          />
        </template>
      </UDashboardNavbar>
      <UDashboardToolbar v-if="info?.configured && files.length">
        <div class="flex w-full min-w-0 items-center gap-2">
          <USelect
            v-model="selected"
            :items="fileItems"
            value-key="value"
            class="w-32 shrink-0 sm:w-44"
            :aria-label="t('logs.file')"
            data-testid="log-file"
          />
          <USelect
            v-model="lineCount"
            :items="lineItems"
            value-key="value"
            class="w-20 shrink-0 sm:w-24"
            :aria-label="t('logs.lines')"
          />
          <UInput
            v-model="filter"
            icon="siemens:filter"
            :placeholder="t('logs.filter')"
            :aria-label="t('logs.filter')"
            class="min-w-0 flex-1 sm:max-w-64"
            data-testid="log-filter"
          />
        </div>
      </UDashboardToolbar>
    </template>

    <template #body>
      <EmptyState
        v-if="!info?.configured"
        icon="siemens:document-text"
        :title="t('logs.notConfigured')"
        :description="t('logs.notConfiguredHint')"
        data-testid="logs-not-configured"
      />
      <EmptyState
        v-else-if="!info.readable"
        icon="siemens:circle-warning"
        :title="t('logs.unreadable')"
        :description="t('logs.unreadableHint')"
      />
      <EmptyState
        v-else-if="!files.length"
        icon="siemens:document-text"
        :title="t('logs.empty')"
      />
      <div
        v-else
        class="flex min-h-0 flex-1 flex-col gap-2"
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-xs text-muted">
            <template v-if="tail">
              {{ t('logs.size', { size: formatBytes(tail.size, locale), at: formatDateTime(tail.modifiedAt, locale) }) }}
              <template v-if="tail.truncated">
                · {{ t('logs.truncated') }}
              </template>
            </template>
          </p>
          <USwitch
            v-model="autoRefresh"
            size="sm"
            :label="t('logs.autoRefresh')"
            :aria-label="t('logs.autoRefresh')"
          />
        </div>
        <UAlert
          v-if="error"
          color="error"
          variant="subtle"
          icon="siemens:circle-error"
          :title="errorText(error)"
        />
        <pre
          v-else
          ref="output"
          class="min-h-64 flex-1 overflow-auto border border-default bg-elevated p-3 font-mono text-xs leading-relaxed"
          data-testid="log-lines"
        ><template v-if="tail?.lines.length">{{ tail.lines.join('\n') }}</template><span
          v-else
          class="text-muted"
        >{{ filterDebounced ? t('logs.noMatches', { filter: filterDebounced }) : t('logs.noLines') }}</span></pre>
      </div>
    </template>
  </UDashboardPanel>
</template>
