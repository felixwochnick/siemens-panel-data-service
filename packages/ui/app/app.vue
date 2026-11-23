<script setup lang="ts">
import { de, en } from '@nuxt/ui/locale'

const { locale } = useI18n()
const uiLocale = computed(() => (locale.value === 'en' ? en : de))

useHead({ htmlAttrs: { lang: locale } })
</script>

<template>
  <UApp :locale="uiLocale">
    <!-- Feste Farbe (Siemens Petrol): eine CSS-Variable im background-Shorthand führt zu Hydration-Abweichungen -->
    <NuxtLoadingIndicator color="#009999" />
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
