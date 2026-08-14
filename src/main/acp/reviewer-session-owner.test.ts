import type { ActiveSession, ClientConnection, McpServer } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import { claudeCodeFramework } from '../agent-framework'
import { ReviewerSessionOwner } from './reviewer-session-owner'

const reviewerServer: McpServer = {
  type: 'http',
  name: 'open-science-reviewer',
  url: 'http://127.0.0.1:1234/mcp',
  headers: []
}

describe('ReviewerSessionOwner Skill Runtime setup', () => {
  it('passes the frozen runtime root through reviewer native and framework setup', async () => {
    const skillRuntime = {
      projectionRoot: '/runtime/projection',
      discoveryRoot: '/runtime/projection/skills',
      descriptors: [],
      environment: { XDG_CACHE_HOME: '/runtime/cache' }
    }
    const session = {
      sessionId: 'reviewer-session',
      dispose: vi.fn()
    } as unknown as ActiveSession
    const buildSession = vi.fn(() => ({ start: vi.fn(async () => session) }))
    const connection = {
      agent: { buildSession, request: vi.fn() }
    } as unknown as ClientConnection
    const owner = new ReviewerSessionOwner({
      addStartupBlocker: vi.fn(),
      assertCurrentConnection: vi.fn(),
      clearPermissionCorrelations: vi.fn(),
      currentSessionSetup: () => ({
        framework: claudeCodeFramework,
        sessionOptions: undefined,
        skillRuntime,
        additionalDirectories: [skillRuntime.projectionRoot]
      }),
      currentStartupGeneration: () => 1,
      isPrimarySessionIdClaimed: () => false,
      onActiveSessionReleased: vi.fn(),
      registerBridgeSession: vi.fn(),
      removeStartupBlocker: vi.fn(),
      unregisterBridgeSession: () => true
    })

    const result = await owner.create(
      { cwd: '/workspace', mcpServers: [reviewerServer] },
      { ensureConnected: async () => connection }
    )

    expect(buildSession).toHaveBeenCalledWith(
      expect.objectContaining({
        additionalDirectories: ['/runtime/projection'],
        _meta: expect.objectContaining({
          claudeCode: expect.objectContaining({
            options: expect.objectContaining({
              additionalDirectories: ['/runtime/projection']
            })
          })
        })
      })
    )
    owner.dispose(result.session)
  })
})
