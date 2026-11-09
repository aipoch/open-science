import { describe, expect, it } from 'vitest'

import { remoteAccessSnapshotSchema } from './remote-access'

describe('remote access contracts', () => {
  it('publishes the persisted expiry of every trusted browser', () => {
    const snapshot = remoteAccessSnapshotSchema.parse({
      canManage: true,
      canManagePairing: true,
      mode: 'off',
      enabled: false,
      lifecycle: 'disabled',
      remoteIt: { installed: true, loggedIn: true, registered: true },
      pendingRequests: [],
      trustedBrowsers: [
        {
          id: 'trusted-browser',
          browser: 'Safari',
          platform: 'macOS',
          createdAt: 1,
          lastSeenAt: 2,
          expiresAt: 3
        }
      ]
    })

    expect(snapshot.trustedBrowsers[0].expiresAt).toBe(3)
  })

  it('accepts route details for trusted and temporary connected devices', () => {
    const device = {
      id: 'phone',
      browser: 'Safari',
      platform: 'iOS/iPadOS',
      createdAt: 1,
      lastSeenAt: 2,
      expiresAt: 3,
      route: 'lan',
      host: '192.168.91.94'
    }
    const snapshot = remoteAccessSnapshotSchema.parse({
      canManage: true,
      canManagePairing: true,
      mode: 'lan',
      enabled: true,
      lifecycle: 'running',
      remoteIt: { installed: false, loggedIn: false, registered: false },
      pendingRequests: [],
      trustedBrowsers: [device],
      connectedDevices: [device]
    })

    expect(snapshot.trustedBrowsers[0].route).toBe('lan')
    expect(snapshot.connectedDevices?.[0].host).toBe('192.168.91.94')
  })
})
