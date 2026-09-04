import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { NotebookRuntimeServiceOptions } from './runtime-service'

const runtimeConstruction = vi.hoisted(() => ({
  options: undefined as NotebookRuntimeServiceOptions | undefined
}))

vi.mock('./runtime-service', () => ({
  NotebookRuntimeService: class MockNotebookRuntimeService {
    state = vi.fn().mockResolvedValue({ sessionId: 'session-1', cells: [] })
    dispose = vi.fn().mockResolvedValue({ reaped: true })

    constructor(options: NotebookRuntimeServiceOptions) {
      runtimeConstruction.options = options
    }
  }
}))

import { composeApplicationRuntime } from '../application-runtime'
import type { NotebookEnvironmentLifecycle } from './environment-lifecycle-workflows'
import {
  createNotebookApplication,
  createNotebookApplicationModule,
  createNotebookLocalRpcModule,
  installNotebookEnvironmentSurface
} from './application'

describe('Notebook application composition', () => {
  it('constructs one runtime and exposes prebuilt command and local-RPC capabilities', async () => {
    const publish = vi.fn()
    const application = createNotebookApplication({
      configRoot: '/config',
      dataRoot: '/data',
      projectId: 'Open Science',
      repository: {} as never,
      locale: 'en-US',
      appVersion: '1.2.3',
      getPackageMirror: vi.fn(),
      notebookRuntimeSettings: { getSnapshot: vi.fn() },
      events: { publish }
    })

    expect(application.localRpc).toBe(application.runtime)
    await expect(
      application.commands.state({ sessionId: 'session-1', workspaceCwd: '/workspace' })
    ).resolves.toEqual({ sessionId: 'session-1', cells: [] })
    expect(application.runtime.state).toHaveBeenCalledOnce()
    expect(runtimeConstruction.options).toMatchObject({
      configRoot: '/config',
      dataRoot: '/data',
      projectId: 'Open Science',
      locale: 'en-US',
      appVersion: '1.2.3'
    })
  })

  it('publishes Notebook state events through the application event owner', () => {
    const publish = vi.fn()
    createNotebookApplication({
      configRoot: '/config',
      dataRoot: '/data',
      projectId: 'Open Science',
      repository: {} as never,
      events: { publish }
    })
    const callbacks = runtimeConstruction.options?.callbacks
    const available = { sessionId: 'session-1', kernels: ['python'] } as never
    const changed = { sessionId: 'session-1', revision: 2 } as never

    callbacks?.onNotebookAvailable?.(available)
    callbacks?.onNotebookChanged?.(changed)

    expect(publish.mock.calls).toEqual([
      ['notebook:available', available],
      ['notebook:changed', changed]
    ])
  })

  it('uses terminal runtime disposal when partial application construction rolls back', async () => {
    const module = createNotebookApplicationModule({
      configRoot: '/config',
      dataRoot: '/data',
      projectId: 'Open Science',
      events: { publish: vi.fn() },
      disposeTimeoutMs: 25,
      isBackendTeardownOwned: () => false
    })

    await module.rollback?.()

    expect(module.capability.runtime.dispose).toHaveBeenCalledOnce()
  })

  it('leaves normal Notebook teardown with the backend coordinator', async () => {
    const module = createNotebookApplicationModule({
      configRoot: '/config',
      dataRoot: '/data',
      projectId: 'Open Science',
      events: { publish: vi.fn() },
      disposeTimeoutMs: 25,
      isBackendTeardownOwned: () => true
    })

    await module.rollback?.()

    expect(module.capability.runtime.dispose).not.toHaveBeenCalled()
    expect(module.dispose).toBeUndefined()
  })

  it('registers the environment surface before starting its lifecycle once', async () => {
    const order: string[] = []
    const startup = vi.fn().mockImplementation(async () => {
      order.push('startup')
    })
    const lifecycle = {
      startup
    } as unknown as NotebookEnvironmentLifecycle

    await installNotebookEnvironmentSurface(lifecycle, () => order.push('register'))

    expect(order).toEqual(['register', 'startup'])
    expect(startup).toHaveBeenCalledOnce()
  })

  it('closes local RPC after backend drain and before application events', async () => {
    const order: string[] = []
    const close = vi.fn().mockImplementation(async () => {
      order.push('local-rpc')
    })
    const runtime = await composeApplicationRuntime(async (modules) => {
      await modules.add(undefined, () => ({
        name: 'application-events',
        capability: undefined,
        dispose: () => {
          order.push('application-events')
        }
      }))
      await modules.add({ close }, createNotebookLocalRpcModule)
      await modules.add(undefined, () => ({
        name: 'backend-shutdown-coordinator',
        capability: undefined,
        dispose: () => {
          order.push('backend-shutdown-coordinator')
        }
      }))
      return {}
    })

    await runtime.dispose()
    await runtime.dispose()

    expect(order).toEqual(['backend-shutdown-coordinator', 'local-rpc', 'application-events'])
    expect(close).toHaveBeenCalledOnce()
  })

  it('registers Host Model after local RPC so reverse disposal cancels inference first', () => {
    const source = readFileSync(resolve(__dirname, '../ipc.ts'), 'utf8')
    const localRpcRegistration = source.indexOf('const notebookRpcServer = await modules.add(')
    const hostModelRegistration = source.indexOf("name: 'host-model-service'")

    expect(localRpcRegistration).toBeGreaterThan(-1)
    expect(hostModelRegistration).toBeGreaterThan(localRpcRegistration)
  })

  it('closes local RPC once when later composition rolls back', async () => {
    const close = vi.fn().mockResolvedValue(undefined)

    await expect(
      composeApplicationRuntime(async (modules) => {
        await modules.add({ close }, createNotebookLocalRpcModule)
        throw new Error('later module failed')
      })
    ).rejects.toThrow('later module failed')

    expect(close).toHaveBeenCalledOnce()
  })
})
