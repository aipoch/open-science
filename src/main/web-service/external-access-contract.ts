import type { IncomingMessage, ServerResponse } from 'node:http'

export type ExternalWebAccessAuthorization = {
  kind: 'authorized' | 'authorized-pairing-manager'
  principalId: string
  isCurrent: () => boolean
}

export type ExternalWebAccessDecision = ExternalWebAccessAuthorization | 'handled' | 'denied'

export type ExternalWebSocketAccess = {
  principalId: string
  isCurrent: () => boolean
}

export type ExternalWebAccess = {
  authorizeHttp: (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) => Promise<ExternalWebAccessDecision>
  authorizeWebSocket: (
    request: IncomingMessage,
    url: URL
  ) => Promise<ExternalWebSocketAccess | undefined>
}
