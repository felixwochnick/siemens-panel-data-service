<script setup lang="ts">
import type { AnalysisStatus } from '~~/shared/types/api'

// Status nie nur über Farbe: immer mit Symbol und Text
const props = defineProps<{ status: AnalysisStatus, size?: 'sm' | 'md' | 'lg' }>()
const { t } = useI18n()

const look = computed(() => ({
  queued: { color: 'neutral' as const, icon: 'siemens:hourglass' },
  running: { color: 'info' as const, icon: 'siemens:refresh' },
  succeeded: { color: 'success' as const, icon: 'siemens:circle-checkmark' },
  failed: { color: 'error' as const, icon: 'siemens:circle-error' },
  aborted: { color: 'warning' as const, icon: 'siemens:stop' },
}[props.status]))
</script>

<template>
  <UBadge
    :color="look.color"
    variant="subtle"
    :size="props.size ?? 'md'"
    :icon="look.icon"
    :label="t(`analysisStatus.${props.status}`)"
    :ui="{ leadingIcon: props.status === 'running' ? 'animate-spin' : '' }"
    :data-testid="`analysis-status-${props.status}`"
  />
</template>
