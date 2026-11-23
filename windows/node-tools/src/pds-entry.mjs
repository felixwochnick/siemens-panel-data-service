// Einstieg der App unter Windows, liegt beim Paketieren neben .output (app\pds-entry.mjs).
// Aufruf durch den Dienst: node.exe --use-system-ca app\pds-entry.mjs

// Windows kennt kein SIGTERM: Der Dienst schließt stdin, um die App geordnet zu beenden.
// process.emit statt process.kill: process.kill(process.pid, 'SIGTERM') beendet den Prozess unter
// Windows sofort (TerminateProcess), ohne Handler. Nitro hört über process.once('SIGTERM') auf das
// Ereignis, das emit direkt auslöst – so läuft sein geordneter Shutdown (NITRO_SHUTDOWN_TIMEOUT).
process.stdin.on('end', () => process.emit('SIGTERM'))
process.stdin.resume()
await import('./server/index.mjs')
