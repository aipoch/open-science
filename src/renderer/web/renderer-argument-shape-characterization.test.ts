// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RENDERER_CONTRACT_CATALOG } from '../../shared/renderer-contract-catalog'
import { WEB_EVENT_CHANNELS, WEB_INVOKE_CHANNELS } from '../../shared/web-api-map.generated'
import {
  WEB_EVENT_STREAM_PROTOCOL_VERSION,
  WEB_RPC_ALLOWED_CHANNELS,
  WEB_RPC_PROTOCOL_VERSION
} from '../../shared/web-rpc-contract'
import { WEB_EVENT_CONSUMERS_READY_EVENT } from '../../shared/web-event-connection'

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn().mockResolvedValue(null),
  on: vi.fn()
}))

const themeMocks = vi.hoisted(() => ({
  applyTheme: vi.fn(),
  resolveInitialTheme: vi.fn(() => 'light')
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electronMocks.exposeInMainWorld },
  webUtils: { getPathForFile: vi.fn() },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    on: electronMocks.on,
    off: vi.fn(),
    send: vi.fn(),
    removeListener: vi.fn()
  }
}))
vi.mock('@/lib/theme', () => themeMocks)
vi.mock('../src/main', () => ({}))
vi.mock('../../main/remote-access/openscience-logo.svg?raw', () => ({
  default: '<svg viewBox="0 0 1 1"></svg>'
}))

type SocketListener = (event: { data?: unknown }) => void

class FakeWebSocket {
  readonly listeners = new Map<string, Set<SocketListener>>()

  addEventListener(name: string, listener: SocketListener): void {
    const listeners = this.listeners.get(name) ?? new Set<SocketListener>()
    listeners.add(listener)
    this.listeners.set(name, listeners)
  }
}

type ApiRoot = Record<string, unknown>

type CapturedInvocation = {
  channel: string
  args: unknown[]
}

const BROWSER_NATIVE_CALLABLE_PATHS = [
  'getRuntimeVersions',
  'saveBlobFile',
  'saveManagedFile',
  'window.close'
] as const

const webInvocations: CapturedInvocation[] = []

const codecAt = (path: string): (typeof RENDERER_CONTRACT_CATALOG)[number]['parameterCodec'] => {
  const contract = RENDERER_CONTRACT_CATALOG.find(({ publicPath }) => publicPath === path)
  if (!contract) throw new Error(`Missing renderer contract: ${path}`)
  return contract.parameterCodec
}

const methodAt = (api: ApiRoot, path: string): ((...args: unknown[]) => Promise<unknown>) => {
  let value: unknown = api
  for (const part of path.split('.')) value = (value as ApiRoot)[part]
  if (typeof value !== 'function') throw new Error(`Missing API method: ${path}`)
  return value as (...args: unknown[]) => Promise<unknown>
}

const collectFunctionPaths = (value: unknown, prefix = ''): string[] => {
  if (typeof value === 'function') return [prefix]
  if (!value || typeof value !== 'object') return []

  return Object.entries(value).flatMap(([key, child]) =>
    collectFunctionPaths(child, prefix ? `${prefix}.${key}` : key)
  )
}

const loadElectronApi = async (): Promise<ApiRoot> => {
  await import('../../preload/index')
  const exposure = electronMocks.exposeInMainWorld.mock.calls.find(([name]) => name === 'api')
  if (!exposure) throw new Error('Preload did not expose window.api')
  return exposure[1] as ApiRoot
}

const loadWebApi = async (): Promise<ApiRoot> => {
  const bootstrapImport = import('./bootstrap')
  await vi.waitFor(() => expect((window as unknown as { api?: ApiRoot }).api).toBeDefined())
  window.dispatchEvent(new Event(WEB_EVENT_CONSUMERS_READY_EVENT))
  await bootstrapImport
  return (window as unknown as { api: ApiRoot }).api
}

const invokeElectron = async (
  api: ApiRoot,
  path: string,
  args: unknown[]
): Promise<CapturedInvocation> => {
  electronMocks.invoke.mockClear()
  if (path === 'sessions.saveSession') {
    electronMocks.invoke.mockResolvedValueOnce({ ok: true, result: null })
  }
  await methodAt(api, path)(...args)
  const [channel, ...forwardedArgs] = electronMocks.invoke.mock.calls.at(-1) ?? []
  return { channel: String(channel), args: forwardedArgs }
}

const invokeWeb = async (
  api: ApiRoot,
  path: string,
  args: unknown[]
): Promise<CapturedInvocation> => {
  webInvocations.length = 0
  await methodAt(api, path)(...args)
  const invocation = webInvocations.at(-1)
  if (!invocation) throw new Error(`Web API did not invoke an RPC channel for ${path}`)
  return invocation
}

