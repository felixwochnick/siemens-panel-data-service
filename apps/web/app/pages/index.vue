<script setup lang="ts">
import type { StatusInfo } from '~~/shared/types/api'

// Vorläufige Übersicht (Task 3): Worker und Warteschlange; die vollständige Oberfläche folgt
const { t } = useI18n()
const { data: status, refresh, pending } = await useFetch<StatusInfo>('/api/status', { key: 'status' })

useHead({ title: () => t('app.overview.title') })
</script>

<template>
  <UDashboardPanel id="overview">
    <template #header>
      <UDashboardNavbar :title="t('app.overview.title')">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <UButton
            icon="siemens:refresh"
            color="neutral"
            variant="ghost"
            :loading="pending"
            :aria-label="t('app.refresh')"
            @click="refresh()"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div
        v-if="status"
        class="grid gap-4 md:grid-cols-2"
      >
        <UPageCard
          :title="t('app.overview.worker')"
          icon="siemens:plant"
        >
          <p data-testid="worker-state">
            {{ t(`app.workerStates.${status.worker.state}`) }}
            <span
              v-if="status.worker.version"
              class="text-muted"
            >({{ status.worker.version }})</span>
          </p>
        </UPageCard>

        <UPageCard
          :title="t('app.overview.queue')"
          icon="siemens:hourglass"
        >
          <p v-if="status.queue.running">
            {{ t('app.overview.running') }}: {{ status.queue.running.projectName }}
            <span
              v-if="status.queue.running.stage"
              class="text-muted"
            >({{ t(`analysisStage.${status.queue.running.stage}`) }})</span>
          </p>
          <p>{{ t('app.overview.queued', { count: status.queue.queuedCount }) }}</p>
        </UPageCard>

        <UPageCard
          :title="t('app.overview.recent')"
          icon="siemens:history"
          class="md:col-span-2"
        >
          <ul
            v-if="status.recentAnalyses.length"
            class="space-y-1"
          >
            <li
              v-for="analysis in status.recentAnalyses"
              :key="analysis.id"
            >
              {{ analysis.projectName }} – {{ t(`analysisStatus.${analysis.status}`) }}
            </li>
          </ul>
          <p
            v-else
            class="text-muted"
          >
            {{ t('app.overview.none') }}
          </p>
        </UPageCard>
      </div>
    </template>
  </UDashboardPanel>
</template>
