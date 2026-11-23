import { createConfigForNuxt } from '@nuxt/eslint-config/flat'

export default createConfigForNuxt({
  features: {
    stylistic: true,
  },
}).append({
  // Von ts-rs erzeugt (Task 14), nicht von Hand ändern
  ignores: ['src/bindings/**'],
})
