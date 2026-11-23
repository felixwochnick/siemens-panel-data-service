<script setup lang="ts">
import type { AnalysisCounts } from '~~/shared/types/api'

// Zähler einer erfolgreichen Analyse als Kacheln; nicht zugeordnete #/Verdrillungen als Warnung, wenn > 0
const props = defineProps<{ counts: AnalysisCounts }>()
const { t } = useI18n()

const tiles = computed(() => {
  const c = props.counts
  return [
    { key: 'connections', value: c.connections },
    { key: 'cables', value: c.cables },
    { key: 'shields', value: c.shields },
    { key: 'texts', value: c.texts },
    { key: 'pages', value: c.pages },
    { key: 'hashMarks', value: c.hashMarks, warn: c.unmatchedHashMarks > 0, extra: c.unmatchedHashMarks ? t('analysis.counts.unmatched', { count: c.unmatchedHashMarks }) : '' },
    { key: 'twisted', value: c.twisted, warn: c.unmatchedTwistTicks > 0, extra: c.unmatchedTwistTicks ? t('analysis.counts.unmatchedTicks', { count: c.unmatchedTwistTicks }) : '' },
    { key: 'shielded', value: c.shielded },
  ]
})
</script>

<template>
  <!-- Kacheln brechen nach Platz um; überlappende Ränder ergeben ein Gitter ohne leere Felder -->
  <dl class="flex flex-wrap pt-px pl-px">
    <div
      v-for="tile in tiles"
      :key="tile.key"
      class="-mt-px -ml-px flex min-w-0 flex-1 basis-28 flex-col gap-0.5 border border-default bg-default px-3 py-2"
      :data-testid="`count-${tile.key}`"
    >
      <dt class="truncate text-xs text-muted">
        {{ t(`analysis.counts.${tile.key}`) }}
      </dt>
      <dd class="text-xl font-semibold text-highlighted tabular-nums">
        {{ tile.value }}
      </dd>
      <dd
        v-if="tile.extra"
        class="truncate text-xs"
        :class="tile.warn ? 'text-warning' : 'text-muted'"
        :title="tile.extra"
      >
        {{ tile.extra }}
      </dd>
    </div>
  </dl>
</template>
