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
import type { NotebookPromptInput } from '../../shared/notebook'
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
import { appendNotebookInputPrompt } from './prompt-preparation-owner'
import {
  ACP_STEERING_METHOD,
  ACP_STEERING_TIMEOUT_MS,
  CODEBUDDY_STEER_METHOD,
  OPENCODE_HTTP_STEER_TIMEOUT_MS,
  buildAcpSteeringParams,
  buildCodeBuddySteerParams,
  buildOpenCodeHttpFollowUpBody,
  contentBlocksToOpenCodeFollowUpParts,
  firstOpenCodeFollowUpText,
  interpretSteerOutcome,
  openCodeHttpFollowUpPath,
  parseOpenCodeHttpFollowUp,
  parseCodeBuddySteer,
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
  close?: () => void
}>

type NativeFollowUpRegisterTurnInputs = (request: {
  projectId: string
  appSessionId: string
  promptMessageId: string
  uploads: UploadedAttachment[]
  references: FileReference[]
  materializeOnly?: boolean
}) => Promise<readonly NotebookPromptInput[] | void>

type NativeFollowUpLivePrompt = Readonly<{
  turnToken: string
  signal: AbortSignal
  promptMessageId?: string
}>

type SideChatAdvisoryFollowUpResult =
  Readonly<{ injected: true; promptMessageId: string }> | Readonly<{ injected: false }>

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
  close?: () => void
}>

const nativeFollowUpPromptBlocks = (content: string | ContentBlock[]): ContentBlock[] => {
  if (typeof content !== 'string') return content
  return content.trim() ? [{ type: 'text', text: content }] : []
}

