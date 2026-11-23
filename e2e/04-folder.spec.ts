import { expect, test } from '@playwright/test'
import { expectToast, gotoHydrated, loggedIn } from './utils'

/*
 * Projekte aus dem Projektordner (eingetragen in 03-settings.spec.ts, angelegt in global-setup.ts): Paul (kein Admin)
 * wählt aus, die Analysen laufen mit dem Ersatz-Worker auf einer Kopie im Arbeitsordner.
 */
test('Projekte aus dem Ordner wählen und analysieren', async ({ browser }) => {
  const { context, page } = await loggedIn(browser, 'paul')
  try {
    await gotoHydrated(page, '/projects')
    await page.getByTestId('projects-folder').click()
    const dialog = page.getByTestId('folder-dialog')
    const items = dialog.getByTestId('folder-item')
    await expect(items).toHaveCount(2)
    await expect(items.first()).toContainText('Neu')
    await expect(dialog).toContainText('Anlage Nord')
    await expect(dialog).toContainText('Anlage Süd')
    // .elk ohne .edb-Ordner wird übersprungen und erklärt
    await dialog.getByRole('button', { name: /Übersprungen: 1/ }).click()
    await expect(dialog.getByTestId('folder-skipped')).toContainText('Ohne Datenbank.elk')
    await expect(dialog.getByTestId('folder-skipped')).toContainText('.edb-Ordner')

    await dialog.getByTestId('folder-search').fill('süd')
    await expect(items).toHaveCount(1)
    await dialog.getByTestId('folder-search').fill('')
    await dialog.getByTestId('folder-select-all').click()
    await expect(page.getByText('2 gewählt')).toBeVisible()
    await page.getByTestId('folder-start').click()
    await expectToast(page, '2 eingereiht, 0 übersprungen')

    // Beide Projekte erscheinen in der Liste und werden nacheinander analysiert
    await expect(page.getByTestId('project-link')).toHaveText(['Anlage E2E', 'Anlage Nord', 'Anlage Süd'])
    await expect(page.getByTestId('projects-table').getByTestId('analysis-status-succeeded')).toHaveCount(3, { timeout: 30_000 })

    // Quelle filtern
    await page.getByTestId('projects-source').click()
    await page.getByRole('option', { name: 'Projektordner' }).click()
    await expect(page.getByTestId('project-link')).toHaveText(['Anlage Nord', 'Anlage Süd'])

    // Projekt aus dem Ordner zeigt seinen Pfad und Ergebnisse
    await page.getByTestId('project-link').first().click()
    await expect(page.getByTestId('project-path')).toContainText('Anlage Nord.elk')
    await expect(page.getByTestId('result-tabs')).toBeVisible()

    // Nach der Analyse gelten beide als aktuell
    await gotoHydrated(page, '/projects')
    await page.getByTestId('projects-folder').click()
    await expect(page.getByTestId('folder-item').filter({ hasText: 'Aktuell' })).toHaveCount(2)
  }
  finally {
    await context.close()
  }
})
