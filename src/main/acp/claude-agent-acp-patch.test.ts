import type { McpServerStatus, Query } from '@anthropic-ai/claude-agent-sdk'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  ClaudeAcpAgent,
  waitForMcpServers
} from '@agentclientprotocol/claude-agent-acp/dist/acp-agent.js'

type McpStatusQuery = Pick<Query, 'mcpServerStatus' | 'close'>

const queryWithStatus = (mcpServerStatus: McpStatusQuery['mcpServerStatus']): McpStatusQuery => ({
  mcpServerStatus,
  close: vi.fn()
})

const status = (
  name: string,
  state: McpServerStatus['status'],
  error?: string
): McpServerStatus => ({ name, status: state, ...(error ? { error } : {}) })

describe('claude-agent-acp MCP readiness patch', () => {
  it('waits until every configured MCP server is connected', async () => {
    const mcpServerStatus = vi
      .fn<McpStatusQuery['mcpServerStatus']>()
      .mockResolvedValueOnce([
        status('open-science-activity', 'connected'),
        status('open-science-notebook', 'pending')
      ])
      .mockResolvedValueOnce([
        status('open-science-activity', 'connected'),
        status('open-science-notebook', 'connected')
      ])

    const query = queryWithStatus(mcpServerStatus)

    await waitForMcpServers(query, ['open-science-activity', 'open-science-notebook'], 500)

    expect(mcpServerStatus).toHaveBeenCalledTimes(2)
    expect(query.close).not.toHaveBeenCalled()
  })

  it('ignores MCP servers that were not configured by the ACP client', async () => {
    const mcpServerStatus = vi
      .fn<McpStatusQuery['mcpServerStatus']>()
      .mockResolvedValue([
        status('open-science-notebook', 'connected'),
        status('user-project-server', 'failed', 'not installed')
      ])

    const query = queryWithStatus(mcpServerStatus)

    await expect(waitForMcpServers(query, ['open-science-notebook'], 100)).resolves.toBeUndefined()
    expect(query.close).not.toHaveBeenCalled()
  })

  it.each([
    ['failed', 'process exited'],
    ['needs-auth', 'login required']
  ] as const)('logs a configured MCP server %s state', async (state, detail) => {
    const mcpServerStatus = vi
      .fn<McpStatusQuery['mcpServerStatus']>()
      .mockResolvedValue([status('open-science-notebook', state, detail)])

    const query = queryWithStatus(mcpServerStatus)
    const logger = { error: vi.fn() }

    await expect(waitForMcpServers(query, ['open-science-notebook'], 100, logger)).rejects.toThrow(
      `MCP server open-science-notebook is ${state}: ${detail}`
    )
    expect(logger.error).toHaveBeenCalledWith(
      `[mcp-readiness] MCP server open-science-notebook is ${state}: ${detail}`
    )
    expect(query.close).toHaveBeenCalledOnce()
  })

  it('times out when MCP status does not respond', async () => {
    const mcpServerStatus = vi
      .fn<McpStatusQuery['mcpServerStatus']>()
      .mockReturnValue(new Promise<McpServerStatus[]>(() => undefined))

    const query = queryWithStatus(mcpServerStatus)
    const logger = { error: vi.fn() }

    await expect(waitForMcpServers(query, ['open-science-notebook'], 5, logger)).rejects.toThrow(
      'Timed out waiting for MCP servers: open-science-notebook'
    )
    expect(logger.error).toHaveBeenCalledWith(
      '[mcp-readiness] Timed out waiting for MCP servers: open-science-notebook'
    )
    expect(query.close).toHaveBeenCalledOnce()
  })
})

describe('claude-agent-acp Session deletion patch', () => {
  it('treats a never-materialized Session as already deleted', async () => {
    const sessionId = '11111111-1111-4111-8111-111111111111'
    const configDir = mkdtempSync(join(tmpdir(), 'open-science-claude-session-delete-'))
    vi.stubEnv('CLAUDE_CONFIG_DIR', configDir)

    try {
      const agent = new ClaudeAcpAgent({} as never)
      await expect(agent.deleteSession({ sessionId })).resolves.toEqual({})
    } finally {
      vi.unstubAllEnvs()
      rmSync(configDir, { recursive: true, force: true })
    }
  })
})
