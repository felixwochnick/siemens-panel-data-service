<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UInput from '@nuxt/ui/components/Input.vue'
import { fromValue, removed, secretMode, secretValue, typed, unchanged } from '../secret'
import type { SecretField } from '../secret'
import { texts } from '../texts'

// Secret-Feld: leer gelassen bleibt der gespeicherte Wert, „Entfernen“ löscht ihn (Übergänge in secret.ts).
const props = defineProps<{
  /** Geladener Wert ("***" oder "") */
  original: string
}>()
const model = defineModel<string>({ required: true })

const field = ref<SecretField>(fromValue(props.original, model.value))
const visible = ref(false)
const mode = computed(() => secretMode(props.original, field.value))

function update(next: SecretField) {
  field.value = next
  model.value = secretValue(props.original, next)
}

// Von außen geändert (Verwerfen, neu Laden): Feldzustand daraus ableiten. Eigene Änderungen ergeben
// denselben Wert und lassen den Eingabetext stehen.
watch([model, () => props.original], ([value, original]) => {
  if (value !== secretValue(original, field.value)) field.value = fromValue(original, value)
})

const placeholder = computed(() => {
  switch (mode.value) {
    case 'set': return texts.secret.setPlaceholder
    case 'removed': return texts.secret.removedPlaceholder
    default: return texts.secret.emptyPlaceholder
  }
})
</script>

<template>
  <div
    class="flex items-start gap-2"
    :data-secret-state="mode"
  >
    <UInput
      :model-value="field.text"
      :type="visible ? 'text' : 'password'"
      :placeholder="placeholder"
      autocomplete="new-password"
      spellcheck="false"
      class="min-w-0 flex-1"
      @update:model-value="value => update(typed(String(value ?? '')))"
    >
      <template
        v-if="mode === 'new'"
        #trailing
      >
        <UButton
          color="tertiary"
          size="xs"
          :icon="visible ? 'siemens:view-off' : 'siemens:view'"
          :aria-label="visible ? texts.actions.hideSecret : texts.actions.showSecret"
          :aria-pressed="visible"
          @click="visible = !visible"
        />
      </template>
    </UInput>
    <UButton
      v-if="mode === 'removed'"
      color="tertiary"
      icon="siemens:undo"
      :label="texts.actions.undo"
      @click="update(unchanged())"
    />
    <UButton
      v-else-if="original !== ''"
      color="tertiary"
      icon="siemens:delete"
      :label="texts.actions.remove"
      @click="update(removed())"
    />
  </div>
</template>
