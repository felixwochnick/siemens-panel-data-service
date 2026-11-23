// Bündelt das Werkzeug samt tedious und der App-Datenbankschicht zu einer Datei: dist/pds-tools.mjs.
// Das Paket legt sie als tools\pds-tools.mjs neben node.exe; dort gibt es kein node_modules.
import { build } from 'esbuild'

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/pds-tools.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // CommonJS-Abhängigkeiten (tedious, iconv-lite …) rufen require() auf, das es in ESM nicht gibt
  banner: { js: 'import { createRequire } from \'node:module\';\nconst require = createRequire(import.meta.url);' },
  // Lizenzhinweise der gebündelten Pakete (tedious, kysely, …) landen in dist/pds-tools.mjs.LEGAL.txt;
  // das Paketieren legt die Datei in den Ordner licenses\ des Pakets
  legalComments: 'linked',
  logLevel: 'info',
})
