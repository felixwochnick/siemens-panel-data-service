<script setup lang="ts">
const { t, locale } = useI18n()
const config = useRuntimeConfig()
const toast = useToast()
const confirm = useConfirmModal()
const apiError = useApiError()

// Ohne MCP gibt es die Seite nicht (nur ein echtes `true` schaltet ein)
if (config.public.mcpEnabled !== true) throw createError({ statusCode: 404, fatal: true })

// Name und Anzeigename kommen aus der app.config der App; core kennt den Schlüssel nicht
const mcp = (useAppConfig() as { pds?: { mcp?: { name?: string, title?: string } } }).pds?.mcp
const serverName = mcp?.name ?? 'mcp'
const appTitle = mcp?.title ?? t('auth.appName')

useSeoMeta({ title: () => t('mcp.assistants.title') })

const command = `claude mcp add --transport http ${serverName} ${config.public.appUrl.replace(/\/+$/, '')}/mcp`
const { copy, copied } = useClipboard({ source: command, copiedDuring: 2000, legacy: true })

const { data: connections, error: loadError, refresh } = await useFetch<McpConnectionInfo[]>('/api/mcp/connections', {
  key: 'mcp-connections',
  default: () => [],
})

// Feste Zeitzone, damit Server (UTC) und Browser identisch rendern
const dateTime = computed(() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' }))
const formatTime = (iso: string) => dateTime.value.format(new Date(iso))

const disconnecting = ref<string | null>(null)

async function disconnect(connection: McpConnectionInfo) {
  const confirmed = await confirm({
    title: t('mcp.assistants.connections.disconnectTitle'),
    question: t('mcp.assistants.connections.disconnectQuestion', { name: connection.name }),
    confirmLabel: t('mcp.assistants.connections.disconnect'),
    danger: true,
  })
  if (!confirmed) return
  disconnecting.value = connection.id
  try {
    await $fetch(`/api/mcp/connections/${connection.id}`, { method: 'DELETE' })
    toast.add({ title: t('mcp.assistants.connections.disconnected'), color: 'success', icon: 'siemens:circle-checkmark' })
  }
  catch (error) {
    toast.add({ title: apiError(error), color: 'error', icon: 'siemens:circle-error' })
  }
  finally {
    disconnecting.value = null
  }
  // Auch nach einem Fehler: die Verbindung kann inzwischen abgelaufen oder schon getrennt sein
  await refresh()
}
</script>

<template>
  <UDashboardPanel id="assistants">
    <template #header>
      <UDashboardNavbar :title="t('mcp.assistants.title')">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="mx-auto flex w-full max-w-4xl flex-col gap-8">
        <p class="text-muted">
          {{ t('mcp.assistants.intro', { app: appTitle }) }}
        </p>

        <UPageCard
          :title="t('mcp.assistants.connect.title')"
          :description="t('mcp.assistants.connect.description')"
          variant="outline"
          :ui="{ container: 'min-w-0' }"
        >
          <ol class="flex min-w-0 flex-col gap-5">
            <li class="flex min-w-0 gap-3">
              <span class="flex size-6 shrink-0 items-center justify-center rounded-full bg-(--ui-color-siemens) text-xs font-bold text-inverted">1</span>
              <div class="flex min-w-0 flex-1 flex-col gap-2">
                <p>{{ t('mcp.assistants.connect.step1') }}</p>
                <div class="flex min-w-0 items-stretch border border-default bg-muted">
                  <code
                    tabindex="0"
                    class="min-w-0 flex-1 overflow-x-auto px-3 py-2.5 font-mono text-sm whitespace-nowrap"
                    data-testid="mcp-command"
                  >{{ command }}</code>
                  <UButton
                    color="neutral"
                    variant="ghost"
                    square
                    class="shrink-0 rounded-none"
                    :icon="copied ? 'siemens:checkmark-medium' : 'siemens:copy'"
                    :aria-label="copied ? t('mcp.assistants.connect.copied') : t('mcp.assistants.connect.copy')"
                    :title="copied ? t('mcp.assistants.connect.copied') : t('mcp.assistants.connect.copy')"
                    data-testid="mcp-copy"
                    @click="copy()"
                  />
                </div>
              </div>
            </li>
            <li class="flex min-w-0 gap-3">
              <span class="flex size-6 shrink-0 items-center justify-center rounded-full bg-(--ui-color-siemens) text-xs font-bold text-inverted">2</span>
              <i18n-t
                keypath="mcp.assistants.connect.step2"
                scope="global"
                tag="p"
                class="min-w-0 flex-1"
              >
                <template #command>
                  <code class="bg-muted px-1 py-0.5 font-mono text-sm">/mcp</code>
                </template>
                <template #server>
                  <code class="bg-muted px-1 py-0.5 font-mono text-sm">{{ serverName }}</code>
                </template>
              </i18n-t>
            </li>
            <li class="flex min-w-0 gap-3">
              <span class="flex size-6 shrink-0 items-center justify-center rounded-full bg-(--ui-color-siemens) text-xs font-bold text-inverted">3</span>
              <p class="min-w-0 flex-1">
                {{ t('mcp.assistants.connect.step3') }}
              </p>
            </li>
          </ol>

          <i18n-t
            keypath="mcp.assistants.connect.lifetime"
            scope="global"
            tag="p"
            class="text-sm text-muted"
          >
            <template #command>
              <code class="bg-muted px-1 py-0.5 font-mono text-xs">/mcp</code>
            </template>
          </i18n-t>
        </UPageCard>

        <UAlert
          color="info"
          variant="subtle"
          icon="siemens:circle-information"
          :title="t('mcp.assistants.privacy.title')"
          :description="t('mcp.assistants.privacy.text')"
          data-testid="mcp-privacy"
        />

        <UPageCard
          :title="t('mcp.assistants.connections.title')"
          :description="t('mcp.assistants.connections.description', { app: appTitle })"
          variant="outline"
          :ui="{ container: 'min-w-0' }"
        >
          <UAlert
            v-if="loadError"
            color="error"
            variant="subtle"
            icon="siemens:circle-error"
            :description="apiError(loadError)"
          />

          <div
            v-else-if="!connections.length"
            class="flex flex-col items-center justify-center gap-3 border border-dashed border-default px-6 py-10 text-center"
            data-testid="mcp-empty"
          >
            <UIcon
              name="siemens:ai"
              class="size-10 text-muted"
            />
            <p class="font-semibold">
              {{ t('mcp.assistants.connections.empty') }}
            </p>
            <p class="max-w-md text-sm text-muted">
              {{ t('mcp.assistants.connections.emptyHint') }}
            </p>
          </div>

          <ul
            v-else
            class="divide-y divide-default border border-default"
          >
            <li
              v-for="connection in connections"
              :key="connection.id"
              class="flex min-w-0 flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between"
              data-testid="mcp-connection"
            >
              <div class="flex min-w-0 flex-col gap-3">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="font-semibold break-words">{{ connection.name }}</span>
                  <UBadge
                    :label="t(`mcp.access.${connection.access}`)"
                    :color="connection.access === 'write' ? 'primary' : 'neutral'"
                    variant="subtle"
                  />
                </div>
                <dl class="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                  <div>
                    <dt class="text-xs text-muted">
                      {{ t('mcp.assistants.connections.connectedAt') }}
                    </dt>
                    <dd>{{ formatTime(connection.createdAt) }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs text-muted">
                      {{ t('mcp.assistants.connections.lastUsed') }}
                    </dt>
                    <dd>{{ connection.lastUsedAt ? formatTime(connection.lastUsedAt) : t('mcp.assistants.connections.neverUsed') }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs text-muted">
                      {{ t('mcp.assistants.connections.expiresAt') }}
                    </dt>
                    <dd>{{ formatTime(connection.expiresAt) }}</dd>
                  </div>
                </dl>
              </div>
              <UButton
                color="secondary"
                icon="siemens:delete"
                :label="t('mcp.assistants.connections.disconnect')"
                :loading="disconnecting === connection.id"
                class="shrink-0 self-start sm:self-center"
                data-testid="mcp-disconnect"
                @click="disconnect(connection)"
              />
            </li>
          </ul>
        </UPageCard>
      </div>
    </template>
  </UDashboardPanel>
</template>
