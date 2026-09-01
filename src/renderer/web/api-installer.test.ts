import { describe, expect, it, vi } from 'vitest'

import {
  composeRendererContractCatalog,
  defineRendererContractGroup
} from '../../shared/renderer-contract'
import {
  RENDERER_CONTRACT_CATALOG,
  RENDERER_CONTRACT_GROUPS
} from '../../shared/renderer-contract-catalog'
import { installWebRendererContracts } from './api-installer'

const methodAt = (
  api: Record<string, unknown>,
  path: string
): ((...args: unknown[]) => unknown) | undefined => {
  let value: unknown = api
  for (const part of path.split('.')) {
    if (!value || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return typeof value === 'function' ? (value as (...args: unknown[]) => unknown) : undefined
}

type Surface<Electron, Web> = { electron: Electron; localWeb: Web; remoteWeb: Web }
function surface<Electron, Web>(electron: Electron, web: Web): Surface<Electron, Web> {
  return { electron, localWeb: web, remoteWeb: web }
}

describe('installWebRendererContracts', () => {
  it('forwards the Session delegation mutation unchanged and returns the authoritative Session', async () => {
    const api: Record<string, unknown> = {}
    const authoritative = { id: 'session-1', projectId: 'project-1', delegationPolicy: 'deny' }
    const invoke = vi.fn().mockResolvedValue(authoritative)

    installWebRendererContracts(api, {
      availableRpcChannels: new Set(['sessions:set-delegation-policy']),
      restrictedRpcChannels: new Set(),
      invoke,
      subscribe: vi.fn(),
      nativeAdapters: {}
    })

    await expect(
      methodAt(api, 'sessions.setDelegationPolicy')?.('project-1', 'session-1', 'deny')
    ).resolves.toBe(authoritative)
    expect(invoke).toHaveBeenCalledWith('sessions:set-delegation-policy', [
      'project-1',
      'session-1',
      'deny'
    ])
  })

  it('installs an available local Web RPC contract from the merged catalog', async () => {
    const api: Record<string, unknown> = {}
    const invoke = vi.fn().mockResolvedValue({ id: 'project-1' })

    installWebRendererContracts(api, {
      availableRpcChannels: new Set(['projects:list']),
      restrictedRpcChannels: new Set(),
      invoke,
      subscribe: vi.fn(),
      nativeAdapters: {}
    })

    const list = (api.projects as { list: (...args: unknown[]) => Promise<unknown> }).list
    await expect(list({ includeArchived: false })).resolves.toEqual({ id: 'project-1' })
    expect(invoke).toHaveBeenCalledWith('projects:list', [{ includeArchived: false }])
  })

  it('keeps the host Save dialog Project ZIP action unavailable on Web', () => {
    const api: Record<string, unknown> = {}
    const invoke = vi.fn()

    installWebRendererContracts(api, {
      availableRpcChannels: new Set(['file:save-project-artifacts']),
      restrictedRpcChannels: new Set(),
      invoke,
      subscribe: vi.fn(),
      nativeAdapters: {}
    })

    expect(methodAt(api, 'saveProjectArtifacts')).toBeUndefined()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('does not mistake a pre-RPC Web flush for post-teardown durability', async () => {
    const api: Record<string, unknown> = {}
    const order: string[] = []
    const invoke = vi.fn(async () => {
      order.push('invoke')
      return { ok: true }
    })

    installWebRendererContracts(api, {
      availableRpcChannels: new Set(['storage:set-data-root-and-relaunch']),
      restrictedRpcChannels: new Set(),
      invoke,
      subscribe: vi.fn(),
      nativeAdapters: {},
      flushDataRootHandoffPersistence: async () => {
        order.push('flush')
      }
    } as never)

    await methodAt(api, 'storage.setDataRootAndRelaunch')?.('/data', true)

    expect(order).toEqual(['invoke'])
  })

  it('preserves the Web optional-argument codecs when dispatching RPC', async () => {
    const api: Record<string, unknown> = {}
    const invoke = vi.fn().mockResolvedValue(undefined)

    installWebRendererContracts(api, {
      availableRpcChannels: new Set(['acp:connect', 'acp:create-session', 'notebook-env:cancel']),
      restrictedRpcChannels: new Set(),
      invoke,
      subscribe: vi.fn(),
      nativeAdapters: {}
    })

    await methodAt(api, 'acp.connect')?.()
    await methodAt(api, 'acp.connect')?.(undefined)
    await methodAt(api, 'acp.createSession')?.()
    await methodAt(api, 'notebookEnv.cancel')?.()
    await methodAt(api, 'notebookEnv.cancel')?.(undefined)

    expect(invoke.mock.calls).toEqual([
      ['acp:connect', [{}]],
      ['acp:connect', [undefined]],
      ['acp:create-session', [{}]],
      ['notebook-env:cancel', []],
      ['notebook-env:cancel', [undefined]]
    ])
  })

  it('installs Web event subscriptions and omits Electron-only event adapters', () => {
    const api: Record<string, unknown> = {}
    const close = vi.fn()
    const subscribe = vi.fn(() => vi.fn())
    const listener = vi.fn()

    installWebRendererContracts(api, {
      availableRpcChannels: new Set(),
      restrictedRpcChannels: new Set(),
      invoke: vi.fn(),
      subscribe,
      nativeAdapters: {
        'window.close': close
      }
    })

    expect(methodAt(api, 'window.close')).toBe(close)
    expect(methodAt(api, 'managedFileVersions.getCapability')).toBeUndefined()
    expect(methodAt(api, 'managedFileVersions.saveTextEdit')).toBeUndefined()
    expect(methodAt(api, 'managedFileVersions.diffText')).toBeUndefined()
    expect(methodAt(api, 'managedFileVersions.cancelDiff')).toBeUndefined()
    expect(methodAt(api, 'specialist.list')).toBeUndefined()
    expect(methodAt(api, 'uploads.stageLocalFile')).toBeUndefined()
    expect(methodAt(api, 'window.announceWindowFindReady')).toBeUndefined()
    expect(methodAt(api, 'notifications.onOpenSession')).toBeUndefined()
    expect(methodAt(api, 'notifications.onViewProbe')).toBeUndefined()
    expect(methodAt(api, 'uploads.onTransferProgress')).toBeUndefined()
    expect(methodAt(api, 'window.onCloseActivePane')).toBeUndefined()

    const unsubscribe = methodAt(api, 'notebookEnv.onProgress')?.(listener)
    expect(subscribe).toHaveBeenCalledOnce()
    expect(subscribe).toHaveBeenCalledWith('notebook-env:progress', listener)
    expect(unsubscribe).toBe(subscribe.mock.results[0]?.value)
  })

  it('installs catalog-declared rejecting stubs only when bootstrap marks them restricted', async () => {
    const api: Record<string, unknown> = {}

    installWebRendererContracts(api, {
      availableRpcChannels: new Set(),
      restrictedRpcChannels: new Set(['compute:download']),
      invoke: vi.fn(),
      subscribe: vi.fn(),
      nativeAdapters: {}
    })

    await expect(methodAt(api, 'compute.download')?.()).rejects.toThrow(
      'This action is only available in the local desktop app (compute:download).'
    )
    expect(methodAt(api, 'compute.revealInFolder')).toBeUndefined()
    expect(methodAt(api, 'projects.list')).toBeUndefined()
  })

  it('does not create namespaces for unavailable Electron-only contracts', () => {
    const api: Record<string, unknown> = {}
    installWebRendererContracts(api, {
      availableRpcChannels: new Set(['specialist:list']),
      restrictedRpcChannels: new Set(),
      invoke: vi.fn(),
      subscribe: vi.fn(),
      nativeAdapters: {}
    })

    // specialist.* is ELECTRON / ELECTRON_EVENT — the namespace must not exist on web.
    expect(api.specialist).toBeUndefined()
    // handoff.list is ELECTRON — namespace must not exist on web.
    expect(api.handoff).toBeUndefined()
    // officePreview.onState is ELECTRON_EVENT — namespace must not exist on web.
    expect(api.officePreview).toBeUndefined()
    expect(methodAt(api, 'specialist.list')).toBeUndefined()
  })

  it('accepts one test-local neutral descriptor in both renderer adapters', async () => {
    const productionPaths = RENDERER_CONTRACT_CATALOG.map(({ publicPath }) => publicPath)
    const injectedCatalog = composeRendererContractCatalog([
      ...RENDERER_CONTRACT_GROUPS,
      defineRendererContractGroup('sample-extension', [
        {
          publicPath: 'sampleExtension.echo',
          channel: 'sample-extension:echo',
          kind: 'method',
          parameterCodec: { electron: 'positional', web: 'positional' },
          surfaceInstallation: surface('preload', 'web-rpc'),
          dispatchPolicy: surface('electron-ipc-request', 'direct-application-request'),
          eventDeliverability: surface('not-event', 'not-event'),
          authorityFlow: surface('electron-sender', 'caller-context'),
          mapProjection: 'invoke'
        }
      ])
    ])

    vi.resetModules()
    vi.doMock('../../shared/renderer-contract-catalog', () => ({
      RENDERER_CONTRACT_CATALOG: injectedCatalog
    }))
    const [{ createElectronRendererContractAdapter }, { installWebRendererContracts }] =
      await Promise.all([
        import('../../preload/electron-renderer-contract-adapter'),
        import('./api-installer')
      ])
    const payload = { value: 'sample' }
    const electronInvoke = vi.fn().mockResolvedValue(payload)
    const electronPort = {
      invoke: electronInvoke,
      send: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
      getPathForFile: vi.fn(() => '')
    }
    await createElectronRendererContractAdapter(electronPort).invoke(
      'sampleExtension.echo',
      payload
    )

    const webInvoke = vi.fn().mockResolvedValue(payload)
    const webApi: Record<string, unknown> = {}
    installWebRendererContracts(webApi, {
      availableRpcChannels: new Set(['sample-extension:echo']),
      restrictedRpcChannels: new Set(),
      invoke: webInvoke,
      subscribe: vi.fn(),
      nativeAdapters: {}
    })
    await methodAt(webApi, 'sampleExtension.echo')?.(payload)

    expect(electronInvoke).toHaveBeenCalledWith('sample-extension:echo', payload)
    expect(webInvoke).toHaveBeenCalledWith('sample-extension:echo', [payload])
    expect(RENDERER_CONTRACT_CATALOG.map(({ publicPath }) => publicPath)).toEqual(productionPaths)
    expect(productionPaths).not.toContain('sampleExtension.echo')
    vi.doUnmock('../../shared/renderer-contract-catalog')
    vi.resetModules()
  })
})
