<script setup lang="ts">
import UButton from '@nuxt/ui/components/Button.vue'
import UModal from '@nuxt/ui/components/Modal.vue'
import { texts } from '../texts'

// Rückfrage vor folgenreichen Aktionen (Dienst stoppen, App-Secret neu erzeugen)
defineProps<{
  title: string
  description: string
  confirmLabel: string
  danger?: boolean
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ confirm: [] }>()

function confirm() {
  open.value = false
  emit('confirm')
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="title"
    :description="description"
    :ui="{ footer: 'justify-end gap-2' }"
  >
    <template #footer>
      <UButton
        color="secondary"
        :label="texts.actions.cancel"
        @click="open = false"
      />
      <UButton
        :color="danger ? 'error' : 'primary'"
        :variant="danger ? 'solid' : 'siemens'"
        :label="confirmLabel"
        data-testid="confirm-ok"
        @click="confirm"
      />
    </template>
  </UModal>
</template>
