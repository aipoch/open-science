import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<
  string,
  (event: { sender: { id: number } }, request?: unknown) => unknown
>()

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../ipc-handler-registry', () => ({
  ipcMainHandle: (
    channel: string,
    handler: (event: { sender: { id: number } }, request?: unknown) => unknown
  ) => handlers.set(channel, handler)
}))

import {
  canManagePairing,
  isDesktopCaller,
  registerRemoteAccessIpcHandlers,
  requireDesktopCaller,
  requirePairingManager
} from './ipc'
import { createElectronCallerContext, createWebCallerContext } from '../caller-context'
import type { RemoteAccessService } from './service'

describe('remote access IPC authorization', () => {
  beforeEach(() => handlers.clear())

  it.each([
    ['Electron desktop', createElectronCallerContext(7), true],
    ['local Web', createWebCallerContext('local-browser'), false],
    [
      'ordinary remote Web',
      createWebCallerContext('remote-browser', { location: 'remote' }),
      false
    ],
    [
      'current remote pairing manager',
      createWebCallerContext('pairing-manager', {
        location: 'remote',
        authorities: ['manage-remote-pairing']
      }),
      true
    ],
    [
      'stale remote pairing manager',
      createWebCallerContext('stale-manager', {
        location: 'remote',
        authorities: ['manage-remote-pairing'],
        isAuthorizationCurrent: () => false
      }),
      false
    ]
  ])('keeps the %s pairing-management decision', (_name, context, expected) => {
    expect(canManagePairing(context)).toBe(expected)
  })

  it('allows a real Electron WebContents sender', () => {
    const context = createElectronCallerContext(7)
    expect(isDesktopCaller(context)).toBe(true)
    expect(canManagePairing(context)).toBe(true)
    expect(() => requireDesktopCaller(context)).not.toThrow()
    expect(() => requirePairingManager(context)).not.toThrow()
  })

  it('rejects an ordinary remote Web caller', () => {
    const context = createWebCallerContext('browser-1', { location: 'remote' })
    expect(isDesktopCaller(context)).toBe(false)
    expect(canManagePairing(context)).toBe(false)
    expect(() => requireDesktopCaller(context)).toThrow(
      'must be approved from the Open Science desktop app'
    )
    expect(() => requirePairingManager(context)).toThrow('approved browser')
  })

  it('allows an approved Web browser to manage pairing only', () => {
    const context = createWebCallerContext('browser-1', {
      location: 'remote',
      authorities: ['manage-remote-pairing']
    })
    expect(isDesktopCaller(context)).toBe(false)
    expect(canManagePairing(context)).toBe(true)
    expect(() => requireDesktopCaller(context)).toThrow()
    expect(() => requirePairingManager(context)).not.toThrow()
  })

  it('rejects malformed payloads before entering the service', async () => {
    const service = {
      approve: vi.fn(),
      detect: vi.fn(),
      probe: vi.fn(),
      disable: vi.fn(),
      snapshot: vi.fn(),
      reject: vi.fn(),
      revoke: vi.fn(),
      setMode: vi.fn()
    }
    registerRemoteAccessIpcHandlers(service as unknown as RemoteAccessService)
    const event = { sender: { id: 7 } }
    const cases: Array<readonly [string, unknown]> = [
      ['remote-access:get-snapshot', { unexpected: true }],
      ['remote-access:detect', { unexpected: true }],
      ['remote-access:probe', { unexpected: true }],
      ['remote-access:disable', { unexpected: true }],
      ['remote-access:approve', undefined],
      ['remote-access:reject', undefined],
      ['remote-access:revoke-browser', undefined],
      ['remote-access:set-mode', { mode: 'invalid' }]
    ]

    for (const [channel, payload] of cases) {
      await expect(
        Promise.resolve().then(() => handlers.get(channel)?.(event, payload))
      ).rejects.toThrow()
    }

    expect(service.approve).not.toHaveBeenCalled()
    expect(service.detect).not.toHaveBeenCalled()
    expect(service.probe).not.toHaveBeenCalled()
    expect(service.disable).not.toHaveBeenCalled()
    expect(service.snapshot).not.toHaveBeenCalled()
    expect(service.reject).not.toHaveBeenCalled()
    expect(service.revoke).not.toHaveBeenCalled()
    expect(service.setMode).not.toHaveBeenCalled()
  })
})
