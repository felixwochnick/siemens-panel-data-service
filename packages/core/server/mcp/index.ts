// MCP-Grundgerüst, Nuxt-frei: Apps beschreiben ihre Werkzeuge, core liefert Server, Stufen und Fehlertexte.
// Bewusst nicht unter server/utils, damit nichts auto-importiert wird; Apps importieren `@pds/core/mcp`.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { z, ZodRawShape } from 'zod'
import en from '../../i18n/locales/en.json'
import { mcpAllows } from '../../shared/utils/mcp'
import type { McpGrant } from '../../shared/utils/mcp'
import type { SessionUser } from '../../shared/types/auth'

export interface McpToolContext {
  user: SessionUser
  access: McpGrant
}

export interface McpTool<S extends ZodRawShape = ZodRawShape> {
  name: string
  title: string
  /** englisch, für das Modell */
  description: string
  /** niedrigste Stufe, die das Werkzeug sehen und aufrufen darf */
  access: McpGrant
  /** ändert nichts, obwohl es eine höhere Stufe verlangt (Vorschau); Standard: nur Werkzeuge der Stufe read */
  readOnly?: boolean
  destructive?: boolean
  idempotent?: boolean
  input: S
  handler: (input: z.infer<z.ZodObject<S>>, ctx: McpToolContext) => Promise<unknown>
}

/** Hält die Eingabetypen des Handlers aus dem Schema, ohne dass die Liste der Werkzeuge sie kennen muss */
export function defineMcpTool<S extends ZodRawShape>(tool: McpTool<S>): McpTool {
  return tool as unknown as McpTool
}

export interface McpServerDefinition {
  name: string
  title: string
  version: string
  /** englisch, für das Modell: Begriffe und Ablauf der App */
  instructions: string
  tools: McpTool[]
  /** Text zu einem Fehlercode der App (englisch); sonst gelten die Texte von core */
  errorText?: (code: string) => string | undefined
}

const coreErrors = en.errors as Record<string, string>
// Die Texte sind vue-i18n-Nachrichten: Escapes wie {'@'} gehören nicht ins Modell. hasOwn, weil ein Fehlercode
// wie "constructor" nicht in Object.prototype landen darf.
const coreText = (code: string) => Object.hasOwn(coreErrors, code) ? coreErrors[code]!.replace(/\{'([^']*)'\}/g, '$1') : undefined

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

/**
 * Fehlertext für das Modell: `code: Text` bei fachlichen Fehlern (statusCode < 500, etwa ServiceError der App oder
 * createError von h3), sonst nur `internal_error` – Datenbank- und Programmfehler gehören nicht in ein Gespräch,
 * sondern mit dem Namen des Werkzeugs ins Log.
 */
export function toolErrorText(error: unknown, tool: string, lookup?: (code: string) => string | undefined): string {
  if (typeof error === 'object' && error !== null) {
    const { statusCode, message, statusMessage, data } = error as Record<string, unknown>
    const code = text(message) ?? text(statusMessage)
    if (typeof statusCode === 'number' && statusCode < 500 && code) {
      const description = lookup?.(code) ?? coreText(code)
      const details = (data as { details?: unknown } | null | undefined)?.details
      return (description === undefined ? code : `${code}: ${description}`) + (typeof details === 'string' ? ` – ${details}` : '')
    }
  }
  console.error('[mcp]', tool, error)
  return 'internal_error'
}

/**
 * Pro Anfrage ein eigener Server: nur Werkzeuge, die die Stufe der Verbindung erlaubt, werden registriert – was nicht
 * da ist, steht nicht in `tools/list` und lässt sich nicht aufrufen. Ergebnisse gehen als kompaktes JSON in einem Textblock.
 */
export function buildMcpServer(def: McpServerDefinition, ctx: McpToolContext): McpServer {
  const server = new McpServer(
    { name: def.name, title: def.title, version: def.version },
    { instructions: def.instructions, capabilities: { tools: {} } },
  )
  for (const tool of def.tools) {
    if (!mcpAllows(ctx.access, tool.access)) continue
    const readOnly = tool.readOnly ?? tool.access === 'read'
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.input,
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: !!tool.destructive,
        idempotentHint: readOnly || !!tool.idempotent,
        openWorldHint: false,
      },
    }, async (input) => {
      try {
        const result = await tool.handler(input as Parameters<typeof tool.handler>[0], ctx)
        return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] }
      }
      catch (error) {
        return { isError: true, content: [{ type: 'text', text: toolErrorText(error, tool.name, def.errorText) }] }
      }
    })
  }
  return server
}
