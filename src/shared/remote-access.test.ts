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
})
