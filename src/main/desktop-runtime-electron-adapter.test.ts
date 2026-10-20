import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApplicationCommandError } from '../shared/application-command-contract'
import { ApplicationCallerLeaseRegistry, bindCallerLeaseToEvent } from './caller-lifecycle'
import { createElectronCallerContext } from './caller-context'
import { installDesktopRuntimeElectronAdapter } from './desktop-runtime-electron-adapter'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>()
}))
vi.mock('electron', async () => ({ ipcMain: new (await import('node:events')).EventEmitter() }))
vi.mock('./ipc-handler-registry', () => ({
  ipcMainHandle: (
    channel: string,
    handler: typeof handlers extends Map<string, infer H> ? H : never
  ) => handlers.set(channel, handler),
  createIpcHandlerInstallationScope: () => ({
    complete: (cleanup: () => void) => ({ uninstall: cleanup }),
    rollback: vi.fn()
  })
}))
beforeEach(() => {
  handlers.clear()
  ipcMain.removeAllListeners()
})

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function setup() {
  const client = {
    notificationAction: vi.fn(),
    notificationView: vi.fn(),
    commandNames: () => [
      'projects:list',
      'sessions:save-session',
      'notebook-env:cancel',
      'office-preview:report-state',
      'internal:never-renderer'
    ],
    invoke: vi.fn(async (_id: string, _channel: string, args: readonly unknown[]) => args),
    release: vi.fn(),
    close: vi.fn(),
    quit: vi.fn()
  }
  const mainFrame = {}
  const sender = { id: 7, mainFrame, isDestroyed: () => false }
  const registry = new ApplicationCallerLeaseRegistry()
  const lease = registry.acquire(createElectronCallerContext(7))
  const event = { sender, senderFrame: mainFrame } as IpcMainInvokeEvent
  bindCallerLeaseToEvent(event, lease.lease)
  const installed = installDesktopRuntimeElectronAdapter(client, (value) => value === event.sender)
  return { client, event, lease, registry, installed }
}

describe('Electron adapter for the Node runtime', () => {
  it('preserves preload envelopes and optional arguments without exposing private control commands', async () => {
    const value = setup()
    expect(handlers.has('internal:never-renderer')).toBe(false)
    await expect(handlers.get('projects:list')!(value.event)).resolves.toEqual({
      ok: true,
      result: []
    })
    await expect(
      handlers.get('sessions:save-session')!(value.event, { id: 'session' })
    ).resolves.toEqual({ ok: true, result: [{ id: 'session' }] })
    await expect(handlers.get('notebook-env:cancel')!(value.event, undefined)).resolves.toEqual([])
    expect(new Set(value.client.invoke.mock.calls.map(([id]) => id)).size).toBe(1)
    const id = value.client.invoke.mock.calls[0][0]
    value.lease.release()
    expect(value.client.release).toHaveBeenCalledExactlyOnceWith(id)
    expect(value.client.release).toHaveBeenCalledOnce()
    const replacement = value.registry.acquire(createElectronCallerContext(7))
    bindCallerLeaseToEvent(value.event, replacement.lease)
    await handlers.get('projects:list')!(value.event)
    expect(value.client.invoke.mock.calls.at(-1)![0]).not.toBe(id)
    replacement.release()
    value.installed.uninstall()
    expect(value.client.release).toHaveBeenCalledTimes(2)
  })

  it('resolves native operations only to the live document that issued a command', async () => {
    const value = setup()
    await handlers.get('projects:list')!(value.event)
    const id = value.client.invoke.mock.calls[0][0]
    expect(value.installed.documentFor(id)).toBe(value.event.sender)
    expect(value.installed.documentFor('not-a-document')).toBeUndefined()
    value.lease.release()
    expect(value.installed.documentFor(id)).toBeUndefined()
    value.installed.uninstall()
  })

  it('rejects guest frames and other WebContents before issuing a Node request', async () => {
    const value = setup()
    await expect(
      handlers.get('projects:list')!({ ...value.event, senderFrame: {} } as IpcMainInvokeEvent)
    ).resolves.toMatchObject({ ok: false })
    await expect(
      handlers.get('notebook-env:cancel')!({
        ...value.event,
        sender: { id: 9 }
      } as IpcMainInvokeEvent)
    ).rejects.toThrow('main application frame')
    expect(value.client.invoke).not.toHaveBeenCalled()
  })

  it('retains structured domain errors expected by preload', async () => {
    const value = setup()
    value.client.invoke.mockRejectedValueOnce(
      new ApplicationCommandError('session-revision-conflict', 'Conflict')
    )
    await expect(handlers.get('sessions:save-session')!(value.event, {})).resolves.toEqual({
      ok: false,
      error: { code: 'session-revision-conflict', message: 'Conflict' }
    })
    value.installed.uninstall()
    expect(value.client.release).toHaveBeenCalledOnce()
  })
})

it('forwards unbound native send events only for an already active document and revokes on navigation', async () => {
  const value = setup()
  const sendEvent = { ...value.event } // Real ipcMain.on receives a fresh, unbound event.
  const report = (): void => {
    ipcMain.emit('office-preview:report-state', sendEvent, 'preview', {
      sessionId: 'preview',
      phase: 'ready'
    })
  }
  report()
  expect(value.client.invoke).not.toHaveBeenCalled()
  await handlers.get('projects:list')!(value.event)
  const id = value.client.invoke.mock.calls[0][0]
  report()
  await vi.waitFor(() => expect(value.client.invoke).toHaveBeenCalledTimes(2))
  expect(value.client.invoke.mock.calls[1]).toEqual([
    id,
    'office-preview:report-state',
    ['preview', { sessionId: 'preview', phase: 'ready' }]
  ])
  value.lease.release()
  report()
  expect(value.client.invoke).toHaveBeenCalledTimes(2)
  value.installed.uninstall()
  expect(ipcMain.listenerCount('office-preview:report-state')).toBe(0)
})
