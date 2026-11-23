<script setup lang="ts">
import type { AnalysisInfo, StatusInfo } from '~~/shared/types/api'
import { ProjectsUploadModal } from '#components'

const { t, locale } = useI18n()
const { settingLabel, issueText, analysisError, stageText } = useLabels()
const { run: toggle, pending: toggling } = useApiAction()
const { run: restart, pending: restarting } = useApiAction()
const confirm = useConfirmModal()
const overlay = useOverlay()
const mounted = useMounted()
const now = useNow({ interval: 1000 })

useSeoMeta({ title: () => t('overview.title') })

const { data: status, refresh, error } = await useFetch<StatusInfo>('/api/status', { key: 'status' })

// Solange etwas läuft oder wartet alle 3 s aktualisieren, sonst alle 30 s (Zeitplan oder andere starten Analysen)
const busy = computed(() => !!status.value && (!!status.value.queue.running || status.value.queue.queuedCount > 0))
const { pause, resume } = useIntervalFn(() => refresh(), () => (busy.value ? 3000 : 30_000), { immediate: false })
onMounted(resume)
onBeforeUnmount(pause)

const running = computed(() => status.value?.queue.running ?? null)
const runningFor = computed(() => {
  const started = running.value?.startedAt
  if (!started || !mounted.value) return ''
  return formatDuration(now.value.getTime() - new Date(started).getTime())
})

const worker = computed(() => status.value?.worker ?? null)
const workerLook = computed(() => {
  switch (worker.value?.state) {
    case 'connected':
      return { color: 'success' as const, icon: 'siemens:radio-waves-connected' }
    case 'connecting':
      return { color: 'info' as const, icon: 'siemens:refresh' }
    case 'disconnected':
      return { color: 'error' as const, icon: 'siemens:radio-waves-disconnected' }
    default:
      return { color: 'neutral' as const, icon: 'siemens:radio-waves-disconnected' }
  }
})

async function setScheduler(enabled: boolean) {
  await toggle(() => $fetch('/api/scheduler', { method: 'PUT', body: { enabled } }), {
    success: t(enabled ? 'overview.schedule.switchedOn' : 'overview.schedule.switchedOff'),
  })
  await refresh()
}

async function restartWorker() {
  const confirmed = await confirm({
    title: t('overview.worker.restartTitle'),
    question: t('overview.worker.restartQuestion'),
    confirmLabel: t('overview.worker.restart'),
    danger: true,
  })
  if (!confirmed) return
  await restart(() => $fetch('/api/worker/restart', { method: 'POST' }), { success: t('overview.worker.restarted') })
  await refresh()
}

async function openUpload() {
  const analysis = await overlay.create(ProjectsUploadModal, { destroyOnClose: true }).open() as AnalysisInfo | undefined
  if (analysis) await navigateTo(`/projects/${analysis.projectId}`)
}

const durationOf = (analysis: AnalysisInfo) => formatDuration(durationBetween(analysis.startedAt, analysis.finishedAt))
</script>

