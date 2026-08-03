import { describe, expect, it, vi } from 'vitest'
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

describe('installWebRendererContracts', () => {
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

  it('installs browser-native and inert event adapters without Electron lifecycle dispatch', () => {
    const api: Record<string, unknown> = {}
    const close = vi.fn()
    const subscribe = vi.fn(() => vi.fn())
    const listener = vi.fn()

    installWebRendererContracts(api, {
      availableRpcChannels: new Set(),
      restrictedRpcChannels: new Set(),
      invoke: vi.fn(),
      subscribe,
      nativeAdapters: { 'window.close': close }
    })

    expect(methodAt(api, 'window.close')).toBe(close)
    expect(methodAt(api, 'specialist.list')).toBeUndefined()
    expect(methodAt(api, 'uploads.stageLocalFile')).toBeUndefined()
    expect(methodAt(api, 'window.announceWindowFindReady')).toBeUndefined()

    const unsubscribe = methodAt(api, 'window.onCloseActivePane')?.(listener)
    expect(subscribe).toHaveBeenCalledWith('shortcut:close-active-pane', listener)
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
})
