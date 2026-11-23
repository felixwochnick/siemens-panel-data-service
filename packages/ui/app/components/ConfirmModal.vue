<script setup lang="ts">
const props = defineProps<{
  title?: string
  question?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}>()

const emit = defineEmits<{ close: [value: boolean] }>()
const { t } = useI18n()
</script>

<template>
  <UModal
    :title="props.title ?? t('common.confirm.title')"
    :description="props.question"
    :ui="{ footer: 'justify-end gap-2' }"
  >
    <template #footer>
      <UButton
        color="secondary"
        :label="props.cancelLabel ?? t('common.cancel')"
        @click="emit('close', false)"
      />
      <UButton
        :color="props.danger ? 'error' : 'primary'"
        :variant="props.danger ? 'solid' : 'siemens'"
        :label="props.confirmLabel ?? t('common.confirm.ok')"
        data-testid="confirm-ok"
        @click="emit('close', true)"
      />
    </template>
  </UModal>
</template>
