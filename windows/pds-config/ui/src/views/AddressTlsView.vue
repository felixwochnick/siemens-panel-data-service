<script setup lang="ts">
import { computed, ref } from 'vue'
import UAlert from '@nuxt/ui/components/Alert.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UCard from '@nuxt/ui/components/Card.vue'
import UInput from '@nuxt/ui/components/Input.vue'
import URadioGroup from '@nuxt/ui/components/RadioGroup.vue'
import USelect from '@nuxt/ui/components/Select.vue'
import { api } from '../api'
import type { PortStatus } from '../bindings/PortStatus'
import type { TlsMode } from '../bindings/TlsMode'
import CertificateImport from '../components/CertificateImport.vue'
import ConfigField from '../components/ConfigField.vue'
import CopyButton from '../components/CopyButton.vue'
import FieldFindings from '../components/FieldFindings.vue'
import FileInput from '../components/FileInput.vue'
import PortInput from '../components/PortInput.vue'
import SecretInput from '../components/SecretInput.vue'
import { useAppState } from '../composables/useAppState'
import { useDraft } from '../composables/useDraft'
import { useTask } from '../composables/useTask'
import { appUrlOf, formatDate } from '../format'
import { texts } from '../texts'

const t = texts.addressTls
const { draft, original, findingsFor } = useDraft()
const { certificate } = useAppState()

const modes: TlsMode[] = ['certificate', 'acme', 'internal', 'off']
const modeItems = modes.map(mode => ({ value: mode, label: t.modes[mode].label, description: t.modes[mode].description }))
const schemeItems = [{ value: 'https', label: 'https' }, { value: 'http', label: 'http' }]

const appUrl = computed(() => draft.value.public.host ? appUrlOf(draft.value) : '')
const certificateFindings = computed(() => findingsFor('tls'))