let electronApi: ApiRoot
let webApi: ApiRoot

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  Object.defineProperty(process, 'contextIsolated', { value: true, configurable: true })
  electronMocks.exposeInMainWorld.mockClear()
  electronMocks.invoke.mockReset().mockResolvedValue(null)
  webInvocations.length = 0
  sessionStorage.clear()
  sessionStorage.setItem('open-science-web-client', 'argument-shape-client')
  delete (window as unknown as { api?: unknown }).api
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/bootstrap') {
        return new Response(
          JSON.stringify({
            platform: 'test',
            webCallerLocation: 'local',
            versions: { electron: '1', chrome: '1', node: '1' },
            rpcProtocolVersion: WEB_RPC_PROTOCOL_VERSION,
            rpcChannels: WEB_RPC_ALLOWED_CHANNELS,
            eventStream: {
              protocolVersion: WEB_EVENT_STREAM_PROTOCOL_VERSION,
              streamId: 'stream-1',
              latestSequence: 0
            }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }

      const match = String(input).match(/^\/rpc\/(.+)$/)
      if (!match) throw new Error(`Unexpected fetch: ${String(input)}`)
      const payload = JSON.parse(String(init?.body)) as { args: unknown[] }
      webInvocations.push({ channel: decodeURIComponent(match[1]), args: payload.args })
      return new Response(
        JSON.stringify({
          protocolVersion: WEB_RPC_PROTOCOL_VERSION,
          ok: true,
          result: null
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })
  )

  electronApi = await loadElectronApi()
  webApi = await loadWebApi()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  sessionStorage.clear()
  delete (window as unknown as { api?: unknown }).api
})

