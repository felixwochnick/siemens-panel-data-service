import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ANALYSIS_EVENT_CODES,
  ANALYSIS_STAGES,
  ANALYSIS_STATUSES,
  ANALYSIS_TRIGGERS,
  AUDIT_ACTIONS,
  CHECK_CODES,
  EPLAN_STATES,
  FOLDER_SKIP_CODES,
  LOG_LEVELS,
  PROJECT_SOURCES,
  SETTINGS_ISSUE_CODES,
  WORKER_STATES,
} from '../shared/types/api'

type Messages = { [key: string]: string | Messages }

const root = join(import.meta.dirname, '..')
const APP_FILES = ['app', 'analyses', 'settings']

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Messages

function merge(target: Messages, source: Messages): Messages {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key]
    target[key] = typeof value === 'object' && typeof current === 'object' ? merge(current, value) : value
  }
  return target
}

/** Alle Texte einer Sprache wie in Nuxt: ui-Layer, core-Layer, dann die Dateien der App */
function messages(locale: 'de' | 'en'): Messages {
  const all: Messages = {}
  merge(all, readJson(join(root, '../../packages/ui/i18n/locales', `${locale}.json`)))
  merge(all, readJson(join(root, '../../packages/core/i18n/locales', `${locale}.json`)))
  for (const file of APP_FILES) merge(all, readJson(join(root, 'i18n/locales', locale, `${file}.json`)))
  return all
}

function lookup(all: Messages, key: string): string | undefined {
  let node: string | Messages | undefined = all
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || !Object.hasOwn(node, part)) return undefined
    node = node[part]
  }
  return typeof node === 'string' ? node : undefined
}

function leaves(node: Messages, prefix = ''): string[] {
  return Object.entries(node).flatMap(([key, value]) => (typeof value === 'string' ? [prefix + key] : leaves(value, `${prefix}${key}.`)))
}

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(vue|ts)$/.test(name) ? [path] : []
  })
}

const de = messages('de')
const en = messages('en')

/** Codes, die als Text einer Antwort kommen, aber nicht als ServiceError-Literal im Code stehen */
const DYNAMIC_ERROR_CODES = [
  // Übersprungene Ordnerpfade (StartAnalysisSkip.code)
  'invalid_path', 'folder_project_not_found', 'edb_missing',
  // Netzlaufwerk (AnalysisError → ServiceError 424)
  'network_drive_unsupported', 'network_drive_failed', 'drive_unavailable', 'secret_unreadable',
]

describe('Übersetzungen', () => {
  const lists: [string, readonly string[]][] = [
    ['analysisEvents', ANALYSIS_EVENT_CODES],
    ['analysisStatus', ANALYSIS_STATUSES],
    ['analysisTrigger', ANALYSIS_TRIGGERS],
    ['analysisStage', ANALYSIS_STAGES],
    ['logLevels', LOG_LEVELS],
    ['projectSources', PROJECT_SOURCES],
    ['eplanStates', EPLAN_STATES],
    ['folderSkips', FOLDER_SKIP_CODES],
    ['settingsIssues', SETTINGS_ISSUE_CODES],
    ['checks', CHECK_CODES],
    ['app.workerStates', WORKER_STATES],
    ['errors', DYNAMIC_ERROR_CODES],
  ]

  it.each(lists)('jeder Code von %s hat einen deutschen und englischen Text', (prefix, codes) => {
    for (const code of codes) {
      expect(lookup(de, `${prefix}.${code}`), `de ${prefix}.${code}`).toBeTruthy()
      expect(lookup(en, `${prefix}.${code}`), `en ${prefix}.${code}`).toBeTruthy()
    }
  })

  it('Ereignisse und Prüfungen nutzen in beiden Sprachen dieselben Platzhalter', () => {
    for (const [prefix, codes] of [['analysisEvents', ANALYSIS_EVENT_CODES], ['checks', CHECK_CODES]] as const) {
      for (const code of codes) {
        const key = `${prefix}.${code}`
        expect(placeholders(lookup(de, key)!), key).toEqual(placeholders(lookup(en, key)!))
      }
    }
  })

  it('jeder Fehlercode der Services hat einen Text (errors.<code>)', () => {
    const codes = new Set<string>()
    for (const file of sourceFiles(join(root, 'server'))) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/(?:ServiceError\(\d+, |issuesError\()'([a-z_]+)'/g)) codes.add(match[1]!)
    }
    expect(codes.size).toBeGreaterThan(15)
    for (const code of codes) {
      expect(lookup(de, `errors.${code}`), `de errors.${code}`).toBeTruthy()
      expect(lookup(en, `errors.${code}`), `en errors.${code}`).toBeTruthy()
    }
  })

  it('Änderungsprotokoll: jede Aktion hat einen Text', () => {
    const keys = AUDIT_ACTIONS.flatMap(action => (action === 'scheduler_toggled' ? ['scheduler_toggled_on', 'scheduler_toggled_off'] : [action]))
    for (const key of keys) {
      expect(lookup(de, `audit.${key}`), key).toBeTruthy()
      expect(lookup(en, `audit.${key}`), key).toBeTruthy()
    }
  })

  it('Deutsch und Englisch haben je Datei dieselben Schlüssel', () => {
    for (const file of APP_FILES) {
      const keysDe = leaves(readJson(join(root, 'i18n/locales/de', `${file}.json`))).sort()
      const keysEn = leaves(readJson(join(root, 'i18n/locales/en', `${file}.json`))).sort()
      expect(keysEn, file).toEqual(keysDe)
    }
  })

  it('jeder feste Schlüssel im Code der Oberfläche existiert in beiden Sprachen', () => {
    const used = new Set<string>()
    for (const file of sourceFiles(join(root, 'app'))) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/\b(?:t|te|\$t)\(\s*'([\w.]+)'/g)) used.add(match[1]!)
    }
    expect(used.size).toBeGreaterThan(3)
    for (const key of used) {
      expect(lookup(de, key), `de ${key}`).toBeDefined()
      expect(lookup(en, key), `en ${key}`).toBeDefined()
    }
  })

  it('Texte sind gültige vue-i18n-Nachrichten (kein ungeschütztes @ oder $, Klammern geschlossen)', () => {
    for (const [locale, all] of [['de', de], ['en', en]] as const) {
      for (const file of APP_FILES) {
        const own = readJson(join(root, 'i18n/locales', locale, `${file}.json`))
        for (const key of leaves(own)) {
          const text = lookup(own, key)!
          expect(text.replace(/\{'[^']*'\}/g, ''), `${locale} ${key}`).not.toMatch(/[@$|]/)
          expect(text.split('{').length, `${locale} ${key}`).toBe(text.split('}').length)
        }
      }
      expect(lookup(all, 'auth.appName')).toBe('Panel Data Service')
      expect(lookup(all, 'app.name')).toBe('Panel Data Service')
    }
  })
})
