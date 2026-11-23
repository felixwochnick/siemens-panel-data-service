<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'

// collapsed: eingeklappte Seitenleiste → nur Symbol
const props = defineProps<{ collapsed?: boolean }>()

const { t, locale, locales, setLocale } = useI18n()
const { user, isAdmin, logout } = useAuth()
const colorMode = useColorMode()
// Nur ein echtes `true` schaltet ein; aus ⇒ kein Eintrag
const mcpEnabled = useRuntimeConfig().public.mcpEnabled === true

const items = computed<DropdownMenuItem[][]>(() => [
  [{ type: 'label', label: user.value?.displayName, description: user.value?.email ?? undefined }],
  [
    ...(mcpEnabled ? [{ label: t('mcp.assistants.title'), icon: 'siemens:ai', to: '/assistants' }] : []),
    {
      label: t('common.language'),
      icon: 'siemens:language',
      children: locales.value.map(l => ({
        label: l.name ?? l.code,
        type: 'checkbox' as const,
        checked: locale.value === l.code,
        onSelect: () => setLocale(l.code),
      })),
    },
    {
      label: t('common.colorMode'),
      icon: colorMode.value === 'dark' ? 'siemens:moon' : 'siemens:sun',
      children: (['light', 'dark', 'system'] as const).map(mode => ({
        label: t(`auth.colorMode.${mode}`),
        type: 'checkbox' as const,
        checked: colorMode.preference === mode,
        onSelect: () => { colorMode.preference = mode },
      })),
    },
  ],
  [{ label: t('auth.logout'), icon: 'siemens:logout', onSelect: logout }],
])
</script>

<template>
  <UDropdownMenu
    v-if="user"
    :items="items"
    :content="{ align: 'start', side: 'top', sideOffset: 8 }"
    :ui="{ content: 'w-(--reka-dropdown-menu-trigger-width) min-w-56' }"
  >
    <UButton
      color="neutral"
      variant="ghost"
      block
      :square="props.collapsed"
      :aria-label="user.displayName"
      class="justify-start data-[state=open]:bg-elevated"
      data-testid="user-menu"
    >
      <UAvatar
        :alt="user.displayName"
        size="xs"
        icon="siemens:user"
      />
      <span
        v-if="!props.collapsed"
        class="min-w-0 flex-1 truncate text-left"
      >
        {{ user.displayName }}
        <UBadge
          v-if="isAdmin"
          size="sm"
          variant="subtle"
          :label="t('auth.adminBadge')"
          class="ml-1"
        />
      </span>
    </UButton>
  </UDropdownMenu>
</template>
