<script setup lang="ts">
import { computed, ref } from 'vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import UInput from '@nuxt/ui/components/Input.vue'
import UModal from '@nuxt/ui/components/Modal.vue'
import URadioGroup from '@nuxt/ui/components/RadioGroup.vue'
import { useToast } from '@nuxt/ui/composables'
import { api } from '../api'
import type { CertInfo } from '../bindings/CertInfo'
import type { StoreCert } from '../bindings/StoreCert'
import { useAppState } from '../composables/useAppState'
import { useDraft } from '../composables/useDraft'
import { useTask } from '../composables/useTask'
import { formatDate } from '../format'
import { texts } from '../texts'
import FileInput from './FileInput.vue'

// Zertifikat importieren: PFX mit Passwort, PEM-Paar oder aus LocalMachine\My. Der Import schreibt
// sofort (wie `tls import`), unabhängig vom Entwurf; danach gelten die Befunde zu `tls` neu. Geprüft
// wird gegen den Hostnamen des Entwurfs, damit ein neuer Hostname mit seinem Zertifikat kommen kann.
const t = texts.addressTls
const { certificate } = useAppState()
const { draft, revalidate } = useDraft()
const toast = useToast()

const dialog = ref<'pfx' | 'pem' | 'store' | null>(null)
const pfxPath = ref('')
const pfxPassword = ref('')
const certPath = ref('')
const keyPath = ref('')
const storeCerts = ref<StoreCert[]>([])
const thumbprint = ref<string | undefined>(undefined)

const pfxFilters = [{ name: t.pfxFilter, extensions: ['pfx', 'p12'] }]
const pemFilters = [{ name: t.pemFilter, extensions: ['pem', 'crt', 'cer', 'key'] }]

const open = computed({
  get: () => dialog.value !== null,
  set: (value: boolean) => {
    if (!value) close()
  },
})

function close() {
  dialog.value = null
  // Das PFX-Passwort bleibt nicht im Speicher der Oberfläche liegen
  pfxPassword.value = ''
}

function imported(cert: CertInfo) {
  certificate.value = cert
  close()
  revalidate()
  toast.add({ title: t.imported, description: t.importedDetail, color: 'success', icon: 'siemens:circle-checkmark' })
}

const importTask = useTask(async () => {
  let cert: CertInfo
  const host = draft.value.public.host
  if (dialog.value === 'pfx') cert = await api.tlsImportPfx(pfxPath.value, pfxPassword.value, host)
  else if (dialog.value === 'pem') cert = await api.tlsImportPem(certPath.value, keyPath.value, host)
  else if (thumbprint.value) cert = await api.tlsImportStore(thumbprint.value, host)
  else return
  imported(cert)
})

const listTask = useTask(async () => {
  storeCerts.value = await api.tlsListStore()
  thumbprint.value = storeCerts.value.find(cert => cert.hasPrivateKey)?.thumbprint
})

function openStore() {
  dialog.value = 'store'
  storeCerts.value = []
  listTask.run()
}

const storeItems = computed(() => storeCerts.value.map(cert => ({
  value: cert.thumbprint,
  label: cert.subject,
  description: [
    t.storeValidUntil(formatDate(cert.notAfter)),
    cert.thumbprint,
    cert.hasPrivateKey ? '' : t.storeNoKey,
  ].filter(Boolean).join(' · '),
  disabled: !cert.hasPrivateKey,
})))

const canImport = computed(() => {
  if (dialog.value === 'pfx') return pfxPath.value !== ''
  if (dialog.value === 'pem') return certPath.value !== '' && keyPath.value !== ''
  return Boolean(thumbprint.value)
})

const title = computed(() => dialog.value === 'pfx' ? t.pfxTitle : dialog.value === 'pem' ? t.pemTitle : t.storeTitle)
const description = computed(() => dialog.value === 'pfx' ? t.pfxDescription : dialog.value === 'pem' ? t.pemDescription : t.storeDescription)
</script>

<template>
  <div class="flex flex-wrap gap-2">
    <UButton
      color="secondary"
      icon="siemens:upload"
      :label="t.importPfx"
      @click="dialog = 'pfx'"
    />
    <UButton
      color="secondary"
      icon="siemens:upload"
      :label="t.importPem"
      @click="dialog = 'pem'"
    />
    <UButton
      color="secondary"
      icon="siemens:lock"
      :label="t.importStore"
      @click="openStore"
    />
  </div>

  <UModal
    v-model:open="open"
    :title="title"
    :description="description"
    :ui="{ footer: 'justify-end gap-2' }"
  >
    <template #body>
      <form
        id="certificate-import"
        class="space-y-4"
        @submit.prevent="importTask.run()"
      >
        <template v-if="dialog === 'pfx'">
          <UFormField :label="t.file">
            <FileInput
              v-model="pfxPath"
              :filters="pfxFilters"
            />
          </UFormField>
          <UFormField :label="t.password">
            <UInput
              v-model="pfxPassword"
              type="password"
              autocomplete="off"
              class="w-full"
            />
          </UFormField>
        </template>
        <template v-else-if="dialog === 'pem'">
          <UFormField :label="t.certFile">
            <FileInput
              v-model="certPath"
              :filters="pemFilters"
            />
          </UFormField>
          <UFormField :label="t.keyFile">
            <FileInput
              v-model="keyPath"
              :filters="pemFilters"
            />
          </UFormField>
        </template>
        <template v-else>
          <p
            v-if="!listTask.running.value && storeCerts.length === 0"
            class="text-sm text-(--ui-color-text-muted)"
          >
            {{ t.storeEmpty }}
          </p>
          <URadioGroup
            v-else
            v-model="thumbprint"
            :items="storeItems"
            :ui="{ description: 'break-all' }"
          />
        </template>
      </form>
    </template>
    <template #footer>
      <UButton
        color="secondary"
        :label="texts.actions.cancel"
        @click="close"
      />
      <UButton
        type="submit"
        form="certificate-import"
        icon="siemens:upload"
        :label="texts.actions.import"
        :loading="importTask.running.value"
        :disabled="!canImport"
      />
    </template>
  </UModal>
</template>
