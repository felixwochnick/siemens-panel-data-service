import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startFakeEplan } from '../apps/web/tests/helpers/fake-eplan'
import { resetData } from './db'
import { E2E_API_PASSWORD, E2E_API_USER, EPDZ_DIR, FAKE_EPLAN_PORT } from './targets'

/** Datenbank leeren, Ordner mit .epdz-Dateien anlegen und die Fake-EPLAN-API starten (läuft bis zum Ende) */
export default async function globalSetup() {
  await resetData()
  await rm(EPDZ_DIR, { recursive: true, force: true })
  await mkdir(EPDZ_DIR, { recursive: true })
  await writeFile(join(EPDZ_DIR, '4711000001_SW.epdz'), 'epdz 1')
  await writeFile(join(EPDZ_DIR, '4711000002_SW.epdz'), 'epdz 2')
  await writeFile(join(EPDZ_DIR, 'notiz.txt'), 'passt nicht zum Muster')
  // Konto existiert schon (wie nach einem früheren Lauf): der Verbindungstest meldet sich an, ohne zu registrieren
  const api = await startFakeEplan({ port: FAKE_EPLAN_PORT, accounts: { [E2E_API_USER]: E2E_API_PASSWORD } })
  return async () => {
    await api.close()
    await rm(EPDZ_DIR, { recursive: true, force: true })
  }
}
