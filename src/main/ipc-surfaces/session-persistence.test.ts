import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

const native = vi.hoisted(() => ({
  handlers: new Map<string, Parameters<IpcMain['handle']>[1]>(),
  failAt: undefined as string | undefined,
  openPath: vi.fn(),
  send: vi.fn(),
  warn: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Parameters<IpcMain['handle']>[1]) => {
      if (native.failAt === channel) throw new Error(`install failed: ${channel}`)
      if (native.handlers.has(channel)) throw new Error(`duplicate channel: ${channel}`)
      native.handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => native.handlers.delete(channel)
  },
  shell: { openPath: native.openPath },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: native.send } }]
  }
}))
vi.mock('../logger', async (importOriginal) => {
  const original = await importOriginal<typeof import('../logger')>()
  return {
    ...original,
    createLogger: () => ({ ...original.createLogger('test'), warn: native.warn })
  }
})

import { disposeIpcHandlerRegistry, ipcMainHandle } from '../ipc-handler-registry'
import { LIFECYCLE_CHANNELS } from '../../shared/lifecycle-events'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { createSessionPersistenceElectronSurface } from './session-persistence'

type Owners = Parameters<typeof createSessionPersistenceElectronSurface>[0]
const session: PersistedChatSession = {
  id: 'session',
  projectId: 'project',
  title: 'Session',
  cwd: resolve('workspace'),
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 2
}
const fixture = (): {
  owners: Owners
  durable: PersistedChatSession
  saveSession: Mock<Owners['sessionPersistenceHandlers']['saveSession']>
  afterSessionSaved: Mock<Owners['sessionDetailsOwner']['afterSessionSaved']>
  wakeMessages: Mock<NonNullable<Owners['delegatedWork']['root']['wakeMessages']>>
  recoveryFolderPath: Mock<Owners['sessionRepository']['recoveryFolderPath']>
} => {
  const durable = { ...session, title: 'Durable title' }
  const saveSession = vi.fn(async () => ({ created: false, session: durable }))
  const afterSessionSaved = vi.fn()
  const wakeMessages = vi.fn<NonNullable<Owners['delegatedWork']['root']['wakeMessages']>>(
    async () => undefined
  )
  const recoveryFolderPath = vi.fn(() => resolve('project', 'recovery'))
  const owners = {
    sessionPersistenceBackend: {},
    reviewRepository: {},
    sessionPersistenceHandlers: { saveSession },
    sessionDetailsOwner: { afterSessionSaved },
    delegatedWork: { root: { wakeMessages } },
    sessionRepository: { recoveryFolderPath }
  } as unknown as Owners
  return { owners, durable, saveSession, afterSessionSaved, wakeMessages, recoveryFolderPath }
}
let event: IpcMainInvokeEvent
const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  const handler = native.handlers.get(channel)
  if (!handler) throw new Error(`missing channel: ${channel}`)
  return handler(event, ...args)
}
const channels = [
  'sessions:load-all',
  'sessions:list',
  'sessions:load-usage',
  'sessions:search-messages',
  'sessions:load-one',
  'sessions:save-session',
  'sessions:save-manifest',
  'sessions:open-recovery-folder'
]
beforeEach(() => {
  vi.clearAllMocks()
  native.failAt = undefined
  native.openPath.mockResolvedValue('')
  event = {
    sender: Object.assign(new EventEmitter(), { id: 2801, isDestroyed: () => false })
  } as unknown as IpcMainInvokeEvent
})
afterEach(() => {
  disposeIpcHandlerRegistry()
  expect(native.handlers.size).toBe(0)
})

