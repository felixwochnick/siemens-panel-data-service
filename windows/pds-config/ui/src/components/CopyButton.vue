<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import UButton from '@nuxt/ui/components/Button.vue'
import { useErrorToast } from '../composables/useTask'
import { texts } from '../texts'

const props = defineProps<{ value: string }>()

const copied = ref(false)
const showError = useErrorToast()
let timer: ReturnType<typeof setTimeout> | undefined

async function copy() {
  try {
    await navigator.clipboard.writeText(props.value)
    copied.value = true
    clearTimeout(timer)
    timer = setTimeout(() => (copied.value = false), 2000)
  }
  catch (error) {
    showError(error)
  }
}

onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <UButton
    color="secondary"
    :icon="copied ? 'siemens:checkmark-small' : 'siemens:copy'"
    :label="copied ? texts.actions.copied : texts.actions.copy"
    @click="copy"
  />
</template>
