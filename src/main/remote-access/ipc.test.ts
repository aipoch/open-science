import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

import {
  canManagePairing,
  isDesktopCaller,
  registerRemoteAccessIpcHandlers,
  requireDesktopCaller,
  requirePairingManager
} from './ipc'
import { createElectronCallerContext, createWebCallerContext } from '../caller-context'
import { webRpc } from '../ipc-handler-registry'

describe('remote access IPC authorization', () => {
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

  it('registers remote access handlers with the Web RPC router', async () => {
    const snapshot = vi.fn(() => ({ mode: 'off' }))
    registerRemoteAccessIpcHandlers({ snapshot } as never)

    expect(webRpc.channels()).toEqual(
      expect.arrayContaining([
        'remote-access:approve',
        'remote-access:detect',
        'remote-access:disable',
        'remote-access:get-snapshot',
        'remote-access:reject',
        'remote-access:revoke-browser',
        'remote-access:set-mode'
      ])
    )
    await expect(
      webRpc.invoke('remote-access:get-snapshot', createWebCallerContext('browser-1'), [])
    ).resolves.toEqual({ mode: 'off' })
    expect(snapshot).toHaveBeenCalledWith(false, false)
  })

  it('allows a real Electron WebContents sender', () => {
    const context = createElectronCallerContext(7)
    expect(isDesktopCaller(context)).toBe(true)
    expect(canManagePairing(context)).toBe(true)
    expect(() => requireDesktopCaller(context)).not.toThrow()
    expect(() => requirePairingManager(context)).not.toThrow()
  })

  it('rejects the synthetic negative sender used by every Web RPC client', () => {
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
})
