<script setup lang="ts">
import { computed } from 'vue'
import UAlert from '@nuxt/ui/components/Alert.vue'
import UCard from '@nuxt/ui/components/Card.vue'
import USwitch from '@nuxt/ui/components/Switch.vue'
import ConfigField from '../components/ConfigField.vue'
import CopyButton from '../components/CopyButton.vue'
import { useDraft } from '../composables/useDraft'
import { appUrlOf } from '../format'
import { texts } from '../texts'

const t = texts.assistants
const { draft } = useDraft()

const endpoint = computed(() => draft.value.public.host ? `${appUrlOf(draft.value)}/mcp` : '')
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
      variant="subtle"
      color="warning"
      icon="siemens:circle-warning"
      :title="t.privacyTitle"
      :description="t.privacy"
      data-testid="privacy"
    />

    <UCard>
      <ConfigField
        path="mcp.enabled"
        :label="t.toggle"
        :description="t.toggleHelp"
        horizontal
      >
        <USwitch v-model="draft.mcp.enabled" />
      </ConfigField>

      <div
        v-if="draft.mcp.enabled"
        class="mt-6 space-y-1"
      >
        <p class="text-sm font-medium">
          {{ t.endpoint }}
        </p>
        <p class="text-sm text-(--ui-color-text-muted)">
          {{ t.endpointHelp }}
        </p>
        <div class="flex flex-wrap items-center gap-2 pt-1">
          <code class="min-w-0 break-all bg-(--ui-color-row-hover) px-2 py-1.5 text-sm">{{ endpoint || texts.status.noAddress }}</code>
          <CopyButton
            v-if="endpoint"
            :value="endpoint"
          />
        </div>
      </div>
      <p
        v-else
        class="mt-4 text-sm text-(--ui-color-text-muted)"
      >
        {{ t.off }}
      </p>
    </UCard>
  </section>
</template>
