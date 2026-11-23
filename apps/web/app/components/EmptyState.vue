<script setup lang="ts">
const props = defineProps<{ icon?: string, title: string, description?: string }>()
</script>

<template>
  <div class="flex flex-col items-center justify-center gap-3 border border-dashed border-default px-6 py-12 text-center">
    <UIcon
      :name="props.icon ?? 'siemens:folder-open'"
      class="size-10 text-muted"
    />
    <p class="text-base font-semibold">
      {{ props.title }}
    </p>
    <p
      v-if="props.description"
      class="max-w-md text-sm text-muted"
    >
      {{ props.description }}
    </p>
    <div class="mt-2 flex flex-wrap justify-center gap-2 empty:hidden">
      <slot />
    </div>
  </div>
</template>
