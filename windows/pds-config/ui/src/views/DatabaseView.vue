<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import UAlert from '@nuxt/ui/components/Alert.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UCard from '@nuxt/ui/components/Card.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import UInput from '@nuxt/ui/components/Input.vue'
import UModal from '@nuxt/ui/components/Modal.vue'
import URadioGroup from '@nuxt/ui/components/RadioGroup.vue'
import USwitch from '@nuxt/ui/components/Switch.vue'
import { api } from '../api'
import type { DbKind } from '../bindings/DbKind'
import type { ToolResult } from '../bindings/ToolResult'
import ConfigField from '../components/ConfigField.vue'
import PortInput from '../components/PortInput.vue'
import SecretInput from '../components/SecretInput.vue'
import ToolResultPanel from '../components/ToolResultPanel.vue'
import { useAppState } from '../composables/useAppState'
import { useDraft } from '../composables/useDraft'
import { useTask } from '../composables/useTask'
import { backupFileName, formatBytes } from '../format'
import { texts } from '../texts'

const t = texts.database
const { draft, original, markSecretSet } = useDraft()
const { defaultDbPath } = useAppState()

const kinds: DbKind[] = ['sqlserver', 'sqlite']
const kindItems = kinds.map(kind => ({ value: kind, label: t.kinds[kind].label, description: t.kinds[kind].description }))
const sqlite = computed(() => draft.value.db.kind === 'sqlite')
// Gespeichert ist eine andere Art: Nach dem Speichern fände die App eine leere Datenbank vor
const kindChanged = computed(() => draft.value.db.kind !== original.value.db.kind)

const result = ref<ToolResult | null>(null)
const scriptPath = ref<string | null>(null)
const backup = ref<{ file: string, size: string | null } | null>(null)
const passwordGenerated = ref(false)

function clearResult() {
  result.value = null
  scriptPath.value = null
  backup.value = null
  passwordGenerated.value = false
}

const testTask = useTask(async () => {
  clearResult()
  result.value = await api.dbTest(draft.value)
})

// Admin-Zugang nur im Speicher dieses Dialogs: nach jedem Lauf und beim Schließen verworfen
const setupOpen = ref(false)
const adminUser = ref('sa')
const adminPassword = ref('')
watch(setupOpen, (open) => {
  if (!open) adminPassword.value = ''
})
// Neu eingetippt und noch nicht gespeichert: Die Einrichtung setzt es trotzdem sofort am Login
const unsavedPassword = computed(() =>
  draft.value.db.password !== '' && draft.value.db.password !== original.value.db.password)

const setupTask = useTask(async () => {
  clearResult()
  try {
    const outcome = await api.dbSetup(draft.value, adminUser.value, adminPassword.value)
    result.value = outcome.result
    setupOpen.value = false
    // Ohne Passwort erzeugt und speichert die Einrichtung eins, auch wenn sie danach scheitert:
    // als „gesetzt“ übernehmen, sonst entfernte es das nächste Speichern wieder
    if (outcome.passwordGenerated) {
      markSecretSet('db.password')
      passwordGenerated.value = true
    }
  }
  finally {
    adminPassword.value = ''
  }
})

const scriptTask = useTask(async () => {
  const path = await api.pickSavePath(t.scriptFile, [{ name: t.scriptFilter, extensions: ['sql'] }])
  if (!path) return
  clearResult()
  result.value = await api.dbScript(draft.value, path)
  scriptPath.value = result.value.ok ? path : null
})

/** `details` der Sicherung (`{ file, bytes }`); fehlt etwas, gilt der gewählte Pfad ohne Größe */
function backupOf(details: unknown, path: string) {
  const value = details && typeof details === 'object' ? details as Record<string, unknown> : {}
  return {
    file: typeof value.file === 'string' && value.file ? value.file : path,
    size: typeof value.bytes === 'number' ? formatBytes(value.bytes) : null,
  }
}

