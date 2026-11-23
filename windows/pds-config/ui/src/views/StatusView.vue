<script setup lang="ts">
import { computed, ref } from 'vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UCard from '@nuxt/ui/components/Card.vue'
import { useToast } from '@nuxt/ui/composables'
import { api } from '../api'
import type { Finding } from '../bindings/Finding'
import type { ServiceAction } from '../bindings/ServiceAction'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import FieldFindings from '../components/FieldFindings.vue'
import { useAppState } from '../composables/useAppState'
import { useDraft } from '../composables/useDraft'
import { useTask } from '../composables/useTask'
import { daysUntil, formatDate, formatDateTime } from '../format'
import { texts } from '../texts'

const appState = useAppState()
const { findingsFor } = useDraft()
const toast = useToast()
const t = texts.status

const report = computed(() => appState.status.value)
const current = computed(() => report.value?.status ?? null)
const scmState = computed(() => report.value?.service?.state ?? null)

// Ampel im Kopf: ein veralteter Status zählt als „läuft nicht“, egal was darin steht
const tone = computed<'ok' | 'busy' | 'bad' | 'off'>(() => {
  if (report.value?.stale) return 'bad'
  const state = current.value?.state
  if (!state) return 'off'
  if (state === 'running') return current.value?.health && !current.value.health.ok ? 'busy' : 'ok'
  if (state === 'starting' || state === 'stopping' || state === 'backoff') return 'busy'
  if (state === 'stopped') return 'off'
  return 'bad'
})

const toneClass = {
  ok: 'bg-(--ui-color-feedback-green)',
  busy: 'bg-(--ui-color-feedback-orange)',
  bad: 'bg-(--ui-color-feedback-red)',
  off: 'bg-(--ui-color-text-faint)',
}

const headline = computed(() => {
  if (report.value?.stale && current.value) return texts.status.stale(appState.staleSeconds.value ?? 0)
  if (!current.value) return t.noStatus
  return t.since(t.stateText(current.value.state), formatDateTime(current.value.since))
})

const childrenShown = computed(() => {
  const state = current.value?.state
  return state === 'starting' || state === 'running' || state === 'backoff'
})

const rows = computed(() => {
  const value = report.value
  if (!value) return []
  const out: Array<{ label: string, value: string, testid: string }> = [
    { label: t.labels.service, value: t.service(value.service), testid: 'service' },
    { label: t.labels.address, value: value.appUrl || t.noAddress, testid: 'address' },
  ]
  // Leer, wenn config.toml nicht lesbar ist; das erklärt dann schon der Befund `config_unreadable`
  if (value.database) out.push({ label: t.labels.database, value: value.database, testid: 'database' })
  out.push(
    { label: t.labels.healthInternal, value: t.probe(value.internal), testid: 'health-internal' },
    { label: t.labels.healthPublic, value: t.probe(value.public), testid: 'health-public' },
  )
  const s = value.status
  if (s) {
    out.push({ label: t.labels.versions, value: t.versions(s.productVersion, s.nodeVersion, s.caddyVersion), testid: 'versions' })
    if (childrenShown.value) {
      out.push({ label: t.labels.app, value: t.child(s.app), testid: 'app' })
      out.push({ label: t.labels.proxy, value: t.child(s.proxy), testid: 'proxy' })
    }
    if (s.certificateNotAfter) {
      out.push({ label: t.labels.certificate, value: t.certificate(formatDate(s.certificateNotAfter), daysUntil(s.certificateNotAfter)), testid: 'certificate' })
    }
    if (s.nextAttempt) out.push({ label: t.labels.nextAttempt, value: formatDateTime(s.nextAttempt), testid: 'next-attempt' })
    out.push({
      label: t.labels.lastError,
      value: s.lastError ? t.lastError(formatDateTime(s.lastError.at), s.lastError.source, s.lastError.message) : t.noError,
      testid: 'last-error',
    })
  }
  return out
})

