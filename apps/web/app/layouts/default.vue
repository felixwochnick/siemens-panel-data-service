<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

const { t } = useI18n()
const route = useRoute()
const { isAdmin } = useAuth()
// Nur ein echtes `true` schaltet ein; aus ⇒ kein Eintrag
const mcpEnabled = useRuntimeConfig().public.mcpEnabled === true

const open = ref(false)
// Mobil: Menü nach Navigation schließen
watch(() => route.fullPath, () => (open.value = false))

// Unterseiten (z. B. /projects/12, /analyses/3) markieren ihren Eintrag
const under = (...paths: string[]) => paths.some(path => route.path === path || route.path.startsWith(`${path}/`))

const nav = computed<NavigationMenuItem[]>(() => [
  { label: t('app.nav.overview'), icon: 'siemens:home', to: '/', exact: true },
  { label: t('app.nav.projects'), icon: 'siemens:folder', to: '/projects', active: under('/projects', '/analyses') },
  // Einstellungen und Protokolle nur für Admins (die API verlangt die Rolle ohnehin)
  ...(isAdmin.value
    ? [
        { label: t('app.nav.settings'), icon: 'siemens:settings', to: '/settings', active: under('/settings') },
        { label: t('app.nav.logs'), icon: 'siemens:document-text', to: '/logs', active: under('/logs') },
      ]
    : []),
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
