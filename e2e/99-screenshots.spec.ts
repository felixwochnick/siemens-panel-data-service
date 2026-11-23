import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { devices, expect, test } from '@playwright/test'
import type { Browser, BrowserContextOptions, Page } from '@playwright/test'
import { gotoHydrated, loggedIn, openTab, sheet } from './utils'

/*
 * Screenshots für docs/screenshots (nur mit E2E_SCREENSHOTS=1, nach den übrigen Specs: sie brauchen deren Projekte).
 * Desktop 1440×900 und iPhone, hell und dunkel (Farbschema „System“ folgt prefers-color-scheme).
 */
const OUT = join(import.meta.dirname, '..', 'docs', 'screenshots')
const iPhone = { ...devices['iPhone 13'], defaultBrowserType: undefined }

test.skip(!process.env.E2E_SCREENSHOTS, 'nur mit E2E_SCREENSHOTS=1')

async function session(browser: Browser, options: BrowserContextOptions) {
  const result = await loggedIn(browser, 'anna', { timezoneId: 'Europe/Berlin', ...options })
  // Entwicklerwerkzeuge des Dev-Servers gehören nicht ins Bild
  await result.context.addInitScript(() => {
    addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style')
      style.textContent = '#nuxt-devtools-container, [id^="nuxt-devtools"] { display: none !important }'
      document.head.append(style)
    })
  })
  return result
}

async function shot(page: Page, name: string) {
  // Toasts und Animationen abklingen lassen
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(OUT, `${name}.png`) })
}

async function openProject(page: Page) {
  await gotoHydrated(page, '/projects')
  await page.getByTestId('project-link').filter({ hasText: 'Anlage E2E' }).click()
  await page.waitForURL(/\/projects\/\d+$/)
  await expect(sheet(page, 'connections').count).toContainText('20')
}

test('Screenshots Desktop', async ({ browser }) => {
  mkdirSync(OUT, { recursive: true })
  for (const scheme of ['light', 'dark'] as const) {
    const { context, page } = await session(browser, { viewport: { width: 1440, height: 900 }, colorScheme: scheme })
    try {
      await gotoHydrated(page, '/')
      await shot(page, `overview-${scheme}`)
      if (scheme === 'light') {
        await gotoHydrated(page, '/projects')
        await shot(page, 'projects-light')
      }
      await openProject(page)
      // Die Tabelle nach oben holen und einen Bereich markieren
      await page.getByTestId('project-results').evaluate(element => element.scrollIntoView({ block: 'start' }))
      const connections = sheet(page, 'connections')
      await connections.cell(1, 3).click()
      await connections.cell(3, 4).click({ modifiers: ['Shift'] })
      await shot(page, `project-connections-${scheme}`)
      if (scheme === 'light') {
        await openTab(page, 'Kabel')
        await page.getByTestId('project-results').evaluate(element => element.scrollIntoView({ block: 'start' }))
        await shot(page, 'project-cables-light')
      }
      if (scheme === 'light') {
        await gotoHydrated(page, '/settings')
        await shot(page, 'settings-light')
      }
    }
    finally {
      await context.close()
    }
  }
})

test('Screenshots mobil', async ({ browser }) => {
  for (const scheme of ['light', 'dark'] as const) {
    const { context, page } = await session(browser, { ...iPhone, colorScheme: scheme })
    try {
      if (scheme === 'light') {
        await gotoHydrated(page, '/')
        await shot(page, 'mobile-overview-light')
      }
      await openProject(page)
      await page.getByTestId('project-results').evaluate(element => element.scrollIntoView({ block: 'start' }))
      await shot(page, `mobile-project-${scheme}`)
    }
    finally {
      await context.close()
    }
  }
})
