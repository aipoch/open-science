import type { ClientConnection, ContentBlock } from '@agentclientprotocol/sdk'
import { randomUUID } from 'node:crypto'

import { createLogger } from '../logger'

import type {
  AcpSteerFollowUpRefuseReason,
  AcpSteerFollowUpRequest,
  AcpSteerFollowUpResult
} from '../../shared/acp'
import type { FileReference } from '../../shared/artifacts'
import type { MessagePart } from '../../shared/session-persistence'
import type { AgentFrameworkId } from '../../shared/settings'
import {
  toPersistedUploadedAttachment,
  type PersistedUploadedAttachment,
  type UploadedAttachment
} from '../../shared/uploads'
import type { AcpOpenCodeUsageApi } from './backend-generation-owner'
import type { AcpConnectionCapabilities } from './connection-resource-owner'
import type { ImageInputCompatibilityOwner } from './image-input-compatibility-owner'
import type { VisionEvidenceSource } from './vision-evidence-repository'
import {
  ACP_STEERING_METHOD,
  ACP_STEERING_TIMEOUT_MS,
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

type NativeFollowUpNotebookTurnInputs = Readonly<{
  projectId: string
  sessionId: string
  livePromptMessageId: string
  uploads: readonly UploadedAttachment[]
  references: readonly FileReference[]
}>

type NativeFollowUpPreparedContent = Readonly<{
  prompt: readonly ContentBlock[]
  uploads?: readonly UploadedAttachment[]
  notebookTurnInputs?: NativeFollowUpNotebookTurnInputs
}>

type NativeFollowUpRegisterTurnInputs = (request: {
  projectId: string
  appSessionId: string
  promptMessageId: string
  uploads: UploadedAttachment[]
  references: FileReference[]
}) => Promise<void>

type NativeFollowUpLivePrompt = Readonly<{
  turnToken: string
  signal: AbortSignal
}>

type NativeFollowUpWorkflowOptions = Readonly<{
  connection: () => ClientConnection | undefined
  capabilities: () => AcpConnectionCapabilities
  frameworkId: () => AgentFrameworkId
  openCodeUsageApi: () => AcpOpenCodeUsageApi | undefined
  activeProviderSessionId: (appSessionId: string) => string | undefined
  hasLivePrompt: (appSessionId: string) => boolean
  hasPendingPermission: (appSessionId: string) => boolean
  livePrompt?: (appSessionId: string) => NativeFollowUpLivePrompt | undefined
  sessionCwd: (appSessionId: string) => string | undefined
  publishUserMessage: (input: NativeFollowUpUserMessage) => void
  prepareFollowUp?: (request: AcpSteerFollowUpRequest) => Promise<NativeFollowUpPreparedContent>
  registerTurnInputs?: NativeFollowUpRegisterTurnInputs
  createMessageId?: () => string
  fetchImpl?: typeof fetch
  followUpTimeoutMs?: number
}>

type NativeFollowUpTurnInputs = Readonly<{
  uploads: readonly UploadedAttachment[]
  references: readonly FileReference[]
}>

type NativeFollowUpMediaInput = Readonly<{
  content: string | ContentBlock[]
  turnInputs?: NativeFollowUpTurnInputs
  projectId: string
  sessionId: string
  livePromptMessageId?: string
  supportsImageInput: boolean
  imageSources?: ReadonlyArray<VisionEvidenceSource | undefined>
  historyImageCount: number
  signal?: AbortSignal
  imageCompatibility?: Pick<ImageInputCompatibilityOwner, 'prepare'>
}>

const nativeFollowUpPromptBlocks = (content: string | ContentBlock[]): ContentBlock[] => {
  if (typeof content !== 'string') return content
  return content.trim() ? [{ type: 'text', text: content }] : []
}

const finalizeNativeFollowUpPreparedContent = async (
  input: NativeFollowUpMediaInput
): Promise<NativeFollowUpPreparedContent> => {
  const content = input.imageCompatibility
    ? await input.imageCompatibility.prepare({
        content: input.content,
        supportsImageInput: input.supportsImageInput,
        projectId: input.projectId,
        sessionId: input.sessionId,
        imageSources: input.imageSources,
        historyImageCount: input.historyImageCount,
        ...(input.signal ? { signal: input.signal } : {})
      })
    : input.content
  return {
    prompt: nativeFollowUpPromptBlocks(content),
    uploads: [...(input.turnInputs?.uploads ?? [])],
    ...(input.turnInputs && input.livePromptMessageId
      ? {
          notebookTurnInputs: {
            projectId: input.projectId,
            sessionId: input.sessionId,
            livePromptMessageId: input.livePromptMessageId,
            uploads: [...input.turnInputs.uploads],
            references: [...input.turnInputs.references]
          }
        }
      : {})
  }
}

const persistableUploads = (
  attachments: readonly UploadedAttachment[]
): PersistedUploadedAttachment[] =>
  attachments
    .filter((attachment) => Boolean(attachment.versionId))
    .map(toPersistedUploadedAttachment)

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
    let preparedUploads: readonly UploadedAttachment[] | undefined
    let notebookTurnInputs: NativeFollowUpNotebookTurnInputs | undefined
    try {
      if (this.options.prepareFollowUp) {
        const prepared = await this.options.prepareFollowUp(request)
        prompt = prepared.prompt
        preparedUploads = prepared.uploads
        notebookTurnInputs = prepared.notebookTurnInputs
      } else {
        prompt = steeringPromptFromText(text)
      }
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

    const live = this.options.livePrompt?.(request.sessionId)
    if (!this.options.hasLivePrompt(request.sessionId) || (this.options.livePrompt && !live)) {
      log.info('native follow-up refused', {
        sessionId: request.sessionId,
        reason: 'no-live-turn',
        transport: route.transport
      })
      return refused('no-live-turn')
    }
    if (this.options.hasPendingPermission(request.sessionId)) {
      log.info('native follow-up refused', {
        sessionId: request.sessionId,
        reason: 'prompt-required',
        pendingPermission: true,
        transport: route.transport
      })
      return refused('prompt-required')
    }

    const transportSignal = this.transportTimeout(route.transport)
    if (route.transport === 'acp-steering') {
      let result: unknown
      try {
        result = await Promise.race([
          connection.agent.request(
            ACP_STEERING_METHOD,
            buildAcpSteeringParams(providerSessionId, prompt),
            { cancellationSignal: transportSignal }
          ),
          this.rejectWhenAborted(transportSignal)
        ])
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
        this.options.sessionCwd(request.sessionId),
        transportSignal
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

    if (this.sameLivePrompt(request.sessionId, live)) {
      await this.commitNotebookTurnInputs(notebookTurnInputs)
    } else {
      log.info('native follow-up skipped notebook registration', {
        sessionId: request.sessionId,
        reason: 'no-live-turn',
        transport: route.transport
      })
    }

    const messageId = this.options.createMessageId?.() ?? `message-${randomUUID()}`
    const uploads = persistableUploads(preparedUploads ?? attachments)
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

  private sameLivePrompt(sessionId: string, live: NativeFollowUpLivePrompt | undefined): boolean {
    if (!this.options.hasLivePrompt(sessionId)) return false
    if (!this.options.livePrompt) return true
    const current = this.options.livePrompt(sessionId)
    return Boolean(current && live && current.turnToken === live.turnToken)
  }

  private transportTimeout(transport: NativeFollowUpTransport): AbortSignal {
    return AbortSignal.timeout(
      this.options.followUpTimeoutMs ??
        (transport === 'opencode-http' ? OPENCODE_HTTP_STEER_TIMEOUT_MS : ACP_STEERING_TIMEOUT_MS)
    )
  }

  private rejectWhenAborted(signal: AbortSignal): Promise<never> {
    return new Promise((_, reject) => {
      const fail = (): void => {
        reject(Object.assign(new Error('TimeoutError'), { name: 'TimeoutError' }))
      }
      if (signal.aborted) {
        fail()
        return
      }
      signal.addEventListener('abort', fail, { once: true })
    })
  }

  private async commitNotebookTurnInputs(
    notebookTurnInputs: NativeFollowUpNotebookTurnInputs | undefined
  ): Promise<void> {
    if (!notebookTurnInputs || !this.options.registerTurnInputs) return
    try {
      await this.options.registerTurnInputs({
        projectId: notebookTurnInputs.projectId,
        appSessionId: notebookTurnInputs.sessionId,
        promptMessageId: notebookTurnInputs.livePromptMessageId,
        uploads: [...notebookTurnInputs.uploads],
        references: [...notebookTurnInputs.references]
      })
    } catch (error) {
      log.info('native follow-up notebook registration failed', {
        sessionId: notebookTurnInputs.sessionId,
        promptMessageId: notebookTurnInputs.livePromptMessageId,
        reason: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private async postOpenCodeSteer(
    api: AcpOpenCodeUsageApi,
    providerSessionId: string,
    parts: readonly OpenCodeHttpFollowUpPart[],
    cwd: string | undefined,
    signal: AbortSignal
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
        signal
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

export { AcpNativeFollowUpWorkflow, finalizeNativeFollowUpPreparedContent }
export type {
  NativeFollowUpPreparedContent,
  NativeFollowUpUserMessage,
  NativeFollowUpWorkflowOptions
}
