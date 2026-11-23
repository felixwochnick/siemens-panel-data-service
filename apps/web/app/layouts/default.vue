<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

// Vorläufiges Gerüst (Task 3); die Oberfläche mit Projekten, Tabellen und Einstellungen folgt
const { t } = useI18n()
const route = useRoute()
// Nur ein echtes `true` schaltet ein; aus ⇒ kein Eintrag
const mcpEnabled = useRuntimeConfig().public.mcpEnabled === true

const open = ref(false)
// Mobil: Menü nach Navigation schließen
watch(() => route.fullPath, () => (open.value = false))

const nav = computed<NavigationMenuItem[]>(() => [
  { label: t('app.nav.overview'), icon: 'siemens:home', to: '/', exact: true },
])

const secondaryNav = computed<NavigationMenuItem[]>(() => mcpEnabled
  ? [{ label: t('app.nav.assistants'), icon: 'siemens:ai', to: '/assistants' }]
  : [])
</script>

<template>
  <UDashboardGroup unit="rem">
    <UDashboardSidebar
      v-model:open="open"
      collapsible
      resizable
      :default-size="16"
      :min-size="13"
      :max-size="22"
      :ui="{ footer: 'border-t border-default', header: 'border-b border-default' }"
    >
      <template #header="{ collapsed }">
        <NuxtLink
          to="/"
          class="flex min-w-0 items-center"
          :class="collapsed ? 'mx-auto' : ''"
        >
          <AppLogo
            :name="collapsed ? undefined : t('app.name')"
            icon="siemens:pds"
            :collapsed="collapsed"
          />
        </NuxtLink>
      </template>

      <template #default="{ collapsed }">
        <UNavigationMenu
          :items="nav"
          :collapsed="collapsed"
          orientation="vertical"
          tooltip
          data-testid="main-nav"
        />
        <UNavigationMenu
          v-if="secondaryNav.length"
          :items="secondaryNav"
          :collapsed="collapsed"
          orientation="vertical"
          tooltip
          class="mt-auto"
        />
      </template>

      <template #footer="{ collapsed }">
        <UserMenu :collapsed="collapsed" />
      </template>
    </UDashboardSidebar>

    <slot />
  </UDashboardGroup>
</template>
