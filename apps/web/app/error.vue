<script setup lang="ts">
import type { NuxtError } from '#app'

// Fehlerseite: angemeldet mit Navigation (403 „nur für Admins“, 404), sonst schlicht wie die Anmeldeseite
const props = defineProps<{ error: NuxtError }>()
const { t } = useI18n()
const { loggedIn } = useUserSession()

const kind = computed(() => (props.error.statusCode === 403 ? 'forbidden' : props.error.statusCode === 404 ? 'notFound' : 'general'))
const icon = computed(() => ({ forbidden: 'siemens:lock', notFound: 'siemens:search', general: 'siemens:circle-warning' })[kind.value])

useHead({ title: () => t(`app.error.${kind.value}.title`) })
</script>

<template>
  <UApp>
    <NuxtLayout v-if="loggedIn">
      <UDashboardPanel id="error">
        <template #header>
          <UDashboardNavbar :title="t(`app.error.${kind}.title`)">
            <template #leading>
              <UDashboardSidebarCollapse />
            </template>
          </UDashboardNavbar>
        </template>
        <template #body>
          <div
            class="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-12 text-center"
            :data-testid="`error-${kind}`"
          >
            <UIcon
              :name="icon"
              class="size-14 text-muted"
            />
            <h1 class="text-2xl font-bold">
              {{ t(`app.error.${kind}.title`) }}
            </h1>
            <p class="max-w-md text-muted">
              {{ t(`app.error.${kind}.text`) }}
            </p>
            <UButton
              icon="siemens:home"
              :label="t('app.error.home')"
              @click="clearError({ redirect: '/' })"
            />
          </div>
        </template>
      </UDashboardPanel>
    </NuxtLayout>
    <div
      v-else
      class="flex min-h-dvh flex-col items-center justify-center gap-6 bg-(--color-siemens-primary-light-sand) px-4 text-center dark:bg-(--ui-bg)"
      :data-testid="`error-${kind}`"
    >
      <AppLogo :name="t('auth.appName')" />
      <UIcon
        :name="icon"
        class="size-14 text-muted"
      />
      <div>
        <h1 class="text-2xl font-bold">
          {{ t(`app.error.${kind}.title`) }}
        </h1>
        <p class="mt-2 max-w-md text-muted">
          {{ t(`app.error.${kind}.text`) }}
        </p>
      </div>
      <UButton
        icon="siemens:home"
        :label="t('app.error.home')"
        @click="clearError({ redirect: '/' })"
      />
    </div>
  </UApp>
</template>
