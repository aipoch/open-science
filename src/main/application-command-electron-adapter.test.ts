import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ApplicationCommandError } from '../shared/application-command-contract'
import type { ApplicationCommandByNameDispatcher } from './application-command-composition'
import type { ApplicationCallerLease } from './application-command-router'
import { bindCallerLeaseToEvent } from './caller-lifecycle'

const { handlers, warn } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  warn: vi.fn()
}))

vi.mock('./ipc-handler-registry', () => ({
  ipcMainHandle: (channel: string, handler: (...args: unknown[]) => unknown) => {
    handlers.set(channel, handler)
  }
}))
import { registerApplicationCommandElectronAdapter } from './application-command-electron-adapter'

const validatedChannels = [
  'acp:respond-elicitation',
  'acp:respond-permission',
  'acp:respond-plan',
  'memory:clear-all',
  'memory:create-category',
  'memory:create-entry',
  'memory:delete-category',
  'memory:delete-entry',
  'memory:set-enabled',
  'memory:snapshot',
  'memory:update-category',
  'memory:update-entry',
  'projects:create',
  'projects:delete',
  'projects:get',
  'projects:list',
  'projects:list-deletion-cleanup',
  'projects:retry-deletion-cleanup',
  'projects:update',
  'projects:update-archive',
  'sessions:delete-session',
  'sessions:edit-details',
  'sessions:filter-pdf-context-candidates',
  'sessions:link-pdf-context',
  'sessions:set-delegation-policy',
  'sessions:unlink-pdf-context',
  'sessions:update-archive',
  'tags:create',
  'tags:delete',
  'tags:reorder',
  'tags:set-assignment',
  'tags:snapshot',
  'tags:update',
  'uploads:finalize-session'
] as const

const eventWithLease = (): IpcMainInvokeEvent => {
  const event = { sender: { id: 7 } } as unknown as IpcMainInvokeEvent
  const lease: ApplicationCallerLease = Object.freeze({
    leaseId: 'electron:7',
    generation: 1,
    signal: new AbortController().signal,
    isCurrent: () => true
  })
  bindCallerLeaseToEvent(event, lease)
  return event
}

const dispatcher = (
  invoke: ApplicationCommandByNameDispatcher['invoke']
): ApplicationCommandByNameDispatcher => ({
  commandNames: () => validatedChannels,
  invoke
})

beforeEach(() => {
  handlers.clear()
  warn.mockClear()
})

describe('Electron Application Command adapter', () => {
  it('installs the catalog-selected validated slice with caller context and lease', async () => {
    const result = [{ id: 'project-1' }]
    const invoke = vi.fn().mockResolvedValue(result)
    registerApplicationCommandElectronAdapter(dispatcher(invoke), { warn })
    const event = eventWithLease()

    await expect(handlers.get('projects:list')?.(event)).resolves.toEqual({ ok: true, result })
    expect([...handlers.keys()]).toEqual(validatedChannels)
    expect(invoke).toHaveBeenCalledWith(
      'projects:list',
      expect.objectContaining({
        args: [],
        callerContext: expect.objectContaining({
          clientId: '7',
          surface: 'electron',
          location: 'local'
        }),
        callerLease: expect.objectContaining({ leaseId: 'electron:7' })
      })
    )
  })

  it('returns the public error envelope after recording rejection diagnostics', async () => {
    const invoke = vi
      .fn()
      .mockRejectedValue(
        new ApplicationCommandError('invalid-command-arguments', 'Invalid project request.')
      )
    registerApplicationCommandElectronAdapter(dispatcher(invoke), { warn })

    await expect(
      handlers.get('projects:create')?.(eventWithLease(), { name: 42 })
    ).resolves.toEqual({
      ok: false,
      error: { code: 'invalid-command-arguments', message: 'Invalid project request.' }
    })
    expect(warn).toHaveBeenCalledWith(
      'ipc handler rejected',
      expect.objectContaining({ channel: 'projects:create', surface: 'electron' })
    )
  })

  it('fails before registration when dispatcher and catalog inventories diverge', () => {
    expect(() =>
      registerApplicationCommandElectronAdapter({
        commandNames: () => ['projects:list'],
        invoke: vi.fn()
      })
    ).toThrow('Electron Application Command adapter inventory mismatch.')
    expect(handlers).toEqual(new Map())
  })
})
