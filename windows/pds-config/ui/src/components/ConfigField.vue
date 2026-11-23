<script setup lang="ts">
import { computed } from 'vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import { useDraft } from '../composables/useDraft'
import FieldFindings from './FieldFindings.vue'

// Formularfeld zu einem Feldpfad der Konfiguration (`db.server`): Befunde stehen direkt unter der
// Eingabe, ein Fehler färbt sie rot, eine Änderung markiert das Label. Die Beschreibung steht unter
// der Eingabe, damit nebeneinanderliegende Eingaben auf einer Höhe beginnen; bei `horizontal`
// (Schalter) steht sie unter dem Label.
const props = defineProps<{
  path: string
  label: string
  description?: string
  horizontal?: boolean
}>()

const { findingsFor, isDirty } = useDraft()
const findings = computed(() => findingsFor(props.path))
const hasError = computed(() => findings.value.some(f => f.severity === 'error'))
const dirty = computed(() => isDirty(props.path))
const helpBelow = computed(() => !props.horizontal && Boolean(props.description))
</script>

<template>
  <UFormField
    :name="path"
    :description="horizontal ? description : undefined"
    :orientation="horizontal ? 'horizontal' : 'vertical'"
    :error="hasError || undefined"
    :data-field="path"
    :data-dirty="dirty || undefined"
    :ui="horizontal ? { root: 'gap-6', container: 'shrink-0' } : undefined"
  >
    <template #label>
      <span class="inline-flex items-center gap-1.5">
        {{ label }}
        <span
          v-if="dirty"
          class="size-1.5 rounded-full bg-(--ui-color-siemens)"
          aria-hidden="true"
        />
      </span>
    </template>
    <slot />
    <template
      v-if="findings.length || helpBelow"
      #help
    >
      <FieldFindings :findings="findings" />
      <p
        v-if="helpBelow"
        class="text-(--ui-color-text-muted)"
        :class="findings.length ? 'mt-1' : ''"
      >
        {{ description }}
      </p>
    </template>
  </UFormField>
</template>