const finalizeNativeFollowUpPreparedContent = async (
  input: NativeFollowUpMediaInput
): Promise<NativeFollowUpPreparedContent> => {
  let content: string | ContentBlock[]
  try {
    content = input.imageCompatibility
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
  } catch (error) {
    try {
      input.close?.()
    } catch {
      // Media preparation failure remains authoritative over resource cleanup.
    }
    throw error
  }
  return {
    prompt: nativeFollowUpPromptBlocks(content),
    uploads: [...(input.turnInputs?.uploads ?? [])],
    ...(input.close ? { close: input.close } : {}),
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
  private readonly preparedBySession = new Map<string, Map<string, Set<() => void>>>()

  constructor(private readonly options: NativeFollowUpWorkflowOptions) {}

  releaseTurn(sessionId: string, turnToken: string): void {
    const turns = this.preparedBySession.get(sessionId)
    const prepared = turns?.get(turnToken)
    turns?.delete(turnToken)
    if (turns?.size === 0) this.preparedBySession.delete(sessionId)
    for (const close of prepared ?? []) {
      try {
        close()
      } catch (error) {
        log.info('native follow-up resource cleanup failed', {
          sessionId,
          reason: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }

  releaseSession(sessionId: string): void {
    const turns = this.preparedBySession.get(sessionId)
    this.preparedBySession.delete(sessionId)
    for (const close of [...(turns?.values() ?? [])].flatMap((prepared) => [...prepared])) {
      try {
        close()
      } catch (error) {
        log.info('native follow-up resource cleanup failed', {
          sessionId,
          reason: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }

  clear(): void {
    for (const sessionId of [...this.preparedBySession.keys()]) this.releaseSession(sessionId)
  }

  async steerSideChatAdvisory(
    request: AcpSteerFollowUpRequest
  ): Promise<SideChatAdvisoryFollowUpResult> {
    const live = this.options.livePrompt?.(request.sessionId)
    if (!live?.promptMessageId) return Object.freeze({ injected: false })
    const result = await this.dispatch(request, false, live.turnToken)
    return result.injected
      ? Object.freeze({ injected: true, promptMessageId: live.promptMessageId })
      : Object.freeze({ injected: false })
  }

  async steerFollowUp(
    request: AcpSteerFollowUpRequest,
    isCurrent?: () => boolean
  ): Promise<AcpSteerFollowUpResult> {
    return this.dispatch(request, true, undefined, isCurrent)
  }

  private async dispatch(
    request: AcpSteerFollowUpRequest,
    publishUserMessage: boolean,
    expectedTurnToken?: string,
    isCurrent: () => boolean = () => true
  ): Promise<AcpSteerFollowUpResult> {
    const initialLive = this.options.livePrompt?.(request.sessionId)
    if (!isCurrent()) return refused('prompt-required')
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
    let closePrepared: (() => void) | undefined
    const closePreparedNow = (): void => {
      const close = closePrepared
      closePrepared = undefined
      if (!close) return
      try {
        close()
      } catch (error) {
        log.info('native follow-up resource cleanup failed', {
          sessionId: request.sessionId,
          reason: error instanceof Error ? error.message : String(error)
        })
      }
    }
    const refusePrepared = (reason: AcpSteerFollowUpRefuseReason): AcpSteerFollowUpResult => {
      closePreparedNow()
      return refused(reason)
    }
    try {
      if (this.options.prepareFollowUp) {
        const prepared = await this.options.prepareFollowUp(request)
        prompt = prepared.prompt
        preparedUploads = prepared.uploads
        notebookTurnInputs = prepared.notebookTurnInputs
        closePrepared = prepared.close
      } else {
        prompt = steeringPromptFromText(text)
      }
    } catch {
      log.info('native follow-up refused', {
        sessionId: request.sessionId,
        reason: 'dispatch-failed',
        transport: route.transport
      })
      return refusePrepared('dispatch-failed')
    }
    if (prompt.length === 0) {
      log.info('native follow-up refused', {
        sessionId: request.sessionId,
        reason: 'empty-text',
        transport: route.transport
      })
      return refusePrepared('empty-text')
    }

    const live = initialLive
    if (!isCurrent() || !this.sameLivePrompt(request.sessionId, live))
      return refusePrepared('no-live-turn')
    if (!this.options.hasLivePrompt(request.sessionId) || (this.options.livePrompt && !live)) {
      log.info('native follow-up refused', {
        sessionId: request.sessionId,
        reason: 'no-live-turn',
        transport: route.transport
      })
      return refusePrepared('no-live-turn')
    }
    if (expectedTurnToken && live?.turnToken !== expectedTurnToken) {
      log.info('native follow-up refused', {
        sessionId: request.sessionId,
        reason: 'no-live-turn',
        transport: route.transport
      })
      return refusePrepared('no-live-turn')
    }
    if (this.options.hasPendingPermission(request.sessionId)) {
      log.info('native follow-up refused', {
        sessionId: request.sessionId,
        reason: 'prompt-required',
        pendingPermission: true,
        transport: route.transport
      })
      return refusePrepared('prompt-required')
    }

    if (notebookTurnInputs && this.options.registerTurnInputs) {
      try {
        const notebookInputs = await this.options.registerTurnInputs({
          projectId: notebookTurnInputs.projectId,
          appSessionId: notebookTurnInputs.sessionId,
          promptMessageId: notebookTurnInputs.livePromptMessageId,
          uploads: [...notebookTurnInputs.uploads],
          references: [...notebookTurnInputs.references],
          materializeOnly: true
        })
        if (notebookInputs) {
          const preparedPrompt = appendNotebookInputPrompt([...prompt], notebookInputs)
          prompt =
            typeof preparedPrompt === 'string'
              ? steeringPromptFromText(preparedPrompt)
              : preparedPrompt
        }
      } catch (error) {
        log.info('native follow-up notebook materialization failed', {
          sessionId: notebookTurnInputs.sessionId,
          promptMessageId: notebookTurnInputs.livePromptMessageId,
          reason: error instanceof Error ? error.message : String(error)
        })
        return refusePrepared('dispatch-failed')
      }
      if (!this.sameLivePrompt(request.sessionId, live)) {
        log.info('native follow-up refused', {
          sessionId: request.sessionId,
          reason: 'no-live-turn',
          transport: route.transport
        })
        return refusePrepared('no-live-turn')
      }
    }

    if (!isCurrent() || !this.sameLivePrompt(request.sessionId, live))
      return refusePrepared('no-live-turn')
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
        return refusePrepared('dispatch-failed')
      }
      const outcome = parseSteerOutcome(result)
      const dispatched = interpretSteerOutcome(outcome)
      if (dispatched.kind !== 'injected') {
        log.info('native follow-up refused', {
          sessionId: request.sessionId,
          reason: dispatched.reason,
          transport: route.transport
        })
        return refusePrepared(dispatched.reason)
      }
    } else if (route.transport === 'codebuddy-acp-steer') {
      try {
        const result = await Promise.race([
          connection.agent.request(
            CODEBUDDY_STEER_METHOD,
            buildCodeBuddySteerParams(providerSessionId, prompt),
            { cancellationSignal: transportSignal }
          ),
          this.rejectWhenAborted(transportSignal)
        ])
        if (!parseCodeBuddySteer(result)) {
          log.info('native follow-up refused', {
            sessionId: request.sessionId,
            reason: 'prompt-required',
            transport: route.transport
          })
          return refusePrepared('prompt-required')
        }
      } catch {
        log.info('native follow-up refused', {
          sessionId: request.sessionId,
          reason: 'dispatch-failed',
          transport: route.transport
        })
        return refusePrepared('dispatch-failed')
      }
    } else {
      if (!openCodeUsageApi) {
        log.info('native follow-up refused', {
          sessionId: request.sessionId,
          reason: 'not-advertised',
          transport: route.transport
        })
        return refusePrepared('not-advertised')
      }
      const parts = contentBlocksToOpenCodeFollowUpParts(prompt)
      if (parts.length === 0) {
        log.info('native follow-up refused', {
          sessionId: request.sessionId,
          reason: 'empty-text',
          transport: route.transport
        })
        return refusePrepared('empty-text')
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
        return refusePrepared('dispatch-failed')
      }
    }

    const sameLivePrompt = this.sameLivePrompt(request.sessionId, live)
    if (sameLivePrompt) {
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
    if (publishUserMessage) {
      this.options.publishUserMessage({
        sessionId: request.sessionId,
        messageId,
        text,
        ...(uploads.length > 0 ? { uploads } : {}),
        ...(parts.length > 0 ? { parts } : {})
      })
    }
    log.info('native follow-up injected', {
      sessionId: request.sessionId,
      transport: route.transport,
      messageId
    })
    const retainedTurn = this.options.livePrompt?.(request.sessionId)
    if (closePrepared && retainedTurn) {
      const turns = this.preparedBySession.get(request.sessionId) ?? new Map()
      const prepared = turns.get(retainedTurn.turnToken) ?? new Set<() => void>()
      prepared.add(closePrepared)
      turns.set(retainedTurn.turnToken, prepared)
      this.preparedBySession.set(request.sessionId, turns)
      closePrepared = undefined
    }
    closePreparedNow()
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
  NativeFollowUpWorkflowOptions,
  SideChatAdvisoryFollowUpResult
}
