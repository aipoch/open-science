import type { AcpPermissionRequest } from '../../../../shared/acp'
import { describe, expect, it } from 'vitest'

import { getVisiblePermissionRequests } from './session-permissions'

// Creates a permission request with ids derived from the target session.
const createPermissionRequest = (sessionId: string): AcpPermissionRequest => ({
  requestId: `permission-${sessionId}`,
  sessionId,
  toolCallId: `tool-${sessionId}`,
  title: `Permission for ${sessionId}`,
  options: [],
  raw: {}
})

describe('workspace session permissions', () => {
  it('returns only permission requests for the active session', () => {
    const visibleRequests = getVisiblePermissionRequests(
      [createPermissionRequest('session-1'), createPermissionRequest('session-2')],
      'session-2'
    )

    expect(visibleRequests.map((request) => request.sessionId)).toEqual(['session-2'])
  })

  it('returns no visible permissions when no session is active', () => {
    expect(getVisiblePermissionRequests([createPermissionRequest('session-1')], undefined)).toEqual(
      []
    )
  })
})