// „Läuft …“ erst nach der Wahl der Datei, nicht schon während der Dateidialog offen ist
const backingUp = ref(false)
const backupTask = useTask(async () => {
  const path = await api.pickSavePath(backupFileName(), [{ name: t.backupFilter, extensions: ['db'] }])
  if (!path) return
  clearResult()
  backingUp.value = true
  try {
    result.value = await api.dbBackup(draft.value, path)
    backup.value = result.value.ok ? backupOf(result.value.details, path) : null
  }
  finally {
    backingUp.value = false
  }
})

const running = () => testTask.running.value || setupTask.running.value || scriptTask.running.value || backupTask.running.value
const showsProgress = computed(() => testTask.running.value || backingUp.value)

// Ergebnisse gelten für die Art, mit der sie entstanden sind; nach einem Wechsel führten sie in die Irre
watch(() => draft.value.db.kind, () => {
  clearResult()
  setupOpen.value = false
})
</script>

<template>
  <section
    class="space-y-6"
    aria-labelledby="view-heading"
  >
    <header>
      <h1
        id="view-heading"
        class="text-2xl font-semibold"
      >
        {{ t.heading }}
      </h1>
      <p class="mt-1 text-sm text-(--ui-color-text-muted)">
        {{ t.description }}
      </p>
    </header>

    <UCard>
      <template #header>
        <h2 class="font-semibold">
          {{ t.storage }}
        </h2>
      </template>
      <div class="space-y-6">
        <div class="space-y-4">
          <ConfigField
            path="db.kind"
            :label="t.kind"
          >
            <URadioGroup
              v-model="draft.db.kind"
              :items="kindItems"
              :disabled="running()"
              class="mt-1"
              :ui="{ fieldset: 'grid gap-3 sm:grid-cols-2' }"
            />
          </ConfigField>
          <UAlert
            v-if="kindChanged"
            variant="subtle"
            color="warning"
            icon="siemens:circle-warning"
            :title="t.kindChangeTitle"
            :description="t.kindChange(original.db.kind)"
            data-testid="db-kind-change"
          />
        </div>

        <div
          v-if="sqlite"
          class="space-y-4"
          data-testid="db-sqlite"
        >
          <ConfigField
            path="db.path"
            :label="t.path"
            :description="t.pathHelp"
          >
            <UInput
              v-model.trim="draft.db.path"
              :placeholder="defaultDbPath"
              spellcheck="false"
              class="w-full"
            />
          </ConfigField>
          <p class="text-sm text-(--ui-color-text-muted)">
            {{ t.pathFolder }}
          </p>
        </div>

        <div
          v-else
          data-testid="db-sqlserver"
        >
          <div class="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <ConfigField
              path="db.server"
              :label="t.server"
              :description="t.serverHelp"
            >
              <UInput
                v-model.trim="draft.db.server"
                :placeholder="t.serverPlaceholder"
                spellcheck="false"
                class="w-full"
              />
            </ConfigField>
            <ConfigField
              path="db.port"
              :label="t.port"
            >
              <PortInput v-model="draft.db.port" />
            </ConfigField>
          </div>
          <div class="mt-4 grid gap-4 sm:grid-cols-2">
            <ConfigField
              path="db.database"
              :label="t.database"
            >
              <UInput
                v-model="draft.db.database"
                spellcheck="false"
                class="w-full"
              />
            </ConfigField>
            <ConfigField
              path="db.user"
              :label="t.user"
            >
              <UInput
                v-model="draft.db.user"
                spellcheck="false"
                class="w-full"
              />
            </ConfigField>
            <ConfigField
              path="db.password"
              :label="t.password"
              class="sm:col-span-2"
            >
              <SecretInput
                v-model="draft.db.password"
                :original="original.db.password"
              />
            </ConfigField>
          </div>
          <div class="mt-6 space-y-4">
            <ConfigField
              path="db.encrypt"
              :label="t.encrypt"
              :description="t.encryptHelp"
              horizontal
            >
              <USwitch v-model="draft.db.encrypt" />
            </ConfigField>
            <ConfigField
              path="db.trust_server_certificate"
              :label="t.trust"
              :description="t.trustHelp"
              horizontal
            >
              <USwitch v-model="draft.db.trust_server_certificate" />
            </ConfigField>
          </div>
        </div>
      </div>
    </UCard>

    <UCard>
      <template #header>
        <h2 class="font-semibold">
          {{ sqlite ? t.sqliteTools : t.tools }}
        </h2>
        <p class="mt-1 text-sm text-(--ui-color-text-muted)">
          {{ sqlite ? t.sqliteToolsHelp : t.toolsHelp }}
        </p>
      </template>
      <div class="flex flex-wrap gap-2">
        <UButton
          icon="siemens:radio-waves-connected"
          :label="texts.actions.testConnection"
          :loading="testTask.running.value"
          :disabled="running()"
          @click="testTask.run()"
        />
        <UButton
          v-if="sqlite"
          color="secondary"
          icon="siemens:download"
          :label="texts.actions.saveBackup"
          :loading="backupTask.running.value"
          :disabled="running()"
          @click="backupTask.run()"
        />
        <template v-else>
          <UButton
            color="secondary"
            icon="siemens:settings"
            :label="texts.actions.setup"
            :disabled="running()"
            @click="setupOpen = true"
          />
          <UButton
            color="secondary"
            icon="siemens:download"
            :label="texts.actions.exportScript"
            :loading="scriptTask.running.value"
            :disabled="running()"
            @click="scriptTask.run()"
          />
        </template>
      </div>
      <div
        v-if="result || showsProgress"
        class="mt-4"
      >
        <ToolResultPanel
          :result="result"
          :running="showsProgress"
        >
          <p
            v-if="scriptPath"
            class="mt-1 text-sm break-all"
          >
            {{ t.scriptSaved(scriptPath) }}
          </p>
          <p
            v-if="backup"
            class="mt-1 text-sm break-words"
            data-testid="backup-saved"
          >
            {{ t.backupSaved(backup.file, backup.size) }}
          </p>
          <p
            v-if="passwordGenerated"
            class="mt-1 text-sm"
            data-testid="password-generated"
          >
            {{ t.passwordGenerated }}
          </p>
        </ToolResultPanel>
      </div>
    </UCard>

    <UModal
      v-model:open="setupOpen"
      :title="t.setupTitle"
      :description="t.setupDescription"
      :dismissible="!setupTask.running.value"
      :ui="{ footer: 'justify-end gap-2' }"
    >
      <template #body>
        <form
          id="db-setup"
          class="space-y-4"
          @submit.prevent="setupTask.run()"
        >
          <ul class="list-disc space-y-1 pl-5 text-sm">
            <li
              v-for="note in t.setupNotes"
              :key="note"
            >
              {{ note }}
            </li>
          </ul>
          <UAlert
            v-if="unsavedPassword"
            variant="subtle"
            color="warning"
            icon="siemens:circle-warning"
            :title="t.setupUnsavedPassword"
            :description="t.setupUnsavedPasswordDetail"
            data-testid="setup-unsaved-password"
          />
          <UFormField :label="t.adminUser">
            <UInput
              v-model.trim="adminUser"
              autocomplete="off"
              spellcheck="false"
              class="w-full"
            />
          </UFormField>
          <UFormField :label="t.adminPassword">
            <UInput
              v-model="adminPassword"
              type="password"
              autocomplete="off"
              class="w-full"
            />
          </UFormField>
          <ToolResultPanel
            v-if="setupTask.running.value"
            :result="null"
            running
          />
        </form>
      </template>
      <template #footer>
        <UButton
          color="secondary"
          :label="texts.actions.cancel"
          :disabled="setupTask.running.value"
          @click="setupOpen = false"
        />
        <UButton
          type="submit"
          form="db-setup"
          icon="siemens:settings"
          :label="t.runSetup"
          :loading="setupTask.running.value"
          :disabled="!adminUser"
        />
      </template>
    </UModal>
  </section>
</template>
