// Einstieg der App unter Windows, liegt beim Paketieren neben .output (app\pds-entry.mjs).
// Aufruf durch den Dienst: node.exe --use-system-ca app\pds-entry.mjs

// Windows kennt kein SIGTERM: Der Dienst schließt stdin, um die App geordnet zu beenden.
// process.emit statt process.kill: process.kill(process.pid, 'SIGTERM') beendet den Prozess unter
// Windows sofort (TerminateProcess), ohne Handler. Nitro hört über process.once('SIGTERM') auf das
// Ereignis, das emit direkt auslöst – so läuft sein geordneter Shutdown (NITRO_SHUTDOWN_TIMEOUT).
process.stdin.on('end', () => process.emit('SIGTERM'))
process.stdin.resume()

// Hochgeladene Projekte (bis 2 GiB) brauchen über langsame Leitungen länger als Nodes Standard von 300 s für die ganze
// Anfrage (sonst 408 mitten im Upload). Davor sitzt Caddy; die App prüft die Größe selbst beim Streamen.
const { Server } = await import('node:http')
const listen = Server.prototype.listen
Server.prototype.listen = function (...args) {
  this.requestTimeout = 2 * 60 * 60 * 1000
  return listen.apply(this, args)
}

await import('./server/index.mjs')
