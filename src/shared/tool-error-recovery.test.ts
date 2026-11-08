import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { installToolErrorRecovery } from './tool-error-recovery'

it('keeps SDK tool errors first and adds the next step', async () => {
  const server = installToolErrorRecovery(new McpServer({ name: 'recovery', version: '1' }))
  server.registerTool('save', { inputSchema: { refs: z.array(z.string()) } }, async () => ({
    content: [{ type: 'text', text: 'saved' }]
  }))
  server.registerTool('echo_error', {}, async () => ({
    content: [{ type: 'text', text: 'Traceback: Tool fetch not found' }],
    isError: true
  }))
  const client = new Client({ name: 'recovery-client', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(a), server.connect(b)])

  const invalid = await client.callTool({ name: 'save', arguments: { refs: 'pmid:1' } })
  const unknown = await client.callTool({ name: 'save_items', arguments: {} })
  const text = (result: typeof invalid): string =>
    (result.content as { text: string }[]).map((item) => item.text).join('')

  expect(text(invalid)).toMatch(
    /^MCP error -32602: Input validation error: Invalid arguments for tool save:[\s\S]*\nCorrect only the reported arguments and call the same tool again\./u
  )
  expect(text(unknown)).toMatch(
    /^MCP error -32602: Tool save_items not found\nCall only tools listed in your current tool list/u
  )
  expect(await client.callTool({ name: 'save', arguments: { refs: [] } })).toMatchObject({
    content: [{ type: 'text', text: 'saved' }]
  })
  const quoted = await client.callTool({ name: 'echo_error', arguments: {} })
  expect(text(quoted)).toBe('Traceback: Tool fetch not found')
  await client.close()
})
