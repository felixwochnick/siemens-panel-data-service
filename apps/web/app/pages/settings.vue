<script setup lang="ts">
import type { FormError } from '@nuxt/ui'
import { EPLAN_OPEN_MODES, SETTINGS_LIMITS } from '~~/shared/types/api'
import type { CronPreview, SettingsInput, SettingsResponse, SettingsSaveResponse, SettingsView } from '~~/shared/types/api'
import { secretTargetChanges } from '~~/shared/utils/secret-targets'
import { SettingsTestModal } from '#components'

definePageMeta({ admin: true })

const { t, locale } = useI18n()
const { issueText, settingLabel, errorText } = useLabels()
const toast = useToast()
const overlay = useOverlay()
const confirm = useConfirmModal()

useSeoMeta({ title: () => t('settings.title') })

const { data, refresh } = await useFetch<SettingsResponse>('/api/settings', { key: 'settings' })

/** Formularzustand: wie die Ansicht; das Netzlaufwerk-Passwort ist eine Eingabe (undefined = unverändert) */
function toInput(view: SettingsView): SettingsInput {
  const copy = JSON.parse(JSON.stringify(view)) as SettingsView
  return { ...copy, networkDrive: { ...copy.networkDrive, password: undefined } }
}

const state = reactive<SettingsInput>(toInput(data.value!.settings))
const snapshot = ref(JSON.stringify(state))
// undefined fällt bei JSON weg: ein eingegebenes oder entferntes Passwort zählt als Änderung
const dirty = computed(() => JSON.stringify(state) !== snapshot.value)

function reset(view: SettingsView) {
  Object.assign(state, toInput(view))
  snapshot.value = JSON.stringify(state)
}

/** Was an den Server geht (Speichern und Verbindungstest) */
const payload = (): SettingsInput => JSON.parse(JSON.stringify(state)) as SettingsInput

// ── Netzlaufwerk-Passwort und sein Ziel ────────────────────────────────────
// Das gespeicherte Passwort gilt nur für seine bisherige Freigabe und seinen Benutzer. Ändert jemand das Ziel, muss es
// neu eingegeben werden (der Server lehnt sonst mit secret_required ab) – schon hier zeigen.
const driveRetargeted = computed(() => {
  const saved = data.value?.settings
  if (!saved?.networkDrive.password.set) return false
  const input = state.networkDrive.password
  return (input === undefined || input === '')
    && secretTargetChanges(saved, state).some(change => change.field === 'networkDrive.password')
})

const form = useTemplateRef('form')
watch(driveRetargeted, (now, before) => {
  if (before && !now) form.value?.clear('networkDrive.password')
})
const saving = ref(false)

