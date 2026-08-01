import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

import {
  canManagePairing,
  isDesktopSender,
  registerRemoteAccessIpcHandlers,
  requireDesktopSender,
  requirePairingManager
} from './ipc'
import { createElectronCallerContext, createWebCallerContext } from '../caller-context'
import { webRpc } from '../ipc-handler-registry'

const eventWithSenderId = (id: number, remotePairingManager = false): IpcMainInvokeEvent =>
  ({
    sender: {
      id,
      callerContext:
        id > 0
          ? createElectronCallerContext(id)
          : createWebCallerContext(`browser-${Math.abs(id)}`, {
              location: 'remote',
              authorities: remotePairingManager ? ['manage-remote-pairing'] : []
            })
    }
  }) as unknown as IpcMainInvokeEvent

describe('remote access IPC authorization', () => {
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
    const event = eventWithSenderId(7)
    expect(isDesktopSender(event)).toBe(true)
    expect(canManagePairing(event)).toBe(true)
    expect(() => requireDesktopSender(event)).not.toThrow()
    expect(() => requirePairingManager(event)).not.toThrow()
  })

  it('rejects the synthetic negative sender used by every Web RPC client', () => {
    const event = eventWithSenderId(-1)
    expect(isDesktopSender(event)).toBe(false)
    expect(canManagePairing(event)).toBe(false)
    expect(() => requireDesktopSender(event)).toThrow(
      'must be approved from the Open Science desktop app'
    )
    expect(() => requirePairingManager(event)).toThrow('approved browser')
  })

  it('allows an approved Web browser to manage pairing only', () => {
    const event = eventWithSenderId(-1, true)
    expect(isDesktopSender(event)).toBe(false)
    expect(canManagePairing(event)).toBe(true)
    expect(() => requireDesktopSender(event)).toThrow()
    expect(() => requirePairingManager(event)).not.toThrow()
  })
})
