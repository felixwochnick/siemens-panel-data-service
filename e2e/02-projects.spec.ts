import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { BrowserContext, Page } from '@playwright/test'
import { readSheet } from 'read-excel-file/node'
import { analyze, parseRawProject } from '../packages/analyzer/src/index'
import { APP_URL, FIXTURE } from './targets'
import { browserFetch, expectToast, gotoHydrated, loggedIn, openTab, sheet } from './utils'

/*
 * Hochladen ⇒ Analyse (Ersatz-Worker mit der Fixture) ⇒ Tabellen: Zähler, Filter, Suche, Sortieren, Kopieren,
 * Export (.xlsx mit Textzellen, CSV), Kabelnavigator, Sprung aus den Schirmen, Stände. Als Paul (kein Admin): alle
 * Angemeldeten dürfen hochladen und analysieren.
 */

const result = analyze(parseRawProject(JSON.parse(readFileSync(new URL('../packages/analyzer/fixtures/sample-raw.json', import.meta.url), 'utf8'))))
const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' })
const CONNECTION_HEADER = ['Seite', 'Funktionsdefinition', 'Verbindungsbezeichnung', 'Quelle', 'Ziel', 'Kabel', 'Farbe/Nummer', 'Querschnitt', 'Typ', 'Länge', 'Artikelnummer', '#-Markierung', 'Verdrillung', 'Abgeschirmt']
const PROJECT = 'Anlage E2E'

