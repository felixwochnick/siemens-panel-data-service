<script setup lang="ts">
// Siemens-Logo plus App-Name; collapsed zeigt nur das App-Symbol. Ein langer Name bricht in eine zweite Zeile um,
// statt abgeschnitten zu werden (Seitenleiste, schmale Kopfzeilen auf dem Handy)
const props = defineProps<{ name?: string, icon?: string, collapsed?: boolean }>()
</script>

<template>
  <div class="flex min-w-0 items-center gap-3">
    <UIcon
      v-if="props.collapsed"
      :name="props.icon ?? 'siemens:apps'"
      class="size-6 shrink-0 text-(--ui-color-siemens)"
    />
    <template v-else>
      <UIcon
        name="siemens:siemens-logo"
        class="h-5 w-24 shrink-0 text-(--color-siemens-primary-petrol)"
      />
      <span
        v-if="props.name"
        class="line-clamp-2 min-w-0 border-l border-default pl-3 text-sm leading-tight font-semibold"
        :title="props.name"
      >{{ props.name }}</span>
    </template>
  </div>
</template>
