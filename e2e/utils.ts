import { expect } from '@playwright/test'
import type { Browser, BrowserContextOptions, Page } from '@playwright/test'
import { APP_URL } from './targets'

export const PASSWORD = (user: string) => `${user}-pass`

const hydrated = (page: Page) => page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' })

export async function gotoHydrated(page: Page, path: string) {
  await page.goto(APP_URL + path)
  await hydrated(page)
}

/** Nach Weiterleitungen warten, bis die Zielseite geladen und hydriert ist */
export async function waitForPage(page: Page, matches: (url: URL) => boolean) {
  await page.waitForURL(matches)
  await page.waitForLoadState()
  await hydrated(page)
}

/** Anmeldung über den Test-IdP (Dex mit Test-LDAP) */
export async function login(page: Page, user: string) {
  await gotoHydrated(page, '/login')
  await page.getByTestId('login-button').click()
  await page.locator('#login').fill(user)
  await page.locator('#password').fill(PASSWORD(user))
  await page.locator('#submit-login').click()
  await waitForPage(page, url => url.origin === new URL(APP_URL).origin && url.pathname !== '/login')
}

/** Neuer Browser-Kontext mit angemeldetem Benutzer */
export async function loggedIn(browser: Browser, user: string, options: BrowserContextOptions = {}) {
  const context = await browser.newContext({ locale: 'de-DE', ...options })
  const page = await context.newPage()
  await login(page, user)
  return { context, page }
}

/** API-Aufruf aus der Seite heraus (Cookies wie im Browser) */
export function browserFetch<T = unknown>(page: Page, path: string, init: { method?: string, body?: unknown } = {}) {
  return page.evaluate(async ({ url, method, body }) => {
    const res = await fetch(url, {
      method,
      credentials: 'include',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json: unknown = null
    try {
      json = JSON.parse(text)
    }
    catch {
      json = text
    }
    return { status: res.status, body: json as T }
  }, { url: APP_URL + path, method: init.method ?? 'GET', body: init.body })
}

export async function expectToast(page: Page, text: string | RegExp) {
  await expect(page.locator('[data-slot="title"]', { hasText: text }).first()).toBeVisible()
}

/** Auswahl in einem Nuxt-UI-SelectMenu/Select treffen */
export async function pick(page: Page, trigger: ReturnType<Page['locator']>, option: string | RegExp) {
  await trigger.click()
  await page.getByRole('option', { name: option }).first().click()
}

/** Keine horizontale Seiten-Scrollbar (Inhalte dürfen nur in eigenen Containern scrollen) */
export async function expectNoPageOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(1)
}

// ── Tabellenansicht (DataSheet) ──────────────────────────────────────────────

/** Tabelle eines Ergebnis-Tabs (connections, cables, shields, texts) */
export function sheet(page: Page, id: string) {
  const root = page.getByTestId(`sheet-${id}`)
  return {
    root,
    grid: root.getByTestId('sheet-grid'),
    count: root.getByTestId('sheet-count'),
    rows: root.getByTestId('sheet-row'),
    search: root.getByTestId('sheet-search'),
    filter: (key: string) => root.getByTestId(`sheet-filter-${key}`),
    sortBy: (key: string) => root.getByTestId(`sheet-sort-${key}`).click(),
    /** Zelle (Zeile 0-basiert in der Anzeige, Spalte 0-basiert) */
    cell: (row: number, col: number) => root.locator(`[data-r="${row}"][data-c="${col}"]`),
    /** Text der Spalte in allen gerenderten Zeilen */
    columnTexts: (col: number) => root.locator(`[data-testid="sheet-row"] [data-c="${col}"]`).allInnerTexts(),
  }
}

/** Ergebnis-Tab wählen (Name ohne Zähler) */
export async function openTab(page: Page, name: string) {
  await page.getByTestId('result-tabs').getByRole('tab', { name: new RegExp(`^${name}`) }).click()
}
