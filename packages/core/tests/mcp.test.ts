import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildMcpServer, defineMcpTool, toolErrorText } from '../server/mcp'
import type { McpServerDefinition } from '../server/mcp'
import type { McpGrant } from '../shared/utils/mcp'

const definition: McpServerDefinition = {
  name: 'test-server',
  title: 'Test server',
  version: '1.0.0',
  instructions: 'Use the tools.',
  errorText: code => (code === 'custom_code' ? 'Custom text.' : undefined),
  tools: [
    defineMcpTool({
      name: 'echo',
      title: 'Echo',
      description: 'Returns the text.',
      access: 'read',
      input: { text: z.string() },
      handler: async input => ({ text: input.text }),
    }),
    defineMcpTool({
      name: 'change',
      title: 'Change',
      description: 'Changes something.',
      access: 'write',
      destructive: true,
      input: {},
      handler: async () => ({ changed: true }),
    }),
    defineMcpTool({
      name: 'preview',
      title: 'Preview',
      description: 'Computes a change without saving it.',
      access: 'write',
      readOnly: true,
      input: {},
      handler: async () => ({ preview: true }),
    }),
    defineMcpTool({
      name: 'boom',
      title: 'Boom',
      description: 'Fails with a domain error.',
      access: 'read',
      input: {},
      handler: async () => {
        throw { statusCode: 403, message: 'forbidden' }
      },
    }),
    defineMcpTool({
      name: 'crash',
      title: 'Crash',
      description: 'Fails with an internal error.',
      access: 'read',
      input: {},
      handler: async () => {
        throw new Error('db down')
      },
    }),
  ],
}

const user = { id: 'user-1', displayName: 'Test', email: null, isAdmin: false }
const clients: Client[] = []

async function connect(access: McpGrant, def = definition) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = buildMcpServer(def, { user, access })
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  clients.push(client)
  return client
}

const textOf = (result: Awaited<ReturnType<Client['callTool']>>) => (result.content as Array<{ type: string, text: string }>)[0]!.text

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(clients.splice(0).map(client => client.close()))
})

describe('MCP-Grundgerüst', () => {
  it('meldet Name, Titel und Anleitung des Servers', async () => {
    const client = await connect('read')
    expect(client.getServerVersion()).toMatchObject({ name: 'test-server', title: 'Test server', version: '1.0.0' })
    expect(client.getInstructions()).toBe('Use the tools.')
  })

  it('zeigt nur Werkzeuge der Stufe', async () => {
    const read = await (await connect('read')).listTools()
    expect(read.tools.map(tool => tool.name).sort()).toEqual(['boom', 'crash', 'echo'])
    const write = await (await connect('write')).listTools()
    expect(write.tools.map(tool => tool.name).sort()).toEqual(['boom', 'change', 'crash', 'echo', 'preview'])
  })

  it('setzt Annotations', async () => {
    const { tools } = await (await connect('write')).listTools()
    const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]))
    expect(byName.echo!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
    expect(byName.change!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false })
    // Ein Werkzeug der Stufe write kann trotzdem nur lesen (Vorschau): dann zählt das, nicht die Stufe
    expect(byName.preview!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
    expect(byName.echo!.title).toBe('Echo')
    expect(byName.echo!.description).toBe('Returns the text.')
  })

  it('beschreibt die Eingabe als JSON-Schema (zod 4)', async () => {
    const { tools } = await (await connect('read')).listTools()
    expect(tools.find(tool => tool.name === 'echo')!.inputSchema).toMatchObject({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] })
  })

  it('liefert Ergebnisse als kompaktes JSON', async () => {
    const result = await (await connect('read')).callTool({ name: 'echo', arguments: { text: 'hi' } })
    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toBe('{"text":"hi"}')
    expect(JSON.parse(textOf(result))).toEqual({ text: 'hi' })
  })

  it('liefert für leere Ergebnisse einen leeren Text statt undefined', async () => {
    const def: McpServerDefinition = {
      ...definition,
      tools: [defineMcpTool({ name: 'nothing', title: 'Nothing', description: 'Returns nothing.', access: 'read', input: {}, handler: async () => undefined })],
    }
    const result = await (await connect('read', def)).callTool({ name: 'nothing', arguments: {} })
    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toBe('null')
  })

  it('übersetzt fachliche Fehler', async () => {
    const result = await (await connect('read')).callTool({ name: 'boom', arguments: {} })
    expect(result.isError).toBe(true)
    expect(textOf(result).startsWith('forbidden: ')).toBe(true)
    expect(textOf(result)).toBe('forbidden: You don\'t have permission to do that.')
  })

  it('verrät keine internen Fehler', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await (await connect('read')).callTool({ name: 'crash', arguments: {} })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('internal_error')
    expect(error).toHaveBeenCalledWith('[mcp]', 'crash', expect.any(Error))
  })

  it('Werkzeug über der Stufe ist nicht aufrufbar', async () => {
    const client = await connect('read')
    const outcome = await client.callTool({ name: 'change', arguments: {} }).then(result => ({ result }), (error: unknown) => ({ error }))
    expect('error' in outcome || outcome.result.isError === true).toBe(true)
  })

  it('weist ungültige Eingaben ab', async () => {
    const client = await connect('read')
    const outcome = await client.callTool({ name: 'echo', arguments: { text: 42 } }).then(result => ({ result }), (error: unknown) => ({ error }))
    expect('error' in outcome || outcome.result.isError === true).toBe(true)
  })
})

describe('toolErrorText', () => {
  it('nimmt den Text der App vor dem von core', () => {
    expect(toolErrorText({ statusCode: 404, message: 'custom_code' }, 'tool', code => (code === 'custom_code' ? 'Custom text.' : undefined)))
      .toBe('custom_code: Custom text.')
  })

  it('fällt auf core-Texte und dann auf den Code zurück', () => {
    expect(toolErrorText({ statusCode: 400, message: 'invalid_input' }, 'tool')).toBe('invalid_input: The input is invalid.')
    expect(toolErrorText({ statusCode: 409, message: 'unheard_of' }, 'tool')).toBe('unheard_of')
    expect(toolErrorText({ statusCode: 409, message: 'constructor' }, 'tool')).toBe('constructor')
  })

  it('nimmt statusMessage, wenn message fehlt', () => {
    expect(toolErrorText({ statusCode: 404, statusMessage: 'not_found' }, 'tool')).toBe('not_found: Not found.')
  })

  it('hängt Details an, wenn sie ein Text sind', () => {
    expect(toolErrorText({ statusCode: 400, message: 'invalid_input', data: { details: 'name: required' } }, 'tool'))
      .toBe('invalid_input: The input is invalid. – name: required')
    expect(toolErrorText({ statusCode: 400, message: 'invalid_input', data: { details: [1] } }, 'tool')).toBe('invalid_input: The input is invalid.')
  })

  it('verrät bei Fehlern ab 500 und Unbekanntem nichts', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(toolErrorText({ statusCode: 500, message: 'secret' }, 'tool')).toBe('internal_error')
    expect(toolErrorText(new Error('db down'), 'tool')).toBe('internal_error')
    expect(toolErrorText('text', 'tool')).toBe('internal_error')
    expect(toolErrorText(null, 'tool')).toBe('internal_error')
    expect(error).toHaveBeenCalledTimes(4)
    expect(error).toHaveBeenCalledWith('[mcp]', 'tool', expect.any(Error))
  })
})
