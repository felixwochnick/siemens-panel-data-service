<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import UAlert from '@nuxt/ui/components/Alert.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UCard from '@nuxt/ui/components/Card.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import UInput from '@nuxt/ui/components/Input.vue'
import { useToast } from '@nuxt/ui/composables'
import { api } from '../api'
import type { EplanInstallOutcome } from '../bindings/EplanInstallOutcome'
import type { ServiceAction } from '../bindings/ServiceAction'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import { useAppState } from '../composables/useAppState'
import { useTask } from '../composables/useTask'
import { accountProblem } from '../eplan'
import { texts } from '../texts'

const t = texts.eplan
const appState = useAppState()
const toast = useToast()

const eplan = computed(() => appState.status.value?.eplan ?? null)
const service = computed(() => eplan.value?.service ?? null)
const workerPresent = computed(() => eplan.value?.workerPresent ?? false)
const installed = computed(() => !!service.value && service.value.state !== 'not_installed')
const scmState = computed(() => service.value?.state ?? null)

const rows = computed(() => {
  const value = eplan.value
  if (!value) return []
  const out: Array<{ label: string, value: string, testid: string }> = [
    { label: t.labels.state, value: texts.status.eplan(value), testid: 'state' },
  ]
  if (installed.value && service.value) out.push({ label: t.labels.account, value: service.value.account, testid: 'account' })
  out.push({ label: t.labels.executable, value: t.executable(value.executable, value.workerPresent), testid: 'executable' })
  return out
})

// Konto vorbelegt mit dem eingerichteten, sobald der Status da ist; das Passwort lebt nur in diesem
// Formular und wird nach jedem Versuch verworfen
const account = ref('')
const password = ref('')
const touched = ref(false)
watch(() => service.value?.account, (current) => {
  if (current && !account.value) account.value = current
}, { immediate: true })

const problem = computed(() => accountProblem(account.value))
const accountError = computed(() => touched.value && problem.value ? t.accountProblems[problem.value] : undefined)

const outcome = ref<EplanInstallOutcome | null>(null)
const installTask = useTask(async () => {
  outcome.value = null
  try {
    outcome.value = await api.eplanInstall(account.value.trim(), password.value)
    await appState.refreshStatus()
    toast.add({
      title: outcome.value.started ? t.installed(outcome.value.account) : t.installedNotStarted(outcome.value.account),
      color: outcome.value.started ? 'success' : 'warning',
      icon: outcome.value.started ? 'siemens:circle-checkmark' : 'siemens:circle-warning',
    })
  }
  finally {
    password.value = ''
  }
})

function submit() {
  touched.value = true
  if (problem.value || !password.value) return
  void installTask.run()
}

const confirmStop = ref(false)
const pending = ref<ServiceAction | null>(null)
const control = useTask(async (action: ServiceAction) => {
  await appState.eplanControl(action)
  toast.add({ title: t.controlDone[action], color: 'info', icon: 'siemens:circle-information' })
})

async function run(action: ServiceAction) {
  pending.value = action
  await control.run(action)
  pending.value = null
}

const busy = computed(() => installTask.running.value || control.running.value)
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

    <UAlert
      v-if="eplan && !workerPresent"
      variant="subtle"
      color="warning"
      icon="siemens:circle-warning"
      :title="t.workerMissingTitle"
      :description="t.workerMissing"
      data-testid="eplan-worker-missing"
    />

    <UCard data-testid="eplan-service">
      <template #header>
        <h2 class="font-semibold">
          {{ t.service }}
        </h2>
      </template>
      <dl class="grid grid-cols-[minmax(8rem,auto)_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
        <template
          v-for="row in rows"
          :key="row.testid"
        >
          <dt class="text-(--ui-color-text-muted)">
            {{ row.label }}
          </dt>
          <dd
            class="break-words"
            :data-testid="`eplan-${row.testid}`"
          >
            {{ row.value }}
          </dd>
        </template>
      </dl>
      <p
        v-if="workerPresent && !installed"
        class="mt-4 text-sm text-(--ui-color-text-muted)"
      >
        {{ t.notInstalled }}
      </p>

      <template #footer>
        <div class="flex flex-wrap gap-2">
          <UButton
            icon="siemens:play"
            :label="texts.actions.start"
            :loading="pending === 'start'"
            :disabled="busy || !installed || scmState === 'running'"
            @click="run('start')"
          />
          <UButton
            color="secondary"
            icon="siemens:stop"
            :label="texts.actions.stop"
            :loading="pending === 'stop'"
            :disabled="busy || !installed || scmState === 'stopped'"
            @click="confirmStop = true"
          />
          <UButton
            color="secondary"
            icon="siemens:refresh"
            :label="texts.actions.restart"
            :loading="pending === 'restart'"
            :disabled="busy || !installed"
            @click="run('restart')"
          />
        </div>
      </template>
    </UCard>

    <UCard data-testid="eplan-setup">
      <template #header>
        <h2 class="font-semibold">
          {{ t.setupHeading }}
        </h2>
        <p class="mt-1 text-sm text-(--ui-color-text-muted)">
          {{ t.setupHelp }}
        </p>
      </template>
      <form
        id="eplan-install"
        class="space-y-4"
        @submit.prevent="submit"
      >
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField
            :label="t.account"
            :description="t.accountHelp"
            :error="accountError"
          >
            <UInput
              v-model="account"
              :placeholder="t.accountPlaceholder"
              autocomplete="off"
              spellcheck="false"
              class="w-full"
              :disabled="!workerPresent || busy"
              data-testid="eplan-account"
              @blur="touched = true"
            />
          </UFormField>
          <UFormField
            :label="t.password"
            :description="t.passwordHelp"
          >
            <UInput
              v-model="password"
              type="password"
              autocomplete="new-password"
              class="w-full"
              :disabled="!workerPresent || busy"
              data-testid="eplan-password"
            />
          </UFormField>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <UButton
            type="submit"
            icon="siemens:settings"
            :label="installed ? t.change : t.install"
            :loading="installTask.running.value"
            :disabled="!workerPresent || busy || !password || !!problem"
            data-testid="eplan-install"
          />
        </div>
        <p
          v-if="installTask.running.value"
          class="text-sm text-(--ui-color-text-muted)"
          role="status"
        >
          {{ t.installing }}
        </p>
        <UAlert
          v-if="outcome && outcome.warnings.length"
          variant="subtle"
          color="warning"
          icon="siemens:circle-warning"
          :title="t.warningsTitle"
          data-testid="eplan-warnings"
        >
          <template #description>
            <ul class="list-disc space-y-1 pl-5">
              <li
                v-for="warning in outcome.warnings"
                :key="warning"
              >
                {{ warning }}
              </li>
            </ul>
          </template>
        </UAlert>
        <p class="text-sm text-(--ui-color-text-muted)">
          {{ t.licenseHint }}
        </p>
      </form>
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
