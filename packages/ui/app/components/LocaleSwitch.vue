<script setup lang="ts">
// Auf schmalen Bildschirmen nur Symbol und Pfeil, damit der App-Name in der Kopfzeile Platz hat
const { locale, locales, setLocale } = useI18n()

const items = computed(() => locales.value.map(l => ({ label: l.name ?? l.code, value: l.code })))
</script>

<template>
  <USelect
    :model-value="locale"
    :items="items"
    icon="siemens:language"
    variant="ghost"
    class="sm:w-36"
    :ui="{ value: 'hidden sm:block' }"
    :aria-label="$t('common.language')"
    @update:model-value="setLocale($event as typeof locale)"
  />
</template>
