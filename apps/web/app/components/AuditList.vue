<script setup lang="ts">
import type { AuditEntry } from '~~/shared/types/api'

const props = defineProps<{ entries: AuditEntry[] }>()
const { t, locale } = useI18n()
const { auditText } = useLabels()
</script>

<template>
  <p
    v-if="!props.entries.length"
    class="text-sm text-muted"
  >
    {{ t('overview.audit.empty') }}
  </p>
  <ul
    v-else
    class="flex flex-col divide-y divide-default"
    data-testid="audit-list"
  >
    <li
      v-for="entry in props.entries"
      :key="entry.id"
      class="flex flex-col gap-0.5 py-2 sm:flex-row sm:items-baseline sm:gap-3"
    >
      <span class="shrink-0 text-xs text-muted tabular-nums sm:w-36">{{ formatDateTime(entry.at, locale) }}</span>
      <span class="min-w-0 flex-1 text-sm break-words">
        {{ auditText(entry) }}
        <UBadge
          v-if="entry.details?.via === 'mcp'"
          :label="t('overview.audit.viaMcp')"
          icon="siemens:ai"
          color="neutral"
          variant="subtle"
          size="sm"
          class="ml-1"
        />
      </span>
      <span class="shrink-0 text-xs text-muted">{{ entry.user ?? t('audit.system') }}</span>
    </li>
  </ul>
</template>
