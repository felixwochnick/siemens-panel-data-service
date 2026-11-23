import { expect, test } from '@playwright/test'
import type { BrowserContext, Page } from '@playwright/test'
import { PROJECTS_DIR } from './targets'
import { browserFetch, expectToast, gotoHydrated, loggedIn } from './utils'

/*
 * Einstellungen (Admin): Prüfung mit Hinweis am Feld, Cron-Vorschau, Speichern, Verbindungstest (Projektordner,
 * Worker, Netzlaufwerk unter Linux nicht unterstützt), Zeitplan auf der Übersicht, Protokolle. Der hier eingetragene
 * Projektordner ist die Grundlage für 04-folder.spec.ts.
 */
test.describe.serial('Einstellungen und Betrieb (Admin)', () => {
  let context: BrowserContext
  let page: Page

  test.beforeAll(async ({ browser }) => {
    ;({ context, page } = await loggedIn(browser, 'anna'))
  })

  test.afterAll(async () => {
    await context.close()
  })

  test('ungültiger Cron-Ausdruck wird am Feld gemeldet; die Vorschau zeigt die nächsten Läufe', async () => {
    await gotoHydrated(page, '/settings')
    await expect(page.getByTestId('settings-form')).toContainText('Noch nie gespeichert')
    const cron = page.getByTestId('field-cronSchedule')
    await cron.fill('jeden Tag')
    await expect(page.getByTestId('cron-preview')).toContainText('Kein gültiger Cron-Ausdruck')
    await page.getByTestId('settings-save').click()
    await expectToast(page, 'Einige Einstellungen sind ungültig')
    await expect(page.getByText('Kein gültiger Cron-Ausdruck').first()).toBeVisible()

    await page.getByRole('button', { name: 'werktags 06:00' }).click()
    await expect(cron).toHaveValue('0 0 6 ? * MON-FRI')
    await expect(page.getByTestId('cron-preview').locator('li')).toHaveCount(5)
  })

  test('Projektordner und Aufbewahrung speichern; Werte bleiben nach dem Neuladen', async () => {
    await page.getByTestId('field-folder').fill(PROJECTS_DIR)
    const retention = page.getByTestId('field-retentionDays')
    await retention.fill('90')
    await retention.blur()
    await expect(page.getByTestId('settings-dirty')).toBeVisible()
    await page.getByTestId('settings-save').click()
    await expectToast(page, 'Einstellungen gespeichert')
    await expect(page.getByTestId('settings-dirty')).toHaveCount(0)

    await gotoHydrated(page, '/settings')
    await expect(page.getByTestId('field-folder')).toHaveValue(PROJECTS_DIR)
    await expect(page.getByTestId('field-retentionDays')).toHaveValue('90')
    await expect(page.getByTestId('field-cronSchedule')).toHaveValue('0 0 6 ? * MON-FRI')
    await expect(page.getByTestId('settings-form')).toContainText('Anna Admin')
    const saved = await browserFetch<{ settings: { retentionDays: number, folder: string } }>(page, '/api/settings')
    expect(saved.body.settings).toMatchObject({ retentionDays: 90, folder: PROJECTS_DIR })
  })

  test('Verbindung testen: Projektordner und Worker; Netzlaufwerk nur unter Windows', async () => {
    await page.getByTestId('settings-test').click()
    const dialog = page.getByTestId('connection-test')
    await expect(dialog.getByTestId('check-folder')).toHaveAttribute('data-ok', 'true')
    await expect(dialog.getByTestId('check-folder')).toContainText('2 Projekte gefunden')
    await expect(dialog.getByTestId('check-worker')).toHaveAttribute('data-ok', 'true')
    await expect(dialog.getByTestId('check-worker')).toContainText('EPLAN-Worker erreichbar')
    await expect(dialog.getByTestId('check-drive')).toHaveCount(0)
    await page.getByRole('button', { name: 'Schließen' }).last().click()

    // Netzlaufwerk mit Passwort (ungespeichert): der Test meldet, dass Linux keine Laufwerke verbindet
    await page.getByTestId('field-source').getByText('Netzlaufwerk').click()
    await page.getByTestId('field-networkPath').fill('\\\\server\\projekte')
    await page.getByTestId('field-drive-password-change').click()
    await page.getByTestId('field-drive-password-input').fill('Geheim-123')
    await page.getByTestId('settings-test').click()
    await expect(dialog.getByTestId('check-drive')).toHaveAttribute('data-ok', 'false')
    await expect(dialog.getByTestId('check-drive')).toContainText('nur unter Windows')
    await expect(dialog).not.toContainText('Geheim-123')
    await page.getByRole('button', { name: 'Schließen' }).last().click()
    await page.getByRole('button', { name: 'Verwerfen' }).click()
    await expect(page.getByTestId('settings-dirty')).toHaveCount(0)
  })

  test('Übersicht: Zeitplan ein- und ausschalten zeigt die nächsten Läufe; Änderungen stehen im Protokoll', async () => {
    await gotoHydrated(page, '/')
    const card = page.getByTestId('card-schedule')
    await expect(card).toContainText('0 0 6 ? * MON-FRI')
    await card.getByTestId('scheduler-switch').click()
    await expectToast(page, 'Zeitplan eingeschaltet')
    await expect(card.getByTestId('next-runs').locator('li')).toHaveCount(5)
    await card.getByTestId('scheduler-switch').click()
    await expectToast(page, 'Zeitplan ausgeschaltet')
    await expect(card.getByTestId('next-runs')).toHaveCount(0)
    await expect(page.getByTestId('audit-list')).toContainText('Zeitplan ausgeschaltet')
    await expect(page.getByTestId('audit-list')).toContainText('Einstellungen geändert')
    await expect(page.getByTestId('worker-state')).toHaveAttribute('data-state', 'connected')
  })

  test('Protokolle: Datei, Filter und Herunterladen', async () => {
    await gotoHydrated(page, '/logs')
    await expect(page.getByTestId('log-lines')).toContainText('Analyse #1 erfolgreich')
    await page.getByTestId('log-file').click()
    await page.getByRole('option', { name: 'service.log' }).click()
    await expect(page.getByTestId('log-lines')).toContainText('Dienst gestartet')
    await page.getByTestId('log-filter').fill('warn')
    await expect(page.getByTestId('log-lines')).toHaveText('2026-11-23T08:00:02Z WARN E2E-Warnung')
    const download = page.waitForEvent('download')
    await page.getByTestId('log-download').click()
    expect((await download).suggestedFilename()).toBe('service.log')
  })
})
