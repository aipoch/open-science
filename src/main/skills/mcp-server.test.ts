import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'

import {
  REQUEST_SKILL_IMPORT_TOOL_NAME,
  SKILL_IMPORT_MCP_SERVER_NAME,
  createSkillImportMcpServer
} from './mcp-server'

describe('Skill import MCP server', () => {
  it('exposes one high-level request tool without exposing filesystem writes', async () => {
    const turnToken = '00000000-0000-4000-8000-000000000001'
    const requestImport = vi.fn().mockResolvedValue({
      status: 'imported',
      skills: [{ id: 'imported-demo', name: 'Demo', status: 'imported' }]
    })
    const server = createSkillImportMcpServer({ requestImport })
    const client = new Client({ name: 'skill-import-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const tools = await client.listTools()
    expect(tools.tools).toEqual([
      expect.objectContaining({
        name: REQUEST_SKILL_IMPORT_TOOL_NAME,
        inputSchema: expect.objectContaining({
          properties: expect.objectContaining({
            attachment_uri: expect.any(Object),
            turn_token: expect.any(Object)
          }),
          required: ['attachment_uri', 'turn_token']
        })
      })
    ])

    const result = await client.callTool({
      name: REQUEST_SKILL_IMPORT_TOOL_NAME,
      arguments: {
        attachment_uri: 'file:///managed/session/demo.skill',
        turn_token: turnToken
      }
    })

    expect(requestImport).toHaveBeenCalledWith('file:///managed/session/demo.skill', turnToken)
    expect(result).toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining('imported-demo') }]
    })
    expect(SKILL_IMPORT_MCP_SERVER_NAME).toBe('open-science-skills')

    await client.close()
    await server.close()
  })
})
