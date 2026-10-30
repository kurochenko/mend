import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import {
  CONTEXT7_LOOKUP_DESCRIPTION,
  CONTEXT7_LOOKUP_TOOL_NAME,
  context7LookupParameters,
  runContext7Lookup,
} from '@/agents/context7-lookup-tool'
import { toErrorMessage } from '@/lib/errors'
import { asRecord } from '@/lib/json'

export const CONTEXT7_MCP_SERVER_NAME = 'context7'

export const CONTEXT7_API_KEY_ENV = 'CONTEXT7_API_KEY'

const DEFAULT_PROTOCOL_VERSION = '2025-06-18'

const MEND_ROOT = resolve(import.meta.dir, '../..')

type JsonRpcId = string | number

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: JsonRpcId | null
  result?: unknown
  error?: { code: number; message: string }
}

type Context7Lookup = (rawParams: unknown) => Promise<unknown>

export interface Context7McpLaunch {
  command: string
  args: string[]
  cwd: string
}

export const buildContext7McpLaunch = (): Context7McpLaunch => ({
  command: process.execPath,
  args: [`--cwd=${MEND_ROOT}`, '--no-env-file', import.meta.path],
  cwd: MEND_ROOT,
})

const toolTextResult = (text: string, isError: boolean) => ({
  content: [{ type: 'text', text }],
  ...(isError ? { isError: true } : {}),
})

const callTool = async (params: Record<string, unknown>, lookup: Context7Lookup) => {
  if (params.name !== CONTEXT7_LOOKUP_TOOL_NAME) {
    return toolTextResult(`Unknown tool: ${String(params.name)}`, true)
  }

  try {
    const result = await lookup(params.arguments ?? {})
    return toolTextResult(JSON.stringify(result, null, 2), false)
  } catch (error) {
    return toolTextResult(toErrorMessage(error), true)
  }
}

const resolveResult = async (
  method: string,
  params: Record<string, unknown>,
  lookup: Context7Lookup,
): Promise<unknown> => {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion:
          typeof params.protocolVersion === 'string'
            ? params.protocolVersion
            : DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'mend-context7', version: '1.0.0' },
      }
    case 'ping':
      return {}
    case 'tools/list':
      return {
        tools: [
          {
            name: CONTEXT7_LOOKUP_TOOL_NAME,
            description: CONTEXT7_LOOKUP_DESCRIPTION,
            inputSchema: context7LookupParameters,
          },
        ],
      }
    case 'tools/call':
      return await callTool(params, lookup)
    default:
      return undefined
  }
}

export const handleMcpMessage = async (
  line: string,
  lookup: Context7Lookup,
): Promise<JsonRpcResponse | null> => {
  let message: Record<string, unknown>
  try {
    message = asRecord(JSON.parse(line))
  } catch {
    return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }
  }

  const { id, method } = message
  if ((typeof id !== 'string' && typeof id !== 'number') || typeof method !== 'string') {
    return null
  }

  const result = await resolveResult(method, asRecord(message.params), lookup)
  return result === undefined
    ? { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }
    : { jsonrpc: '2.0', id, result }
}

const serve = (): void => {
  const apiKey = process.env[CONTEXT7_API_KEY_ENV]
  const lookup: Context7Lookup = (rawParams) => runContext7Lookup(rawParams, apiKey)

  const respond = async (line: string): Promise<void> => {
    const response = await handleMcpMessage(line, lookup)
    if (response) {
      process.stdout.write(`${JSON.stringify(response)}\n`)
    }
  }

  createInterface({ input: process.stdin }).on('line', (line) => {
    if (line.trim()) {
      void respond(line)
    }
  })
}

if (import.meta.main) {
  serve()
}