<template>
  <UDashboardPanel id="overview">
    <template #header>
      <UDashboardNavbar :title="t('overview.title')">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <UButton
            color="tertiary"
            icon="siemens:refresh"
            square
            :aria-label="t('app.refresh')"
            @click="refresh()"
          />
          <UButton
            icon="siemens:upload"
            :label="t('projects.upload.button')"
            :ui="{ label: 'hidden sm:inline' }"
            :aria-label="t('projects.upload.button')"
            data-testid="overview-upload"
            @click="openUpload"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UAlert
        v-if="error"
        color="error"
        variant="subtle"
        icon="siemens:circle-error"
        :title="t('errors.unknown')"
      />
      <div
        v-if="status"
        class="flex flex-col gap-6"
      >
        <!-- Hinweise (Admin) -->
        <template v-if="status.admin">
          <UAlert
            v-if="status.admin.unreadableSecrets.length"
            color="error"
            variant="subtle"
            icon="siemens:lock"
            :title="t('overview.issues.unreadableTitle')"
            :description="t('overview.issues.unreadableText')"
            :actions="[{ label: t('overview.issues.fix'), to: '/settings', color: 'secondary' }]"
            data-testid="alert-unreadable"
          />
          <UAlert
            v-if="status.admin.issues.length"
            color="warning"
            variant="subtle"
            icon="siemens:circle-warning"
            :title="t('overview.issues.title')"
            :actions="[{ label: t('overview.issues.fix'), to: '/settings', color: 'secondary' }]"
            data-testid="alert-issues"
          >
            <template #description>
              <p v-if="!status.admin.saved">
                {{ t('overview.issues.unsaved') }}
              </p>
              <ul class="mt-1 list-inside list-disc">
                <li
                  v-for="issue in status.admin.issues"
                  :key="issue.path"
                >
                  {{ settingLabel(issue.path) }}: {{ issueText(issue.code) }}
                </li>
              </ul>
            </template>
          </UAlert>
        </template>
        <UAlert
          v-if="worker?.state === 'disabled' || worker?.state === 'disconnected'"
          :color="worker.state === 'disabled' ? 'info' : 'warning'"
          variant="subtle"
          icon="siemens:radio-waves-disconnected"
          :title="t(`overview.worker.hint.${worker.state}`)"
          :description="t('overview.worker.hint.text')"
          data-testid="alert-worker"
        />

        <div class="grid gap-4 lg:grid-cols-2">
          <!-- EPLAN-Worker -->
          <UPageCard
            variant="outline"
            :ui="{ container: 'gap-y-3 lg:flex' }"
            data-testid="card-worker"
          >
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="flex min-w-0 items-center gap-3">
                <UIcon
                  name="siemens:plant"
                  class="size-6 shrink-0 text-(--ui-color-siemens)"
                />
                <h2 class="text-lg font-semibold">
                  {{ t('overview.worker.title') }}
                </h2>
              </div>
              <UBadge
                v-if="worker"
                :color="workerLook.color"
                :icon="workerLook.icon"
                variant="subtle"
                :label="t(`app.workerStates.${worker.state}`)"
                :ui="{ leadingIcon: worker.state === 'connecting' ? 'animate-spin' : '' }"
                data-testid="worker-state"
                :data-state="worker.state"
              />
            </div>
            <dl
              v-if="worker"
              class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm"
            >
              <dt class="text-muted">
                {{ t('overview.worker.eplan') }}
              </dt>
              <dd data-testid="eplan-state">
                {{ worker.eplan ? t(`eplanStates.${worker.eplan.eplan}`) : '–' }}
                <span
                  v-if="worker.eplan?.eplanVersion"
                  class="text-muted"
                >({{ worker.eplan.eplanVersion }})</span>
                <UBadge
                  v-if="worker.eplan?.busy"
                  color="info"
                  variant="subtle"
                  size="sm"
                  :label="t('overview.worker.busy')"
                  class="ml-1"
                />
              </dd>
              <template v-if="worker.version">
                <dt class="text-muted">
                  {{ t('overview.worker.version') }}
                </dt>
                <dd class="break-all">
                  {{ worker.version }}
                  <span
                    v-if="worker.transport"
                    class="text-muted"
                  >· {{ t(`overview.worker.transports.${worker.transport}`) }}</span>
                </dd>
              </template>
              <dt class="text-muted">
                {{ t('overview.worker.since') }}
              </dt>
              <dd>{{ formatDateTime(worker.since, locale) }}</dd>
            </dl>
            <p
              v-if="worker?.lastError && worker.state !== 'connected'"
              class="text-xs break-all text-error"
            >
              {{ worker.lastError }}
            </p>
            <div v-if="status.admin && worker?.state !== 'disabled'">
              <UButton
                color="secondary"
                size="sm"
                icon="siemens:refresh"
                :label="t('overview.worker.restart')"
                :loading="restarting"
                :disabled="worker?.state !== 'connected'"
                data-testid="worker-restart"
                @click="restartWorker"
              />
            </div>
          </UPageCard>

          <!-- Warteschlange -->
          <UPageCard
            variant="outline"
            :ui="{ container: 'gap-y-3 lg:flex' }"
            data-testid="card-queue"
          >
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="flex min-w-0 items-center gap-3">
                <UIcon
                  name="siemens:hourglass"
                  class="size-6 shrink-0 text-(--ui-color-siemens)"
                />
                <h2 class="text-lg font-semibold">
                  {{ t('overview.queue.title') }}
                </h2>
              </div>
              <span
                class="text-sm text-muted"
                data-testid="queue-count"
              >{{ t('overview.queue.waiting', { count: status.queue.queuedCount }) }}</span>
            </div>
            <div
              v-if="running"
              class="flex flex-col gap-1 border border-default p-3"
              data-testid="queue-running"
            >
              <div class="flex flex-wrap items-center justify-between gap-2">
                <NuxtLink
                  :to="`/analyses/${running.id}`"
                  class="min-w-0 truncate font-semibold text-(--ui-color-siemens) hover:underline"
                >{{ running.projectName }}</NuxtLink>
                <AnalysesStatusBadge status="running" />
              </div>
              <p class="text-sm text-muted">
                <span data-testid="queue-stage">{{ stageText(running.stage) || t('analysisStatus.running') }}</span>
                <template v-if="runningFor">
                  · {{ t('overview.queue.since', { duration: runningFor }) }}
                </template>
              </p>
            </div>
            <p
              v-else
              class="text-sm text-muted"
            >
              {{ t('overview.queue.idle') }}
            </p>
            <ul
              v-if="status.queue.queued.length"
              class="flex flex-col divide-y divide-default text-sm"
              data-testid="queue-waiting"
            >
              <li
                v-for="(analysis, index) in status.queue.queued.slice(0, 8)"
                :key="analysis.id"
                class="flex items-center gap-3 py-1.5"
              >
                <span class="w-6 shrink-0 text-right text-xs text-muted tabular-nums">{{ index + 1 }}.</span>
                <NuxtLink
                  :to="`/analyses/${analysis.id}`"
                  class="min-w-0 flex-1 truncate hover:underline"
                >{{ analysis.projectName }}</NuxtLink>
                <span class="shrink-0 text-xs text-muted">{{ t(`analysisTrigger.${analysis.trigger}`) }}</span>
              </li>
            </ul>
            <p
              v-if="status.queue.queuedCount > 8"
              class="text-xs text-muted"
            >
              {{ t('overview.queue.more', { count: status.queue.queuedCount - 8 }) }}
            </p>
          </UPageCard>

          <!-- Zeitplan (Admin) -->
          <UPageCard
            v-if="status.admin"
            variant="outline"
            :ui="{ container: 'gap-y-3 lg:flex' }"
            data-testid="card-schedule"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="flex min-w-0 items-center gap-3">
                <UIcon
                  name="siemens:calendar"
                  class="size-6 shrink-0 text-(--ui-color-siemens)"
                />
                <h2 class="text-lg font-semibold">
                  {{ t('overview.schedule.title') }}
                </h2>
              </div>
              <USwitch
                :model-value="status.admin.scheduler.enabled"
                :loading="toggling"
                :label="status.admin.scheduler.enabled ? t('overview.schedule.on') : t('overview.schedule.off')"
                :aria-label="t('overview.schedule.toggle')"
                data-testid="scheduler-switch"
                @update:model-value="setScheduler"
              />
            </div>
            <p class="font-mono text-sm">
              {{ status.admin.scheduler.cronSchedule }} <span class="font-sans text-muted">· {{ status.admin.scheduler.timezone }}</span>
            </p>
            <p
              v-if="!status.admin.scheduler.valid"
              class="flex items-center gap-2 text-sm text-error"
            >
              <UIcon
                name="siemens:circle-error"
                class="size-4 shrink-0"
              />
              {{ t('overview.schedule.invalid') }}
            </p>
            <template v-else-if="status.admin.scheduler.enabled">
              <p
                v-if="!status.admin.scheduler.active"
                class="flex items-center gap-2 text-sm text-warning"
              >
                <UIcon
                  name="siemens:circle-warning"
                  class="size-4 shrink-0"
                />
                {{ t('overview.schedule.notActive') }}
              </p>
              <div>
                <p class="text-sm text-muted">
                  {{ t('overview.schedule.next') }}
                </p>
                <ul
                  class="mt-1 flex flex-col gap-0.5 text-sm tabular-nums"
                  data-testid="next-runs"
                >
                  <li
                    v-for="next in status.admin.scheduler.nextRuns"
                    :key="next"
                  >
                    {{ formatDateTime(next, locale, { timeZone: status.admin.scheduler.timezone }) }}
                  </li>
                </ul>
              </div>
            </template>
            <p
              v-else
              class="text-sm text-muted"
            >
              {{ t('overview.schedule.offHint') }}
            </p>
            <div>
              <UButton
                color="tertiary"
                icon="siemens:settings"
                :label="t('overview.schedule.edit')"
                to="/settings#schedule"
                class="-ml-3"
              />
            </div>
          </UPageCard>

          <!-- Zuletzt analysiert -->
          <UPageCard
            variant="outline"
            :ui="{ container: 'gap-y-3 lg:flex' }"
            :class="status.admin ? '' : 'lg:col-span-2'"
            data-testid="card-recent"
          >
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="flex min-w-0 items-center gap-3">
                <UIcon
                  name="siemens:history"
                  class="size-6 shrink-0 text-(--ui-color-siemens)"
                />
                <h2 class="text-lg font-semibold">
                  {{ t('overview.recent.title') }}
                </h2>
              </div>
              <UButton
                color="tertiary"
                icon="siemens:arrow-right"
                :label="t('overview.recent.all')"
                to="/projects"
              />
            </div>
            <ul
              v-if="status.recentAnalyses.length"
              class="flex flex-col divide-y divide-default"
              data-testid="recent-list"
            >
              <li
                v-for="analysis in status.recentAnalyses"
                :key="analysis.id"
                class="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:gap-3"
              >
                <div class="min-w-0 flex-1">
                  <NuxtLink
                    :to="analysis.status === 'succeeded' ? `/projects/${analysis.projectId}?analysis=${analysis.id}` : `/analyses/${analysis.id}`"
                    class="block truncate font-semibold hover:underline"
                  >{{ analysis.projectName }}</NuxtLink>
                  <p class="truncate text-xs text-muted">
                    {{ formatDateTime(analysis.finishedAt, locale) }}
                    <template v-if="durationOf(analysis)">
                      · {{ durationOf(analysis) }}
                    </template>
                    · {{ t(`analysisTrigger.${analysis.trigger}`) }}
                    <template v-if="analysis.counts">
                      · {{ t('overview.recent.summary', { connections: analysis.counts.connections, cables: analysis.counts.cables }) }}
                    </template>
                  </p>
                  <p
                    v-if="analysis.errorCode"
                    class="truncate text-xs text-error"
                    :title="analysisError(analysis.errorCode)"
                  >
                    {{ analysisError(analysis.errorCode) }}
                  </p>
                </div>
                <AnalysesStatusBadge
                  :status="analysis.status"
                  size="sm"
                  class="self-start sm:self-center"
                />
              </li>
            </ul>
            <EmptyState
              v-else
              icon="siemens:folder-open"
              :title="t('overview.recent.none')"
              :description="t('overview.recent.noneHint')"
            />
          </UPageCard>
        </div>

        <!-- Änderungen (Admin) -->
        <UPageCard
          v-if="status.admin"
          :title="t('overview.audit.title')"
          variant="outline"
        >
          <AuditList :entries="status.admin.recentAudit" />
        </UPageCard>

        <p
          class="text-xs text-muted"
          data-testid="database-type"
        >
          {{ t('overview.database', { name: t(`overview.databases.${status.database}`) }) }}
        </p>
      </div>

      <div
        v-else-if="!error"
        class="grid gap-4 lg:grid-cols-2"
      >
        <USkeleton
          v-for="i in 4"
          :key="i"
          class="h-48"
        />
      </div>
    </template>
  </UDashboardPanel>
</template>
