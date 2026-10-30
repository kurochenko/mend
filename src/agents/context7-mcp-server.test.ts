import { describe, expect, it } from 'bun:test'
import { buildContext7McpLaunch, handleMcpMessage } from '@/agents/context7-mcp-server'

const request = (id: number, method: string, params?: unknown): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params })

const unusedLookup = async (): Promise<unknown> => {
  throw new Error('lookup should not be called')
}

describe('handleMcpMessage', () => {
  it('echoes the requested protocol version on initialize', async () => {
    const response = await handleMcpMessage(
      request(1, 'initialize', { protocolVersion: '2025-03-26' }),
      unusedLookup,
    )

    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'mend-context7', version: '1.0.0' },
      },
    })
  })

  it('lists only the context7_lookup tool with a JSON schema', async () => {
    const response = await handleMcpMessage(request(2, 'tools/list'), unusedLookup)
    const result = response?.result as { tools: Array<Record<string, unknown>> } | undefined
    const tools = result?.tools ?? []

    expect(tools.map((tool) => tool.name)).toEqual(['context7_lookup'])
    expect(JSON.parse(JSON.stringify(tools[0]?.inputSchema))).toMatchObject({
      type: 'object',
      required: ['query'],
    })
  })

  it('returns lookup results as text content', async () => {
    const calls: unknown[] = []
    const response = await handleMcpMessage(
      request(3, 'tools/call', { name: 'context7_lookup', arguments: { query: 'hooks' } }),
      async (rawParams) => {
        calls.push(rawParams)
        return { count: 1 }
      },
    )

    expect(calls).toEqual([{ query: 'hooks' }])
    expect(response?.result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ count: 1 }, null, 2) }],
    })
  })

  it('reports lookup failures and unknown tools as tool errors', async () => {
    const failed = await handleMcpMessage(
      request(4, 'tools/call', { name: 'context7_lookup', arguments: {} }),
      async () => {
        throw new Error('Context7 down')
      },
    )
    const unknown = await handleMcpMessage(
      request(5, 'tools/call', { name: 'shell', arguments: {} }),
      unusedLookup,
    )

    expect(failed?.result).toEqual({
      content: [{ type: 'text', text: 'Context7 down' }],
      isError: true,
    })
    expect(unknown?.result).toEqual({
      content: [{ type: 'text', text: 'Unknown tool: shell' }],
      isError: true,
    })
  })

  it('ignores notifications and rejects unknown methods and bad JSON', async () => {
    expect(
      await handleMcpMessage(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        unusedLookup,
      ),
    ).toBeNull()
    expect((await handleMcpMessage(request(6, 'resources/list'), unusedLookup))?.error).toEqual({
      code: -32601,
      message: 'Method not found: resources/list',
    })
    expect((await handleMcpMessage('{not json', unusedLookup))?.error?.code).toBe(-32700)
  })
})

describe('buildContext7McpLaunch', () => {
  it('runs from the Mend root without loading bunfig or .env from the reviewed repo', () => {
    const launch = buildContext7McpLaunch()

    expect(launch.command).toBe(process.execPath)
    expect(launch.args).toEqual([
      `--cwd=${launch.cwd}`,
      '--no-env-file',
      `${launch.cwd}/src/agents/context7-mcp-server.ts`,
    ])
  })
})
