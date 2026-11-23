<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { Component } from 'vue'
import UAlert from '@nuxt/ui/components/Alert.vue'
import UApp from '@nuxt/ui/components/App.vue'
import UBadge from '@nuxt/ui/components/Badge.vue'
import UIcon from '@nuxt/ui/components/Icon.vue'
import UNavigationMenu from '@nuxt/ui/components/NavigationMenu.vue'
import USkeleton from '@nuxt/ui/components/Skeleton.vue'
import UColorModeSelect from '@nuxt/ui/components/color-mode/ColorModeSelect.vue'
import { defineShortcuts } from '@nuxt/ui/composables'
import type { NavigationMenuItem } from '@nuxt/ui'
import { de } from '@nuxt/ui/locale'
import { inTauri } from './api'
import SaveBar from './components/SaveBar.vue'
import { useAppState } from './composables/useAppState'
import { useDraft } from './composables/useDraft'
import { texts } from './texts'
import AddressTlsView from './views/AddressTlsView.vue'
import AssistantsView from './views/AssistantsView.vue'
import DatabaseView from './views/DatabaseView.vue'
import EplanView from './views/EplanView.vue'
import LoginView from './views/LoginView.vue'
import StatusView from './views/StatusView.vue'

type SectionId = 'status' | 'address' | 'database' | 'login' | 'eplan' | 'assistants'

interface Section {
  id: SectionId
  label: string
  icon: string
  view: Component
  /** Erste Teile der Feldpfade, deren Befunde hier stehen */
  fields: string[]
}

const sections: Section[] = [
  { id: 'status', label: texts.sections.status, icon: 'siemens:chart-line', view: StatusView, fields: ['config'] },
  { id: 'address', label: texts.sections.addressTls, icon: 'siemens:lock', view: AddressTlsView, fields: ['public', 'listen', 'internal', 'tls'] },
  { id: 'database', label: texts.sections.database, icon: 'siemens:capacity', view: DatabaseView, fields: ['db'] },
  { id: 'login', label: texts.sections.login, icon: 'siemens:login', view: LoginView, fields: ['oidc', 'proxy', 'app'] },
  // Nicht Teil der Konfigurationsdatei: Einrichten wirkt sofort, ohne Speichern
  { id: 'eplan', label: texts.sections.eplan, icon: 'siemens:configure', view: EplanView, fields: [] },
  { id: 'assistants', label: texts.sections.assistants, icon: 'siemens:ai', view: AssistantsView, fields: ['mcp'] },
]

const app = useAppState()
const { findings } = useDraft()
const demo = !inTauri()

// Bereich steht im Fragment (#database), damit ein Neuladen dort bleibt und Tests ihn direkt öffnen
function sectionFromHash(): SectionId {
  const id = window.location.hash.slice(1)
  return sections.some(section => section.id === id) ? id as SectionId : 'status'
}

const active = ref<SectionId>(sectionFromHash())
const mainEl = ref<HTMLElement>()
watch(active, (id) => {
  history.replaceState(null, '', `#${id}`)
  mainEl.value?.scrollTo({ top: 0 })
})
const current = computed(() => sections.find(section => section.id === active.value) ?? sections[0]!)

const items = computed<NavigationMenuItem[]>(() => sections.map((section) => {
  const own = findings.value.filter(finding => section.fields.includes(finding.field.split('.')[0] ?? ''))
  const errors = own.filter(finding => finding.severity === 'error').length
  const warnings = own.length - errors
  return {
    label: section.label,
    icon: section.icon,
    active: section.id === active.value,
    // Eigener Zähler im Slot `item-trailing`: Zahl sichtbar, „1 Fehler, 2 Warnungen“ für Screenreader.
    // Siemens-Feedbackfarben mit lesbarem Text (Weiß auf Gelb wäre zu schwach).
    findingsBadge: own.length
      ? {
          count: own.length,
          text: texts.app.findingsBadge(errors, warnings),
          class: errors
            ? 'bg-(--ui-color-feedback-red) text-white dark:text-(--color-siemens-primary-deep-blue)'
            : 'bg-(--ui-color-feedback-yellow) text-(--color-siemens-primary-deep-blue)',
        }
      : undefined,
    onSelect: () => (active.value = section.id),
  }
}))

defineShortcuts({
  meta_s: {
    usingInput: true,
    handler: () => app.save(),
  },
})

onMounted(async () => {
  await app.load()
  app.startPolling()
})
</script>

<template>
  <UApp
    :locale="de"
    :toaster="{ position: 'top-right' }"
  >
    <div class="grid h-dvh grid-cols-[15rem_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto]">
      <aside class="flex min-h-0 flex-col border-r border-(--ui-color-surface-strong-border) bg-(--ui-color-surface)">
        <div class="border-b border-(--ui-color-surface-border) px-4 py-4">
          <UIcon
            name="siemens:siemens-logo"
            class="h-5 w-24 text-(--color-siemens-primary-petrol)"
          />
          <p class="mt-3 font-semibold leading-tight">
            {{ texts.app.name }}
          </p>
          <p class="text-sm text-(--ui-color-text-muted)">
            {{ texts.app.subtitle }}
          </p>
          <UBadge
            v-if="demo"
            color="neutral"
            variant="subtle"
            :label="texts.app.demo"
            class="mt-2"
          />
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto px-2 py-3">
          <UNavigationMenu
            :items="items"
            orientation="vertical"
            :aria-label="texts.app.navigation"
            :ui="{ linkLabel: 'whitespace-normal' }"
          >
            <template #item-trailing="{ item }">
              <UBadge
                v-if="item.findingsBadge"
                size="sm"
                :title="item.findingsBadge.text"
                :class="item.findingsBadge.class"
                data-testid="findings-badge"
              >
                <span aria-hidden="true">{{ item.findingsBadge.count }}</span>
                <span class="sr-only">{{ item.findingsBadge.text }}</span>
              </UBadge>
            </template>
          </UNavigationMenu>
        </div>
        <div class="border-t border-(--ui-color-surface-border) px-4 py-3">
          <label
            for="color-mode"
            class="mb-1 block text-xs text-(--ui-color-text-muted)"
          >{{ texts.app.colorMode }}</label>
          <UColorModeSelect
            id="color-mode"
            class="w-full"
          />
        </div>
      </aside>

      <main
        ref="mainEl"
        class="min-h-0 overflow-y-auto"
      >
        <div class="mx-auto max-w-4xl space-y-6 px-6 py-6">
          <UAlert
            v-if="app.staleSeconds.value !== null"
            variant="subtle"
            color="error"
            icon="siemens:circle-error"
            :title="texts.status.stale(app.staleSeconds.value)"
            :description="texts.status.staleDetail"
            data-testid="stale-banner"
          />

          <div
            v-if="app.loading.value"
            class="space-y-4"
            :aria-label="texts.app.loading"
            role="status"
          >
            <USkeleton class="h-8 w-64" />
            <USkeleton class="h-40 w-full" />
            <USkeleton class="h-40 w-full" />
          </div>

          <UAlert
            v-else-if="app.loadError.value"
            variant="subtle"
            color="error"
            icon="siemens:circle-error"
            :title="texts.app.loadFailed"
            :description="app.loadError.value.message"
            :actions="[{ label: texts.app.retry, color: 'secondary', onClick: app.load }]"
          />

          <fieldset
            v-else
            :disabled="app.saving.value"
            class="m-0 min-w-0 border-0 p-0"
          >
            <component
              :is="current.view"
              :key="current.id"
            />
          </fieldset>
        </div>
      </main>

      <SaveBar class="col-span-2" />
    </div>
  </UApp>
</template>
