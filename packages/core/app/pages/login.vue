<script setup lang="ts">
definePageMeta({ layout: 'auth', public: true })

const { t, te } = useI18n()
const route = useRoute()
const config = useRuntimeConfig()

useSeoMeta({ title: () => t('auth.login.title') })

const redirect = computed(() => safeRedirectPath(route.query.redirect))
const loginUrl = computed(() => `/auth/login?redirect=${encodeURIComponent(redirect.value)}`)

const error = computed(() => {
  const code = typeof route.query.error === 'string' ? route.query.error : ''
  if (!code) return ''
  return te(`errors.${code}`) ? t(`errors.${code}`) : t('errors.sso_failed')
})
</script>

<template>
  <UCard class="w-full max-w-md">
    <div class="flex flex-col gap-6">
      <div class="flex items-center gap-4">
        <UIcon
          name="siemens:pds"
          class="size-14 shrink-0"
        />
        <div>
          <h1 class="text-2xl font-bold">
            {{ t('auth.login.title') }}
          </h1>
          <p class="text-sm text-muted">
            {{ t('auth.login.subtitle') }}
          </p>
        </div>
      </div>

      <UAlert
        v-if="error"
        color="error"
        variant="subtle"
        icon="siemens:circle-error"
        :description="error"
        data-testid="login-error"
      />

      <UButton
        :to="loginUrl"
        external
        block
        size="lg"
        icon="siemens:login"
        :label="t('auth.login.button', { provider: config.public.oidcProviderName })"
        data-testid="login-button"
      />

      <p class="text-xs text-muted">
        {{ t('auth.login.hint') }}
      </p>
    </div>
  </UCard>
</template>
