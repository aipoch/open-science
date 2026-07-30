import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

import {
  canManagePairing,
  isDesktopSender,
  requireDesktopSender,
  requirePairingManager
} from './ipc'

const eventWithSenderId = (id: number, remotePairingManager = false): IpcMainInvokeEvent =>
  ({
    sender: { id, canManageRemotePairing: remotePairingManager }
  }) as unknown as IpcMainInvokeEvent

describe('remote access IPC authorization', () => {
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
