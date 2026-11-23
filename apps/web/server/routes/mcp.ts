import { createPdsMcpServer } from '../mcp'

// MCP-Endpunkt für KI-Assistenten (OAuth-Token, nur POST); Prüfung, Stufen und Transport liegen in core
export default defineEventHandler(async event => handleMcpRequest(event, createPdsMcpServer(await useAppContext())))
