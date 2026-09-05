import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProvisionProgress, RuntimeProvisioner } from './provisioner'

const registered = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
const sent: Array<{ channel: string; progress: ProvisionProgress }> = []
const destroyedSend = vi.fn()

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: never) => registered.set(channel, handler) },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, progress: ProvisionProgress) => sent.push({ channel, progress })
        }
      },
      {
        isDestroyed: () => true,
        webContents: { send: destroyedSend }
      }
    ]
  }
}))

import { broadcastNotebookEnvProgress, registerNotebookEnvIpcHandlers } from './env-ipc'
import {
  createNotebookEnvironmentLifecycle,
  type NotebookEnvironmentLifecycle
} from './environment-lifecycle-workflows'

const fakeProvisioner = (over: Partial<RuntimeProvisioner> = {}): RuntimeProvisioner => ({
  status: vi
    .fn()
    .mockReturnValue({ pythonReady: false, rReady: false, version: 0, provisioning: false }),
  provisionPython: vi.fn().mockResolvedValue(undefined),
  provisionR: vi.fn().mockResolvedValue(undefined),
  upgradeIfNeeded: vi.fn().mockResolvedValue(undefined),
  repair: vi.fn().mockResolvedValue(undefined),
  restoreRelocatedEnvs: vi.fn().mockResolvedValue(undefined),
  restoreEnvironmentFromLock: vi.fn().mockResolvedValue(undefined),
  cancel: vi.fn(),
  ...over
})

const createLifecycle = (
  provisioner: RuntimeProvisioner | undefined
): NotebookEnvironmentLifecycle =>
  createNotebookEnvironmentLifecycle({
    provisioner,
    root: '/runtime',
    projectProgress: broadcastNotebookEnvProgress
  })

describe('registerNotebookEnvIpcHandlers', () => {
  beforeEach(() => {
    registered.clear()
    sent.length = 0
    destroyedSend.mockReset()
  })

  it('registers the exact four channels even when the backend is unavailable', async () => {
    registerNotebookEnvIpcHandlers(createLifecycle(undefined))

    expect([...registered.keys()].sort()).toEqual([
      'notebook-env:cancel',
      'notebook-env:provision',
      'notebook-env:repair',
      'notebook-env:status'
    ])
    await expect(registered.get('notebook-env:status')?.({})).resolves.toMatchObject({
      pythonReady: false,
      rReady: false,
      provisioning: false
    })
    await expect(registered.get('notebook-env:provision')?.({}, 'python')).rejects.toThrow(
      /micromamba/i
    )
  })

  it('rejects an unknown provision language instead of installing Python', async () => {
    const provisioner = fakeProvisioner()
    registerNotebookEnvIpcHandlers(createLifecycle(provisioner))

    await expect(registered.get('notebook-env:provision')?.({}, 'julia')).rejects.toThrow(
      /python or r/i
    )
    expect(provisioner.provisionPython).not.toHaveBeenCalled()
    expect(provisioner.provisionR).not.toHaveBeenCalled()
  })

  it('rejects an unknown repair language instead of rebuilding Python', async () => {
    const provisioner = fakeProvisioner()
    registerNotebookEnvIpcHandlers(createLifecycle(provisioner))

    await expect(registered.get('notebook-env:repair')?.({}, 'julia')).rejects.toThrow(
      /python or r/i
    )
    expect(provisioner.repair).not.toHaveBeenCalled()
  })

  it('projects scoped progress only through live Electron BrowserWindows', async () => {
    const provisioner = fakeProvisioner({
      provisionR: vi.fn().mockImplementation(async (report) => {
        report({ phase: 'fetch-r', event: { code: 'downloading-r-runtime' }, progress: 0.4 })
      }),
      repair: vi.fn().mockImplementation(async (_language, report) => {
        report({
          phase: 'create-python',
          event: { code: 'repairing-package-cache', environment: 'default-python' },
          progress: 0.2
        })
      })
    })
    registerNotebookEnvIpcHandlers(createLifecycle(provisioner))

    await registered.get('notebook-env:provision')?.({}, 'r', 'provision-operation')
    await registered.get('notebook-env:repair')?.(
      {},
      'python',
      'default-python',
      'repair-operation'
    )

    expect(sent).toEqual([
      {
        channel: 'notebook-env:progress',
        progress: {
          phase: 'fetch-r',
          event: { code: 'downloading-r-runtime' },
          progress: 0.4,
          scope: 'r',
          operationId: 'provision-operation'
        }
      },
      {
        channel: 'notebook-env:progress',
        progress: {
          phase: 'create-python',
          event: { code: 'repairing-package-cache', environment: 'default-python' },
          progress: 0.2,
          scope: 'python',
          operationId: 'repair-operation'
        }
      }
    ])
    expect(destroyedSend).not.toHaveBeenCalled()
  })

  it('forwards cancel synchronously and starts maintenance after registration', async () => {
    let settleProvision!: () => void
    const provisioner = fakeProvisioner({
      provisionR: vi.fn().mockReturnValue(
        new Promise<void>((resolve) => {
          settleProvision = resolve
        })
      )
    })

    const lifecycle = createLifecycle(provisioner)
    registerNotebookEnvIpcHandlers(lifecycle)
    expect(provisioner.restoreRelocatedEnvs).not.toHaveBeenCalled()
    void lifecycle.startup()
    const operation = registered.get('notebook-env:provision')?.({}, 'r') as Promise<void>
    registered.get('notebook-env:cancel')?.({}, 'r')

    expect(provisioner.cancel).toHaveBeenCalledWith('r')
    await vi.waitFor(() => expect(provisioner.restoreRelocatedEnvs).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(provisioner.provisionR).toHaveBeenCalledOnce())
    settleProvision()
    await operation
  })
})
