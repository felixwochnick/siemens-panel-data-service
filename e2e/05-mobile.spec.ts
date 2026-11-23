import { devices, expect, test } from '@playwright/test'
import { FIXTURE } from './targets'
import { expectNoPageOverflow, gotoHydrated, loggedIn, sheet } from './utils'

const iPhone = { ...devices['iPhone 13'], defaultBrowserType: undefined }

// Mobil: einklappbares Menü, keine Seiten-Scrollbar quer, Tabellen scrollen in sich
test('mobil: Menü, Übersicht, Projekte und Tabelle ohne Seitenüberlauf', async ({ browser }) => {
  const { context, page } = await loggedIn(browser, 'anna', iPhone)
  try {
    await gotoHydrated(page, '/')
    await expect(page.getByTestId('card-worker')).toBeVisible()
    await expectNoPageOverflow(page)
    // Navigation hinter dem Menüknopf
    await expect(page.getByTestId('main-nav')).toBeHidden()
    await page.getByRole('button', { name: 'Seitenleiste öffnen' }).first().click()
    await page.getByTestId('main-nav').getByRole('link', { name: 'Projekte', exact: true }).click()
    await page.waitForURL(/\/projects$/)
    await expect(page.getByTestId('project-link').first()).toBeVisible()
    await expectNoPageOverflow(page)

    await page.getByTestId('project-link').filter({ hasText: 'Anlage E2E' }).click()
    await page.waitForURL(/\/projects\/\d+$/)
    const connections = sheet(page, 'connections')
    await expect(connections.count).toHaveText(`${FIXTURE.connections} von ${FIXTURE.connections} Zeilen`)
    await expectNoPageOverflow(page)
    // Das Gitter ist breiter als der Bildschirm und scrollt quer in sich
    const scrollable = await connections.grid.evaluate(element => element.scrollWidth > element.clientWidth)
    expect(scrollable).toBe(true)

    for (const path of ['/settings', '/logs']) {
      await gotoHydrated(page, path)
      await expectNoPageOverflow(page)
    }
  }
  finally {
    await context.close()
  }
})
