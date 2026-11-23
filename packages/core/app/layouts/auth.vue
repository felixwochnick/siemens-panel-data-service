<template>
  <div class="flex min-h-dvh flex-col bg-(--color-siemens-primary-light-sand) dark:bg-(--ui-bg)">
    <header class="flex items-center justify-between px-4 py-4 sm:px-8">
      <AppLogo :name="$t('auth.appName')" />
      <div class="flex items-center gap-1">
        <LocaleSwitch />
        <UColorModeButton />
      </div>
    </header>
    <main class="flex flex-1 items-center justify-center px-4 pb-16">
      <slot />
    </main>
  </div>
</template>
