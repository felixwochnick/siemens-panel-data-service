import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resetData } from './db'
import { PROJECTS_DIR } from './targets'

/**
 * Datenbank leeren und einen Projektordner mit Ersatz-Projekten anlegen: ein .elk mit .edb-Ordner (in einem
 * Unterordner), ein .zw1 und ein .elk ohne .edb (wird übersprungen). Der Ersatz-Worker liest die Dateien nicht, er
 * prüft nur, dass es sie gibt.
 */
export default async function globalSetup() {
  await resetData()
  await rm(PROJECTS_DIR, { recursive: true, force: true })
  await mkdir(join(PROJECTS_DIR, 'Linie 1', 'Anlage Nord.edb'), { recursive: true })
  await writeFile(join(PROJECTS_DIR, 'Linie 1', 'Anlage Nord.elk'), 'elk')
  await writeFile(join(PROJECTS_DIR, 'Linie 1', 'Anlage Nord.edb', 'project.db'), 'edb')
  await writeFile(join(PROJECTS_DIR, 'Anlage Süd.zw1'), 'zw1')
  await writeFile(join(PROJECTS_DIR, 'Ohne Datenbank.elk'), 'elk ohne edb')
  await writeFile(join(PROJECTS_DIR, 'notiz.txt'), 'passt nicht zum Muster')
  return async () => {
    await rm(PROJECTS_DIR, { recursive: true, force: true })
  }
}
