<script setup lang="ts">
import type { CheckResult, ConnectionTestResult, SettingsInput } from '~~/shared/types/api'

// Verbindungstest mit den Werten des Formulars (Netzlaufwerk, Projektordner, EPLAN-Worker); startet beim Öffnen
const props = defineProps<{ input: SettingsInput }>()
const emit = defineEmits<{ close: [] }>()
const { t, te } = useI18n()
const { errorText } = useLabels()

const result = ref<ConnectionTestResult | null>(null)
const failure = ref('')
const pending = ref(false)

async function test() {
  pending.value = true
  failure.value = ''
  result.value = null
  try {
    result.value = await $fetch<ConnectionTestResult>('/api/settings/test', { method: 'POST', body: props.input })
  }
  catch (error) {
    failure.value = errorText(error)
  }
  finally {
    pending.value = false
  }
}
onMounted(test)

const rows = computed(() => {
  const r = result.value
  if (!r) return []
  return ([['drive', r.drive], ['folder', r.folder], ['worker', r.worker]] as const)
    .filter((row): row is readonly ['drive' | 'folder' | 'worker', CheckResult] => !!row[1])
    .map(([key, check]) => ({ key, check }))
})

const checkText = (check: CheckResult) => {
  if (!te(`checks.${check.code}`)) return check.code
  const params: Record<string, string | number> = { ...check.params }
  // Zustand von EPLAN im Worker als Text statt Code
  if (typeof params.eplan === 'string' && te(`eplanStates.${params.eplan}`)) params.eplan = t(`eplanStates.${params.eplan}`)
  return t(`checks.${check.code}`, params)
}
</script>

<template>
  <UModal
    :title="t('settings.testDialog.title')"
    :description="t('settings.testDialog.description')"
    :ui="{ footer: 'justify-end gap-2' }"
  >
    <template #body>
      <div
        class="flex flex-col gap-3"
        data-testid="connection-test"
      >
        <div
          v-if="pending"
          class="flex items-center gap-2 text-sm text-muted"
        >
          <UIcon
            name="siemens:refresh"
            class="size-5 animate-spin"
          />
          {{ t('settings.testDialog.running') }}
        </div>
        <UAlert
          v-else-if="failure"
          color="error"
          variant="subtle"
          icon="siemens:circle-error"
          :title="failure"
        />
        <ul
          v-else
          class="flex flex-col divide-y divide-default border border-default"
        >
          <li
            v-for="row in rows"
            :key="row.key"
            class="flex gap-3 p-3"
            :data-testid="`check-${row.key}`"
            :data-ok="row.check.ok"
          >
            <UIcon
              :name="row.check.ok ? 'siemens:circle-checkmark' : 'siemens:circle-error'"
              :class="row.check.ok ? 'text-success' : 'text-error'"
              class="mt-0.5 size-5 shrink-0"
            />
            <div class="min-w-0 flex-1">
              <p class="font-semibold">
                {{ t(`settings.testDialog.${row.key}`) }}
              </p>
              <p class="text-sm break-words">
                {{ checkText(row.check) }}
              </p>
              <pre
                v-if="row.check.detail"
                class="mt-1 max-h-32 overflow-auto bg-elevated p-2 font-mono text-xs break-all whitespace-pre-wrap"
              >{{ row.check.detail }}</pre>
            </div>
          </li>
        </ul>
      </div>
    </template>
    <template #footer>
      <UButton
        color="secondary"
        icon="siemens:refresh"
        :label="t('settings.testDialog.again')"
        :disabled="pending"
        @click="test"
      />
      <UButton
        :label="t('common.close')"
        @click="emit('close')"
      />
    </template>
  </UModal>
</template>
