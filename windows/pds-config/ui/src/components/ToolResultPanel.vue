<script setup lang="ts">
import { computed } from 'vue'
import UAlert from '@nuxt/ui/components/Alert.vue'
import UIcon from '@nuxt/ui/components/Icon.vue'
import type { ToolLine } from '../bindings/ToolLine'
import type { ToolResult } from '../bindings/ToolResult'
import { texts } from '../texts'

// Ergebnis eines Werkzeugs (DB-Test, Einrichtung, SQL-Skript, OIDC-Prüfung) mit seinen Schritten
const props = defineProps<{
  result: ToolResult | null
  running?: boolean
}>()

type StepKind = 'ok' | 'warning' | 'error'

// Laut Werkzeug: `details.warning` kennzeichnet eine Warnung (ok: false, Ergebnis bleibt ok)
function kindOf(line: ToolLine): StepKind {
  if (line.ok) return 'ok'
  const details = line.details
  return details && typeof details === 'object' && 'warning' in details ? 'warning' : 'error'
}

const steps = computed(() => (props.result?.steps ?? []).map(line => ({ line, kind: kindOf(line) })))

const color = computed(() => {
  if (!props.result?.ok) return 'error'
  return steps.value.some(step => step.kind !== 'ok') ? 'warning' : 'success'
})

const icons: Record<StepKind, string> = {
  ok: 'siemens:checkmark-medium',
  warning: 'siemens:circle-warning',
  error: 'siemens:circle-error',
}

const iconColors: Record<StepKind, string> = {
  ok: 'text-(--ui-color-feedback-green)',
  warning: 'text-(--ui-color-feedback-orange)',
  error: 'text-(--ui-color-feedback-red)',
}

const labels: Record<StepKind, string> = {
  ok: texts.tool.stepOk,
  warning: texts.tool.stepWarning,
  error: texts.tool.stepError,
}
</script>

<template>
  <p
    v-if="running"
    class="flex items-center gap-2 text-sm text-(--ui-color-text-muted)"
    role="status"
  >
    <UIcon
      name="siemens:refresh"
      class="size-4 animate-spin"
    />
    {{ texts.tool.running }}
  </p>
  <UAlert
    v-else-if="result"
    variant="subtle"
    :color="color"
    :icon="color === 'success' ? 'siemens:circle-checkmark' : color === 'warning' ? 'siemens:circle-warning' : 'siemens:circle-error'"
    :title="result.message"
    data-testid="tool-result"
    :data-ok="result.ok"
  >
    <template
      v-if="steps.length || !result.ok || $slots.default"
      #description
    >
      <ol
        v-if="steps.length"
        class="mt-1 space-y-1"
      >
        <li
          v-for="(step, index) in steps"
          :key="index"
          class="flex items-start gap-2 text-sm text-(--ui-text)"
        >
          <UIcon
            :name="icons[step.kind]"
            class="mt-0.5 size-4 shrink-0"
            :class="iconColors[step.kind]"
          />
          <span><span class="sr-only">{{ labels[step.kind] }}: </span>{{ step.line.message }}</span>
        </li>
      </ol>
      <p
        v-if="!result.ok"
        class="mt-1 font-mono text-xs text-(--ui-color-text-muted)"
      >
        {{ result.code }}
      </p>
      <slot />
    </template>
  </UAlert>
</template>
