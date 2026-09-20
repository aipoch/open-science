import { EventEmitter } from 'node:events'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  handlers: new Map<string, Parameters<IpcMain['handle']>[1]>(),
  failAt: undefined as string | undefined
}))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    ipcMain: Object.assign(new EventEmitter(), {
      handle: (channel: string, handler: Parameters<IpcMain['handle']>[1]) => {
        if (native.failAt === channel) throw new Error(`install failed: ${channel}`)
        if (native.handlers.has(channel)) throw new Error(`duplicate channel: ${channel}`)
        native.handlers.set(channel, handler)
      },
      removeHandler: (channel: string) => native.handlers.delete(channel)
    })
  }
})

import { ipcMain } from 'electron'
import { disposeIpcHandlerRegistry, ipcMainHandle } from '../ipc-handler-registry'
import { createElectronSurfaceAdapter } from '../ipc-surfaces/adapter'
import { registerOfficePreviewIpcHandlers } from './office-preview-ipc'

const fixture = (): {
  supervisor: {
    open: ReturnType<typeof vi.fn>
    attachFrame: ReturnType<typeof vi.fn>
    reportState: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    closeOwner: ReturnType<typeof vi.fn>
  }
  surface: ReturnType<typeof createElectronSurfaceAdapter>
} => {
  const supervisor = {
    open: vi.fn(async () => ({ kind: 'cancelled' as const })),
    attachFrame: vi.fn(),
    reportState: vi.fn(),
    close: vi.fn(async () => {}),
    closeOwner: vi.fn(async () => {})
  }
  return {
    supervisor,
    surface: createElectronSurfaceAdapter('office-preview', () =>
      registerOfficePreviewIpcHandlers(supervisor)
    )
  }
}
const emitState = (): void => {
  ipcMain.emit('office-preview:report-state', { sender: { id: 7 } }, 'session-1', {
    sessionId: 'session-1',
    phase: 'ready'
  })
}

afterEach(() => {
  disposeIpcHandlerRegistry()
  ipcMain.removeAllListeners()
  native.failAt = undefined
  expect(native.handlers.size).toBe(0)
})

describe('Office preview installation lifetime', () => {
  it('stops state delivery after uninstall and preserves unrelated listeners and handlers', async () => {
    const { surface, supervisor } = fixture()
    const external = vi.fn()
    ipcMain.on('office-preview:report-state', external)
    ipcMainHandle('test:external', () => undefined)
    const installation = await surface.install()
    emitState()
    expect(supervisor.reportState).toHaveBeenCalledOnce()
    supervisor.reportState.mockClear()
    await installation.uninstall()
    await installation.uninstall()
    emitState()
    expect(external).toHaveBeenCalledTimes(2)
    expect([...native.handlers.keys()]).toEqual(['test:external'])
    expect(supervisor.reportState).not.toHaveBeenCalled()
  })

  it('delivers each state once to only the current installation after reinstall', async () => {
    const old = fixture()
    const installation = await old.surface.install()
    await installation.uninstall()
    const current = fixture()
    const next = await current.surface.install()
    emitState()
    expect(current.supervisor.reportState).toHaveBeenCalledExactlyOnceWith(7, 'session-1', {
      sessionId: 'session-1',
      phase: 'ready'
    })
    expect(old.supervisor.reportState).not.toHaveBeenCalled()
    await next.uninstall()
  })

  it('rolls back the state listener when the final request handler fails to register', () => {
    const { surface, supervisor } = fixture()
    const external = vi.fn()
    ipcMain.on('office-preview:report-state', external)
    ipcMainHandle('test:external', () => undefined)
    native.failAt = 'office-preview:close'
    expect(() => surface.install()).toThrow('install failed: office-preview:close')
    expect([...native.handlers.keys()]).toEqual(['test:external'])
    emitState()
    expect(external).toHaveBeenCalledOnce()
    expect(supervisor.reportState).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'releases tracked owners once and detaches sender callbacks (release fails=%s)',
    async (releaseFails) => {
      const { surface, supervisor } = fixture()
      if (releaseFails) supervisor.closeOwner.mockRejectedValue(new Error('release failed'))
      const installation = await surface.install()
      const sender = Object.assign(new EventEmitter(), { id: 17 })
      const external = vi.fn()
      sender.on('did-start-navigation', external)
      await native.handlers.get('office-preview:open')!(
        { sender } as unknown as IpcMainInvokeEvent,
        {
          source: 'artifact',
          projectId: 'p',
          fileId: 'f',
          requestId: 'r',
          name: 'document.docx',
          extension: 'docx',
          attempt: 0
        }
      )
      await installation.uninstall()
      await installation.uninstall()
      expect(supervisor.closeOwner).toHaveBeenCalledExactlyOnceWith(17)
      supervisor.closeOwner.mockClear()
      sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
      sender.emit('render-process-gone')
      sender.emit('destroyed')
      expect(external).toHaveBeenCalledOnce()
      expect(supervisor.closeOwner).not.toHaveBeenCalled()
      expect(sender.listeners('did-start-navigation')).toEqual([external])
    }
  )
})
