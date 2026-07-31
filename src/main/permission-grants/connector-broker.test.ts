import { describe, expect, it, vi } from 'vitest'

import type { PermissionGrantRecord } from '../../shared/permission-grants'
import type { PermissionGrantRegistry } from './registry'
import { ConnectorPermissionBroker, type ConnectorPermissionRequest } from './connector-broker'

const capability = {
  kind: 'mcp_tool' as const,
  key: 'mcp:pubmed/search_articles',
  qualifier: { mode: 'any' as const }
}

const createRequest = (
  overrides?: Partial<ConnectorPermissionRequest>
): ConnectorPermissionRequest => ({
  capability,
  context: { projectId: 'project-1', sessionId: 'session-1' },
  connector: 'pubmed',
  method: 'search_articles',
  args: { query: 'tumor immunology' },
  policy: {
    aliases: ['pubmed'],
    askToolIds: ['pubmed/search_articles']
  },
  ...overrides
})

const createRegistry = (
  resolved?: PermissionGrantRecord
): {
  registry: PermissionGrantRegistry
  resolve: ReturnType<typeof vi.fn<PermissionGrantRegistry['resolve']>>
  remember: ReturnType<typeof vi.fn<PermissionGrantRegistry['remember']>>
} => {
  const resolve = vi
    .fn<PermissionGrantRegistry['resolve']>()
    .mockResolvedValue(
      resolved ? { grant: resolved, matchedScope: resolved.scope.kind } : undefined
    )
  const remember = vi
    .fn<PermissionGrantRegistry['remember']>()
    .mockImplementation(async ({ capability: rememberedCapability, scope }) => ({
      id: 'grant-1',
      capability: rememberedCapability,
      scope,
      revision: 1
    }))
  return {
    registry: { resolve, remember } as unknown as PermissionGrantRegistry,
    resolve,
    remember
  }
}

describe('ConnectorPermissionBroker', () => {
  it('enforces Block before consulting remembered grants or prompting', () => {
    const { registry, resolve } = createRegistry()
    const prompt = vi.fn()
    const broker = new ConnectorPermissionBroker(registry, prompt)
    const request = createRequest({
      policy: {
        aliases: ['pubmed'],
        autoAllowIds: ['pubmed'],
        blockedToolIds: ['pubmed/search_articles']
      }
    })

    expect(() => broker.preflight(request)).toThrow('tool blocked by policy')
    expect(resolve).not.toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()
  })

  it('allows policy-approved calls without consulting grants or prompting', async () => {
    const { registry, resolve } = createRegistry()
    const prompt = vi.fn()
    const broker = new ConnectorPermissionBroker(registry, prompt)
    const request = createRequest({
      policy: { aliases: ['pubmed'], autoAllowIds: ['pubmed'] }
    })

    await expect(broker.authorize(request)).resolves.toBeUndefined()
    expect(resolve).not.toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()
  })

  it('uses a remembered grant before opening Require approval', async () => {
    const remembered: PermissionGrantRecord = {
      id: 'grant-1',
      capability,
      scope: { kind: 'project', projectId: 'project-1' },
      revision: 1
    }
    const { registry, resolve } = createRegistry(remembered)
    const prompt = vi.fn()
    const broker = new ConnectorPermissionBroker(registry, prompt)

    await expect(broker.authorize(createRequest())).resolves.toBeUndefined()
    expect(resolve).toHaveBeenCalledWith(capability, {
      projectId: 'project-1',
      sessionId: 'session-1'
    })
    expect(prompt).not.toHaveBeenCalled()
  })

  it('offers only scopes backed by the current context and durable registry', async () => {
    const { registry, remember } = createRegistry()
    const prompt = vi.fn().mockResolvedValue('project')
    const broker = new ConnectorPermissionBroker(registry, prompt)

    await expect(
      broker.authorize(createRequest({ context: { projectId: 'project-1' } }))
    ).resolves.toBeUndefined()

    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({ availableScopes: ['once', 'project', 'global'] })
    )
    expect(remember).toHaveBeenCalledWith({
      capability,
      scope: { kind: 'project', projectId: 'project-1' }
    })
  })

  it('returns a confirmed scope without persisting when the caller defers the write', async () => {
    const { registry, remember } = createRegistry()
    const prompt = vi.fn().mockResolvedValue('session')
    const broker = new ConnectorPermissionBroker(registry, prompt)

    await expect(
      broker.authorize(createRequest(), 'require_approval', { deferRemember: true })
    ).resolves.toEqual({
      kind: 'session',
      projectId: 'project-1',
      sessionId: 'session-1'
    })
    expect(remember).not.toHaveBeenCalled()
  })

  it('fails closed when approval is denied or durable grant storage fails', async () => {
    const denied = new ConnectorPermissionBroker(
      createRegistry().registry,
      vi.fn().mockResolvedValue('deny')
    )
    await expect(denied.authorize(createRequest())).rejects.toThrow('tool call denied by user')

    const { registry, remember } = createRegistry()
    remember.mockRejectedValue(new Error('database unavailable'))
    const storageFailure = new ConnectorPermissionBroker(
      registry,
      vi.fn().mockResolvedValue('global')
    )
    await expect(storageFailure.authorize(createRequest())).rejects.toThrow('database unavailable')
  })
})
