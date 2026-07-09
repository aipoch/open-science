import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import { randomUUID } from 'node:crypto'

import type { AcpPermissionRequest, AcpPermissionResponse } from '../../shared/acp'

type PendingPermission = {
  request: AcpPermissionRequest
  resolve: (response: RequestPermissionResponse) => void
}

type EmitPermissionRequest = (request: AcpPermissionRequest) => void

// Tracks permission requests until the renderer chooses an outcome.
class AcpPermissionBroker {
  private pendingRequests = new Map<string, PendingPermission>()

  // Accepts the callback used to publish new permission requests to listeners.
  constructor(private readonly emitPermissionRequest: EmitPermissionRequest) {}

  // Returns serializable pending requests for runtime snapshots.
  getPendingRequests(): AcpPermissionRequest[] {
    return Array.from(this.pendingRequests.values(), ({ request }) => request)
  }

  // Stores a permission request and resolves it later from a renderer response.
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const requestId = randomUUID()
    const request: AcpPermissionRequest = {
      requestId,
      sessionId: params.sessionId,
      toolCallId: params.toolCall.toolCallId,
      title: params.toolCall.title ?? params.toolCall.toolCallId,
      status: params.toolCall.status ?? undefined,
      options: params.options.map((option) => ({
        optionId: option.optionId,
        name: option.name,
        kind: option.kind
      })),
      raw: params
    }

    // The returned promise is held open until the UI selects or cancels an option.
    return new Promise((resolve) => {
      this.pendingRequests.set(requestId, { request, resolve })
      this.emitPermissionRequest(request)
    })
  }

  // Resolves one pending request and reports whether it was found.
  respond(response: AcpPermissionResponse): boolean {
    const pending = this.pendingRequests.get(response.requestId)

    if (!pending) {
      return false
    }

    this.pendingRequests.delete(response.requestId)

    if (response.cancelled || !response.optionId) {
      pending.resolve({ outcome: { outcome: 'cancelled' } })
      return true
    }

    pending.resolve({
      outcome: {
        outcome: 'selected',
        optionId: response.optionId
      }
    })

    return true
  }

  // Cancels every pending request during full runtime teardown.
  cancelAll(): void {
    const pendingRequests = Array.from(this.pendingRequests.keys())

    for (const requestId of pendingRequests) {
      this.respond({ requestId, cancelled: true })
    }
  }

  // Cancels pending requests for one session while leaving other sessions intact.
  cancelForSession(sessionId: string): void {
    const pendingRequests = Array.from(this.pendingRequests.values())

    for (const { request } of pendingRequests) {
      if (request.sessionId === sessionId) {
        this.respond({ requestId: request.requestId, cancelled: true })
      }
    }
  }
}

export { AcpPermissionBroker }
