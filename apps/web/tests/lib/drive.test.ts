import { describe, expect, it } from 'vitest'
import { createWindowsDriveConnector, serializeConnector, windowsCommandPaths } from '../../server/lib/drive'
import { AnalysisError } from '../../server/lib/errors'
import { ANALYSIS_ERROR_CODES, ANALYSIS_EVENT_CODES, CHECK_CODES } from '../../shared/types/api'
import type { ProcessSpawner, SpawnResult } from '../../server/lib/drive'
import type { NetworkDriveSettings } from '../../shared/types/api'
import { DRIVE_PASSWORD, recorder } from '../helpers/common'

interface Call { command: string, args: readonly string[], env: NodeJS.ProcessEnv }

function fakeSpawner(results: (call: Call) => SpawnResult | Error): { spawn: ProcessSpawner, calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    spawn: async (command, args, options) => {
      const call = { command, args, env: options.env }
      calls.push(call)
      const r = results(call)
      if (r instanceof Error) throw r
      return r
    },
  }
}

const ok: SpawnResult = { code: 0, stdout: '', stderr: '' }
// Absolute Pfade unter SystemRoot statt Suche über PATH/Arbeitsverzeichnis
const WIN_ENV = { SystemRoot: 'C:\\Windows' }
const NET = 'C:\\Windows\\System32\\net.exe'
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const drive = (extra: Partial<NetworkDriveSettings> = {}): NetworkDriveSettings => ({
  mapping: 'p:', networkPath: '\\\\fileserver\\share\\eplan', user: 'DOMAIN\\svc', password: DRIVE_PASSWORD, ...extra,
})
/** PowerShell-Skript aus -EncodedCommand */
const decode = (args: readonly string[]) => {
  const i = args.indexOf('-EncodedCommand')
  return i >= 0 ? Buffer.from(args[i + 1]!, 'base64').toString('utf16le') : ''
}

