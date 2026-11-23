import { expect, test } from '@playwright/test'
import { browserFetch, gotoHydrated, login, waitForPage } from './utils'

test.describe('Anmeldung und Rechte', () => {
  test('leitet ohne Anmeldung zur Login-Seite und als Admin zurück zum Ziel', async ({ page }) => {
    await gotoHydrated(page, '/settings')
    await expect(page).toHaveURL(/\/login\?redirect=(%2F|\/)settings/)
    await expect(page.getByRole('heading', { name: 'Anmelden' })).toBeVisible()
    await page.getByTestId('login-button').click()
    await page.locator('#login').fill('anna')
    await page.locator('#password').fill('anna-pass')
    await page.locator('#submit-login').click()
    await waitForPage(page, url => url.pathname === '/settings')
    await expect(page.getByTestId('settings-form')).toContainText('EPLAN')
    // Navigation für Admins
    for (const name of ['Übersicht', 'Projekte', 'Einstellungen', 'Protokolle', 'KI-Assistenten'])
      await expect(page.getByRole('link', { name, exact: true })).toBeVisible()
    const status = await browserFetch<{ admin: unknown }>(page, '/api/status')
    expect(status.status).toBe(200)
    expect(status.body.admin).not.toBeNull()
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

  test('Nicht-Admins sehen Projekte, aber keine Einstellungen; die Admin-API antwortet 403', async ({ page }) => {
    await login(page, 'paul')
    await expect(page).toHaveURL(/\/$/)
    const nav = page.getByTestId('main-nav')
    await expect(nav.getByRole('link', { name: 'Übersicht', exact: true })).toBeVisible()
    await expect(nav.getByRole('link', { name: 'Projekte', exact: true })).toBeVisible()
    await expect(nav.getByRole('link', { name: 'Einstellungen', exact: true })).toHaveCount(0)
    await expect(nav.getByRole('link', { name: 'Protokolle', exact: true })).toHaveCount(0)
    // Übersicht ohne Zeitplan und Änderungen
    await expect(page.getByTestId('card-worker')).toBeVisible()
    await expect(page.getByTestId('card-schedule')).toHaveCount(0)
    await expect(page.getByTestId('worker-restart')).toHaveCount(0)

    // Direkte Adressen zeigen „Kein Zugriff“ mit Navigation
    for (const path of ['/settings', '/logs']) {
      await gotoHydrated(page, path)
      await expect(page.getByTestId('error-forbidden')).toContainText('Kein Zugriff')
      await expect(page.getByTestId('main-nav')).toBeVisible()
    }

    const status = await browserFetch<{ admin: unknown }>(page, '/api/status')
    expect(status.status).toBe(200)
    expect(status.body.admin).toBeNull()
    expect((await browserFetch(page, '/api/projects')).status).toBe(200)
    for (const path of ['/api/settings', '/api/logs', '/api/settings/cron-preview?cron=0+0+2+*+*+%3F&timezone=UTC'])
      expect((await browserFetch(page, path)).status, path).toBe(403)
    expect((await browserFetch(page, '/api/scheduler', { method: 'PUT', body: { enabled: true } })).status).toBe(403)
    expect((await browserFetch(page, '/api/worker/restart', { method: 'POST' })).status).toBe(403)
    expect((await browserFetch(page, '/api/projects/1', { method: 'DELETE' })).status).toBe(403)
  })

  test('meldet ab und sperrt danach die API', async ({ page }) => {
    await login(page, 'anna')
    await page.getByTestId('user-menu').click()
    await page.getByRole('menuitem', { name: 'Abmelden' }).click()
    await waitForPage(page, url => url.pathname === '/login')
    expect((await browserFetch(page, '/api/status')).status).toBe(401)
  })
})
