import { expect, test } from '@playwright/test'
import { browserFetch, expectToast, gotoHydrated, loggedIn } from './utils'

// Löschen nur für Admins und nur nach Rückfrage; Nicht-Admins sehen den Knopf nicht
test('Admins löschen ein Projekt nach Bestätigung', async ({ browser }) => {
  const paul = await loggedIn(browser, 'paul')
  try {
    await gotoHydrated(paul.page, '/projects')
    await paul.page.getByTestId('project-link').filter({ hasText: 'Anlage Süd' }).click()
    await expect(paul.page.getByTestId('project-header')).toBeVisible()
    await expect(paul.page.getByTestId('project-delete')).toHaveCount(0)
  }
  finally {
    await paul.context.close()
  }

  const { context, page } = await loggedIn(browser, 'anna')
  try {
    await gotoHydrated(page, '/projects')
    await page.getByTestId('project-link').filter({ hasText: 'Anlage Süd' }).click()
    await page.waitForURL(/\/projects\/\d+$/)
    const id = new URL(page.url()).pathname.split('/').pop()
    // Erst abbrechen, dann bestätigen
    await page.getByTestId('project-delete').click()
    await expect(page.getByTestId('confirm-ok')).toBeVisible()
    await page.getByRole('button', { name: 'Abbrechen' }).click()
    await expect(page).toHaveURL(new RegExp(`/projects/${id}$`))
    await page.getByTestId('project-delete').click()
    await page.getByTestId('confirm-ok').click()
    await expectToast(page, 'Projekt gelöscht')
    await page.waitForURL(/\/projects$/)
    await expect(page.getByTestId('project-link')).toHaveText(['Anlage E2E', 'Anlage Nord'])
    expect((await browserFetch(page, `/api/projects/${id}`)).status).toBe(404)
    await gotoHydrated(page, `/projects/${id}`)
    await expect(page.getByText('Projekt nicht gefunden')).toBeVisible()
  }
  finally {
    await context.close()
  }
})