describe('createWindowsDriveConnector', () => {
  it('außerhalb von Windows ⇒ AnalysisError network_drive_unsupported', async () => {
    const { spawn, calls } = fakeSpawner(() => ok)
    const connector = createWindowsDriveConnector({ spawn, platform: 'linux' })
    const err = await connector.connect(drive(), () => {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AnalysisError)
    expect((err as AnalysisError).code).toBe('network_drive_unsupported')
    expect(calls).toHaveLength(0)
  })

  it('trennt, verbindet per PowerShell und übergibt das Passwort nur über die Umgebung', async () => {
    const { spawn, calls } = fakeSpawner(c => c.command === NET ? { code: 2, stdout: '', stderr: 'The network connection could not be found.' } : ok)
    const checked: string[] = []
    const rec = recorder()
    const connector = createWindowsDriveConnector({
      spawn,
      platform: 'win32',
      env: { PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows' },
      pathExists: async (p) => {
        checked.push(p)
        return true
      },
    })
    await connector.connect(drive(), rec.log)

    expect(calls.map(c => c.command)).toEqual([NET, POWERSHELL, POWERSHELL])
    expect(calls[0]!.args).toEqual(['use', 'P:', '/delete', '/y'])
    // Fallback wie .NET: WScript.Network
    expect(decode(calls[1]!.args)).toContain('RemoveNetworkDrive($env:PDS_DRIVE_LETTER')
    expect(calls[1]!.env.PDS_DRIVE_LETTER).toBe('P:')
    // Verbinden
    const connect = calls[2]!
    expect(connect.args.slice(0, 2)).toEqual(['-NoProfile', '-NonInteractive'])
    const script = decode(connect.args)
    expect(script).toContain('New-SmbMapping @p')
    expect(script).toContain('$env:PDS_DRIVE_PASSWORD')
    expect(connect.env).toMatchObject({
      PDS_DRIVE_PATH: '\\\\fileserver\\share\\eplan',
      PDS_DRIVE_LETTER: 'P:',
      PDS_DRIVE_USER: 'DOMAIN\\svc',
      PDS_DRIVE_PASSWORD: DRIVE_PASSWORD,
      SystemRoot: 'C:\\Windows',
    })
    // Passwort nie in argv (auch nicht im kodierten Skript) und nur in der Umgebung des Verbindungsaufrufs
    for (const c of calls) {
      expect(c.args.join(' ')).not.toContain(DRIVE_PASSWORD)
      expect(decode(c.args)).not.toContain(DRIVE_PASSWORD)
    }
    expect(calls[0]!.env.PDS_DRIVE_PASSWORD).toBeUndefined()
    expect(calls[1]!.env.PDS_DRIVE_PASSWORD).toBeUndefined()
    expect(process.env.PDS_DRIVE_PASSWORD).toBeUndefined()

    expect(checked).toEqual(['P:\\'])
    expect(rec.codes()).toEqual(['drive_connecting', 'drive_disconnect_fallback', 'drive_connected'])
    expect(rec.events[1]!.params).toEqual({ target: 'P:', exitCode: 2 })
  })

  it('ohne Laufwerksbuchstaben nur UNC-Verbindung; ohne Benutzer keine Anmeldedaten', async () => {
    const { spawn, calls } = fakeSpawner(c => c.command === NET ? { code: 2, stdout: '', stderr: '' } : ok)
    const checked: string[] = []
    const connector = createWindowsDriveConnector({
      spawn,
      platform: 'win32',
      env: WIN_ENV,
      pathExists: async (p) => {
        checked.push(p)
        return true
      },
    })
    await connector.connect(drive({ mapping: '', user: '', password: '' }), () => {})
    expect(calls.map(c => c.command)).toEqual([NET, POWERSHELL])
    expect(calls[0]!.args).toEqual(['use', '\\\\fileserver\\share\\eplan', '/delete', '/y'])
    expect(calls[1]!.env).toMatchObject({ PDS_DRIVE_LETTER: '', PDS_DRIVE_USER: '', PDS_DRIVE_PASSWORD: '' })
    expect(checked).toEqual(['\\\\fileserver\\share\\eplan'])
  })

  it('Verbindungsfehler ⇒ network_drive_failed mit stderr ohne Passwort', async () => {
    const { spawn } = fakeSpawner(c => c.args.includes('-EncodedCommand') && decode(c.args).includes('New-SmbMapping')
      ? { code: 1, stdout: '', stderr: `Access is denied for ${DRIVE_PASSWORD}\r\n` }
      : ok)
    const connector = createWindowsDriveConnector({ spawn, platform: 'win32', pathExists: async () => true })
    const err = await connector.connect(drive(), () => {}).catch((e: unknown) => e) as AnalysisError
    expect(err).toBeInstanceOf(AnalysisError)
    expect(err.code).toBe('network_drive_failed')
    expect(err.detail).toBe('Access is denied for ***')
  })

  it('fehlendes powershell.exe ⇒ network_drive_failed', async () => {
    const { spawn } = fakeSpawner(c => c.command === POWERSHELL ? Object.assign(new Error(`spawn ${POWERSHELL} ENOENT`), { code: 'ENOENT' }) : ok)
    const connector = createWindowsDriveConnector({ spawn, platform: 'win32', env: WIN_ENV, pathExists: async () => true })
    await expect(connector.connect(drive(), () => {})).rejects.toMatchObject({ code: 'network_drive_failed', detail: expect.stringContaining('ENOENT') })
  })

  it('Laufwerk nach dem Verbinden nicht erreichbar ⇒ drive_unavailable', async () => {
    const { spawn } = fakeSpawner(() => ok)
    const connector = createWindowsDriveConnector({ spawn, platform: 'win32', pathExists: async () => false })
    await expect(connector.connect(drive(), () => {})).rejects.toMatchObject({ code: 'drive_unavailable', detail: 'P:\\' })
  })

  it('startet net.exe und powershell.exe absolut unter SystemRoot (Schlüssel ohne Groß-/Kleinschreibung)', async () => {
    const { spawn, calls } = fakeSpawner(c => c.command.endsWith('net.exe') ? { code: 2, stdout: '', stderr: '' } : ok)
    const env = { PATH: '.;C:\\Temp', SYSTEMROOT: 'D:\\WINNT' }
    const connector = createWindowsDriveConnector({ spawn, platform: 'win32', env, pathExists: async () => true })
    await connector.connect(drive(), () => {})
    expect(calls.map(c => c.command)).toEqual([
      'D:\\WINNT\\System32\\net.exe',
      'D:\\WINNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'D:\\WINNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ])
    // Die Umgebung der Kindprozesse bleibt unverändert
    expect(calls[2]!.env).toMatchObject(env)
  })

  it('ungültiges oder fehlendes SystemRoot ⇒ C:\\Windows', async () => {
    for (const env of [{}, { SystemRoot: '..\\evil' }]) {
      const { spawn, calls } = fakeSpawner(() => ok)
      const connector = createWindowsDriveConnector({ spawn, platform: 'win32', env, pathExists: async () => true })
      await connector.connect(drive(), () => {})
      expect(calls.map(c => c.command)).toEqual([NET, POWERSHELL])
    }
  })

  it('ungültige Angaben werden vor jedem Prozessstart abgelehnt', async () => {
    const { spawn, calls } = fakeSpawner(() => ok)
    const connector = createWindowsDriveConnector({ spawn, platform: 'win32', pathExists: async () => true })
    await expect(connector.connect(drive({ networkPath: 'C:\\local' }), () => {})).rejects.toMatchObject({ code: 'network_drive_failed' })
    await expect(connector.connect(drive({ mapping: 'PQ' }), () => {})).rejects.toMatchObject({ code: 'network_drive_failed' })
    expect(calls).toHaveLength(0)
  })

  it('Abbruch wird weitergereicht', async () => {
    const ac = new AbortController()
    const spawn: ProcessSpawner = async (_c, _a, o) => {
      ac.abort()
      o.signal?.throwIfAborted()
      return ok
    }
    const connector = createWindowsDriveConnector({ spawn, platform: 'win32', pathExists: async () => true })
    await expect(connector.connect(drive(), () => {}, ac.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('alle Codes des Konnektors stehen in den Listen', () => {
    expect(ANALYSIS_EVENT_CODES).toEqual(expect.arrayContaining(['drive_connecting', 'drive_disconnect_fallback', 'drive_connected']))
    expect(ANALYSIS_ERROR_CODES).toEqual(expect.arrayContaining(['network_drive_unsupported', 'network_drive_failed', 'drive_unavailable']))
    expect(CHECK_CODES).toEqual(expect.arrayContaining(['drive_ok', 'drive_unsupported', 'drive_failed', 'drive_unavailable']))
  })
})

describe('serializeConnector', () => {
  it('verbindet nacheinander, auch wenn ein Versuch scheitert', async () => {
    const order: string[] = []
    let running = 0
    const inner = {
      async connect(drive: NetworkDriveSettings) {
        running++
        expect(running).toBe(1)
        order.push(`start ${drive.mapping}`)
        await new Promise(resolve => setTimeout(resolve, 10))
        order.push(`end ${drive.mapping}`)
        running--
        if (drive.mapping === 'A') throw new AnalysisError('network_drive_failed')
      },
    }
    const serial = serializeConnector(inner)
    const results = await Promise.allSettled(['A', 'B'].map(mapping => serial.connect(drive({ mapping }), () => {})))
    expect(results.map(r => r.status)).toEqual(['rejected', 'fulfilled'])
    expect(order).toEqual(['start A', 'end A', 'start B', 'end B'])
  })
})

describe('windowsCommandPaths', () => {
  it('baut die Pfade unter SystemRoot mit Backslashes', () => {
    expect(windowsCommandPaths({ SystemRoot: 'C:\\Windows' })).toEqual({ net: NET, powershell: POWERSHELL })
    expect(windowsCommandPaths({ SystemRoot: 'D:\\WINNT\\' }).net).toBe('D:\\WINNT\\System32\\net.exe')
    expect(windowsCommandPaths({ SystemRoot: 'E:\\OS\\Win 10 (x64)' }).net).toBe('E:\\OS\\Win 10 (x64)\\System32\\net.exe')
  })

  it('findet SystemRoot ohne Rücksicht auf Groß-/Kleinschreibung', () => {
    expect(windowsCommandPaths({ SYSTEMROOT: 'D:\\WINNT' }).net).toBe('D:\\WINNT\\System32\\net.exe')
    expect(windowsCommandPaths({ systemroot: 'd:\\win' }).powershell).toBe('d:\\win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  })

  it('fehlendes SystemRoot ⇒ C:\\Windows', () => {
    expect(windowsCommandPaths({})).toEqual({ net: NET, powershell: POWERSHELL })
    expect(windowsCommandPaths({ PATH: 'C:\\Tools' })).toEqual({ net: NET, powershell: POWERSHELL })
  })

  it.each([
    ['leer', ''],
    ['relativ', 'Windows'],
    ['relativ mit Punkt', '.\\Windows'],
    ['relativ zum Laufwerk', 'C:Windows'],
    ['nur Laufwerk', 'C:\\'],
    ['übergeordneter Ordner', 'C:\\Windows\\..\\Temp'],
    ['übergeordneter Ordner am Ende', 'C:\\Windows\\..'],
    ['aktueller Ordner', 'C:\\Windows\\.'],
    ['Punkt am Segmentende', 'C:\\Windows.'],
    ['UNC-Freigabe', '\\\\attacker\\share'],
    ['Gerätepfad', '\\\\?\\C:\\Windows'],
    ['Schrägstriche', 'C:/Windows'],
    ['Unix-Pfad', '/usr/bin'],
    ['führendes Leerzeichen', ' C:\\Windows'],
    ['Platzhalter', 'C:\\Win*'],
    ['Zeilenumbruch', 'C:\\Windows\nC:\\Temp'],
    ['Umgebungsvariable', '%TEMP%'],
  ])('%s ⇒ C:\\Windows', (_, systemRoot) => {
    expect(windowsCommandPaths({ SystemRoot: systemRoot })).toEqual({ net: NET, powershell: POWERSHELL })
  })
})