test.describe.serial('Projekte und Tabellen', () => {
  let context: BrowserContext
  let page: Page
  let projectUrl = ''

  test.beforeAll(async ({ browser }) => {
    ;({ context, page } = await loggedIn(browser, 'paul'))
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP_URL })
  })

  test.afterAll(async () => {
    await context.close()
  })

  test('ohne Projekte: Hinweis; ohne Projektordner erklärt der Ordner-Dialog, wer ihn einrichtet', async () => {
    await gotoHydrated(page, '/projects')
    await expect(page.getByTestId('projects-empty')).toContainText('Noch keine Projekte')
    await page.getByTestId('projects-folder').click()
    await expect(page.getByTestId('folder-not-configured')).toContainText('Administrator')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('folder-dialog')).toHaveCount(0)
  })

  test('Hochladen startet die Analyse und führt zum Projekt; danach erscheinen die Tabellen', async ({}, testInfo) => {
    // Nur .zw1: im Dialog gesperrt, und auch am Dialog vorbei lehnt der Server andere Endungen ab
    const wrong = testInfo.outputPath('Anlage.elk')
    writeFileSync(wrong, 'kein Archiv')
    const rejected = await page.evaluate(async () => (await fetch('/api/projects/upload?name=Anlage.elk', { method: 'POST', body: 'x' })).json())
    expect(rejected.message).toBe('upload_invalid_type')

    await page.getByTestId('projects-upload').click()
    const input = page.getByTestId('upload-dialog').locator('input[type="file"]')
    await input.setInputFiles(wrong)
    await expect(page.getByTestId('upload-error')).toContainText('.zw1')
    await expect(page.getByTestId('upload-start')).toBeDisabled()

    const file = testInfo.outputPath(`${PROJECT}.zw1`)
    writeFileSync(file, 'zw1-Inhalt für den Ersatz-Worker')
    await input.setInputFiles(file)
    await expect(page.getByTestId('upload-error')).toHaveCount(0)
    await page.getByTestId('upload-start').click()
    await page.waitForURL(/\/projects\/\d+$/)
    projectUrl = new URL(page.url()).pathname
    await expect(page.getByTestId('project-header')).toBeVisible()
    await expect(page.getByRole('heading', { level: 1, name: PROJECT })).toBeVisible()
    // Die Analyse läuft (Stufen des Ersatz-Workers), danach erscheinen die Tabellen ohne Neuladen
    await expect(page.getByTestId('result-tabs')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('project-version')).toHaveCount(1)
    await expect(page.getByTestId('project-version').first()).toHaveAttribute('data-status', 'succeeded')

    const tabs = page.getByTestId('result-tabs').getByRole('tab')
    await expect(tabs).toHaveText([
      `Verbindungen${FIXTURE.connections}`,
      `Kabel${FIXTURE.cables}`,
      `Schirme${FIXTURE.shields}`,
      `Texte${FIXTURE.texts}`,
    ])
  })

  test('Verbindungen: alle Zeilen, Spalten wie in der alten Excel, ja/leer', async () => {
    const connections = sheet(page, 'connections')
    await expect(connections.count).toHaveText(`${FIXTURE.connections} von ${FIXTURE.connections} Zeilen`)
    await expect(connections.rows).toHaveCount(FIXTURE.connections)
    const header = await connections.root.locator('[data-testid^="sheet-sort-"]').allInnerTexts()
    expect(header.map(text => text.trim())).toEqual(CONNECTION_HEADER)
    await expect(connections.cell(0, 0)).toHaveText(result.connections[0]!.page)
    await expect(connections.cell(0, 11)).toHaveText('ja')
    await expect(connections.cell(1, 11)).toHaveText('')
  })

  test('Filter je Spalte, ja/nein-Filter und Suche', async () => {
    const connections = sheet(page, 'connections')
    await connections.filter('cable').fill('w20')
    await expect(connections.count).toHaveText(`2 von ${FIXTURE.connections} Zeilen`)
    await expect(connections.rows).toHaveCount(2)
    await page.getByTestId('sheet-connections').getByTestId('sheet-reset').click()
    await expect(connections.count).toHaveText(`${FIXTURE.connections} von ${FIXTURE.connections} Zeilen`)

    await connections.filter('twisted').click()
    await page.getByRole('option', { name: 'ja', exact: true }).click()
    const twisted = result.connections.filter(row => row.twisted).length
    await expect(connections.count).toHaveText(`${twisted} von ${FIXTURE.connections} Zeilen`)
    await connections.filter('twisted').click()
    await page.getByRole('option', { name: 'nein', exact: true }).click()
    await expect(connections.count).toHaveText(`${FIXTURE.connections - twisted} von ${FIXTURE.connections} Zeilen`)
    await connections.filter('twisted').click()
    await page.getByRole('option', { name: 'alle', exact: true }).click()

    await connections.search.fill('X11:4')
    await expect(connections.count).toHaveText(`1 von ${FIXTURE.connections} Zeilen`)
    await expect(connections.cell(0, 4)).toHaveText('=VB030+LCM-A2:X11:4')
    await connections.search.fill('gibt es nicht')
    await expect(connections.root.getByTestId('sheet-empty')).toContainText('Keine Zeile passt')
    await connections.search.fill('')
    await expect(connections.count).toHaveText(`${FIXTURE.connections} von ${FIXTURE.connections} Zeilen`)
  })

  test('Sortieren per Klick auf die Kopfzeile: auf, ab, aus (natürlich)', async () => {
    const connections = sheet(page, 'connections')
    const sources = result.connections.map(row => row.source)
    const ascending = [...sources].sort((a, b) => (!a || !b ? (a ? -1 : b ? 1 : 0) : collator.compare(a, b)))
    await connections.sortBy('source')
    await expect.poll(() => connections.columnTexts(3)).toEqual(ascending)
    await connections.sortBy('source')
    const descending = [...sources].filter(Boolean).sort((a, b) => collator.compare(b, a))
    await expect.poll(async () => (await connections.columnTexts(3)).filter(Boolean)).toEqual(descending)
    await connections.sortBy('source')
    await expect.poll(() => connections.columnTexts(3)).toEqual(sources)
    // Natürlich: Seite 5 vor 7, 8, 9 – auch bei zweistelligen Nummern
    await connections.sortBy('page')
    const pages = await connections.columnTexts(0)
    expect(pages).toEqual([...pages].sort((a, b) => collator.compare(a, b)))
    await connections.sortBy('page')
    await connections.sortBy('page')
  })

  test('Zellbereich markieren und mit Strg+C als TSV kopieren; ganze Spalten mit Überschrift', async () => {
    const connections = sheet(page, 'connections')
    await connections.cell(0, 3).click()
    await connections.cell(1, 4).click({ modifiers: ['Shift'] })
    await page.keyboard.press('Control+c')
    await expectToast(page, '2 × 2 Zellen kopiert')
    const [first, second] = result.connections
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${first!.source}\t${first!.destination}\r\n${second!.source}\t${second!.destination}`)

    // Tastatur: Umschalt+Pfeil erweitert, Strg+Leertaste nimmt die ganze Spalte samt Überschrift
    await connections.cell(0, 0).click()
    await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('Control+Space')
    await page.keyboard.press('Control+c')
    await expectToast(page, 'mit Überschrift')
    const lines = (await page.evaluate(() => navigator.clipboard.readText())).split('\r\n')
    expect(lines).toHaveLength(FIXTURE.connections + 1)
    expect(lines[0]).toBe('Seite\tFunktionsdefinition')
    expect(lines[1]).toBe(`${first!.page}\t${first!.definition}`)

    // Maus ziehen
    await connections.cell(2, 0).hover()
    await page.mouse.down()
    await connections.cell(4, 2).hover()
    await page.mouse.up()
    await expect(connections.root.getByTestId('sheet-selection')).toHaveText('3 × 3 markiert')
  })

  test('Export als .xlsx: gefilterte Zeilen, alle Werte als Text, Dateiname mit Projekt, Tab und Analyse', async () => {
    const connections = sheet(page, 'connections')
    await connections.filter('shielded').click()
    await page.getByRole('option', { name: 'ja', exact: true }).click()
    const shielded = result.connections.filter(row => row.shielded)
    await expect(connections.count).toHaveText(`${shielded.length} von ${FIXTURE.connections} Zeilen`)

    await connections.root.getByTestId('sheet-export').click()
    const download = page.waitForEvent('download')
    await page.getByRole('menuitem', { name: /Excel/ }).click()
    const file = await download
    const analysisId = (await browserFetch<{ currentAnalysis: { id: number } }>(page, `/api${projectUrl}`)).body.currentAnalysis.id
    expect(file.suggestedFilename()).toBe(`${PROJECT}_Verbindungen_${analysisId}.xlsx`)

    const rows = await readSheet(await file.path())
    expect(rows[0]).toEqual(CONNECTION_HEADER)
    expect(rows).toHaveLength(shielded.length + 1)
    // Kennzeichen wie =VB030+LCM-B1:1 bleiben Text (keine Formel), leere Zellen leer
    expect(rows[1]![0]).toBe(shielded[0]!.page)
    expect(rows[1]![3]).toBe(shielded[0]!.source)
    expect(rows[1]![13]).toBe('ja')
    for (const row of rows) for (const value of row) expect(value === null || typeof value === 'string').toBe(true)
  })

  test('Export als CSV: Semikolon, UTF-8 mit BOM, Formeln geschützt', async () => {
    const connections = sheet(page, 'connections')
    await connections.root.getByTestId('sheet-export').click()
    const download = page.waitForEvent('download')
    await page.getByRole('menuitem', { name: /CSV/ }).click()
    const file = await download
    expect(file.suggestedFilename()).toMatch(/^Anlage E2E_Verbindungen_\d+\.csv$/)
    const text = readFileSync(await file.path(), 'utf8')
    expect(text.startsWith('﻿Seite;Funktionsdefinition;')).toBe(true)
    const shielded = result.connections.filter(row => row.shielded)
    expect(text.split('\r\n').filter(Boolean)).toHaveLength(shielded.length + 1)
    expect(text).toContain(`'${shielded[0]!.page};`)
    await page.getByTestId('sheet-connections').getByTestId('sheet-reset').click()
  })

  test('Kabel wie im Kabelnavigator: Kabel mit eingerückten Adern, auf- und zuklappbar', async () => {
    await openTab(page, 'Kabel')
    const cables = sheet(page, 'cables')
    const lines = FIXTURE.cables + FIXTURE.cableWires
    await expect(cables.count).toHaveText(`${lines} von ${lines} Zeilen`)
    await expect(cables.rows).toHaveCount(lines)
    await expect(cables.cell(0, 0)).toHaveText(result.cables[0]!.name)
    await expect(cables.cell(0, 1)).toHaveText('Kabeldefinition')
    await expect(cables.cell(1, 1)).toHaveText('Ader / Draht')
    await expect(cables.rows.first()).toHaveAttribute('aria-expanded', 'true')

    await cables.root.getByTestId('sheet-collapse-all').click()
    await expect(cables.rows).toHaveCount(FIXTURE.cables)
    await cables.rows.first().getByTestId('sheet-toggle').click()
    await expect(cables.rows).toHaveCount(FIXTURE.cables + result.cables[0]!.wires.length)
    await cables.root.getByTestId('sheet-expand-all').click()
    await expect(cables.rows).toHaveCount(lines)

    // Filter auf eine Ader bringt ihr Kabel mit
    await cables.search.fill('X11:5')
    await expect(cables.rows).toHaveCount(2)
    await expect(cables.cell(0, 0)).toHaveText('=VB030+LCM-W21')
    await cables.search.fill('')
  })

  test('Schirme zeigen ihre Adern; ein Klick springt zur Verbindung', async () => {
    await openTab(page, 'Schirme')
    const shields = sheet(page, 'shields')
    const lines = FIXTURE.shields + FIXTURE.shieldWires
    await expect(shields.count).toHaveText(`${lines} von ${lines} Zeilen`)
    const target = result.shields[1]!.connectionIdx[1]!
    const connection = result.connections[target]!
    const link = shields.root.getByTestId('shield-wire-link').filter({ hasText: `${connection.source} → ${connection.destination}` })
    await expect(link).toHaveText(`${connection.wireNumber}: ${connection.source} → ${connection.destination}`)
    await link.click()

    await expect(page.getByTestId('result-tabs').getByRole('tab', { name: /^Verbindungen/ })).toHaveAttribute('aria-selected', 'true')
    await expect(page).toHaveURL(/tab=connections|\/projects\/\d+$/)
    const row = sheet(page, 'connections').root.locator(`[data-testid="sheet-row"][data-key="c${target}"]`)
    await expect(row).toBeInViewport()
    await expect(row.locator('[data-c="3"]')).toHaveAttribute('data-selected', '')
  })

  test('Texte', async () => {
    await openTab(page, 'Texte')
    const texts = sheet(page, 'texts')
    await expect(texts.count).toHaveText(`${FIXTURE.texts} von ${FIXTURE.texts} Zeilen`)
    await expect(texts.cell(0, 1)).toHaveText(result.texts[0]!.text)
  })

  test('erneut analysieren ergibt einen zweiten Stand; ältere Stände bleiben wählbar', async () => {
    await page.getByTestId('project-reanalyze').click()
    await expectToast(page, 'eingereiht')
    await expect(page.getByTestId('project-version')).toHaveCount(2)
    await expect(page.getByTestId('project-version').first()).toHaveAttribute('data-status', 'succeeded', { timeout: 30_000 })
    await expect(page.getByTestId('project-selected-version')).toContainText('Aktueller Stand')

    // Älteren Stand wählen: Tabellen des älteren Stands, Hinweis und Rückweg
    await page.getByTestId('project-version').nth(1).getByRole('button').first().click()
    await expect(page.getByTestId('project-selected-version')).toContainText('Älterer Stand')
    await expect(page).toHaveURL(/analysis=\d+/)
    await expect(sheet(page, 'texts').count).toHaveText(`${FIXTURE.texts} von ${FIXTURE.texts} Zeilen`)
    await page.getByRole('button', { name: 'Zum aktuellen Stand' }).click()
    await expect(page.getByTestId('project-selected-version')).toContainText('Aktueller Stand')
    // Auch über die Auswahl im Kopf der Tabellen
    await page.getByTestId('project-version-select').click()
    await expect(page.getByRole('option')).toHaveCount(2)
    await page.getByRole('option').nth(1).click()
    await expect(page.getByTestId('project-selected-version')).toContainText('Älterer Stand')
    await page.getByRole('button', { name: 'Zum aktuellen Stand' }).click()
    await expect(page.getByTestId('project-selected-version')).toContainText('Aktueller Stand')
  })

  test('Analyse: Details, übersetzte Ereignisse mit Filter und dieselben Tabs', async () => {
    await page.getByTestId('project-version').first().getByRole('link', { name: 'Details' }).click()
    await page.waitForURL(/\/analyses\/\d+$/)
    await expect(page.getByTestId('analysis-summary')).toContainText('Erfolgreich')
    await expect(page.getByTestId('count-connections')).toContainText(String(FIXTURE.connections))
    const events = page.getByTestId('analysis-events')
    await expect(events.locator('[data-code="results_saved"]')).toContainText(`Ergebnisse gespeichert: ${FIXTURE.connections} Verbindungen`)
    await expect(events.locator('[data-code="analysis_started"]')).toContainText('Von Hand')
    await page.getByTestId('event-level').click()
    await page.getByRole('option', { name: 'Warnungen und Fehler' }).click()
    // Die Fixture hat nicht zugeordnete Verdrillungssymbole (Warnung), aber keine Fehler
    await expect(events.locator('[data-code="unmatched_twist_ticks"]')).toBeVisible()
    await expect(events.locator('[data-code="results_saved"]')).toHaveCount(0)
    await expect(page.getByTestId('analysis-results').getByTestId('result-tabs')).toBeVisible()
    await expect(sheet(page, 'connections').count).toHaveText(`${FIXTURE.connections} von ${FIXTURE.connections} Zeilen`)
  })

  test('Projektliste: Suche und Quelle', async () => {
    await gotoHydrated(page, '/projects')
    await expect(page.getByTestId('project-link')).toHaveText([PROJECT])
    await page.getByTestId('projects-search').fill('gibt es nicht')
    await expect(page.getByTestId('projects-empty')).toContainText('Kein Projekt passt')
    await expect(page).toHaveURL(/search=gibt/)
    await page.getByTestId('projects-search').fill('e2e')
    await expect(page.getByTestId('project-link')).toHaveText([PROJECT])
  })
})