async function save() {
  saving.value = true
  form.value?.clear()
  try {
    const result = await $fetch<SettingsSaveResponse>('/api/settings', { method: 'PUT', body: payload() })
    data.value = result
    reset(result.settings)
    toast.add({ title: result.changed.length ? t('settings.saved') : t('settings.unchanged'), color: 'success', icon: 'siemens:circle-checkmark' })
  }
  catch (error) {
    const issues = issuesOf(error)
    if (issues.length) {
      form.value?.setErrors(issues.map<FormError>(issue => ({ name: issue.path, message: issueText(issue.code) })))
      // invalid_settings: „Felder prüfen“; sonst (secret_required, settings_incomplete) der erklärende Text des Codes
      const code = (error as { data?: { message?: string } })?.data?.message
      toast.add({ title: code === 'invalid_settings' ? t('settings.invalid') : errorText(error), color: 'error', icon: 'siemens:circle-error' })
      await nextTick()
      document.querySelector('[data-invalid="true"], [aria-invalid="true"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
    else {
      toast.add({ title: errorText(error), color: 'error', icon: 'siemens:circle-error' })
    }
  }
  finally {
    saving.value = false
  }
}

async function discard() {
  form.value?.clear()
  await refresh()
  if (data.value) reset(data.value.settings)
}

// ── Zeitplan-Vorschau ──────────────────────────────────────────────────────
const cron = refDebounced(computed(() => state.cronSchedule), 400)
const timezone = refDebounced(computed(() => state.timezone), 400)
const { data: preview } = useFetch<CronPreview>('/api/settings/cron-preview', {
  key: 'cron-preview',
  query: { cron, timezone },
})
const cronExamples = computed(() => [
  { label: t('settings.cron.daily'), value: '0 0 2 * * ?' },
  { label: t('settings.cron.weekdays'), value: '0 0 6 ? * MON-FRI' },
  { label: t('settings.cron.hourly'), value: '0 0 * * * ?' },
  { label: t('settings.cron.every15'), value: '0 0/15 * * * ?' },
])
const timezones = computed(() => {
  const zones = new Set(Intl.supportedValuesOf('timeZone'))
  zones.add('UTC')
  if (state.timezone) zones.add(state.timezone)
  return [...zones].sort()
})

const sourceItems = computed(() => (['local', 'network'] as const).map(value => ({ label: t(`settings.sources.${value}`), value })))
const openModeItems = computed(() => EPLAN_OPEN_MODES.map(value => ({ label: t(`settings.openModes.${value}`), value })))

function openTest() {
  overlay.create(SettingsTestModal, { destroyOnClose: true, props: { input: payload() } }).open()
}

// Ungespeicherte Änderungen nicht stillschweigend verwerfen
onBeforeRouteLeave(async () => {
  if (!dirty.value) return true
  return confirm({ question: t('settings.unsavedLeave'), danger: true })
})
useEventListener('beforeunload', (event: BeforeUnloadEvent) => {
  if (dirty.value) event.preventDefault()
})
</script>

<template>
  <UDashboardPanel id="settings">
    <template #header>
      <UDashboardNavbar :title="t('settings.title')">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <UButton
            color="secondary"
            icon="siemens:radio-waves-connected"
            :label="t('settings.test')"
            :ui="{ label: 'hidden sm:inline' }"
            :aria-label="t('settings.test')"
            data-testid="settings-test"
            @click="openTest"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UForm
        id="settings-form"
        ref="form"
        :state="state"
        class="mx-auto flex w-full max-w-4xl flex-col gap-6"
        data-testid="settings-form"
        @submit="save"
      >
        <p class="text-sm text-muted">
          <template v-if="data?.saved && data.updatedAt">
            {{ t('settings.lastSaved', { at: formatDateTime(data.updatedAt, locale), name: data.updatedBy ?? t('audit.system') }) }}
          </template>
          <template v-else>
            {{ t('settings.neverSaved') }}
          </template>
        </p>

        <UAlert
          v-if="data?.issues.length"
          color="warning"
          variant="subtle"
          icon="siemens:circle-warning"
          :title="t('settings.issuesTitle')"
          data-testid="settings-issues"
        >
          <template #description>
            <ul class="list-inside list-disc">
              <li
                v-for="issue in data.issues"
                :key="issue.path"
              >
                {{ settingLabel(issue.path) }}: {{ issueText(issue.code) }}
              </li>
            </ul>
          </template>
        </UAlert>

        <!-- Projektordner und Netzlaufwerk -->
        <UPageCard
          id="folder"
          :title="t('settings.sections.folder.title')"
          :description="t('settings.sections.folder.description')"
          variant="outline"
        >
          <div class="grid gap-4 sm:grid-cols-3">
            <UFormField
              :label="settingLabel('source')"
              name="source"
              class="sm:col-span-3"
            >
              <URadioGroup
                v-model="state.source"
                :items="sourceItems"
                orientation="horizontal"
                data-testid="field-source"
              />
            </UFormField>
            <UFormField
              :label="settingLabel('folder')"
              :help="t('settings.help.folder')"
              name="folder"
              class="sm:col-span-3"
            >
              <UInput
                v-model="state.folder"
                icon="siemens:folder"
                placeholder="D:\EPLAN\Projekte"
                class="w-full"
                data-testid="field-folder"
              />
            </UFormField>
            <UFormField
              :label="settingLabel('filePatterns')"
              :help="t('settings.help.filePatterns')"
              name="filePatterns"
              class="sm:col-span-2"
            >
              <UInputTags
                v-model="state.filePatterns"
                :max="SETTINGS_LIMITS.filePatterns.max"
                class="w-full"
                data-testid="field-filePatterns"
              />
            </UFormField>
            <UFormField
              :label="settingLabel('recursive')"
              name="recursive"
            >
              <USwitch
                v-model="state.recursive"
                :label="t('settings.help.recursive')"
                data-testid="field-recursive"
              />
            </UFormField>
          </div>

          <USeparator class="my-2" />

          <h3
            id="network"
            class="text-base font-semibold"
          >
            {{ t('settings.sections.networkDrive.title') }}
          </h3>
          <p class="text-sm text-muted">
            {{ t('settings.sections.networkDrive.description') }}
          </p>
          <p
            v-if="state.source !== 'network'"
            class="flex items-center gap-2 text-sm text-muted"
          >
            <UIcon
              name="siemens:circle-information"
              class="size-4 shrink-0"
            />
            {{ t('settings.sections.networkDrive.inactive') }}
          </p>
          <div class="grid gap-4 sm:grid-cols-3">
            <UFormField
              :label="settingLabel('networkDrive.mapping')"
              :help="t('settings.help.mapping')"
              name="networkDrive.mapping"
            >
              <UInput
                v-model="state.networkDrive.mapping"
                placeholder="P"
                class="w-full"
              />
            </UFormField>
            <UFormField
              :label="settingLabel('networkDrive.networkPath')"
              name="networkDrive.networkPath"
              :required="state.source === 'network'"
              class="sm:col-span-2"
            >
              <UInput
                v-model="state.networkDrive.networkPath"
                placeholder="\\server\share"
                class="w-full"
                data-testid="field-networkPath"
              />
            </UFormField>
            <UFormField
              :label="settingLabel('networkDrive.user')"
              :help="t('settings.help.networkUser')"
              name="networkDrive.user"
            >
              <UInput
                v-model="state.networkDrive.user"
                autocomplete="off"
                class="w-full"
              />
            </UFormField>
            <UFormField
              :label="settingLabel('networkDrive.password')"
              name="networkDrive.password"
              :error="driveRetargeted ? t('settings.secret.retargetDrive') : undefined"
              class="sm:col-span-2"
            >
              <SettingsSecretField
                v-model="state.networkDrive.password"
                :state="data!.settings.networkDrive.password"
                :reenter="driveRetargeted"
                optional
                testid="field-drive-password"
              />
            </UFormField>
          </div>
        </UPageCard>

        <!-- EPLAN -->
        <UPageCard
          id="eplan"
          :title="t('settings.sections.eplan.title')"
          :description="t('settings.sections.eplan.description')"
          variant="outline"
        >
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField
              :label="settingLabel('eplan.platformBin')"
              name="eplan.platformBin"
              required
              class="sm:col-span-2"
            >
              <UInput
                v-model="state.eplan.platformBin"
                class="w-full font-mono text-sm"
                data-testid="field-platformBin"
              />
            </UFormField>
            <UFormField
              :label="settingLabel('eplan.productBin')"
              name="eplan.productBin"
              required
              class="sm:col-span-2"
            >
              <UInput
                v-model="state.eplan.productBin"
                class="w-full font-mono text-sm"
                data-testid="field-productBin"
              />
            </UFormField>
            <UFormField
              :label="settingLabel('eplan.applicationModifier')"
              :help="t('settings.help.applicationModifier')"
              name="eplan.applicationModifier"
            >
              <UInput
                v-model="state.eplan.applicationModifier"
                class="w-full"
              />
            </UFormField>
            <UFormField
              :label="settingLabel('eplan.openMode')"
              :help="t('settings.help.openMode')"
              name="eplan.openMode"
            >
              <USelect
                v-model="state.eplan.openMode"
                :items="openModeItems"
                value-key="value"
                class="w-full"
                data-testid="field-openMode"
              />
            </UFormField>
          </div>
        </UPageCard>

        <!-- Zeitplan -->
        <UPageCard
          id="schedule"
          :title="t('settings.sections.schedule.title')"
          :description="t('settings.sections.schedule.description')"
          variant="outline"
        >
          <div class="grid gap-4 sm:grid-cols-2">
            <USwitch
              v-model="state.schedulerEnabled"
              :label="settingLabel('schedulerEnabled')"
              :description="t('settings.help.schedulerEnabled')"
              class="sm:col-span-2"
              data-testid="field-schedulerEnabled"
            />
            <UFormField
              :label="settingLabel('cronSchedule')"
              :help="t('settings.help.cronSchedule')"
              name="cronSchedule"
              required
            >
              <UInput
                v-model="state.cronSchedule"
                class="w-full font-mono"
                data-testid="field-cronSchedule"
              />
            </UFormField>
            <UFormField
              :label="settingLabel('timezone')"
              name="timezone"
              required
            >
              <USelectMenu
                v-model="state.timezone"
                :items="timezones"
                :search-input="{ placeholder: t('common.search') }"
                class="w-full"
                data-testid="field-timezone"
              />
            </UFormField>
            <div class="flex flex-wrap items-center gap-2 sm:col-span-2">
              <span class="text-sm text-muted">{{ t('settings.cron.examples') }}:</span>
              <UButton
                v-for="item in cronExamples"
                :key="item.value"
                color="neutral"
                variant="outline"
                size="xs"
                :label="item.label"
                @click="state.cronSchedule = item.value"
              />
            </div>
            <div
              class="sm:col-span-2"
              data-testid="cron-preview"
            >
              <p class="text-sm font-semibold">
                {{ state.schedulerEnabled ? t('settings.cron.preview') : t('settings.cron.previewOff') }}
              </p>
              <ul
                v-if="preview?.valid"
                class="mt-1 grid gap-x-6 gap-y-0.5 text-sm tabular-nums sm:grid-cols-2"
              >
                <li
                  v-for="next in preview.nextRuns"
                  :key="next"
                >
                  {{ formatDateTime(next, locale, { timeZone: state.timezone }) }}
                </li>
              </ul>
              <p
                v-else-if="preview"
                class="mt-1 text-sm text-error"
              >
                {{ t('settings.cron.previewInvalid') }}
              </p>
            </div>
          </div>
        </UPageCard>

        <!-- Analyse -->
        <UPageCard
          id="analysis"
          :title="t('settings.sections.analysis.title')"
          :description="t('settings.sections.analysis.description')"
          variant="outline"
        >
          <div class="grid gap-4 sm:grid-cols-3">
            <UFormField
              :label="settingLabel('analysisTimeoutMinutes')"
              :help="t('settings.help.analysisTimeoutMinutes')"
              name="analysisTimeoutMinutes"
              required
            >
              <UInputNumber
                v-model="state.analysisTimeoutMinutes"
                :min="SETTINGS_LIMITS.analysisTimeoutMinutes.min"
                :max="SETTINGS_LIMITS.analysisTimeoutMinutes.max"
                class="w-full"
                data-testid="field-analysisTimeoutMinutes"
              />
            </UFormField>
            <UFormField
              :label="settingLabel('retentionDays')"
              :help="t('settings.help.retentionDays')"
              name="retentionDays"
              required
            >
              <UInputNumber
                v-model="state.retentionDays"
                :min="SETTINGS_LIMITS.retentionDays.min"
                :max="SETTINGS_LIMITS.retentionDays.max"
                class="w-full"
                data-testid="field-retentionDays"
              />
            </UFormField>
            <UFormField
              :label="settingLabel('uploadMaxMb')"
              :help="t('settings.help.uploadMaxMb')"
              name="uploadMaxMb"
              required
            >
              <UInputNumber
                v-model="state.uploadMaxMb"
                :min="SETTINGS_LIMITS.uploadMaxMb.min"
                :max="SETTINGS_LIMITS.uploadMaxMb.max"
                class="w-full"
                data-testid="field-uploadMaxMb"
              />
            </UFormField>
          </div>
        </UPageCard>
      </UForm>
    </template>

    <!-- Speichern: immer erreichbar, außerhalb des Formulars (Knopf über form="settings-form") -->
    <template #footer>
      <div class="flex flex-wrap items-center justify-end gap-3 border-t border-default px-4 py-3 sm:px-6">
        <span
          v-if="dirty"
          class="mr-auto flex items-center gap-2 text-sm text-warning"
          data-testid="settings-dirty"
        >
          <UIcon
            name="siemens:edit"
            class="size-4"
          />
          {{ t('settings.unsaved') }}
        </span>
        <UButton
          v-if="dirty"
          color="tertiary"
          icon="siemens:undo"
          :label="t('settings.discard')"
          @click="discard"
        />
        <UButton
          type="submit"
          form="settings-form"
          icon="siemens:save"
          :label="t('settings.save')"
          :loading="saving"
          :disabled="!dirty && data?.saved"
          data-testid="settings-save"
        />
      </div>
    </template>
  </UDashboardPanel>
</template>
