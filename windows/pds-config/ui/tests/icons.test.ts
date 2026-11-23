import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { siemensCollection } from '../src/icons'

const root = join(import.meta.dirname, '..')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'bindings' ? [] : sources(path)
    return /\.(vue|ts)$/.test(entry.name) ? [path] : []
  })
}

describe('Siemens-Icons', () => {
  const collection = siemensCollection()

  it('collection_contains_layer_icons', () => {
    const files = readdirSync(join(root, '../../../packages/ui/app/assets/siemens')).filter(name => name.endsWith('.svg'))
    expect(collection.prefix).toBe('siemens')
    expect(Object.keys(collection.icons).sort()).toEqual(files.map(name => name.slice(0, -4)).sort())
  })

  it('used_icons_are_local', () => {
    // Jedes Icon der Oberfläche und der Nuxt-UI-Konfiguration muss in der Sammlung liegen, sonst bliebe es leer
    const text = [...sources(join(root, 'src')), join(root, 'vite.config.ts'), join(root, '../../../packages/ui/app/app.config.ts')]
      .map(path => readFileSync(path, 'utf8'))
      .join('\n')
    const used = new Set([...text.matchAll(/['"]siemens:([a-z0-9-]+)['"]/g)].map(match => match[1]!))
    expect(used.size).toBeGreaterThan(20)
    expect([...used].filter(name => !(name in collection.icons))).toEqual([])
    // Keine anderen Sammlungen (z. B. i-lucide-…, heroicons:…)
    expect(text).not.toMatch(/['"]i-[a-z]+-[a-z0-9-]+['"]/)
  })
})
