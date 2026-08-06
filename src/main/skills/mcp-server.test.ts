import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'

import {
  REQUEST_SKILL_IMPORT_TOOL_NAME,
  SKILL_IMPORT_MCP_SERVER_NAME,
  SKILL_IMPORT_SYSTEM_PROMPT_APPEND,
  createSkillImportMcpServer
} from './mcp-server'

describe('Skill import MCP server', () => {
  it('exposes one high-level request tool without exposing filesystem writes', async () => {
    const turnToken = '00000000-0000-4000-8000-000000000001'
    const requestImport = vi.fn().mockResolvedValue({
      status: 'imported',
      skills: [{ id: 'imported-demo', name: 'Demo', status: 'imported' }]
    })
    const requestGitHubImport = vi.fn().mockResolvedValue({
      status: 'imported',
      skills: [{ id: 'imported-slide-master', name: 'Slide Master', status: 'imported' }]
    })
    const server = createSkillImportMcpServer({ requestImport, requestGitHubImport })
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
            turn_token: expect.any(Object),
            github_url: expect.any(Object)
          })
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

    const githubUrl = 'https://github.com/acme/skills/tree/main/slide-master'
    const githubResult = await client.callTool({
      name: REQUEST_SKILL_IMPORT_TOOL_NAME,
      arguments: { github_url: githubUrl }
    })
    expect(requestGitHubImport).toHaveBeenCalledWith(githubUrl)
    expect(githubResult).toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining('imported-slide-master') }]
    })
    const invalidGitHubResult = await client.callTool({
      name: REQUEST_SKILL_IMPORT_TOOL_NAME,
      arguments: { github_url: 'https://example.invalid/github.com/acme/skills' }
    })
    expect(invalidGitHubResult).toMatchObject({ isError: true })
    expect(requestGitHubImport).toHaveBeenCalledOnce()
    expect(SKILL_IMPORT_SYSTEM_PROMPT_APPEND).toContain(
      'When the user supplies only a Skill name or keywords'
    )
    expect(SKILL_IMPORT_SYSTEM_PROMPT_APPEND).toContain('first use available web search')
    expect(SKILL_IMPORT_SYSTEM_PROMPT_APPEND).toContain(
      'Do not download GitHub content into a temporary attachment'
    )
    expect(SKILL_IMPORT_SYSTEM_PROMPT_APPEND).toContain('install-skill-from-github.py')
    expect(SKILL_IMPORT_SYSTEM_PROMPT_APPEND).toContain('do not write to codex/skills')
    expect(SKILL_IMPORT_MCP_SERVER_NAME).toBe('open-science-skills')

    await client.close()
    await server.close()
  })
})
