import { describe, expect, it, vi, type Mock } from 'vitest'

import { ApplicationCommandError } from '../shared/application-command-contract'
import { createElectronRendererContractAdapter } from './electron-renderer-contract-adapter'

type MockPort = Readonly<{
  invoke: Mock<(channel: string, ...args: unknown[]) => Promise<unknown>>
  send: Mock<(channel: string, ...args: unknown[]) => void>
  on: Mock<(channel: string, listener: (event: unknown, payload: unknown) => void) => void>
  removeListener: Mock<
    (channel: string, listener: (event: unknown, payload: unknown) => void) => void
  >
  getPathForFile: Mock<(file: unknown) => string>
}>

const createPort = (): MockPort => ({
  invoke: vi
    .fn<(channel: string, ...args: unknown[]) => Promise<unknown>>()
    .mockResolvedValue(undefined),
  send: vi.fn<(channel: string, ...args: unknown[]) => void>(),
  on: vi.fn<(channel: string, listener: (event: unknown, payload: unknown) => void) => void>(),
  removeListener:
    vi.fn<(channel: string, listener: (event: unknown, payload: unknown) => void) => void>(),
  getPathForFile: vi.fn<(file: unknown) => string>()
})

describe('electron renderer contract adapter', () => {
  it.each([
    {
      publicPath: 'diagnostics.reportRendererFailure',
      channel: 'diagnostics:renderer-failure',
      args: [{ source: 'renderer', message: 'render failed' }]
    },
    {
      publicPath: 'notifications.syncViewState',
      channel: 'notifications:sync-unread-view',
      args: [{ visible: true }]
    },
    {
      publicPath: 'officePreview.reportState',
      channel: 'office-preview:report-state',
      args: ['session-1', { ready: true }]
    },
    {
      publicPath: 'sessions.sendFlushResponse',
      channel: 'sessions:flush-response',
      args: [{ requestId: 'flush-1' }]
    },
    {
      publicPath: 'window.announceWindowFindAppearance',
      channel: 'window:find-appearance-changed',
      args: [{ height: 42 }]
    },
    { publicPath: 'window.clearFind', channel: 'window:clear-find-in-page', args: [] },
    { publicPath: 'window.closeFind', channel: 'window:find-close', args: [] },
    {
      publicPath: 'window.findInPage',
      channel: 'window:find-in-page',
      args: [{ query: 'science' }]
    },
    {
      publicPath: 'window.sendCloseConfirmResponse',
      channel: 'window:close-confirm-response',
      args: [{ requestId: 'close-1', confirmed: true }]
    }
  ])(
    'dispatches $publicPath as a catalog-defined one-way message',
    ({ publicPath, channel, args }) => {
      const port = createPort()
      const adapter = createElectronRendererContractAdapter(port)

      adapter.send(publicPath, ...args)

      expect(port.send).toHaveBeenCalledWith(channel, ...args)
    }
  )

  it('rejects lifecycle-managed contracts from generic send and subscribe paths', () => {
    const port = createPort()
    const adapter = createElectronRendererContractAdapter(port)

    expect(() => adapter.send('window.announceWindowFindReady')).toThrow(
      'Renderer contract requires dedicated Electron lifecycle dispatch: window.announceWindowFindReady'
    )
    expect(() => adapter.subscribe('window.onCloseActivePane', vi.fn())).toThrow(
      'Renderer contract requires dedicated Electron lifecycle dispatch: window.onCloseActivePane'
    )
    expect(port.send).not.toHaveBeenCalled()
    expect(port.on).not.toHaveBeenCalled()
  })

  it('resolves ACP session requests and supplies their default empty objects', async () => {
    const result = { status: 'connected' }
    const port = createPort()
    port.invoke.mockResolvedValue(result)
    const adapter = createElectronRendererContractAdapter(port)

    await expect(adapter.invoke('acp.connect')).resolves.toBe(result)
    await adapter.invoke('acp.connect', undefined)
    await adapter.invoke('acp.createSession')
    await adapter.invoke('acp.createSession', undefined)

    expect(port.invoke).toHaveBeenNthCalledWith(1, 'acp:connect', {})
    expect(port.invoke).toHaveBeenNthCalledWith(2, 'acp:connect', {})
    expect(port.invoke).toHaveBeenNthCalledWith(3, 'acp:create-session', {})
    expect(port.invoke).toHaveBeenNthCalledWith(4, 'acp:create-session', {})
  })

  it('preserves positional request arguments and result identity', async () => {
    const result = { saved: true }
    const port = createPort()
    port.invoke.mockResolvedValue(result)
    const adapter = createElectronRendererContractAdapter(port)
    const request = { projectId: 'project-1', content: 'preview' }

    await expect(adapter.invoke('preview.save', request)).resolves.toBe(result)

    expect(port.invoke).toHaveBeenCalledWith('preview:save', request)
  })

  it('forwards Project ZIP logical file identities without narrowing the request', async () => {
    const port = createPort()
    const adapter = createElectronRendererContractAdapter(port)
    const request = {
      projectId: 'project-1',
      projectName: 'Research',
      files: [
        {
          source: 'artifact',
          sessionId: 'session-1',
          path: '/stale/report.md',
          fileId: 'artifact-file-1',
          versionId: 'artifact-version-2',
          suggestedName: 'report.md'
        }
      ]
    }

    await adapter.invoke('saveProjectArtifacts', request)

    expect(port.invoke).toHaveBeenCalledWith('file:save-project-artifacts', request)
  })

  it('propagates request failures unchanged', async () => {
    const failure = new Error('main process unavailable')
    const port = createPort()
    port.invoke.mockRejectedValue(failure)
    const adapter = createElectronRendererContractAdapter(port)

    await expect(adapter.invoke('preview.load', { projectId: 'project-1' })).rejects.toBe(failure)
  })

  it('unwraps runtime-validated Project outcomes and reconstructs public failures', async () => {
    const project = { id: 'project-1' }
    const port = createPort()
    const adapter = createElectronRendererContractAdapter(port)
    port.invoke.mockResolvedValueOnce({ ok: true, result: project }).mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'invalid-command-arguments',
        message: 'Invalid arguments for application command: projects:create'
      }
    })

    await expect(adapter.invoke('projects.get', 'project-1')).resolves.toBe(project)
    await expect(adapter.invoke('projects.create', { name: 42 })).rejects.toEqual(
      expect.objectContaining<ApplicationCommandError>({
        name: 'ApplicationCommandError',
        code: 'invalid-command-arguments',
        message: 'Invalid arguments for application command: projects:create'
      })
    )
  })

  it('reconstructs Session size-limit failures from the Electron ACP command boundary', async () => {
    const port = createPort()
    const adapter = createElectronRendererContractAdapter(port)
    port.invoke.mockResolvedValue({
      ok: false,
      error: {
        code: 'session-size-limit',
        message: 'Session exceeds the persistence limit.'
      }
    })

    await expect(
      adapter.invoke('acp.respondToPermission', {
        requestId: 'permission-1',
        optionId: 'allow-once'
      })
    ).rejects.toMatchObject({
      name: 'ApplicationCommandError',
      code: 'session-size-limit'
    })
  })

  it('rejects surface-native methods from the IPC request path', async () => {
    const port = createPort()
    const adapter = createElectronRendererContractAdapter(port)

    await expect(adapter.invoke('getRuntimeVersions')).rejects.toThrow(
      'Renderer contract is not an Electron IPC request: getRuntimeVersions'
    )
    expect(port.invoke).not.toHaveBeenCalled()
  })

  it('preserves the optional notebook cancellation argument slot', async () => {
    const port = createPort()
    const adapter = createElectronRendererContractAdapter(port)

    await adapter.invoke('notebookEnv.cancel')
    await adapter.invoke('notebookEnv.cancel', undefined)

    expect(port.invoke).toHaveBeenNthCalledWith(1, 'notebook-env:cancel', undefined)
    expect(port.invoke).toHaveBeenNthCalledWith(2, 'notebook-env:cancel', undefined)
  })

  it('omits the optional session save argument when it is absent or falsy', async () => {
    const port = createPort()
    const adapter = createElectronRendererContractAdapter(port)
    const session = { id: 'session-1' }
    const options = { expectedRevision: 4 }

    await adapter.invoke('sessions.saveSession', session)
    await adapter.invoke('sessions.saveSession', session, undefined)
    await adapter.invoke('sessions.saveSession', session, null)
    await adapter.invoke('sessions.saveSession', session, options)

    expect(port.invoke).toHaveBeenNthCalledWith(1, 'sessions:save-session', session)
    expect(port.invoke).toHaveBeenNthCalledWith(2, 'sessions:save-session', session)
    expect(port.invoke).toHaveBeenNthCalledWith(3, 'sessions:save-session', session)
    expect(port.invoke).toHaveBeenNthCalledWith(4, 'sessions:save-session', session, options)
  })

  it('encodes storage parent requests as objects', async () => {
    const port = createPort()
    const adapter = createElectronRendererContractAdapter(port)

    await adapter.invoke('storage.validateDataRoot', '/data/open-science')

    expect(port.invoke).toHaveBeenCalledWith('storage:validate-data-root', {
      parent: '/data/open-science'
    })
  })

  it('encodes the storage data-root relaunch request as one object', async () => {
    const port = createPort()
    const adapter = createElectronRendererContractAdapter(port)

    await adapter.invoke('storage.setDataRootAndRelaunch', '/data/open-science', true)

    expect(port.invoke).toHaveBeenCalledWith('storage:set-data-root-and-relaunch', {
      parent: '/data/open-science',
      markOnboarding: true
    })
  })

  it('returns null without IPC when a local upload has no native path', async () => {
    const port = createPort()
    const adapter = createElectronRendererContractAdapter(port)
    const file = { name: 'clipboard.csv' }

    await expect(
      adapter.invoke('uploads.stageLocalFile', file, { transferId: 'transfer-1' })
    ).resolves.toBeNull()

    expect(port.getPathForFile).toHaveBeenCalledWith(file)
    expect(port.invoke).not.toHaveBeenCalled()
  })

  it('merges a native upload path into the request before IPC dispatch', async () => {
    const attachment = { id: 'attachment-1' }
    const port = createPort()
    port.getPathForFile.mockReturnValue('/data/large.csv')
    port.invoke.mockResolvedValue(attachment)
    const adapter = createElectronRendererContractAdapter(port)
    const file = { name: 'large.csv' }
    const request = { transferId: 'transfer-1', projectId: 'project-1' }

    await expect(adapter.invoke('uploads.stageLocalFile', file, request)).resolves.toBe(attachment)

    expect(port.getPathForFile).toHaveBeenCalledWith(file)
    expect(port.invoke).toHaveBeenCalledWith('uploads:stage-local-file', {
      ...request,
      sourcePath: '/data/large.csv'
    })
  })

  it('encodes Electron runtime deviations without leaking them into preload callers', async () => {
    const port = createPort()
    const adapter = createElectronRendererContractAdapter(port)

    await adapter.invoke('runtime.listPackages', 'python', 'science')
    await adapter.invoke('runtime.getEnablement', 'r')
    await adapter.invoke('runtime.setEnvironmentEnabled', 'r', 'renv', true, false)
    await adapter.invoke('runtime.setInstallAuthorized', 'python', 'science', true)
    await adapter.invoke('runtime.registerInterpreter', 'python', '/usr/bin/python3')

    expect(port.invoke).toHaveBeenNthCalledWith(1, 'runtime:list-packages', {
      language: 'python',
      envId: 'science'
    })
    expect(port.invoke).toHaveBeenNthCalledWith(2, 'runtime:get-enablement', {
      language: 'r'
    })
    expect(port.invoke).toHaveBeenNthCalledWith(3, 'runtime:set-environment-enabled', {
      language: 'r',
      envId: 'renv',
      enabled: true,
      force: false
    })
    expect(port.invoke).toHaveBeenNthCalledWith(4, 'runtime:set-install-authorized', {
      language: 'python',
      envId: 'science',
      authorized: true
    })
    expect(port.invoke).toHaveBeenNthCalledWith(5, 'runtime:register-interpreter', {
      language: 'python',
      path: '/usr/bin/python3'
    })
  })

  it('strips Electron events and removes the exact wrapped listener on unsubscribe', () => {
    const port = createPort()
    const adapter = createElectronRendererContractAdapter(port)
    const listener = vi.fn()

    const unsubscribe = adapter.subscribe('specialist.onPendingSwitch', listener)
    const wrappedListener = port.on.mock.calls[0]?.[1]
    const payload = { specialistId: 'specialist-1' }

    wrappedListener?.({ sender: 'electron' }, payload)
    unsubscribe()

    expect(port.on).toHaveBeenCalledWith('specialist:pending-switch', wrappedListener)
    expect(listener).toHaveBeenCalledWith(payload)
    expect(port.removeListener).toHaveBeenCalledWith('specialist:pending-switch', wrappedListener)
  })
})
