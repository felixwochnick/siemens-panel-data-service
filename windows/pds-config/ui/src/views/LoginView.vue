<script setup lang="ts">
import { computed, ref } from 'vue'
import UBadge from '@nuxt/ui/components/Badge.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UCard from '@nuxt/ui/components/Card.vue'
import UCheckbox from '@nuxt/ui/components/Checkbox.vue'
import UCollapsible from '@nuxt/ui/components/Collapsible.vue'
import UIcon from '@nuxt/ui/components/Icon.vue'
import UInput from '@nuxt/ui/components/Input.vue'
import { useToast } from '@nuxt/ui/composables'
import { api } from '../api'
import type { ToolResult } from '../bindings/ToolResult'
import ConfigField from '../components/ConfigField.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import CopyButton from '../components/CopyButton.vue'
import FieldFindings from '../components/FieldFindings.vue'
import SecretInput from '../components/SecretInput.vue'
import ToolResultPanel from '../components/ToolResultPanel.vue'
import { useDraft } from '../composables/useDraft'
import { useTask } from '../composables/useTask'
import { issuerOf, redirectUriOf } from '../format'
import { texts } from '../texts'

const t = texts.login
const { draft, original, findings, findingsFor, markSecretSet } = useDraft()
const toast = useToast()

const customIssuer = computed(() => draft.value.oidc.issuer !== '')
const redirectUri = computed(() => draft.value.public.host ? redirectUriOf(draft.value) : '')
const issuer = computed(() => issuerOf(draft.value))

// „Erweitert“ offen, wenn dort etwas eingetragen ist oder ein Befund steht
const advancedFields = ['oidc.issuer', 'oidc.scopes', 'proxy.url', 'proxy.no_proxy']
const advancedOpen = ref(
  customIssuer.value || draft.value.proxy.url !== '' || findings.value.some(f => advancedFields.includes(f.field)),
)

const checkClient = ref(true)
const result = ref<ToolResult | null>(null)
const checkTask = useTask(async () => {
  result.value = null
  result.value = await api.oidcTest(draft.value, checkClient.value)
})

