import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// Jeder Bereich bei 1280×800 und 900×700, hell und dunkel, mit Beispieldaten (mock.ts).
// Prüft Überschrift, keine waagerechte Scrollleiste, keine Konsolenfehler und keine Anfragen nach außen.
// Bilder: test-results/screens/<bereich>-<breite>-<schema>.png (Fenster) und …-full.png (ganzer Inhalt).
// Ohne Zusatz zeigt die Vorschau eine Installation auf SQL Server, mit `?fresh=1` eine neue mit SQLite.

const SCREENS = 'test-results/screens'

const DEFAULT_DB_PATH = 'C:\\ProgramData\\EPLAN Panel Data Service\\data\\pds.db'

const sections = [
  { id: 'status', heading: 'Status', name: 'status', query: '' },
  { id: 'status', heading: 'Status', name: 'status-sqlite', query: '?fresh=1' },
  { id: 'address', heading: 'Adresse und TLS', name: 'address', query: '' },
  { id: 'database', heading: 'Datenbank', name: 'database', query: '' },
  { id: 'database', heading: 'Datenbank', name: 'database-sqlite', query: '?fresh=1' },
  { id: 'login', heading: 'Anmeldung', name: 'login', query: '' },
  { id: 'assistants', heading: 'KI-Assistenten', name: 'assistants', query: '' },
] as const

const viewports = [
  { width: 1280, height: 800 },
  { width: 900, height: 700 },
] as const

const schemes = ['light', 'dark'] as const

interface Watch {
  problems: string[]
}

/** Sammelt Konsolenfehler, Vue-Warnungen, Seitenfehler und Anfragen an fremde Hosts */
function watch(page: Page): Watch {
  const state: Watch = { problems: [] }
  page.on('console', (message) => {
    if (message.type() === 'error' || message.text().includes('[Vue warn]')) {
      state.problems.push(`console.${message.type()}: ${message.text()}`)
    }
  })
  page.on('pageerror', error => state.problems.push(`pageerror: ${error.message}`))
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && url.hostname !== 'localhost') {
      state.problems.push(`request: ${request.url()}`)
    }
  })
  return state
}

async function open(page: Page, hash: string, heading: string, query = '') {
  await page.goto(`/${query}#${hash}`)
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement
    const main = document.querySelector('main')!
    const aside = document.querySelector('aside')!
    return {
      page: root.scrollWidth - root.clientWidth,
      main: main.scrollWidth - main.clientWidth,
      aside: aside.scrollWidth - aside.clientWidth,
    }
  })
  expect(overflow).toEqual({ page: 0, main: 0, aside: 0 })
}

/** Fenster wie gesehen und zusätzlich der ganze Inhalt (Rasterhöhe aufgehoben, Seite scrollt) */
async function shoot(page: Page, name: string) {
  await page.screenshot({ path: `${SCREENS}/${name}.png`, animations: 'disabled' })
  await page.addStyleTag({ content: '#app > div { height: auto !important; min-height: 100dvh } main { overflow: visible !important }' })
  await page.screenshot({ path: `${SCREENS}/${name}-full.png`, fullPage: true, animations: 'disabled' })
}

