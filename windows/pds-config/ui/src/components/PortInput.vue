<script setup lang="ts">
import { computed } from 'vue'
import UInput from '@nuxt/ui/components/Input.vue'
import { toPort } from '../format'

// Portfeld: leer oder ungültig wird 0, die Prüfung meldet das dann am Feld (`invalid_port`)
const model = defineModel<number>({ required: true })

// Als Text, damit ein geleertes Feld leer bleibt statt „0“ zu zeigen
const text = computed({
  get: () => (model.value ? String(model.value) : ''),
  set: (value: string) => (model.value = toPort(value)),
})
</script>

<template>
  <UInput
    v-model="text"
    type="number"
    inputmode="numeric"
    min="1"
    max="65535"
    class="w-full"
  />
</template>
