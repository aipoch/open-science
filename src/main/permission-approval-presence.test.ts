import { describe, expect, it } from 'vitest'

import { PermissionApprovalPresence } from './permission-approval-presence'

describe('PermissionApprovalPresence', () => {
  it('tracks approval clients with idempotent releases', () => {
    const presence = new PermissionApprovalPresence()
    const releaseFirst = presence.acquire()
    const releaseSecond = presence.acquire()

    expect(presence.isAvailable()).toBe(true)
    releaseFirst()
    releaseFirst()
    expect(presence.isAvailable()).toBe(true)
    releaseSecond()
    expect(presence.isAvailable()).toBe(false)
  })
})
