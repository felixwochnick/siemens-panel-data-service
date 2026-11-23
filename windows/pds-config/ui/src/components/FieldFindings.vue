<script setup lang="ts">
import UIcon from '@nuxt/ui/components/Icon.vue'
import type { Finding } from '../bindings/Finding'
import { texts } from '../texts'

defineProps<{ findings: Finding[] }>()
</script>

<template>
  <ul
    v-if="findings.length"
    class="space-y-1"
    data-testid="field-findings"
  >
    <li
      v-for="(finding, index) in findings"
      :key="`${index}:${finding.field}:${finding.code}`"
      class="flex items-start gap-1.5 text-sm"
      :class="finding.severity === 'error' ? 'text-(--ui-color-feedback-red)' : 'text-(--ui-text)'"
      :data-severity="finding.severity"
      :data-code="finding.code"
    >
      <UIcon
        :name="finding.severity === 'error' ? 'siemens:circle-error' : 'siemens:circle-warning'"
        class="mt-0.5 size-4 shrink-0"
        :class="finding.severity === 'error' ? 'text-(--ui-color-feedback-red)' : 'text-(--ui-color-feedback-orange)'"
      />
      <span>
        <span class="sr-only">{{ finding.severity === 'error' ? texts.finding.error : texts.finding.warning }}: </span>{{ finding.message }}
      </span>
    </li>
  </ul>
</template>
