<script setup lang="ts">
import type { AnalysisEventInfo } from '~~/shared/types/api'

// Ereignisse einer Analyse: Zeit, Stufe (Symbol + Text), Satz in der Sprache der Oberfläche, Rohtext aufklappbar
const props = defineProps<{ events: AnalysisEventInfo[] }>()
const { t, locale } = useI18n()
const { eventText } = useLabels()

const levelLook = {
  debug: { icon: 'siemens:source-code', class: 'text-dimmed' },
  info: { icon: 'siemens:circle-information', class: 'text-info' },
  warn: { icon: 'siemens:circle-warning', class: 'text-warning' },
  error: { icon: 'siemens:circle-error', class: 'text-error' },
}
const expanded = ref(new Set<string>())
function toggle(id: string) {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}
</script>

<template>
  <ol
    class="divide-y divide-default border border-default"
    data-testid="analysis-events"
  >
    <li
      v-for="event in props.events"
      :key="event.id"
      class="flex min-w-0 gap-3 px-3 py-2 text-sm"
      :class="event.level === 'error' ? 'bg-error/5' : event.level === 'warn' ? 'bg-warning/5' : ''"
      :data-code="event.code"
    >
      <UIcon
        :name="levelLook[event.level].icon"
        :class="levelLook[event.level].class"
        class="mt-0.5 size-4 shrink-0"
        :aria-label="t(`logLevels.${event.level}`)"
      />
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-baseline gap-x-3">
          <span class="font-mono text-xs text-muted tabular-nums">{{ formatTime(event.at, locale) }}</span>
          <span class="min-w-0 break-words">{{ eventText(event) }}</span>
        </div>
        <template v-if="event.detail">
          <UButton
            color="tertiary"
            size="xs"
            class="-ml-2 mt-0.5"
            :icon="expanded.has(event.id) ? 'siemens:chevron-up' : 'siemens:chevron-down'"
            :label="t('analysis.showDetail')"
            @click="toggle(event.id)"
          />
          <pre
            v-if="expanded.has(event.id)"
            class="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-all bg-elevated p-2 font-mono text-xs"
          >{{ event.detail }}</pre>
        </template>
      </div>
    </li>
  </ol>
</template>