// Befunde des Dienstes plus solche, die keinem Bereich gehören (Konfiguration unlesbar). Bei einer
// unlesbaren Datei melden beide `config_unreadable` – jeder Befund (Feld + Code) steht nur einmal da.
const findings = computed<Finding[]>(() => {
  const seen = new Set<string>()
  return [...(current.value?.findings ?? []), ...findingsFor('config')].filter((finding) => {
    const key = `${finding.field}:${finding.code}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
})

const confirmStop = ref(false)
const control = useTask(async (action: ServiceAction) => {
  await appState.serviceControl(action)
  toast.add({ title: t.controlDone[action], color: 'info', icon: 'siemens:circle-information' })
})
// Auswahl im Logordner, geöffnet im Editor (`open_log_file`): Ein Explorer liefe ohne Adminrechte
// und böte für den geschützten Ordner „Fortsetzen“ an, das den Benutzer in dessen ACL einträgt
const openLogs = useTask(async () => {
  const file = await api.pickFile([{ name: t.logFilter, extensions: ['log*'] }], await api.logsDir())
  if (!file) return
  await api.openLogFile(file)
  toast.add({ title: t.logOpened(file), color: 'info', icon: 'siemens:circle-information' })
})
// Adresse der gespeicherten Konfiguration; geöffnet wird sie in Rust (`open_web_console`), nicht hier
const webConsoleUrl = computed(() => report.value?.appUrl ?? '')
const openWebConsole = useTask(async () => {
  await api.openWebConsole()
  toast.add({ title: t.webConsole.opened(webConsoleUrl.value), color: 'info', icon: 'siemens:circle-information' })
})
const pending = ref<ServiceAction | null>(null)

async function run(action: ServiceAction) {
  pending.value = action
  await control.run(action)
  pending.value = null
}
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
      <div
        class="flex items-center gap-3"
        data-testid="status-headline"
      >
        <span
          class="size-3 shrink-0 rounded-full"
          :class="toneClass[tone]"
          aria-hidden="true"
        />
        <p class="text-lg">
          <span class="text-(--ui-color-text-muted)">{{ t.labels.state }}: </span><span class="font-semibold">{{ headline }}</span>
        </p>
      </div>

      <dl class="mt-4 grid grid-cols-[minmax(8rem,auto)_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
        <template
          v-for="row in rows"
          :key="row.testid"
        >
          <dt class="text-(--ui-color-text-muted)">
            {{ row.label }}
          </dt>
          <dd
            class="break-words"
            :data-testid="`status-${row.testid}`"
          >
            {{ row.value }}
          </dd>
        </template>
      </dl>

      <div
        v-if="findings.length"
        class="mt-4 border-t border-(--ui-color-surface-border) pt-4"
      >
        <h2 class="mb-2 text-sm font-semibold">
          {{ t.labels.findings }}
        </h2>
        <FieldFindings :findings="findings" />
      </div>

      <template #footer>
        <div class="flex flex-wrap gap-2">
          <UButton
            icon="siemens:play"
            :label="texts.actions.start"
            :loading="pending === 'start'"
            :disabled="control.running.value || scmState === 'running' || scmState === 'not_installed'"
            @click="run('start')"
          />
          <UButton
            color="secondary"
            icon="siemens:stop"
            :label="texts.actions.stop"
            :loading="pending === 'stop'"
            :disabled="control.running.value || scmState === 'stopped' || scmState === 'not_installed'"
            @click="confirmStop = true"
          />
          <UButton
            color="secondary"
            icon="siemens:refresh"
            :label="texts.actions.restart"
            :loading="pending === 'restart'"
            :disabled="control.running.value || scmState === 'not_installed'"
            @click="run('restart')"
          />
          <UButton
            color="tertiary"
            icon="siemens:document-text"
            :label="texts.actions.openLogs"
            :loading="openLogs.running.value"
            @click="openLogs.run()"
          />
        </div>
      </template>
    </UCard>

    <UCard data-testid="web-console">
      <div class="flex flex-wrap items-center gap-x-6 gap-y-4">
        <div class="min-w-0 flex-1 basis-80">
          <h2 class="font-semibold">
            {{ t.webConsole.heading }}
          </h2>
          <p class="mt-1 text-sm text-(--ui-color-text-muted)">
            {{ t.webConsole.description }}
          </p>
        </div>
        <UButton
          icon="siemens:link-extern"
          :label="texts.actions.openWebConsole"
          :loading="openWebConsole.running.value"
          :disabled="!webConsoleUrl"
          @click="openWebConsole.run()"
        />
      </div>
    </UCard>

    <ConfirmDialog
      v-model:open="confirmStop"
      :title="t.confirmStopTitle"
      :description="t.confirmStop"
      :confirm-label="texts.actions.stop"
      danger
      @confirm="run('stop')"
    />
  </section>
</template>
