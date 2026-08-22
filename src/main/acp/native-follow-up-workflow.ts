import { randomUUID } from 'node:crypto'

import type { ClientConnection } from '@agentclientprotocol/sdk'
import { createLogger } from '../logger'

import type {
  AcpSteerFollowUpRefuseReason,
  AcpSteerFollowUpRequest,
  AcpSteerFollowUpResult
} from '../../shared/acp'
import type { AgentFrameworkId } from '../../shared/settings'
import type { AcpOpenCodeUsageApi } from './backend-generation-owner'
import type { AcpConnectionCapabilities } from './connection-resource-owner'
import {
  ACP_STEERING_METHOD,
  OPENCODE_HTTP_STEER_TIMEOUT_MS,
  buildAcpSteeringParams,
  buildOpenCodeHttpSteerBody,
  interpretSteerOutcome,
  openCodeHttpSteerPath,
  parseSteerOutcome,
  resolveNativeFollowUpRoute,
  type NativeFollowUpTransport
} from './native-follow-up'

type NativeFollowUpWorkflowOptions = Readonly<{
  connection: () => ClientConnection | undefined
  capabilities: () => AcpConnectionCapabilities
  frameworkId: () => AgentFrameworkId
  openCodeUsageApi: () => AcpOpenCodeUsageApi | undefined
  activeProviderSessionId: (appSessionId: string) => string | undefined
  hasLivePrompt: (appSessionId: string) => boolean
  sessionCwd: (appSessionId: string) => string | undefined
  publishUserMessage: (input: { sessionId: string; messageId: string; text: string }) => void
  createMessageId?: () => string
  fetchImpl?: typeof fetch
}>

const log = createLogger('acp')

const refused = (reason: AcpSteerFollowUpRefuseReason): AcpSteerFollowUpResult =>
  Object.freeze({ injected: false, reason })

const injected = (transport: NativeFollowUpTransport, messageId: string): AcpSteerFollowUpResult =>
  Object.freeze({ injected: true, transport, messageId })

class AcpNativeFollowUpWorkflow {
  constructor(private readonly options: NativeFollowUpWorkflowOptions) {}

  async steerFollowUp(request: AcpSteerFollowUpRequest): Promise<AcpSteerFollowUpResult> {
    const text = request.text.trim()
    const openCodeUsageApi = this.options.openCodeUsageApi()
    const route = resolveNativeFollowUpRoute({
      advertisedSteering: this.options.capabilities().steering,
      hasLivePrompt: this.options.hasLivePrompt(request.sessionId),
      frameworkId: this.options.frameworkId(),
      hasOpenCodeHttp: Boolean(openCodeUsageApi),
      text
    })
    if (route.transport === 'unsupported') {
      log.info('native follow-up refused', {
        sessionId: request.sessionId,
        reason: route.reason,
        advertisedSteering: this.options.capabilities().steering,
        frameworkId: this.options.frameworkId()
      })
      return refused(route.reason)
    }

    const connection = this.options.connection()
    const providerSessionId = this.options.activeProviderSessionId(request.sessionId)
    if (!connection || !providerSessionId) {
      log.info('native follow-up refused', {
        sessionId: request.sessionId,
        reason: 'no-live-turn',
        transport: route.transport
      })
      return refused('no-live-turn')
    }

    if (route.transport === 'acp-steering') {
      let result: unknown
      try {
        result = await connection.agent.request(
          ACP_STEERING_METHOD,
          buildAcpSteeringParams(providerSessionId, text)
        )
      } catch {
        log.info('native follow-up refused', {
          sessionId: request.sessionId,
          reason: 'dispatch-failed',
          transport: route.transport
        })
        return refused('dispatch-failed')
      }
      const dispatched = interpretSteerOutcome(parseSteerOutcome(result))
      if (dispatched.kind !== 'injected') {
        log.info('native follow-up refused', {
          sessionId: request.sessionId,
          reason: dispatched.reason,
          transport: route.transport
        })
        return refused(dispatched.reason)
      }
    } else {
      if (!openCodeUsageApi) {
        log.info('native follow-up refused', {
          sessionId: request.sessionId,
          reason: 'not-advertised',
          transport: route.transport
        })
        return refused('not-advertised')
      }
      const accepted = await this.postOpenCodeSteer(
        openCodeUsageApi,
        providerSessionId,
        text,
        this.options.sessionCwd(request.sessionId)
      )
      if (!accepted) {
        log.info('native follow-up refused', {
          sessionId: request.sessionId,
          reason: 'dispatch-failed',
          transport: route.transport
        })
        return refused('dispatch-failed')
      }
    }

    const messageId = this.options.createMessageId?.() ?? `message-${randomUUID()}`
    this.options.publishUserMessage({
      sessionId: request.sessionId,
      messageId,
      text
    })
    log.info('native follow-up injected', {
      sessionId: request.sessionId,
      transport: route.transport,
      messageId
    })
    return injected(route.transport, messageId)
  }

  private async postOpenCodeSteer(
    api: AcpOpenCodeUsageApi,
    providerSessionId: string,
    text: string,
    cwd: string | undefined
  ): Promise<boolean> {
    const fetchImpl = this.options.fetchImpl ?? fetch
    try {
      const base = api.baseUrl.endsWith('/') ? api.baseUrl : `${api.baseUrl}/`
      const url = new URL(openCodeHttpSteerPath(providerSessionId).replace(/^\//, ''), base)
      if (cwd) url.searchParams.set('directory', cwd)
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: api.authorization,
          'content-type': 'application/json'
        },
        body: JSON.stringify(buildOpenCodeHttpSteerBody(text)),
        signal: AbortSignal.timeout(OPENCODE_HTTP_STEER_TIMEOUT_MS)
      })
      return response.ok
    } catch {
      return false
    }
  }
}

export { AcpNativeFollowUpWorkflow }
export type { NativeFollowUpWorkflowOptions }
