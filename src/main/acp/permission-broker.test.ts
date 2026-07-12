import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import { AcpPermissionBroker } from './permission-broker'

// Builds the serializable permission request shape used by broker tests.
const createPermissionRequest = (sessionId = 'session-1'): RequestPermissionRequest => ({
  sessionId,
  toolCall: {
    toolCallId: 'tool-1',
    title: 'Run command',
    status: 'pending'
  },
  options: [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }
  ]
})

// Builds a notebook tool permission request that also offers an "always allow" option.
const createNotebookPermissionRequest = (sessionId = 'session-1'): RequestPermissionRequest => ({
  sessionId,
  toolCall: {
    toolCallId: `tool-${Math.random()}`,
    title: 'mcp__open-science-notebook__notebook_execute',
    status: 'pending'
  },
  options: [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'allow-always', name: 'Always', kind: 'allow_always' },
    { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }
  ]
})

describe('ACP permission broker', () => {
  it('emits a serializable permission request and resolves the selected option', async () => {
    const emittedRequests: string[] = []
    const broker = new AcpPermissionBroker((request) => emittedRequests.push(request.requestId))

    const responsePromise = broker.requestPermission(createPermissionRequest())
    const [requestId] = emittedRequests

    broker.respond({ requestId, optionId: 'allow-once' })

    await expect(responsePromise).resolves.toEqual({
      outcome: {
        outcome: 'selected',
        optionId: 'allow-once'
      }
    })
  })

  it('resolves pending requests as cancelled when all permissions are cancelled', async () => {
    const broker = new AcpPermissionBroker(() => undefined)

    const responsePromise = broker.requestPermission(createPermissionRequest())

    broker.cancelAll()

    await expect(responsePromise).resolves.toEqual({
      outcome: {
        outcome: 'cancelled'
      }
    })
  })

  it('auto-approves later notebook calls after the user picks Always, without prompting again', async () => {
    const emittedRequests: string[] = []
    const broker = new AcpPermissionBroker((request) => emittedRequests.push(request.requestId))

    // First notebook request prompts; the user chooses the always-allow option.
    const firstResponse = broker.requestPermission(createNotebookPermissionRequest())
    expect(emittedRequests).toHaveLength(1)
    broker.respond({ requestId: emittedRequests[0], optionId: 'allow-always' })
    await expect(firstResponse).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-always' }
    })

    // A later same-session notebook call resolves immediately as allowed, emitting no new prompt.
    const secondResponse = broker.requestPermission(createNotebookPermissionRequest())

    await expect(secondResponse).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    })
    expect(emittedRequests).toHaveLength(1)
    expect(broker.getPendingRequests()).toHaveLength(0)
  })

  it('keeps prompting for notebook calls in other sessions and after allow-once', async () => {
    const emittedRequests: string[] = []
    const broker = new AcpPermissionBroker((request) => emittedRequests.push(request.requestId))

    // allow_once must NOT establish a standing always-allow.
    const onceResponse = broker.requestPermission(createNotebookPermissionRequest('session-1'))
    broker.respond({ requestId: emittedRequests[0], optionId: 'allow-once' })
    await onceResponse
    broker.requestPermission(createNotebookPermissionRequest('session-1'))
    expect(emittedRequests).toHaveLength(2)

    // Always in session-1 does not leak into session-2.
    broker.respond({ requestId: emittedRequests[1], optionId: 'allow-always' })
    broker.requestPermission(createNotebookPermissionRequest('session-2'))
    expect(emittedRequests).toHaveLength(3)
  })

  it('cancels only pending requests for the selected session', async () => {
    const broker = new AcpPermissionBroker(() => undefined)

    const firstResponsePromise = broker.requestPermission(createPermissionRequest('session-1'))
    const secondResponsePromise = broker.requestPermission(createPermissionRequest('session-2'))

    broker.cancelForSession('session-1')

    await expect(firstResponsePromise).resolves.toEqual({
      outcome: {
        outcome: 'cancelled'
      }
    })
    expect(broker.getPendingRequests().map((request) => request.sessionId)).toEqual(['session-2'])

    broker.cancelForSession('session-2')

    await expect(secondResponsePromise).resolves.toEqual({
      outcome: {
        outcome: 'cancelled'
      }
    })
  })
})
