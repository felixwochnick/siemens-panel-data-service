<script setup lang="ts">
definePageMeta({ layout: 'auth' })

const { t } = useI18n()
const route = useRoute()
const { user } = useAuth()
const apiError = useApiError()

// Ohne MCP gibt es die Seite nicht (nur ein echtes `true` schaltet ein)
if (useRuntimeConfig().public.mcpEnabled !== true) throw createError({ statusCode: 404, fatal: true })

// Der Anzeigename der App kommt aus der app.config der App; core kennt den Schlüssel nicht
const appTitle = (useAppConfig() as { pds?: { mcp?: { title?: string } } }).pds?.mcp?.title ?? t('auth.appName')

// Nur Texte: die Query geht unverändert an den Server zurück, der sie bei jedem Aufruf neu prüft
const query = computed(() => Object.fromEntries(
  Object.entries(route.query).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
))

// Fester Schlüssel: der automatische hasht die Refs im query-Objekt (Server ≠ Browser → Daten verworfen)
const { data: info, error: loadError, status } = await useFetch<AuthorizeInfo>('/api/oauth/authorize', {
  key: 'oauth-authorize',
  query,
})

// Anmeldung zu alt für eine Zustimmung (Server: höchstens 10 Minuten): einmal über die Anmeldung und hierher zurück –
// mit Entra-SSO meist ohne Eingabe. Der Server entscheidet; die Seite folgt nur dem Fehlercode.
const isReauth = (error: unknown) => (error as { data?: { message?: unknown } } | null | undefined)?.data?.message === 'reauth_required'
const reauthUrl = computed(() => `/auth/login?redirect=${encodeURIComponent(route.fullPath)}`)
const reauthenticating = ref(false)
const needsReauth = computed(() => reauthenticating.value || isReauth(loadError.value))

function reauthenticate() {
  reauthenticating.value = true
  window.location.assign(reauthUrl.value)
}

const failed = computed(() => !needsReauth.value && (!!loadError.value || (status.value !== 'pending' && !info.value)))

useSeoMeta({ title: () => t(failed.value ? 'oauth.consent.errorTitle' : 'oauth.consent.title') })

// Vorausgewählt ist immer die niedrigste Stufe: höhere wählt man bewusst
const access = ref<McpGrant>('read')
const accessItems = computed(() => MCP_GRANTS.map(grant => ({
  value: grant,
  label: t(`mcp.access.${grant}`),
  description: t(`mcp.accessHint.${grant}`),
})))

const submitting = ref<'allow' | 'deny' | null>(null)
const submitError = ref('')

async function submit(approve: boolean) {
  submitting.value = approve ? 'allow' : 'deny'
  submitError.value = ''
  try {
    const { redirect } = await $fetch<{ redirect: string }>('/api/oauth/authorize', {
      method: 'POST',
      body: approve ? { query: query.value, approve, access: access.value } : { query: query.value, approve },
    })
    // Nur dorthin, wohin ein Programm überhaupt zurückspringen darf (https oder Loopback) – nie javascript: o. ä.
    if (!isAllowedRedirectUri(redirect)) throw new Error('unexpected redirect')
    // Ziel kann http://localhost:<port> des Programms sein, daher kein Router; die Knöpfe bleiben gesperrt
    window.location.assign(redirect)
  }
  catch (error) {
    if (isReauth(error)) return reauthenticate()
    submitError.value = apiError(error)
    submitting.value = null
  }
}

// Zurück aus dem Programm oder von der Anmeldung (Back-Forward-Cache): sonst blieben die Knöpfe gesperrt
function onPageShow(event: PageTransitionEvent) {
  if (!event.persisted) return
  submitting.value = null
  reauthenticating.value = false
}

onMounted(() => {
  window.addEventListener('pageshow', onPageShow)
  if (isReauth(loadError.value)) reauthenticate()
})
onBeforeUnmount(() => window.removeEventListener('pageshow', onPageShow))
</script>

