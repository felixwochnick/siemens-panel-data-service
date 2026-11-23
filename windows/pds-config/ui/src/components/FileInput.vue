<script setup lang="ts">
import UButton from '@nuxt/ui/components/Button.vue'
import UInput from '@nuxt/ui/components/Input.vue'
import { api } from '../api'
import type { FileFilter } from '../api'
import { useTask } from '../composables/useTask'
import { texts } from '../texts'

// Dateipfad: eintippen oder über den Dateidialog wählen
const props = defineProps<{
  filters: FileFilter[]
  placeholder?: string
}>()
const model = defineModel<string>({ required: true })

const pick = useTask(async () => {
  const path = await api.pickFile(props.filters)
  if (path) model.value = path
})
</script>

<template>
  <div class="flex items-start gap-2">
    <UInput
      v-model="model"
      :placeholder="placeholder ?? texts.addressTls.noFile"
      spellcheck="false"
      class="min-w-0 flex-1"
    />
    <UButton
      color="secondary"
      icon="siemens:folder-open"
      :label="texts.actions.choose"
      :loading="pick.running.value"
      @click="pick.run()"
    />
  </div>
</template>