const ports = ref<PortStatus[] | null>(null)
const portsTask = useTask(async () => {
  ports.value = await api.portsCheck(draft.value)
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
          {{ t.address }}
        </h2>
      </template>
      <div class="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <ConfigField
          path="public.host"
          :label="t.host"
          :description="t.hostHelp"
        >
          <UInput
            v-model.trim="draft.public.host"
            :placeholder="t.hostPlaceholder"
            spellcheck="false"
            class="w-full"
          />
        </ConfigField>
        <ConfigField
          path="public.port"
          :label="t.port"
        >
          <PortInput v-model="draft.public.port" />
        </ConfigField>
      </div>
      <div class="mt-4">
        <p class="text-sm font-medium">
          {{ t.appUrl }}
        </p>
        <p class="text-sm text-(--ui-color-text-muted)">
          {{ t.appUrlHelp }}
        </p>
        <div class="mt-1 flex flex-wrap items-center gap-2">
          <code
            class="min-w-0 break-all bg-(--ui-color-row-hover) px-2 py-1.5 text-sm"
            data-testid="app-url"
          >{{ appUrl || texts.status.noAddress }}</code>
          <CopyButton
            v-if="appUrl"
            :value="appUrl"
          />
        </div>
      </div>
    </UCard>

    <UCard>
      <template #header>
        <h2 class="font-semibold">
          {{ t.tls }}
        </h2>
      </template>
      <div class="space-y-6">
        <ConfigField
          path="tls.mode"
          :label="t.mode"
        >
          <URadioGroup
            v-model="draft.tls.mode"
            :items="modeItems"
            class="mt-1"
            :ui="{ fieldset: 'grid gap-3 sm:grid-cols-2' }"
          />
        </ConfigField>

        <div
          v-if="draft.tls.mode === 'certificate'"
          class="space-y-4"
          data-testid="certificate"
        >
          <h3 class="text-sm font-semibold">
            {{ t.certificate }}
          </h3>
          <dl
            v-if="certificate"
            class="grid grid-cols-[minmax(8rem,auto)_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm"
          >
            <dt class="text-(--ui-color-text-muted)">
              {{ t.certificateLabels.subject }}
            </dt>
            <dd class="break-words">
              {{ certificate.subject }}
            </dd>
            <dt class="text-(--ui-color-text-muted)">
              {{ t.certificateLabels.issuer }}
            </dt>
            <dd class="break-words">
              {{ certificate.issuer }}
            </dd>
            <dt class="text-(--ui-color-text-muted)">
              {{ t.certificateLabels.dnsNames }}
            </dt>
            <dd class="break-words">
              {{ certificate.dnsNames.join(', ') }}
            </dd>
            <dt class="text-(--ui-color-text-muted)">
              {{ t.certificateLabels.validity }}
            </dt>
            <dd>{{ t.validity(formatDate(certificate.notBefore), formatDate(certificate.notAfter)) }}</dd>
            <dt class="text-(--ui-color-text-muted)">
              {{ t.certificateLabels.thumbprint }}
            </dt>
            <dd class="font-mono text-xs break-all">
              {{ certificate.thumbprintSha1 }}
            </dd>
          </dl>
          <p
            v-else
            class="text-sm text-(--ui-color-text-muted)"
          >
            {{ t.noCertificate }}
          </p>
          <FieldFindings :findings="certificateFindings" />
          <CertificateImport />
          <p class="text-sm text-(--ui-color-text-muted)">
            {{ t.importHint }}
          </p>
        </div>

        <div
          v-else-if="draft.tls.mode === 'acme'"
          class="grid gap-4 sm:grid-cols-2"
        >
          <ConfigField
            path="tls.acme_email"
            :label="t.acmeEmail"
            :description="t.acmeEmailHelp"
          >
            <UInput
              v-model.trim="draft.tls.acme_email"
              type="email"
              class="w-full"
            />
          </ConfigField>
          <ConfigField
            path="tls.acme_ca_url"
            :label="t.acmeCaUrl"
            :description="t.acmeCaUrlHelp"
          >
            <UInput
              v-model.trim="draft.tls.acme_ca_url"
              :placeholder="texts.placeholders.https"
              spellcheck="false"
              class="w-full"
            />
          </ConfigField>
          <ConfigField
            path="tls.acme_ca_root"
            :label="t.acmeCaRoot"
            :description="t.acmeCaRootHelp"
            class="sm:col-span-2"
          >
            <FileInput
              v-model="draft.tls.acme_ca_root"
              :filters="[{ name: t.pemFilter, extensions: ['pem', 'crt', 'cer'] }]"
            />
          </ConfigField>
          <ConfigField
            path="tls.acme_eab_key_id"
            :label="t.acmeEabKeyId"
            :description="t.acmeEabHelp"
          >
            <UInput
              v-model.trim="draft.tls.acme_eab_key_id"
              spellcheck="false"
              class="w-full"
            />
          </ConfigField>
          <ConfigField
            path="tls.acme_eab_hmac"
            :label="t.acmeEabHmac"
            :description="t.acmeEabHelp"
          >
            <SecretInput
              v-model="draft.tls.acme_eab_hmac"
              :original="original.tls.acme_eab_hmac"
            />
          </ConfigField>
        </div>

        <UAlert
          v-else-if="draft.tls.mode === 'internal'"
          variant="subtle"
          color="warning"
          icon="siemens:circle-warning"
          :description="t.internalHint"
        />

        <div
          v-else
          class="space-y-4"
        >
          <ConfigField
            path="public.scheme"
            :label="t.scheme"
            class="max-w-xs"
          >
            <USelect
              v-model="draft.public.scheme"
              :items="schemeItems"
              class="w-full"
            />
          </ConfigField>
          <UAlert
            variant="subtle"
            color="info"
            icon="siemens:circle-information"
            :description="t.cookieHint"
          />
        </div>
      </div>
    </UCard>

    <UCard>
      <template #header>
        <h2 class="font-semibold">
          {{ t.ports }}
        </h2>
      </template>
      <div class="grid gap-4 sm:grid-cols-2">
        <ConfigField
          path="listen.http_port"
          :label="t.httpPort"
          :description="draft.tls.mode === 'off' ? t.httpPortOff : t.httpPortRedirect"
        >
          <PortInput v-model="draft.listen.http_port" />
        </ConfigField>
        <ConfigField
          path="internal.port"
          :label="t.internalPort"
          :description="t.internalPortHelp"
        >
          <PortInput v-model="draft.internal.port" />
        </ConfigField>
      </div>
      <div class="mt-4 space-y-3">
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
          <UButton
            color="secondary"
            icon="siemens:search"
            :label="texts.actions.checkPorts"
            :loading="portsTask.running.value"
            @click="portsTask.run()"
          />
          <p class="text-sm text-(--ui-color-text-muted)">
            {{ t.portsHelp }}
          </p>
        </div>
        <ul
          v-if="ports"
          class="space-y-1 text-sm"
          data-testid="ports"
        >
          <li
            v-for="port in ports"
            :key="port.port"
            class="flex items-start gap-2"
          >
            <span
              class="mt-1.5 size-2 shrink-0 rounded-full"
              :class="port.free ? 'bg-(--ui-color-feedback-green)' : 'bg-(--ui-color-feedback-orange)'"
              aria-hidden="true"
            />
            <span><span class="font-semibold">{{ t.portLabel(port.port) }}:</span> {{ t.portState(port) }}</span>
          </li>
        </ul>
      </div>
    </UCard>
  </section>
</template>
