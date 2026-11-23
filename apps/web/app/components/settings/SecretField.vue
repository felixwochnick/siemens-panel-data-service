<script setup lang="ts">
import type { SecretInput, SecretState } from '~~/shared/types/api'

/*
 * Verdecktes Geheimnis im Formular (Netzlaufwerk-Passwort, wie im ESWC): zeigt nur den Zustand (gesetzt, nicht
 * gesetzt, nicht lesbar). Ein neuer Wert wird erst nach „Ändern“ eingegeben; leer bleibt der gespeicherte Wert
 * unverändert, null entfernt ihn. `reenter`: das Ziel (Freigabe, Benutzer) wurde geändert, der gespeicherte Wert gilt
 * dafür nicht mehr.
 */
const props = defineProps<{ state: SecretState, optional?: boolean, reenter?: boolean, id?: string, testid?: string }>()
const model = defineModel<SecretInput | undefined>()
const { t } = useI18n()

const editing = ref(false)
watch(model, (value) => {
  if (value === undefined) editing.value = false
})

const look = computed(() => {
  if (model.value === null) return { label: t('settings.secret.willClear'), color: 'warning' as const, icon: 'siemens:delete' }
  if (props.reenter) return { label: t('settings.secret.reenter'), color: 'warning' as const, icon: 'siemens:circle-warning' }
  if (props.state.set && !props.state.readable) return { label: t('settings.secret.unreadable'), color: 'error' as const, icon: 'siemens:circle-error' }
  if (props.state.set) return { label: t('settings.secret.set'), color: 'success' as const, icon: 'siemens:lock' }
  return { label: t('settings.secret.notSet'), color: 'neutral' as const, icon: 'siemens:lock-open' }
})

const text = computed({
  get: () => (typeof model.value === 'string' ? model.value : ''),
  set: (value: string) => (model.value = value),
})

function startEditing() {
  editing.value = true
  model.value = ''
}

function reset() {
  editing.value = false
  model.value = undefined
}
</script>

<template>
  <div
    class="flex flex-col gap-2"
    :data-testid="props.testid"
  >
    <UInput
      v-if="editing && typeof model === 'string'"
      :id="props.id"
      v-model="text"
      type="password"
      autocomplete="new-password"
      :placeholder="t('settings.secret.placeholder')"
      class="w-full"
      :data-testid="props.testid ? `${props.testid}-input` : undefined"
    >
      <template #trailing>
        <UButton
          color="tertiary"
          size="xs"
          icon="siemens:close"
          :aria-label="t('settings.secret.cancel')"
          @click="reset"
        />
      </template>
    </UInput>
    <div
      v-else
      class="flex flex-wrap items-center gap-2"
    >
      <UBadge
        :label="look.label"
        :color="look.color"
        :icon="look.icon"
        variant="subtle"
        :data-testid="props.testid ? `${props.testid}-state` : undefined"
      />
      <UButton
        v-if="model === undefined"
        :id="props.id"
        color="secondary"
        size="sm"
        icon="siemens:edit"
        :label="props.state.set && !props.reenter ? t('settings.secret.change') : t('settings.secret.enter')"
        :data-testid="props.testid ? `${props.testid}-change` : undefined"
        @click="startEditing"
      />
      <UButton
        v-if="model === undefined && props.optional && props.state.set"
        color="tertiary"
        size="sm"
        icon="siemens:delete"
        :label="t('settings.secret.remove')"
        @click="model = null"
      />
      <UButton
        v-if="model !== undefined"
        color="tertiary"
        size="sm"
        icon="siemens:undo"
        :label="t('settings.secret.cancel')"
        @click="reset"
      />
    </div>
  </div>
</template>
