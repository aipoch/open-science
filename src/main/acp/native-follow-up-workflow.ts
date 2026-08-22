import type { ClientConnection, ContentBlock } from '@agentclientprotocol/sdk'
import { randomUUID } from 'node:crypto'

import { createLogger } from '../logger'

import type {
  AcpSteerFollowUpRefuseReason,
  AcpSteerFollowUpRequest,
  AcpSteerFollowUpResult
} from '../../shared/acp'
import type { MessagePart } from '../../shared/session-persistence'
import type { AgentFrameworkId } from '../../shared/settings'
import { toPersistedUploadedAttachment, type PersistedUploadedAttachment } from '../../shared/uploads'
import type { AcpOpenCodeUsageApi } from './backend-generation-owner'
import type { AcpConnectionCapabilities } from './connection-resource-owner'
import {
  ACP_STEERING_METHOD,
  OPENCODE_HTTP_STEER_TIMEOUT_MS,
  buildAcpSteeringParams,
  buildOpenCodeHttpFollowUpBody,
  contentBlocksToOpenCodeFollowUpParts,
  firstOpenCodeFollowUpText,
  interpretSteerOutcome,
  openCodeHttpFollowUpPath,
  parseOpenCodeHttpFollowUp,
  parseSteerOutcome,
  resolveNativeFollowUpRoute,
  steeringPromptFromText,
  type NativeFollowUpTransport,
  type OpenCodeHttpFollowUpPart
} from './native-follow-up'

type NativeFollowUpUserMessage = Readonly<{
  sessionId: string
  messageId: string
  text: string
  uploads?: readonly PersistedUploadedAttachment[]
  parts?: readonly MessagePart[]
}>

type NativeFollowUpWorkflowOptions = Readonly<{
  connection: () => ClientConnection | undefined
  capabilities: () => AcpConnectionCapabilities
  frameworkId: () => AgentFrameworkId
  openCodeUsageApi: () => AcpOpenCodeUsageApi | undefined
  activeProviderSessionId: (appSessionId: string) => string | undefined
  hasLivePrompt: (appSessionId: string) => boolean
  sessionCwd: (appSessionId: string) => string | undefined
  publishUserMessage: (input: NativeFollowUpUserMessage) => void
  prepareFollowUp?: (request: AcpSteerFollowUpRequest) => Promise<readonly ContentBlock[]>
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
    const text = typeof request.text === 'string' ? request.text : ''
    const attachments = request.attachments ?? []
    const forcedSkillIds = request.forcedSkillIds ?? []
    const openCodeUsageApi = this.options.openCodeUsageApi()
    const route = resolveNativeFollowUpRoute({
      advertisedSteering: this.options.capabilities().steering,
      hasLivePrompt: this.options.hasLivePrompt(request.sessionId),
      frameworkId: this.options.frameworkId(),
      hasOpenCodeHttp: Boolean(openCodeUsageApi),
      text,
      hasAttachments: attachments.length > 0 || (request.referencedArtifacts?.length ?? 0) > 0,
      hasForcedSkills: forcedSkillIds.length > 0
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

    let prompt: readonly ContentBlock[]
    try {
      prompt = this.options.prepareFollowUp
        ? await this.options.prepareFollowUp(request)
        : steeringPromptFromText(text)
    } catch {
      log.info('native follow-up refused', {
        sessionId: request.sessionId,
        reason: 'dispatch-failed',
        transport: route.transport
      })
      return refused('dispatch-failed')
    }
    if (prompt.length === 0) {
      log.info('native follow-up refused', {
        sessionId: request.sessionId,
        reason: 'empty-text',
        transport: route.transport
      })
      return refused('empty-text')
    }

    if (route.transport === 'acp-steering') {
      let result: unknown
      try {
        result = await connection.agent.request(
          ACP_STEERING_METHOD,
          buildAcpSteeringParams(providerSessionId, prompt)
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
      const parts = contentBlocksToOpenCodeFollowUpParts(prompt)
      if (parts.length === 0) {
        log.info('native follow-up refused', {
          sessionId: request.sessionId,
          reason: 'empty-text',
          transport: route.transport
        })
        return refused('empty-text')
      }
      const accepted = await this.postOpenCodeSteer(
        openCodeUsageApi,
        providerSessionId,
        parts,
        this.options.sessionCwd(request.sessionId)
      )
      if (!accepted) {
        log.info('native follow-up refused', {
          sessionId: request.sessionId,
          reason: 'dispatch-failed',
          transport: route.transport,
          providerSessionId
        })
        return refused('dispatch-failed')
      }
    }

    const messageId = this.options.createMessageId?.() ?? `message-${randomUUID()}`
    const uploads = attachments.map(toPersistedUploadedAttachment)
    const parts = request.parts ?? []
    this.options.publishUserMessage({
      sessionId: request.sessionId,
      messageId,
      text,
      ...(uploads.length > 0 ? { uploads } : {}),
      ...(parts.length > 0 ? { parts } : {})
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
    parts: readonly OpenCodeHttpFollowUpPart[],
    cwd: string | undefined
  ): Promise<boolean> {
    const fetchImpl = this.options.fetchImpl ?? fetch
    try {
      const base = api.baseUrl.endsWith('/') ? api.baseUrl : `${api.baseUrl}/`
      const url = new URL(openCodeHttpFollowUpPath(providerSessionId).replace(/^\//, ''), base)
      if (cwd) url.searchParams.set('directory', cwd)
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: api.authorization,
          'content-type': 'application/json'
        },
        body: JSON.stringify(buildOpenCodeHttpFollowUpBody(parts)),
        signal: AbortSignal.timeout(OPENCODE_HTTP_STEER_TIMEOUT_MS)
      })
      if (!response.ok) return false
      let result: unknown
      try {
        result = await response.json()
      } catch {
        return false
      }
      return parseOpenCodeHttpFollowUp(result, firstOpenCodeFollowUpText(parts))
    } catch {
      return false
    }
  }
}

export { AcpNativeFollowUpWorkflow }
export type { NativeFollowUpUserMessage, NativeFollowUpWorkflowOptions }
