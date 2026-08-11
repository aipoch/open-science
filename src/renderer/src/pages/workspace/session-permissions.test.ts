import type { AcpPermissionRequest } from '../../../../shared/acp'
import { describe, expect, it } from 'vitest'

import {
  getVisiblePermissionRequests,
  hasBlockingRootPermissionRequest
} from './session-permissions'
import { createLinearConversationGraph } from '../../../../shared/conversation-graph'

// Creates a permission request with ids derived from the target session.
const createPermissionRequest = (sessionId: string): AcpPermissionRequest => ({
  requestId: `permission-${sessionId}`,
  sessionId,
  toolCallId: `tool-${sessionId}`,
  title: `Permission for ${sessionId}`,
  options: []
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

  it('hides a delegated permission whose child origin left the active root Branch', () => {
    const rootMessage = {
      id: 'root-message',
      role: 'user' as const,
      content: 'active',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [rootMessage],
      frameworkId: 'codex',
      createdAt: 1,
      updatedAt: 1
    })
    graph.frames.push({
      id: 'child-frame',
      parentFrameId: graph.rootFrameId,
      originMessageId: 'inactive-message',
      originBindingState: 'validated',
      kind: 'delegate',
      status: 'running',
      activeBranchId: 'child-branch',
      createdAt: 2
    })
    const permission: AcpPermissionRequest = {
      ...createPermissionRequest('session-1'),
      delegated: {
        frameId: 'child-frame',
        attemptId: 'attempt-1',
        childTitle: 'child',
        riskScope: 'This call only'
      }
    }

    expect(getVisiblePermissionRequests([permission], 'session-1', graph)).toEqual([])
    graph.frames[1].originMessageId = 'root-message'
    expect(getVisiblePermissionRequests([permission], 'session-1', graph)).toEqual([permission])
  })

  it('does not let a hidden delegated permission block a new Turn', () => {
    const delegated = {
      ...createPermissionRequest('session-1'),
      delegated: {
        frameId: 'inactive-child',
        attemptId: 'attempt-1',
        childTitle: 'child',
        riskScope: 'This call only'
      }
    }
    expect(hasBlockingRootPermissionRequest([delegated], 'session-1')).toBe(false)
    expect(
      hasBlockingRootPermissionRequest([createPermissionRequest('session-1')], 'session-1')
    ).toBe(true)
  })
})
