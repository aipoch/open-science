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