describe('Session persistence Electron surface', () => {
  it('installs lazily and idempotently removes only its own channels', async () => {
    const f = fixture()
    const surface = createSessionPersistenceElectronSurface(f.owners)
    expect(surface.name).toBe('session-persistence')
    expect(native.handlers.size).toBe(0)
    ipcMainHandle('test:external', () => 'external')
    const installed = await surface.install()
    expect([...native.handlers.keys()]).toEqual(['test:external', ...channels])
    await installed?.uninstall()
    await installed?.uninstall()
    expect([...native.handlers.keys()]).toEqual(['test:external'])
    expect(f.saveSession).not.toHaveBeenCalled()
    expect(await invoke('test:external')).toBe('external')
  })

  it.each(['sessions:save-session', 'sessions:open-recovery-folder'])(
    'rolls back partial registration failure at %s without touching unrelated channels',
    async (channel) => {
      ipcMainHandle('test:external', () => 'external')
      native.failAt = channel
      const surface = createSessionPersistenceElectronSurface(fixture().owners)
      expect(() => surface.install()).toThrow(`install failed: ${channel}`)
      expect([...native.handlers.keys()]).toEqual(['test:external'])
      native.failAt = undefined
      const installed = await surface.install()
      expect([...native.handlers.keys()]).toEqual(['test:external', ...channels])
      await installed?.uninstall()
    }
  )

  it('notifies details with the durable result before waking messages without waiting for wake', async () => {
    const f = fixture()
    const pending = Promise.withResolvers<void>()
    f.wakeMessages.mockImplementation(() => pending.promise)
    await createSessionPersistenceElectronSurface(f.owners).install()
    expect(await invoke('sessions:save-session', session)).toEqual({ ok: true, result: f.durable })
    expect(f.saveSession).toHaveBeenCalledWith(session)
    expect(native.send).toHaveBeenCalledWith(LIFECYCLE_CHANNELS.sessionUpdated, {
      session: f.durable,
      originClientId: 'electron:2801'
    })
    expect(f.afterSessionSaved).toHaveBeenCalledWith(f.durable)
    expect(f.wakeMessages).toHaveBeenCalledWith(f.durable.id)
    expect(native.send.mock.invocationCallOrder[0]).toBeLessThan(
      f.afterSessionSaved.mock.invocationCallOrder[0]
    )
    expect(f.afterSessionSaved.mock.invocationCallOrder[0]).toBeLessThan(
      f.wakeMessages.mock.invocationCallOrder[0]
    )
    pending.resolve()
  })

  it('keeps a successful durable save successful when message wake fails and logs the failure', async () => {
    const f = fixture()
    f.wakeMessages.mockRejectedValue(new Error('wake failed'))
    await createSessionPersistenceElectronSurface(f.owners).install()
    expect(await invoke('sessions:save-session', session)).toEqual({ ok: true, result: f.durable })
    expect(native.warn).toHaveBeenCalledWith('message wake after Session activation failed', {
      errorCategory: 'error'
    })
  })

  it('keeps message wake optional and does not notify after a failed save', async () => {
    const f = fixture()
    f.owners.delegatedWork.root = {}
    await createSessionPersistenceElectronSurface(f.owners).install()
    expect(await invoke('sessions:save-session', session)).toEqual({ ok: true, result: f.durable })
    expect(f.afterSessionSaved).toHaveBeenCalledOnce()
    f.saveSession.mockRejectedValue(new Error('save failed'))
    await expect(invoke('sessions:save-session', session)).rejects.toThrow('save failed')
    expect(f.afterSessionSaved).toHaveBeenCalledOnce()
    expect(f.wakeMessages).not.toHaveBeenCalled()
  })

  it.each(['', 'native failure'])(
    'opens the repository recovery path and preserves native result handling (%s)',
    async (error) => {
      const f = fixture()
      native.openPath.mockResolvedValue(error)
      await createSessionPersistenceElectronSurface(f.owners).install()
      const result = invoke('sessions:open-recovery-folder', { projectId: 'project' })
      if (error)
        await expect(result).rejects.toThrow('Session recovery folder could not be opened.')
      else await expect(result).resolves.toBeUndefined()
      expect(f.recoveryFolderPath).toHaveBeenCalledWith('project')
      expect(native.openPath).toHaveBeenCalledWith(resolve('project', 'recovery'))
    }
  )
})
