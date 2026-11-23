import { expect, test } from '@playwright/test'
import { browserFetch, gotoHydrated, login, waitForPage } from './utils'

test.describe('Anmeldung', () => {
  test('leitet ohne Anmeldung zur Login-Seite und als Admin zurück zum Ziel', async ({ page }) => {
    await gotoHydrated(page, '/settings')
    await expect(page).toHaveURL(/\/login\?redirect=(%2F|\/)settings/)
    await expect(page.getByRole('heading', { name: 'Anmelden' })).toBeVisible()
    await page.getByTestId('login-button').click()
    await page.locator('#login').fill('anna')
    await page.locator('#password').fill('anna-pass')
    await page.locator('#submit-login').click()
    await waitForPage(page, url => url.pathname === '/settings')
    await expect(page.getByTestId('settings-form')).toContainText('EPLAN-API')
    // Navigation der Konsole
    for (const name of ['Übersicht', 'Läufe', 'Dateien', 'Protokolle', 'Einstellungen', 'KI-Assistenten'])
      await expect(page.getByRole('link', { name, exact: true })).toBeVisible()
    expect((await browserFetch(page, '/api/status')).status).toBe(200)
  })

  test('zeigt Fehler des Login-Ablaufs verständlich an', async ({ page }) => {
    await gotoHydrated(page, '/login?error=sso_denied')
    await expect(page.getByTestId('login-error')).toContainText('abgelehnt')
  })

  test('verhindert offene Weiterleitungen nach dem Login', async ({ page }) => {
    await gotoHydrated(page, '/login?redirect=https://evil.example')
    await page.getByTestId('login-button').click()
    await page.locator('#login').fill('anna')
    await page.locator('#password').fill('anna-pass')
    await page.locator('#submit-login').click()
    await waitForPage(page, url => !url.pathname.startsWith('/login') && !url.pathname.startsWith('/dex'))
    expect(new URL(page.url()).hostname).not.toBe('evil.example')
  })

  test('Nicht-Admins sehen nur „Kein Zugriff“; API und MCP-Zustimmung sind gesperrt', async ({ page }) => {
    await login(page, 'paul')
    await expect(page).toHaveURL(/\/no-access$/)
    await expect(page.getByTestId('no-access')).toContainText('Kein Zugriff')
    await expect(page.getByTestId('no-access')).toContainText('Paul Planer')

    // Auch direkte Adressen führen dorthin
    await gotoHydrated(page, '/runs')
    await expect(page).toHaveURL(/\/no-access$/)

    for (const path of ['/api/status', '/api/settings', '/api/runs', '/api/files', '/api/logs'])
      expect((await browserFetch(page, path)).status, path).toBe(403)
    expect((await browserFetch(page, '/api/runs', { method: 'POST' })).status).toBe(403)
    // Keine KI-Verbindung für Nicht-Admins (die Anfrage wird vor jeder Prüfung abgewiesen)
    expect((await browserFetch(page, '/api/oauth/authorize?client_id=x')).status).toBe(403)
    expect((await browserFetch(page, '/api/oauth/authorize', { method: 'POST', body: { query: {}, approve: false } })).status).toBe(403)

    // Abmelden aus der Seite heraus; danach ist die API zu
    await page.getByTestId('no-access-logout').click()
    await waitForPage(page, url => url.pathname === '/login')
    expect((await browserFetch(page, '/api/status')).status).toBe(401)
  })

  test('meldet ab und sperrt danach die API', async ({ page }) => {
    await login(page, 'anna')
    await page.getByTestId('user-menu').click()
    await page.getByRole('menuitem', { name: 'Abmelden' }).click()
    await waitForPage(page, url => url.pathname === '/login')
    expect((await browserFetch(page, '/api/status')).status).toBe(401)
  })
})