for (const scheme of schemes) {
  test.describe(`Schema ${scheme}`, () => {
    test.use({ colorScheme: scheme })

    for (const viewport of viewports) {
      for (const section of sections) {
        test(`${section.name} ${viewport.width}`, async ({ page }) => {
          const problems = watch(page)
          await page.setViewportSize(viewport)
          await open(page, section.id, section.heading, section.query)

          await expect(page.locator('html')).toHaveClass(scheme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/)
          await expect(page.getByTestId('save-bar')).toBeVisible()
          await expectNoHorizontalScroll(page)
          await shoot(page, `${section.name}-${viewport.width}-${scheme}`)
          expect(problems.problems).toEqual([])
        })
      }
    }

    test('veralteter Status', async ({ page }) => {
      const problems = watch(page)
      await page.setViewportSize(viewports[0])
      await open(page, 'status', 'Status', '?stale=1')
      await expect(page.getByTestId('stale-banner')).toContainText(/Dienst läuft nicht \(letztes Lebenszeichen vor \d+ s\)/)
      await expectNoHorizontalScroll(page)
      await shoot(page, `stale-1280-${scheme}`)
      expect(problems.problems).toEqual([])
    })

    test('unlesbare Konfiguration', async ({ page }) => {
      const problems = watch(page)
      await page.setViewportSize(viewports[0])
      await open(page, 'status', 'Status', '?broken=1')
      await expect(page.getByTestId('status-headline')).toContainText('nicht eingerichtet')
      // Ohne lesbare Konfiguration keine Zeile zur Datenbank
      await expect(page.getByTestId('status-database')).toHaveCount(0)
      // Status und Prüfung melden beide `config_unreadable`; angezeigt wird er einmal
      await expect(page.locator('main [data-code="config_unreadable"]')).toHaveCount(1)
      // Zähler in der Seitenleiste mit Text für Screenreader
      await expect(page.getByRole('button', { name: 'Status 1 Fehler' })).toBeVisible()
      await expectNoHorizontalScroll(page)
      await shoot(page, `broken-1280-${scheme}`)
      expect(problems.problems).toEqual([])
    })

    test('Fehler am Feld sperrt Speichern', async ({ page }) => {
      const problems = watch(page)
      await page.setViewportSize(viewports[1])
      await open(page, 'database', 'Datenbank')
      await page.getByLabel('Server', { exact: true }).fill('sql01\\INST')
      const field = page.locator('[data-field="db.server"]')
      await expect(field.locator('[data-code="named_instance_not_supported"]')).toBeVisible()
      await expect(page.getByTestId('save-summary')).toContainText('1 ungespeicherte Änderung · 1 Fehler')
      await expect(page.getByTestId('save')).toBeDisabled()
      // Secret entfernen: Platzhalter wechselt, Änderung zählt mit
      await page.locator('[data-field="db.password"]').getByRole('button', { name: 'Entfernen' }).click()
      await expect(page.locator('[data-field="db.password"] [data-secret-state="removed"]')).toBeVisible()
      await expect(page.getByTestId('save-summary')).toContainText('2 ungespeicherte Änderungen')
      await expectNoHorizontalScroll(page)
      await shoot(page, `field-error-900-${scheme}`)
      // Verwerfen stellt alles wieder her
      await page.getByTestId('discard').click()
      await expect(page.getByTestId('save-summary')).toContainText('Keine ungespeicherten Änderungen · 0 Fehler')
      await expect(page.locator('[data-field="db.password"] [data-secret-state="set"]')).toBeVisible()
      // Ein Passwort, das mit *** beginnt, lässt sich tippen und bleibt Klartext
      const password = page.locator('[data-field="db.password"] input')
      await password.pressSequentially('***abc')
      await expect(password).toHaveValue('***abc')
      await expect(page.locator('[data-field="db.password"] [data-secret-state="new"]')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Adresse und TLS 1 Warnung' })).toBeVisible()
      expect(problems.problems).toEqual([])
    })

    test('Werkzeugergebnis und Einrichtungsdialog', async ({ page }) => {
      const problems = watch(page)
      await page.setViewportSize(viewports[0])
      await open(page, 'database', 'Datenbank')
      await page.getByRole('button', { name: 'Verbindung testen' }).click()
      const result = page.getByTestId('tool-result')
      await expect(result).toContainText('READ_COMMITTED_SNAPSHOT ist ausgeschaltet')
      await result.scrollIntoViewIfNeeded()
      await expectNoHorizontalScroll(page)
      await page.screenshot({ path: `${SCREENS}/db-test-1280-${scheme}.png`, animations: 'disabled' })

      await page.getByRole('button', { name: 'Einrichten …' }).click()
      await expect(page.getByRole('dialog', { name: 'Datenbank einrichten' })).toBeVisible()
      // Ohne neu eingegebenes Passwort kein Hinweis
      await expect(page.getByTestId('setup-unsaved-password')).toHaveCount(0)
      await page.screenshot({ path: `${SCREENS}/db-setup-dialog-1280-${scheme}.png`, animations: 'disabled' })
      expect(problems.problems).toEqual([])
    })

    test('Einrichtungsdialog mit ungespeichertem Passwort', async ({ page }) => {
      const problems = watch(page)
      await page.setViewportSize(viewports[1])
      await open(page, 'database', 'Datenbank')
      await page.locator('[data-field="db.password"] input').fill('Neu-Pässwort 1')
      await page.getByRole('button', { name: 'Einrichten …' }).click()
      const dialog = page.getByRole('dialog', { name: 'Datenbank einrichten' })
      await expect(dialog.getByTestId('setup-unsaved-password')).toContainText('noch nicht gespeichert')
      await expect(dialog.getByTestId('setup-unsaved-password')).toContainText('sofort am SQL-Login')
      await expectNoHorizontalScroll(page)
      await page.screenshot({ path: `${SCREENS}/db-setup-unsaved-password-${viewports[1].width}-${scheme}.png`, animations: 'disabled' })
      expect(problems.problems).toEqual([])
    })

    test('Einrichtung erzeugt das Datenbankpasswort', async ({ page }) => {
      const problems = watch(page)
      await page.setViewportSize(viewports[0])
      // Neue Installation (SQLite), die auf SQL Server wechselt
      await open(page, 'database', 'Datenbank', '?fresh=1')
      await page.getByRole('radio', { name: 'SQL Server', exact: true }).click()
      await page.getByLabel('Server', { exact: true }).fill('sql01.example.com')
      await expect(page.locator('[data-field="db.password"] [data-code="required"]')).toBeVisible()
      await page.getByRole('button', { name: 'Einrichten …' }).click()
      const dialog = page.getByRole('dialog', { name: 'Datenbank einrichten' })
      await dialog.getByLabel('Admin-Passwort').fill('Admin-Pässwort 1')
      await dialog.getByRole('button', { name: 'Einrichten', exact: true }).click()
      await expect(dialog).toBeHidden()
      await expect(page.getByTestId('password-generated')).toContainText('Ein neues wurde erzeugt und verschlüsselt gespeichert')
      // Als gesetzt übernommen: kein Befund, keine Änderung, die es beim Speichern wieder entfernte
      await expect(page.locator('[data-field="db.password"] [data-secret-state="set"]')).toBeVisible()
      await expect(page.locator('[data-field="db.password"] [data-code="required"]')).toHaveCount(0)
      // Übrig bleiben nur Art und Server
      await expect(page.getByTestId('save-summary')).toContainText('2 ungespeicherte Änderungen · 0 Fehler')
      await page.getByTestId('tool-result').scrollIntoViewIfNeeded()
      await expectNoHorizontalScroll(page)
      await page.screenshot({ path: `${SCREENS}/db-password-generated-1280-${scheme}.png`, animations: 'disabled' })
      expect(problems.problems).toEqual([])
    })

    test('SQLite: Datei, Prüfung und Sicherung', async ({ page }) => {
      const problems = watch(page)
      await page.setViewportSize(viewports[1])
      await open(page, 'database', 'Datenbank', '?fresh=1')
      await expect(page.getByRole('radio', { name: 'SQLite (Datei)', exact: true })).toBeChecked()
      // Nur die Datei, keine SQL-Server-Felder und -Werkzeuge, kein Hinweis auf einen Wechsel
      const path = page.getByLabel('Datenbankdatei')
      await expect(path).toHaveValue('')
      await expect(path).toHaveAttribute('placeholder', DEFAULT_DB_PATH)
      await expect(page.locator('[data-field="db.server"]')).toHaveCount(0)
      await expect(page.locator('[data-field="db.password"]')).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Einrichten …' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'SQL-Skript exportieren …' })).toHaveCount(0)
      await expect(page.getByTestId('db-kind-change')).toHaveCount(0)
      await expect(page.getByTestId('db-legacy-hint')).toContainText('wiring_files')

      await page.getByRole('button', { name: 'Verbindung testen' }).click()
      const result = page.getByTestId('tool-result')
      // Der Test legt nichts an: Die Standarddatei einer neuen Installation legt der Dienst an
      await expect(result).toContainText(`${DEFAULT_DB_PATH} gibt es noch nicht`)
      await expect(result).toContainText('Angelegt wurde nichts')
      await expect(result).toContainText('Noch keine Migrationen')
      await expect(result).toHaveAttribute('data-ok', 'true')

      // Sicherung: Dateiname mit dem lokalen Datum, Größe aus `details.bytes`
      await page.getByRole('button', { name: 'Sicherung speichern …' }).click()
      await expect(page.getByTestId('backup-saved')).toContainText(/Gespeichert unter C:\\Users\\admin\\Documents\\pds-sicherung-\d{8}\.db \(18,0\sMB\)/)
      await expect(result).toContainText('Die Datenbank wurde gesichert.')
      await result.scrollIntoViewIfNeeded()
      await expectNoHorizontalScroll(page)
      await shoot(page, `db-sqlite-backup-900-${scheme}`)

      // Befunde am Pfad: Netzlaufwerk und relativer Pfad sind Fehler, ein fehlendes Laufwerk nur eine Warnung
      const field = page.locator('[data-field="db.path"]')
      await path.fill('\\\\fileserver\\pds\\pds.db')
      await expect(field.locator('[data-code="sqlite_network_path"]')).toBeVisible()
      await expect(page.getByTestId('save-summary')).toContainText('1 ungespeicherte Änderung · 1 Fehler')
      await expect(page.getByTestId('save')).toBeDisabled()
      await expect(page.getByRole('button', { name: 'Datenbank 1 Fehler' })).toBeVisible()
      await expectNoHorizontalScroll(page)
      await shoot(page, `db-sqlite-path-error-900-${scheme}`)
      await path.fill('pds.db')
      await expect(field.locator('[data-code="sqlite_path_not_absolute"]')).toBeVisible()
      await path.fill('X:\\PDS\\pds.db')
      await expect(field.locator('[data-code="sqlite_drive_missing"]')).toBeVisible()
      await expect(field.locator('[data-severity="error"]')).toHaveCount(0)
      await expect(page.getByTestId('save')).toBeEnabled()

      // Eigene Datei: im Beispiel eine Kopie der Datenbank der .NET-Version
      await path.fill('D:\\PDS\\pds.db')
      await expect(field.locator('[data-code]')).toHaveCount(0)
      await page.getByRole('button', { name: 'Verbindung testen' }).click()
      await expect(result).toContainText('Tabelle wiring_files der .NET-Version gefunden')
      expect(problems.problems).toEqual([])
    })

    test('Wechsel der Datenbankart', async ({ page }) => {
      const problems = watch(page)
      await page.setViewportSize(viewports[0])
      await open(page, 'database', 'Datenbank')
      await expect(page.getByRole('radio', { name: 'SQL Server', exact: true })).toBeChecked()
      await expect(page.getByTestId('db-kind-change')).toHaveCount(0)
      await page.getByRole('button', { name: 'Verbindung testen' }).click()
      await expect(page.getByTestId('tool-result')).toContainText('READ_COMMITTED_SNAPSHOT')

      // Auf SQLite: Warnung vor der leeren Datenbank, alte Ergebnisse weg, nur noch Datei und SQLite-Werkzeuge
      await page.getByRole('radio', { name: 'SQLite (Datei)', exact: true }).click()
      const warning = page.getByTestId('db-kind-change')
      await expect(warning).toContainText('leeren Datenbank')
      await expect(warning).toContainText('bisherigen Datenbank (SQL Server)')
      await expect(page.getByTestId('tool-result')).toHaveCount(0)
      await expect(page.locator('[data-field="db.server"]')).toHaveCount(0)
      await expect(page.getByLabel('Datenbankdatei')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Sicherung speichern …' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Einrichten …' })).toHaveCount(0)
      // Die SQL-Server-Angaben bleiben stehen: keine Befunde mehr, nur die Art ist geändert
      await expect(page.getByTestId('save-summary')).toContainText('1 ungespeicherte Änderung · 0 Fehler')
      await expect(page.locator('[data-field="db.kind"]')).toHaveAttribute('data-dirty', 'true')
      await expectNoHorizontalScroll(page)
      await shoot(page, `db-kind-change-1280-${scheme}`)

      // Zurück: Felder wieder da, Warnung weg
      await page.getByRole('radio', { name: 'SQL Server', exact: true }).click()
      await expect(warning).toHaveCount(0)
      await expect(page.getByLabel('Server', { exact: true })).toHaveValue('sql01.example.com')
      await expect(page.getByTestId('save-summary')).toContainText('Keine ungespeicherten Änderungen')

      // Speichern mit SQLite und eigener Datei: Der Status zeigt die neue Datenbank
      await page.getByRole('radio', { name: 'SQLite (Datei)', exact: true }).click()
      await page.getByLabel('Datenbankdatei').fill('D:\\PDS\\pds.db')
      await expect(page.getByTestId('save')).toBeEnabled()
      await page.getByTestId('save').click()
      await expect(page.getByTestId('save-outcome')).toContainText('Gespeichert – der Dienst läuft')
      await expect(warning).toHaveCount(0)
      await page.getByRole('button', { name: 'Status', exact: true }).click()
      await expect(page.getByTestId('status-database')).toHaveText('SQLite: D:\\PDS\\pds.db')
      expect(problems.problems).toEqual([])
    })

    test('Status nennt die Datenbank', async ({ page }) => {
      const problems = watch(page)
      await page.setViewportSize(viewports[1])
      await open(page, 'status', 'Status')
      await expect(page.getByTestId('status-database')).toHaveText('SQL Server: sql01.example.com:1433, Datenbank pds')
      await open(page, 'status', 'Status', '?fresh=1')
      await expect(page.getByTestId('status-database')).toHaveText(`SQLite: ${DEFAULT_DB_PATH}`)
      expect(problems.problems).toEqual([])
    })

    test('Speichern mit Warnung', async ({ page }) => {
      const problems = watch(page)
      await page.setViewportSize(viewports[1])
      await open(page, 'assistants', 'KI-Assistenten', '?gpo=1')
      await page.getByRole('switch', { name: 'KI-Assistenten (MCP) zulassen' }).click()
      await page.getByTestId('save').click()
      await expect(page.getByTestId('save-outcome')).toContainText('Gespeichert – der Dienst läuft')
      await expect(page.getByTestId('save-warnings')).toContainText('Ports 80, 443 von Hand freigeben')
      await expectNoHorizontalScroll(page)
      await page.screenshot({ path: `${SCREENS}/save-warning-900-${scheme}.png`, animations: 'disabled' })
      expect(problems.problems).toEqual([])
    })

    test('Zertifikat aus dem Speicher', async ({ page }) => {
      const problems = watch(page)
      await page.setViewportSize(viewports[1])
      await open(page, 'address', 'Adresse und TLS')
      await page.getByRole('button', { name: 'Aus Zertifikatspeicher …' }).click()
      const dialog = page.getByRole('dialog', { name: 'Zertifikat aus dem Speicher wählen' })
      await expect(dialog.getByText('Example Root CA')).toBeVisible()
      await page.screenshot({ path: `${SCREENS}/cert-store-dialog-900-${scheme}.png`, animations: 'disabled' })
      await dialog.getByRole('button', { name: 'Importieren' }).click()
      await expect(dialog).toBeHidden()
      // Neues Zertifikat (365 Tage) ⇒ die Ablaufwarnung verschwindet
      await expect(page.locator('[data-code="certificate_expires_soon"]')).toHaveCount(0)
      expect(problems.problems).toEqual([])
    })

    test('Neuer Hostname mit neuem Zertifikat', async ({ page }) => {
      const problems = watch(page)
      await page.setViewportSize(viewports[1])
      await open(page, 'address', 'Adresse und TLS')
      await page.getByLabel('Hostname').fill('konsole.example.org')
      const mismatch = page.locator('[data-field="public.host"] [data-code="certificate_hostname_mismatch"]')
      await expect(mismatch).toBeVisible()
      // Der Import prüft gegen den Hostnamen des Entwurfs, nicht den gespeicherten
      await page.getByRole('button', { name: 'Aus Zertifikatspeicher …' }).click()
      const dialog = page.getByRole('dialog', { name: 'Zertifikat aus dem Speicher wählen' })
      await dialog.getByRole('button', { name: 'Importieren' }).click()
      await expect(dialog).toBeHidden()
      await expect(mismatch).toHaveCount(0)
      await expect(page.getByTestId('save')).toBeEnabled()
      expect(problems.problems).toEqual([])
    })

    test('Logdatei öffnen', async ({ page }) => {
      const problems = watch(page)
      await page.setViewportSize(viewports[0])
      await open(page, 'status', 'Status')
      await page.getByRole('button', { name: 'Logdatei öffnen …' }).click()
      await expect(page.getByText('Im Editor geöffnet: C:\\ProgramData\\EPLAN Panel Data Service\\logs\\service.log')).toBeVisible()
      await page.screenshot({ path: `${SCREENS}/log-opened-1280-${scheme}.png`, animations: 'disabled' })
      expect(problems.problems).toEqual([])
    })

    test('Web-Konsole öffnen', async ({ page }) => {
      const problems = watch(page)
      await page.setViewportSize(viewports[1])
      await open(page, 'status', 'Status')
      // Die gespeicherte Adresse, nicht die eines Entwurfs
      await expect(page.getByTestId('status-address')).toHaveText('https://pds.example.com')
      await page.getByRole('button', { name: 'Web-Konsole öffnen' }).click()
      await expect(page.getByText('Im Browser geöffnet: https://pds.example.com', { exact: true })).toBeVisible()
      await expectNoHorizontalScroll(page)
      await page.screenshot({ path: `${SCREENS}/web-console-900-${scheme}.png`, animations: 'disabled' })
      expect(problems.problems).toEqual([])
    })

    test('Speichern zeigt das Ergebnis', async ({ page }) => {
      const problems = watch(page)
      await page.setViewportSize(viewports[0])
      await open(page, 'assistants', 'KI-Assistenten')
      await page.getByRole('switch', { name: 'KI-Assistenten (MCP) zulassen' }).click()
      await expect(page.getByTestId('save-summary')).toContainText('1 ungespeicherte Änderung')
      await expect(page.getByTestId('save')).toBeEnabled()
      await page.getByTestId('save').click()
      await expect(page.getByTestId('save-outcome')).toContainText('Gespeichert – der Dienst läuft')
      await expect(page.getByTestId('save-summary')).toContainText('Keine ungespeicherten Änderungen')
      await expectNoHorizontalScroll(page)
      await page.screenshot({ path: `${SCREENS}/save-outcome-1280-${scheme}.png`, animations: 'disabled' })
      expect(problems.problems).toEqual([])
    })

    test('TLS-Modi und Portprüfung', async ({ page }) => {
      const problems = watch(page)
      await page.setViewportSize(viewports[1])
      await open(page, 'address', 'Adresse und TLS')
      await page.getByRole('radio', { name: 'ACME' }).click()
      await expect(page.locator('[data-field="tls.acme_email"] [data-code="required"]')).toBeVisible()
      await expectNoHorizontalScroll(page)
      await shoot(page, `tls-acme-900-${scheme}`)

      await page.reload()
      await expect(page.getByRole('heading', { level: 1, name: 'Adresse und TLS' })).toBeVisible()
      await page.getByRole('radio', { name: 'Aus' }).click()
      await expect(page.getByText('setzt die App das Sitzungs-Cookie ohne Secure-Flag')).toBeVisible()
      await page.getByRole('button', { name: 'Ports prüfen' }).click()
      await expect(page.getByTestId('ports')).toContainText('http.sys')
      await expectNoHorizontalScroll(page)
      await shoot(page, `tls-off-900-${scheme}`)
      expect(problems.problems).toEqual([])
    })

    test('Erweiterte Anmeldung', async ({ page }) => {
      const problems = watch(page)
      await page.setViewportSize(viewports[1])
      await open(page, 'login', 'Anmeldung')
      await page.getByTestId('advanced-toggle').click()
      await page.getByLabel('Eigener Issuer').fill('http://idp.example.com')
      await expect(page.locator('[data-field="oidc.issuer"] [data-code="invalid_url"]')).toBeVisible()
      // Mit eigenem Issuer ist die Tenant-ID gesperrt
      await expect(page.getByLabel('Tenant-ID')).toBeDisabled()
      await page.getByRole('button', { name: 'Prüfen', exact: true }).click()
      await expect(page.getByTestId('tool-result')).toBeVisible()
      await expectNoHorizontalScroll(page)
      await shoot(page, `login-advanced-900-${scheme}`)
      expect(problems.problems).toEqual([])
    })
  })
}