const confirmRegenerate = ref(false)
const regenerateTask = useTask(async () => {
  await api.regenerateAppSecret()
  // Jetzt sicher gesetzt (auch wenn es vorher fehlte); "***" behält beim Speichern das neue
  markSecretSet('app.secret')
  toast.add({ title: t.regenerated, description: t.regeneratedDetail, color: 'success', icon: 'siemens:circle-checkmark' })
})
const appSecretFindings = computed(() => findingsFor('app.secret'))
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
          {{ t.entra }}
        </h2>
      </template>
      <!-- GUIDs brauchen Platz: zweispaltig erst ab breiten Fenstern -->
      <div class="grid gap-4 lg:grid-cols-2">
        <ConfigField
          path="oidc.tenant_id"
          :label="t.tenantId"
          :description="customIssuer ? t.tenantIdUnused : undefined"
        >
          <UInput
            v-model.trim="draft.oidc.tenant_id"
            :placeholder="t.guidPlaceholder"
            :disabled="customIssuer"
            spellcheck="false"
            class="w-full font-mono"
          />
        </ConfigField>
        <ConfigField
          path="oidc.client_id"
          :label="t.clientId"
        >
          <UInput
            v-model.trim="draft.oidc.client_id"
            :placeholder="t.guidPlaceholder"
            spellcheck="false"
            class="w-full font-mono"
          />
        </ConfigField>
        <ConfigField
          path="oidc.client_secret"
          :label="t.clientSecret"
          :description="t.clientSecretHelp"
          class="lg:col-span-2"
        >
          <SecretInput
            v-model="draft.oidc.client_secret"
            :original="original.oidc.client_secret"
          />
        </ConfigField>
      </div>
      <div class="mt-4 grid gap-4 sm:grid-cols-2">
        <ConfigField
          path="oidc.roles_claim"
          :label="t.rolesClaim"
          :description="t.rolesClaimHelp"
        >
          <UInput
            v-model.trim="draft.oidc.roles_claim"
            spellcheck="false"
            class="w-full"
          />
        </ConfigField>
        <ConfigField
          path="oidc.admin_roles"
          :label="t.adminRoles"
          :description="t.adminRolesHelp"
        >
          <UInput
            v-model="draft.oidc.admin_roles"
            spellcheck="false"
            class="w-full"
          />
        </ConfigField>
        <ConfigField
          path="oidc.provider_name"
          :label="t.providerName"
          :description="t.providerNameHelp"
          class="sm:col-span-2"
        >
          <UInput
            v-model="draft.oidc.provider_name"
            class="w-full sm:w-1/2"
          />
        </ConfigField>
      </div>

      <div class="mt-6 space-y-1">
        <p class="text-sm font-medium">
          {{ t.redirectUri }}
        </p>
        <p class="text-sm text-(--ui-color-text-muted)">
          {{ t.redirectUriHelp }}
        </p>
        <div class="flex flex-wrap items-center gap-2 pt-1">
          <code
            class="min-w-0 break-all bg-(--ui-color-row-hover) px-2 py-1.5 text-sm"
            data-testid="redirect-uri"
          >{{ redirectUri || texts.status.noAddress }}</code>
          <CopyButton
            v-if="redirectUri"
            :value="redirectUri"
          />
        </div>
      </div>

      <template #footer>
        <div class="space-y-3">
          <div class="text-sm">
            <p class="text-(--ui-color-text-muted)">
              {{ t.checkHelp }}
            </p>
            <p class="mt-1">
              <span class="text-(--ui-color-text-muted)">{{ t.issuer }}: </span><span class="break-all">{{ issuer }}</span>
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-x-6 gap-y-2">
            <UButton
              icon="siemens:circle-checkmark"
              :label="texts.actions.check"
              :loading="checkTask.running.value"
              @click="checkTask.run()"
            />
            <UCheckbox
              v-model="checkClient"
              :label="t.checkClient"
            />
          </div>
          <ToolResultPanel
            v-if="result || checkTask.running.value"
            :result="result"
            :running="checkTask.running.value"
          />
        </div>
      </template>
    </UCard>

    <UCard :ui="{ body: 'p-0 sm:p-0' }">
      <UCollapsible
        v-model:open="advancedOpen"
        :unmount-on-hide="false"
      >
        <button
          type="button"
          class="flex w-full items-center justify-between gap-2 px-4 py-4 text-left font-semibold hover:bg-(--ui-color-siemens-hover-background) sm:px-6"
          data-testid="advanced-toggle"
        >
          {{ t.advanced }}
          <UIcon
            name="siemens:chevron-down"
            class="size-5 shrink-0 transition-transform"
            :class="advancedOpen ? 'rotate-180' : ''"
          />
        </button>
        <template #content>
          <div class="grid gap-4 border-t border-(--ui-color-surface-border) p-4 sm:grid-cols-2 sm:p-6">
            <ConfigField
              path="oidc.issuer"
              :label="t.customIssuer"
              :description="t.customIssuerHelp"
              class="sm:col-span-2"
            >
              <UInput
                v-model.trim="draft.oidc.issuer"
                :placeholder="texts.placeholders.https"
                spellcheck="false"
                class="w-full"
              />
            </ConfigField>
            <ConfigField
              path="oidc.scopes"
              :label="t.scopes"
              class="sm:col-span-2"
            >
              <UInput
                v-model="draft.oidc.scopes"
                spellcheck="false"
                class="w-full"
              />
            </ConfigField>
            <ConfigField
              path="proxy.url"
              :label="t.proxyUrl"
              :description="t.proxyUrlHelp"
            >
              <UInput
                v-model.trim="draft.proxy.url"
                :placeholder="texts.placeholders.http"
                spellcheck="false"
                class="w-full"
              />
            </ConfigField>
            <ConfigField
              path="proxy.no_proxy"
              :label="t.noProxy"
              :description="t.noProxyHelp"
            >
              <UInput
                v-model.trim="draft.proxy.no_proxy"
                spellcheck="false"
                class="w-full"
              />
            </ConfigField>
          </div>
        </template>
      </UCollapsible>
    </UCard>

    <UCard>
      <template #header>
        <div class="flex items-center justify-between gap-2">
          <h2 class="font-semibold">
            {{ t.appSecret }}
          </h2>
          <!-- Siemens-Feedbackfarben; das Grün von Nuxt UI wäre auf Weiß zu blass -->
          <UBadge
            variant="outline"
            :label="original.app.secret ? t.appSecretSet : t.appSecretMissing"
            :class="original.app.secret
              ? 'border-(--ui-color-feedback-green) bg-(--ui-color-alert-success) text-(--ui-color-feedback-green) ring-0'
              : 'border-(--ui-color-feedback-red) bg-(--ui-color-alert-error) text-(--ui-color-feedback-red) ring-0'"
          />
        </div>
      </template>
      <p class="text-sm">
        {{ t.appSecretHelp }}
      </p>
      <FieldFindings
        :findings="appSecretFindings"
        class="mt-2"
      />
      <UButton
        color="secondary"
        icon="siemens:refresh"
        :label="texts.actions.regenerate"
        :loading="regenerateTask.running.value"
        class="mt-4"
        @click="confirmRegenerate = true"
      />
    </UCard>

    <ConfirmDialog
      v-model:open="confirmRegenerate"
      :title="t.regenerateTitle"
      :description="t.regenerateWarning"
      :confirm-label="t.regenerateConfirm"
      danger
      @confirm="regenerateTask.run()"
    />
  </section>
</template>