<template>
  <UCard
    class="w-full max-w-lg"
    data-testid="oauth-consent"
  >
    <div class="flex flex-col gap-6">
      <div class="flex items-center gap-4">
        <UIcon
          name="siemens:pds"
          class="size-14 shrink-0"
        />
        <div class="min-w-0">
          <h1 class="text-2xl font-bold">
            {{ failed ? t('oauth.consent.errorTitle') : t('oauth.consent.title') }}
          </h1>
          <p class="text-sm text-muted">
            {{ appTitle }}
          </p>
        </div>
      </div>

      <div
        v-if="status === 'pending' && !info"
        class="flex flex-col gap-3"
      >
        <USkeleton class="h-12" />
        <USkeleton class="h-28" />
      </div>

      <template v-else-if="needsReauth">
        <UAlert
          color="info"
          variant="subtle"
          icon="siemens:circle-information"
          :description="t('errors.reauth_required')"
          data-testid="oauth-reauth"
        />
        <UButton
          :to="reauthUrl"
          external
          block
          icon="siemens:login"
          :label="t('oauth.consent.reauth')"
          :loading="reauthenticating"
          data-testid="oauth-reauth-login"
        />
      </template>

      <template v-else-if="failed || !info">
        <UAlert
          color="error"
          variant="subtle"
          icon="siemens:circle-error"
          :description="apiError(loadError)"
          data-testid="oauth-error"
        />
        <p class="text-sm text-muted">
          {{ t('oauth.consent.errorHint') }}
        </p>
      </template>

      <template v-else>
        <p>{{ t('oauth.consent.intro', { app: appTitle }) }}</p>

        <dl class="flex flex-col gap-4 border-y border-default py-4">
          <div class="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-x-4">
            <dt class="text-sm text-muted">
              {{ t('oauth.consent.client') }}
            </dt>
            <dd class="min-w-0">
              <p
                class="break-words text-base font-semibold"
                data-testid="oauth-client"
              >
                {{ info.client.name }}
              </p>
              <p class="text-xs text-muted">
                {{ t('oauth.consent.clientHint') }}
              </p>
            </dd>
          </div>
          <div class="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-x-4">
            <dt class="text-sm text-muted">
              {{ t('oauth.consent.redirectHost') }}
            </dt>
            <dd class="min-w-0">
              <p
                class="break-all font-mono text-sm font-medium"
                data-testid="oauth-redirect-host"
              >
                {{ info.client.redirectHost }}
              </p>
              <p class="text-xs text-muted">
                {{ t('oauth.consent.redirectHint') }}
              </p>
            </dd>
          </div>
          <div class="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-x-4">
            <dt class="text-sm text-muted">
              {{ t('oauth.consent.user') }}
            </dt>
            <dd class="min-w-0 break-words font-medium">
              {{ user?.displayName }}
            </dd>
          </div>
        </dl>

        <div class="flex flex-col gap-2">
          <URadioGroup
            v-model="access"
            :items="accessItems"
            :legend="t('oauth.consent.access')"
            variant="card"
            :disabled="submitting !== null"
            data-testid="oauth-access"
          />
          <p
            v-if="info.requested"
            class="text-xs text-muted"
          >
            {{ t('oauth.consent.requested', { level: t(`mcp.access.${info.requested}`) }) }}
          </p>
        </div>

        <UAlert
          v-if="submitError"
          color="error"
          variant="subtle"
          icon="siemens:circle-error"
          :description="submitError"
          data-testid="oauth-error"
        />

        <div class="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <UButton
            color="secondary"
            :label="t('oauth.consent.deny')"
            :disabled="submitting !== null"
            :loading="submitting === 'deny'"
            data-testid="oauth-deny"
            @click="submit(false)"
          />
          <UButton
            icon="siemens:checkmark-medium"
            :label="t('oauth.consent.allow')"
            :disabled="submitting !== null"
            :loading="submitting === 'allow'"
            data-testid="oauth-allow"
            @click="submit(true)"
          />
        </div>

        <p class="text-xs text-muted">
          {{ t('oauth.consent.footer') }}
        </p>
      </template>
    </div>
  </UCard>
</template>
