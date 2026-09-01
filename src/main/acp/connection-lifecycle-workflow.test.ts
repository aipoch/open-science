import { describe, expect, it, vi } from 'vitest'

import {
  RequestError,
  type ClientConnection,
  type SetProviderRequest
} from '@agentclientprotocol/sdk'
import type { AcpConnectRequest, AcpStateSnapshot } from '../../shared/acp'
import type { AcpConnectionResourceOwner } from './connection-resource-owner'
import { AcpConnectionLifecycleWorkflow } from './connection-lifecycle-workflow'

const connection = {} as ClientConnection

describe('AcpConnectionLifecycleWorkflow', () => {
  it('initializes, authenticates, configures the advertised provider, then publishes connected', async () => {
    const actions: string[] = []
    const ready = {
      epoch: 1,
      connection,
      framework: 'claude-code' as const,
      capabilities: { close: true, delete: false, resume: true, steering: false },
      assertCurrent: vi.fn()
    }
    const attempt = {
      epoch: 1,
      assertCurrent: vi.fn(),
      attach: vi.fn(),
      publish: vi.fn(() => ready),
      owns: vi.fn(() => true)
    }
    const candidate = {
      transferTo: vi.fn(() => ({
        backendAttempt: {
          consumeInitializeMaterial: () => ({
            authentication: { methodId: 'api-key' },
            providerConfiguration: {
              providerId: 'openai',
              apiType: 'openai',
              baseUrl: 'http://127.0.0.1:1234/v1',
              headers: {}
            }
          }),
          fail: vi.fn()
        },
        initialize: vi.fn(async () => {
          actions.push('initialize')
          return {
            protocolVersion: 1,
            agentCapabilities: { sessionCapabilities: { close: true, resume: true } }
          }
        }),
        authenticate: async () => {
          actions.push('authenticate')
        },
        listProviders: async () => {
          actions.push('provider-list')
          // Real Codex ACP 1.1.4 wire response captured from the reported failing setup.
          return {
            providers: [
              {
                providerId: 'custom-gateway',
                supported: ['openai' as const],
                required: false,
                current: null
              }
            ]
          }
        },
        setProvider: vi.fn(async (request: SetProviderRequest) => {
          actions.push('provider-set')
          if (request.providerId !== 'custom-gateway') {
            throw RequestError.invalidParams(
              { providerId: request.providerId },
              `Unknown providerId "${request.providerId}"; only "custom-gateway" is configurable`
            )
          }
        })
      })),
      dispose: vi.fn(async () => undefined)
    }
    const snapshot = { status: 'connected' } as AcpStateSnapshot
    const workflow = new AcpConnectionLifecycleWorkflow({
      appVersion: 'test',
      defaultCwd: '/workspace',
      currentConnection: () => undefined,
      currentStatus: () => 'closed',
      currentGeneration: () => 1,
      currentFramework: () => 'claude-code',
      reconnectBarrier: () => undefined,
      getSnapshot: () => snapshot,
      invalidatePendingSessionStartups: vi.fn(),
      disconnectCurrent: vi.fn(async () => snapshot),
      updateCwd: vi.fn(),
      updateError: vi.fn(),
      setStatus: (status) => actions.push(status),
      pushEvent: (event) => actions.push(event.title ?? ''),
      transitionStatus: vi.fn(),
      emitState: vi.fn(),
      diagnosticContext: () => ({ framework: 'claude-code', generation: 1, status: 'closed' }),
      openCandidate: vi.fn(async () => candidate) as never,
      connectResources: {
        connect: async (operation: Parameters<AcpConnectionResourceOwner['connect']>[0]) =>
          operation(attempt)
      } as never
    })

    await expect(workflow.connect({ cwd: '/workspace' } satisfies AcpConnectRequest)).resolves.toBe(
      snapshot
    )

    expect(actions).toEqual([
      'connecting',
      'initialize',
      'authenticate',
      'provider-set',
      'provider-list',
      'provider-set',
      'Agent initialized',
      'connected'
    ])
    expect(candidate.transferTo).toHaveBeenCalledOnce()
    expect(candidate.transferTo.mock.results[0]?.value.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        clientCapabilities: expect.objectContaining({ elicitation: { form: {} } })
      })
    )
    expect(candidate.transferTo.mock.results[0]?.value.setProvider).toHaveBeenCalledWith({
      providerId: 'custom-gateway',
      apiType: 'openai',
      baseUrl: 'http://127.0.0.1:1234/v1',
      headers: {}
    })
    expect(attempt.publish).toHaveBeenCalledWith({
      close: true,
      delete: false,
      resume: true,
      steering: false
    })
  })

  it('retains advertised steering from initialize _meta', async () => {
    const snapshot = { status: 'connected' } as AcpStateSnapshot
    const attempt = {
      epoch: 1,
      assertCurrent: vi.fn(),
      attach: vi.fn(),
      publish: vi.fn(() => ({
        epoch: 1,
        connection,
        framework: 'claude-code' as const,
        capabilities: { close: true, delete: true, resume: true, steering: true },
        assertCurrent: vi.fn()
      })),
      owns: vi.fn(() => true)
    }
    const candidate = {
      transferTo: vi.fn(() => ({
        backendAttempt: {
          consumeInitializeMaterial: () => undefined,
          fail: vi.fn()
        },
        initialize: async () => ({
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { close: {}, delete: {}, resume: {} } },
          _meta: { steering: { supported: true } }
        }),
        authenticate: async () => undefined,
        setProvider: async () => undefined
      })),
      dispose: vi.fn(async () => undefined)
    }
    const workflow = new AcpConnectionLifecycleWorkflow({
      appVersion: 'test',
      defaultCwd: '/workspace',
      currentConnection: () => undefined,
      currentStatus: () => 'closed',
      currentGeneration: () => 1,
      currentFramework: () => 'claude-code',
      reconnectBarrier: () => undefined,
      getSnapshot: () => snapshot,
      invalidatePendingSessionStartups: vi.fn(),
      disconnectCurrent: vi.fn(async () => snapshot),
      updateCwd: vi.fn(),
      updateError: vi.fn(),
      setStatus: vi.fn(),
      pushEvent: vi.fn(),
      transitionStatus: vi.fn(),
      emitState: vi.fn(),
      diagnosticContext: () => ({ framework: 'claude-code', generation: 1, status: 'closed' }),
      openCandidate: vi.fn(async () => candidate) as never,
      connectResources: {
        connect: async (operation: Parameters<AcpConnectionResourceOwner['connect']>[0]) =>
          operation(attempt)
      } as never
    })

    await workflow.connect({ cwd: '/workspace' })
    expect(attempt.publish).toHaveBeenCalledWith({
      close: true,
      delete: true,
      resume: true,
      steering: true
    })
  })

  it('coalesces concurrent connects through the resource owner', async () => {
    const snapshot = { status: 'connected' } as AcpStateSnapshot
    const attempt = {
      epoch: 1,
      assertCurrent: vi.fn(),
      attach: vi.fn(),
      publish: vi.fn(() => ({
        epoch: 1,
        connection,
        framework: 'claude-code' as const,
        capabilities: { close: false, delete: false, resume: false, steering: false },
        assertCurrent: vi.fn()
      })),
      owns: vi.fn(() => true)
    }
    const candidate = {
      transferTo: vi.fn(() => ({
        backendAttempt: {
          consumeInitializeMaterial: () => undefined,
          fail: vi.fn()
        },
        initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }),
        authenticate: async () => undefined,
        setProvider: async () => undefined
      })),
      dispose: vi.fn(async () => undefined)
    }
    let inFlight: Promise<unknown> | undefined
    const connectResources = {
      connect: vi.fn((operation: (value: never) => Promise<unknown>) => {
        inFlight ??= operation(attempt as never)
        return inFlight as Promise<never>
      })
    }
    const workflow = new AcpConnectionLifecycleWorkflow({
      appVersion: 'test',
      defaultCwd: '/workspace',
      currentConnection: () => connection,
      currentStatus: () => 'connected',
      currentGeneration: () => 1,
      currentFramework: () => 'claude-code',
      reconnectBarrier: () => undefined,
      getSnapshot: () => snapshot,
      invalidatePendingSessionStartups: vi.fn(),
      disconnectCurrent: vi.fn(async () => snapshot),
      updateCwd: vi.fn(),
      updateError: vi.fn(),
      setStatus: vi.fn(),
      pushEvent: vi.fn(),
      transitionStatus: vi.fn(),
      emitState: vi.fn(),
      diagnosticContext: () => ({ framework: 'claude-code', generation: 1, status: 'connected' }),
      openCandidate: vi.fn(async () => candidate) as never,
      connectResources: connectResources as never
    })

    await expect(Promise.all([workflow.connect(), workflow.connect()])).resolves.toEqual([
      snapshot,
      snapshot
    ])
    expect(connectResources.connect).toHaveBeenCalledTimes(2)
    expect(candidate.transferTo).toHaveBeenCalledOnce()
  })

  it('waits for a reconnect barrier before checking or opening a connection', async () => {
    let releaseBarrier!: () => void
    const barrier = new Promise<void>((resolveBarrier) => {
      releaseBarrier = resolveBarrier
    })
    let current: ClientConnection | undefined
    const connect = vi.fn(async () => {
      current = connection
      return { status: 'connected' } as AcpStateSnapshot
    })
    const workflow = new AcpConnectionLifecycleWorkflow({
      appVersion: 'test',
      defaultCwd: '/workspace',
      currentConnection: () => current,
      currentStatus: () => (current ? 'connected' : 'closed'),
      currentGeneration: () => 1,
      currentFramework: () => 'claude-code',
      reconnectBarrier: () => barrier,
      connect,
      getSnapshot: () => ({ status: 'connected' }) as AcpStateSnapshot,
      connectResources: {} as never,
      invalidatePendingSessionStartups: vi.fn(),
      disconnectCurrent: vi.fn(async () => ({ status: 'closed' }) as AcpStateSnapshot),
      updateCwd: vi.fn(),
      updateError: vi.fn(),
      setStatus: vi.fn(),
      pushEvent: vi.fn(),
      transitionStatus: vi.fn(),
      emitState: vi.fn(),
      diagnosticContext: () => ({ framework: 'claude-code', generation: 1, status: 'closed' }),
      openCandidate: vi.fn()
    })

    const result = workflow.ensureConnected('/workspace')
    await Promise.resolve()
    expect(connect).not.toHaveBeenCalled()
    releaseBarrier()
    await expect(result).resolves.toBe(connection)
    expect(connect).toHaveBeenCalledOnce()
  })

  it('disposes an untransferred superseded candidate exactly once', async () => {
    const snapshot = { status: 'error' } as AcpStateSnapshot
    const candidate = {
      transferTo: vi.fn(() => {
        throw new Error('ACP connection superseded.')
      }),
      dispose: vi.fn(async () => undefined)
    }
    const attempt = {
      epoch: 1,
      assertCurrent: vi.fn(),
      attach: vi.fn(),
      publish: vi.fn(),
      owns: vi.fn(() => false)
    }
    const workflow = new AcpConnectionLifecycleWorkflow({
      appVersion: 'test',
      defaultCwd: '/workspace',
      currentConnection: () => undefined,
      currentStatus: () => 'closed',
      currentGeneration: () => 1,
      currentFramework: () => 'claude-code',
      reconnectBarrier: () => undefined,
      getSnapshot: () => snapshot,
      connectResources: {
        connect: (operation: (value: never) => Promise<unknown>) => operation(attempt as never)
      } as never,
      invalidatePendingSessionStartups: vi.fn(),
      disconnectCurrent: vi.fn(async () => snapshot),
      updateCwd: vi.fn(),
      updateError: vi.fn(),
      setStatus: vi.fn(),
      pushEvent: vi.fn(),
      transitionStatus: vi.fn(),
      emitState: vi.fn(),
      diagnosticContext: () => ({ framework: 'claude-code', generation: 1, status: 'closed' }),
      openCandidate: vi.fn(async () => candidate) as never
    })

    await expect(workflow.connect()).rejects.toThrow('ACP connection superseded.')
    expect(candidate.transferTo).toHaveBeenCalledOnce()
    expect(candidate.dispose).toHaveBeenCalledOnce()
  })

  it('preserves the original initialize error while clearing attempt material', async () => {
    const cause = new Error('initialize failed')
    const fail = vi.fn()
    const snapshot = { status: 'error' } as AcpStateSnapshot
    let material: unknown = {
      authentication: { methodId: 'api-key', _meta: { secret: 'redacted' } }
    }
    const candidate = {
      transferTo: vi.fn(() => ({
        backendAttempt: {
          consumeInitializeMaterial: () => {
            const consumed = material
            material = undefined
            return consumed
          },
          fail: () => {
            material = undefined
            fail()
          }
        },
        initialize: async () => {
          throw cause
        },
        authenticate: vi.fn(),
        setProvider: vi.fn()
      })),
      dispose: vi.fn(async () => undefined)
    }
    const attempt = {
      epoch: 1,
      assertCurrent: vi.fn(),
      attach: vi.fn(),
      publish: vi.fn(),
      owns: vi.fn(() => true)
    }
    const disconnectCurrent = vi.fn(async () => snapshot)
    const workflow = new AcpConnectionLifecycleWorkflow({
      appVersion: 'test',
      defaultCwd: '/workspace',
      currentConnection: () => connection,
      currentStatus: () => 'connecting',
      currentGeneration: () => 1,
      currentFramework: () => 'claude-code',
      reconnectBarrier: () => undefined,
      getSnapshot: () => snapshot,
      connectResources: {
        connect: (operation: (value: never) => Promise<unknown>) => operation(attempt as never)
      } as never,
      invalidatePendingSessionStartups: vi.fn(),
      disconnectCurrent,
      updateCwd: vi.fn(),
      updateError: vi.fn(),
      setStatus: vi.fn(),
      pushEvent: vi.fn(() => {
        throw new Error('notification failed')
      }),
      transitionStatus: vi.fn(),
      emitState: vi.fn(),
      diagnosticContext: () => ({ framework: 'claude-code', generation: 1, status: 'connecting' }),
      openCandidate: vi.fn(async () => candidate) as never
    })

    await expect(workflow.connect()).rejects.toBe(cause)
    expect(fail).toHaveBeenCalledOnce()
    expect(disconnectCurrent).toHaveBeenCalledTimes(2)
    expect(material).toBeUndefined()
  })

  it('does not publish connected after a reentrant disconnect from the initialized event', async () => {
    let generation = 1
    let reentrant = false
    const snapshot = { status: 'closed' } as AcpStateSnapshot
    const attempt = {
      epoch: 1,
      assertCurrent: vi.fn(() => {
        if (generation !== 1) throw new Error('ACP connection superseded.')
      }),
      attach: vi.fn(),
      publish: vi.fn(() => ({
        epoch: 1,
        connection,
        framework: 'claude-code' as const,
        capabilities: { close: true, delete: true, resume: true, steering: false },
        assertCurrent: vi.fn(() => {
          if (generation !== 1) throw new Error('ACP connection superseded.')
        })
      })),
      owns: vi.fn(() => true)
    }
    const candidate = {
      transferTo: vi.fn(() => ({
        backendAttempt: {
          consumeInitializeMaterial: () => undefined,
          fail: vi.fn()
        },
        initialize: async () => ({
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { close: true, delete: true, resume: true } }
        }),
        authenticate: async () => undefined,
        setProvider: async () => undefined
      })),
      dispose: vi.fn(async () => undefined)
    }
    const disconnectCurrent = vi.fn(async () => {
      if (reentrant) generation = 2
      return snapshot
    })
    const workflow = new AcpConnectionLifecycleWorkflow({
      appVersion: 'test',
      defaultCwd: '/workspace',
      currentConnection: () => (generation === 1 ? undefined : connection),
      currentStatus: () => 'connecting',
      currentGeneration: () => generation,
      currentFramework: () => 'claude-code',
      reconnectBarrier: () => undefined,
      getSnapshot: () => snapshot,
      connectResources: {
        connect: (operation: (value: never) => Promise<unknown>) => operation(attempt as never)
      } as never,
      invalidatePendingSessionStartups: vi.fn(),
      disconnectCurrent,
      updateCwd: vi.fn(),
      updateError: vi.fn(),
      setStatus: vi.fn(),
      pushEvent: vi.fn((event) => {
        if (event.title === 'Agent initialized') {
          reentrant = true
          void disconnectCurrent()
        }
      }),
      transitionStatus: vi.fn(),
      emitState: vi.fn(),
      diagnosticContext: () => ({ framework: 'claude-code', generation, status: 'connecting' }),
      openCandidate: vi.fn(async () => candidate) as never
    })

    await expect(workflow.connect()).rejects.toThrow('ACP connection superseded.')
    expect(disconnectCurrent).toHaveBeenCalledTimes(2)
  })

  it('lets an external disconnect unblock a stalled initialize without publishing connected', async () => {
    let rejectInitialize!: (error: Error) => void
    let generation = 1
    const snapshot = { status: 'closed' } as AcpStateSnapshot
    const attempt = {
      epoch: 1,
      assertCurrent: vi.fn(),
      attach: vi.fn(),
      publish: vi.fn(),
      owns: vi.fn(() => true)
    }
    const candidate = {
      transferTo: vi.fn(() => ({
        backendAttempt: { consumeInitializeMaterial: () => undefined, fail: vi.fn() },
        initialize: () =>
          new Promise<never>((_, reject) => {
            rejectInitialize = reject
          }),
        authenticate: vi.fn(),
        setProvider: vi.fn()
      })),
      dispose: vi.fn(async () => undefined)
    }
    let disconnectCount = 0
    const disconnectCurrent = vi.fn(async () => {
      disconnectCount += 1
      if (disconnectCount > 1) {
        generation = 2
        rejectInitialize(new Error('connection closed'))
      }
      return snapshot
    })
    const workflow = new AcpConnectionLifecycleWorkflow({
      appVersion: 'test',
      defaultCwd: '/workspace',
      currentConnection: () => connection,
      currentStatus: () => 'connecting',
      currentGeneration: () => generation,
      currentFramework: () => 'claude-code',
      reconnectBarrier: () => undefined,
      getSnapshot: () => snapshot,
      connectResources: {
        connect: (operation: (value: never) => Promise<unknown>) => operation(attempt as never)
      } as never,
      invalidatePendingSessionStartups: vi.fn(),
      disconnectCurrent,
      updateCwd: vi.fn(),
      updateError: vi.fn(),
      setStatus: vi.fn(),
      pushEvent: vi.fn(),
      transitionStatus: vi.fn(),
      emitState: vi.fn(),
      diagnosticContext: () => ({ framework: 'claude-code', generation, status: 'connecting' }),
      openCandidate: vi.fn(async () => candidate) as never
    })

    const connectPromise = workflow.connect()
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0))
    await disconnectCurrent()
    await expect(connectPromise).rejects.toThrow('connection closed')
    expect(attempt.publish).not.toHaveBeenCalled()
  })
})