describe('renderer argument-shape characterization', () => {
  it('loads the complete local Web callable surface from the real bootstrap', () => {
    const expectedPaths = [
      ...Object.entries(WEB_INVOKE_CHANNELS)
        .filter(([, channel]) => WEB_RPC_ALLOWED_CHANNELS.includes(channel))
        .map(([path]) => path),
      ...Object.keys(WEB_EVENT_CHANNELS),
      ...BROWSER_NATIVE_CALLABLE_PATHS
    ].sort()
    const actualPaths = collectFunctionPaths(webApi).sort()

    expect(new Set(actualPaths).size).toBe(actualPaths.length)

    expect(actualPaths).toEqual(expectedPaths)
  })

  it('keeps Runtime request arguments equivalent across Electron and Web', async () => {
    const cases = [
      {
        path: 'runtime.listPackages',
        args: ['python', 'python-env'],
        channel: 'runtime:list-packages',
        electronArgs: [{ language: 'python', envId: 'python-env' }]
      },
      {
        path: 'runtime.listPackageCounts',
        args: ['python'],
        channel: 'runtime:list-package-counts',
        electronArgs: [{ language: 'python' }]
      },
      {
        path: 'runtime.getEnablement',
        args: ['python'],
        channel: 'runtime:get-enablement',
        electronArgs: [{ language: 'python' }]
      },
      {
        path: 'runtime.describeUsage',
        args: ['python', 'python-env'],
        channel: 'runtime:describe-usage',
        electronArgs: [{ language: 'python', envId: 'python-env' }]
      },
      {
        path: 'runtime.setEnvironmentEnabled',
        args: ['python', 'python-env', true, true],
        channel: 'runtime:set-environment-enabled',
        electronArgs: [{ language: 'python', envId: 'python-env', enabled: true, force: true }]
      },
      {
        path: 'runtime.setInstallAuthorized',
        args: ['python', 'python-env', true],
        channel: 'runtime:set-install-authorized',
        electronArgs: [{ language: 'python', envId: 'python-env', authorized: true }]
      },
      {
        path: 'runtime.registerInterpreter',
        args: ['python', '/opt/python'],
        channel: 'runtime:register-interpreter',
        electronArgs: [{ language: 'python', path: '/opt/python' }]
      },
      {
        path: 'runtime.unregisterInterpreter',
        args: ['python', '/opt/python'],
        channel: 'runtime:unregister-interpreter',
        electronArgs: [{ language: 'python', path: '/opt/python' }]
      }
    ] as const

    for (const testCase of cases) {
      const electron = await invokeElectron(electronApi, testCase.path, [...testCase.args])
      const web = await invokeWeb(webApi, testCase.path, [...testCase.args])

      expect(electron, `${testCase.path}: Electron wraps a request object`).toEqual({
        channel: testCase.channel,
        args: testCase.electronArgs
      })
      expect(web, `${testCase.path}: Web wraps the same request object`).toEqual({
        channel: testCase.channel,
        args: testCase.electronArgs
      })
      expect(web.args, `${testCase.path}: renderer transports stay equivalent`).toEqual(
        electron.args
      )
    }
  })

  it('records equivalent session-save calls and the explicit-undefined JSON deviation', async () => {
    const session = { id: 'session-1', projectId: 'project-1', title: 'Characterization' }
    const options = { conflictRebaseFields: ['title'] }

    for (const args of [[session], [session, options]]) {
      const electron = await invokeElectron(electronApi, 'sessions.saveSession', args)
      const web = await invokeWeb(webApi, 'sessions.saveSession', args)

      expect(web, 'ordinary optional-options usage is intentionally equivalent').toEqual(electron)
    }

    const electronWithUndefined = await invokeElectron(electronApi, 'sessions.saveSession', [
      session,
      undefined
    ])
    const webWithUndefined = await invokeWeb(webApi, 'sessions.saveSession', [session, undefined])

    expect(electronWithUndefined).toEqual({
      channel: 'sessions:save-session',
      args: [session]
    })
    expect(webWithUndefined).toEqual({
      channel: 'sessions:save-session',
      args: [session, null]
    })
  })

  it('installs summary-first Session reads on Web', async () => {
    const request = { projectId: 'project-1', sessionId: 'session-1' }

    await expect(invokeWeb(webApi, 'sessions.list', [])).resolves.toEqual({
      channel: 'sessions:list',
      args: []
    })
    await expect(invokeWeb(webApi, 'sessions.loadOne', [request])).resolves.toEqual({
      channel: 'sessions:load-one',
      args: [request]
    })
    await expect(invokeWeb(webApi, 'sessions.loadUsage', [])).resolves.toEqual({
      channel: 'sessions:load-usage',
      args: []
    })
  })

  it('records ACP optional requests by call absence instead of normalizing explicit undefined', async () => {
    for (const { path, channel } of [
      { path: 'acp.connect', channel: 'acp:connect' },
      { path: 'acp.createSession', channel: 'acp:create-session' }
    ]) {
      const electronWithoutArgument = await invokeElectron(electronApi, path, [])
      const webWithoutArgument = await invokeWeb(webApi, path, [])
      const electronWithUndefined = await invokeElectron(electronApi, path, [undefined])
      const webWithUndefined = await invokeWeb(webApi, path, [undefined])

      expect(electronWithoutArgument).toEqual({ channel, args: [{}] })
      expect(webWithoutArgument).toEqual({ channel, args: [{}] })
      expect(electronWithUndefined).toEqual({ channel, args: [{}] })
      expect(webWithUndefined).toEqual({ channel, args: [null] })
      expect(codecAt(path)).toEqual({
        electron: 'default-empty-object',
        web: 'default-empty-object-absent-only'
      })
    }
  })

  it('records the Electron-only optional notebook environment argument slot', async () => {
    const electronWithoutArgument = await invokeElectron(electronApi, 'notebookEnv.cancel', [])
    const webWithoutArgument = await invokeWeb(webApi, 'notebookEnv.cancel', [])
    const electronWithUndefined = await invokeElectron(electronApi, 'notebookEnv.cancel', [
      undefined
    ])
    const webWithUndefined = await invokeWeb(webApi, 'notebookEnv.cancel', [undefined])

    expect(electronWithoutArgument).toEqual({
      channel: 'notebook-env:cancel',
      args: [undefined]
    })
    expect(webWithoutArgument).toEqual({ channel: 'notebook-env:cancel', args: [] })
    expect(electronWithUndefined).toEqual({
      channel: 'notebook-env:cancel',
      args: [undefined]
    })
    expect(webWithUndefined).toEqual({ channel: 'notebook-env:cancel', args: [null] })
    expect(codecAt('notebookEnv.cancel')).toEqual({
      electron: 'optional-argument-slot',
      web: 'positional'
    })
  })

  it('keeps storage Web transforms equivalent to their Electron wrappers', async () => {
    const cases = [
      { path: 'storage.validateDataRoot', args: ['/data'] },
      { path: 'storage.inspectDataRoot', args: ['/data'] },
      { path: 'storage.migrate', args: ['/data'] },
      { path: 'storage.commitAndRelaunch', args: ['/data'] },
      { path: 'storage.discardMigratedCopy', args: ['/data'] },
      { path: 'storage.setDataRootAndRelaunch', args: ['/data', true] }
    ] as const

    for (const testCase of cases) {
      const electron = await invokeElectron(electronApi, testCase.path, [...testCase.args])
      const web = await invokeWeb(webApi, testCase.path, [...testCase.args])

      expect(web, `${testCase.path}: explicit Web transform is an intended equivalence`).toEqual(
        electron
      )
    }
  })

  it('keeps projectFiles.searchArtifacts request forwarding equivalent', async () => {
    const request = {
      projectId: 'project-1',
      query: 'analysis',
      limit: 24
    }
    const electron = await invokeElectron(electronApi, 'projectFiles.searchArtifacts', [request])
    const web = await invokeWeb(webApi, 'projectFiles.searchArtifacts', [request])

    expect(electron).toEqual({
      channel: 'project-files:search-artifacts',
      args: [request]
    })
    expect(web).toEqual(electron)
  })
})
