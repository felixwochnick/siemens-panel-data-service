<script setup lang="ts">
import { computed } from 'vue'
import UAlert from '@nuxt/ui/components/Alert.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import { useAppState } from '../composables/useAppState'
import { useDraft } from '../composables/useDraft'
import { texts } from '../texts'

// Feste Leiste unten: Stand des Entwurfs, Verwerfen/Speichern und das Ergebnis des letzten Speicherns
const { dirtyCount, errorCount, warningCount, validating, validationError, reset } = useDraft()
const { saving, canSave, outcome, save } = useAppState()

const result = computed(() => {
  const value = outcome.value
  if (!value) return null
  if (!value.saved) {
    return { color: 'error' as const, icon: 'siemens:circle-error', title: texts.saveBar.notSaved, description: texts.saveBar.notSavedDetail }
  }
  const apply = value.apply
  if (!apply) {
    return { color: 'info' as const, icon: 'siemens:circle-information', title: texts.saveBar.savedOnly, description: texts.saveBar.notRestarted }
  }
  const description = `${apply.message} (${texts.saveBar.waited(apply.waitedSeconds)})`
  if (!apply.ok) return { color: 'error' as const, icon: 'siemens:circle-error', title: texts.saveBar.applyFailed, description }
  // Läuft, aber mit Einschränkung (etwa Firewall-Regel nicht angelegt)
  return value.warnings.length
    ? { color: 'warning' as const, icon: 'siemens:circle-warning', title: texts.saveBar.applied, description }
    : { color: 'success' as const, icon: 'siemens:circle-checkmark', title: texts.saveBar.applied, description }
})

// Gespeichert, aber mit Einschränkung: Firewall-Regel, Grund für den ausgebliebenen Neustart
const warnings = computed(() => outcome.value?.saved ? outcome.value.warnings : [])
</script>

<template>
  <footer
    class="border-t border-(--ui-color-surface-strong-border) bg-(--ui-color-surface)"
    data-testid="save-bar"
  >
    <!-- Abstand am Rahmen statt am Alert: der ist w-full und liefe mit Rand über -->
    <div
      v-if="result"
      class="px-6 pt-3"
    >
      <UAlert
        variant="subtle"
        :color="result.color"
        :icon="result.icon"
        :title="result.title"
        close
        data-testid="save-outcome"
        @update:open="outcome = null"
      >
        <template #description>
          <p>{{ result.description }}</p>
          <ul
            v-if="warnings.length"
            class="mt-1 list-disc pl-5"
            data-testid="save-warnings"
          >
            <li
              v-for="(warning, index) in warnings"
              :key="index"
            >
              {{ warning }}
            </li>
          </ul>
        </template>
      </UAlert>
    </div>
    <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-6 py-3">
      <p
        class="min-w-0 text-sm"
        aria-live="polite"
        data-testid="save-summary"
      >
        <span v-if="saving">{{ texts.saveBar.saving }}</span>
        <template v-else>
          <span>{{ texts.saveBar.changes(dirtyCount) }}</span>
          <span class="text-(--ui-color-text-subtle)"> · </span>
          <span :class="errorCount ? 'font-semibold text-(--ui-color-feedback-red)' : ''">{{ texts.saveBar.errors(errorCount) }}</span>
          <template v-if="warningCount">
            <span class="text-(--ui-color-text-subtle)"> · </span>
            <span>{{ texts.saveBar.warnings(warningCount) }}</span>
          </template>
          <template v-if="validating">
            <span class="text-(--ui-color-text-subtle)"> · </span>
            <span class="text-(--ui-color-text-muted)">{{ texts.saveBar.validating }}</span>
          </template>
          <template v-else-if="validationError">
            <span class="text-(--ui-color-text-subtle)"> · </span>
            <span class="text-(--ui-color-feedback-red)">{{ texts.errors.validationFailed }}</span>
          </template>
        </template>
      </p>
      <div class="flex shrink-0 gap-2">
        <UButton
          color="secondary"
          icon="siemens:undo"
          :label="texts.actions.discard"
          :disabled="dirtyCount === 0 || saving"
          data-testid="discard"
          @click="reset()"
        />
        <UButton
          icon="siemens:save"
          :label="texts.actions.save"
          :loading="saving"
          :disabled="!canSave"
          :title="errorCount ? texts.saveBar.blocked : undefined"
          data-testid="save"
          @click="save()"
        />
      </div>
    </div>
  </footer>
</template>
