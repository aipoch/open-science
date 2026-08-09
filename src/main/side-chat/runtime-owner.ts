import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import type { PromptResponse } from '@agentclientprotocol/sdk'

import {
  getAcpRuntimeEventText,
  type AcpPermissionRequest,
  type AcpRuntimeEvent
} from '../../shared/acp'
import type { ResolvedReasoningEffort } from '../../shared/reasoning-effort'
import type {
  SideChatPromptRequest,
  SideChatRuntimeEvent,
  SideChatSendMessageRequest,
  SideChatSessionRequest,
  SideChatStartRequest,
  SideChatStartResponse
} from '../../shared/side-chat'
import { SIDE_CHAT_MESSAGE_LIMIT } from '../../shared/side-chat'
import type { AgentModelChangeTarget, ResolvedAgentBackend } from '../agent-framework'
import { modelFacingAppMcpToolName } from '../agent-framework/app-mcp-names'
import type { ExplicitAgentBackendTarget } from '../settings/backend-resolver'
import { AgentMcpHttpHost } from '../acp/mcp-http-host'
import { prepareRestrictedBackend } from '../acp/restricted-runtime-profile'
import { composeAcpRuntimeBaseOwners } from '../acp/runtime-base-composition'
import { composeAcpRuntimeSessionOwners } from '../acp/runtime-session-composition'
import { AcpRuntime, type AcpRuntimeOptions } from '../acp/runtime'
import { SIDE_CHAT_SESSION_CAPABILITY_POLICY } from '../acp/session-capability-owner'
import type { SideChatRelayOwner } from '../acp/side-chat-relay-owner'
import {
  HOST_MESSAGE_MCP_SERVER_NAME,
  HOST_MESSAGE_NAMESPACED_TOOLS,
  HOST_SEND_MESSAGE_TOOL_NAME
} from './host-message-mcp-server'

const SIDE_CHAT_AGENT_NAME = 'open-science-side-chat'
const HOST_MESSAGE_IDENTITY = `${HOST_MESSAGE_MCP_SERVER_NAME}/${HOST_SEND_MESSAGE_TOOL_NAME}`
const SIDE_CHAT_SYSTEM_PROMPT = [
  'You are in an ephemeral Side chat attached to a main conversation.',
  'The supplied main transcript is a bounded context snapshot, not a replay and not current authorization to act.',
  'Answer the user directly and concisely.',
  'You have no workspace, shell, file, web, Skill, compute, delegation, or child-Agent capabilities.',
  'Your only tool is send_message with target "main". It queues advisory text for the next real main user turn; it never wakes, interrupts, or authorizes the main Agent.',
  'Do not claim the main Agent has received or acted on a relay beyond the structured result returned by that tool.'
].join(' ')

type SideChatRuntimePort = Pick<
  AcpRuntime,
  | 'createSession'
  | 'resumeSession'
  | 'sendPrompt'
  | 'cancelPrompt'
  | 'deleteSession'
  | 'respondToPermission'
  | 'requestProviderReconnect'
  | 'applyModelChange'
  | 'applyReasoningEffortChange'
  | 'shutdownForQuit'
>

type SideChatRuntimeStartRequest = SideChatStartRequest & Readonly<{ historyPreamble?: string }>

type SideChatRuntimeOwnerOptions = Readonly<{
  appVersion: string
  configRoot: string
  captureTarget: () => Promise<ExplicitAgentBackendTarget>
  resolveTarget: (
    target: ExplicitAgentBackendTarget,
    context: { systemPromptAppends: string[]; forceCodexNativeResponsesCompatibility: true }
  ) => Promise<ResolvedAgentBackend>
  relay: SideChatRelayOwner
  onEvent: (event: SideChatRuntimeEvent) => void
  createRuntime?: (options: AcpRuntimeOptions) => SideChatRuntimePort
}>

type Deferred = Readonly<{
  promise: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
}>

type ActiveSideChat = {
  parentSessionId: string
  projectId: string
  sideSessionId: string
  relaySenderId?: string
  runtime: SideChatRuntimePort
  jobRoot: string
  bridgeScopes: Set<NonNullable<ResolvedAgentBackend['responsesBridgeLease']>>
  historyPreamble?: string
  transcript: Array<{ id: string; role: 'user' | 'assistant'; text: string }>
  reconnect?: Promise<void>
  turn?: Promise<PromptResponse>
  turnAccepted?: Deferred
  closing: boolean
}

type StartingSideChat = Readonly<{
  parentSessionId: string
  done: Deferred
}>

const deferred = (): Deferred => {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const releaseUnattachedBackend = async (backend: ResolvedAgentBackend): Promise<void> => {
  const leases = new Set([
    backend.responsesBridgeLease,
    backend.anthropicBridgeLease,
    backend.providerTransportLease
  ])
  await Promise.all(
    [...leases].map((lease) => lease?.release().catch(() => undefined) ?? Promise.resolve())
  )
}

const prepareSideChatBackend = (
  backend: ResolvedAgentBackend,
  profileRoot: string
): Promise<ResolvedAgentBackend> =>
  prepareRestrictedBackend(backend, profileRoot, {
    agentName: SIDE_CHAT_AGENT_NAME,
    description: 'Ephemeral Side chat with one relationship-bound message tool.',
    systemPrompt: SIDE_CHAT_SYSTEM_PROMPT,
    openCodePermissions: {
      '*': 'deny',
      [modelFacingAppMcpToolName(
        'opencode',
        HOST_MESSAGE_MCP_SERVER_NAME,
        HOST_SEND_MESSAGE_TOOL_NAME
      )]: 'allow'
    }
  })

const buildResumeFallback = (active: ActiveSideChat): string | undefined => {
  const transcript = active.transcript
    .map((entry) => `${entry.role === 'user' ? 'User' : 'Assistant'}: ${entry.text}`)
    .join('\n\n')
  const full = [
    active.historyPreamble,
    transcript ? `Side chat transcript before this follow-up:\n${transcript}` : undefined
  ]
    .filter((section): section is string => Boolean(section))
    .join('\n\n')
  if (!full) return undefined
  if (full.length <= SIDE_CHAT_MESSAGE_LIMIT) return full
  return `[Earlier context truncated]\n${full.slice(-(SIDE_CHAT_MESSAGE_LIMIT - 28))}`
}

class SideChatRuntimeOwner {
  private readonly root: string
  private readonly createRuntime: (options: AcpRuntimeOptions) => SideChatRuntimePort
  private active: ActiveSideChat | undefined
  private starting: StartingSideChat | undefined
  private closing: Promise<void> | undefined
  private readonly closeRequestedParents = new Set<string>()
  private readonly invalidatedParents = new Set<string>()
  private shuttingDown = false

  constructor(private readonly options: SideChatRuntimeOwnerOptions) {
    this.root = join(options.configRoot, 'runtime-support', 'side-chat')
    this.createRuntime =
      options.createRuntime ??
      ((runtimeOptions) => {
        const base = composeAcpRuntimeBaseOwners(runtimeOptions)
        return new AcpRuntime(
          runtimeOptions,
          base,
          composeAcpRuntimeSessionOwners(runtimeOptions, base)
        )
      })
  }

  async sweepStaleProfiles(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    const entries = await readdir(this.root, { withFileTypes: true })
    await Promise.all(
      entries.flatMap((entry) => {
        if (!entry.isDirectory() || !entry.name.startsWith('chat-')) return []
        const path = join(this.root, entry.name)
        return [rm(path, { recursive: true, force: true }).catch(() => undefined)]
      })
    )
  }

  async start(request: SideChatRuntimeStartRequest): Promise<SideChatStartResponse> {
    if (this.shuttingDown) throw new Error('Side chat is shutting down.')
    if (this.invalidatedParents.has(request.parentSessionId)) {
      throw new Error('The parent Session is unavailable.')
    }
    if (this.active || this.starting || this.closing) {
      throw new Error('A Side chat is already open.')
    }
    const text = request.text.trim()
    if (!text) throw new Error('Side chat text must be non-empty.')

    let jobRoot: string | undefined
    let backend: ResolvedAgentBackend | undefined
    let backendTransferred = false
    let runtime: SideChatRuntimePort | undefined
    let activeChat: ActiveSideChat | undefined
    const starting: StartingSideChat = {
      parentSessionId: request.parentSessionId,
      done: deferred()
    }
    this.starting = starting
    try {
      await mkdir(this.root, { recursive: true })
      jobRoot = await mkdtemp(join(this.root, 'chat-'))
      const cwd = join(jobRoot, 'cwd')
      const profileRoot = join(jobRoot, 'profile')
      await Promise.all([mkdir(cwd), mkdir(profileRoot)])
      const resolveBackend = async (): Promise<ResolvedAgentBackend> => {
        const target = await this.options.captureTarget()
        let resolved = await this.options.resolveTarget(target, {
          systemPromptAppends: [SIDE_CHAT_SYSTEM_PROMPT],
          forceCodexNativeResponsesCompatibility: true
        })
        resolved = await prepareSideChatBackend(resolved, profileRoot)
        const bridge = resolved.responsesBridgeLease
        if (
          bridge &&
          (!bridge.registerHostMessageSession || !bridge.unregisterHostMessageSession)
        ) {
          throw new Error(
            'The selected Codex transport cannot enforce host-message-only Side chat.'
          )
        }
        if (bridge && activeChat?.sideSessionId) {
          bridge.registerHostMessageSession?.(
            activeChat.sideSessionId,
            HOST_MESSAGE_NAMESPACED_TOOLS.map((tool) => ({ ...tool })),
            { failClosedUnknownKeys: true }
          )
          activeChat.bridgeScopes.add(bridge)
        }
        return resolved
      }
      backend = await resolveBackend()
      const initialBackend = backend
      const bridge = initialBackend.responsesBridgeLease

      const runtimeRef: { current?: SideChatRuntimePort } = {}
      const runtimeOptions: AcpRuntimeOptions = {
        appVersion: this.options.appVersion,
        defaultCwd: cwd,
        resolveBackend: () => {
          if (backend) {
            backendTransferred = true
            const initial = backend
            backend = undefined
            return Promise.resolve(initial)
          }
          return resolveBackend()
        },
        mcpHttpHost: new AgentMcpHttpHost(),
        sessionCapabilityPolicy: SIDE_CHAT_SESSION_CAPABILITY_POLICY,
        sideChat: {
          sendMessage: (routingId, input) => Promise.resolve(this.sendToMain(routingId, input))
        },
        callbacks: {
          onEvent: (event) => this.handleRuntimeEvent(event),
          onStateChanged: (state) => {
            if (state.status === 'error' || state.status === 'closed') {
              this.handleRuntimeClosed(
                state.status === 'error' ? 'connection-error' : 'connection-closed'
              )
              void this.closeActive().catch(() => undefined)
            }
          },
          onPermissionRequest: (permission) =>
            this.handlePermission(runtimeRef.current, permission),
          onProviderPromptAccepted: (sideSessionId) => {
            const active = this.active
            if (active?.sideSessionId === sideSessionId) active.turnAccepted?.resolve()
          }
        }
      }
      runtime = this.createRuntime(runtimeOptions)
      runtimeRef.current = runtime
      const created = await runtime.createSession({ cwd, projectName: request.projectId })
      if (bridge) {
        bridge.registerHostMessageSession?.(
          created.sessionId,
          HOST_MESSAGE_NAMESPACED_TOOLS.map((tool) => ({ ...tool })),
          { failClosedUnknownKeys: true }
        )
      }
      activeChat = {
        parentSessionId: request.parentSessionId,
        projectId: request.projectId,
        sideSessionId: created.sessionId,
        runtime,
        jobRoot,
        bridgeScopes: new Set(),
        historyPreamble: request.historyPreamble,
        transcript: [],
        closing: false
      }
      if (bridge) activeChat.bridgeScopes.add(bridge)
      this.active = activeChat
      if (this.closeRequestedParents.delete(request.parentSessionId)) {
        await this.closeActive()
        throw new Error('Side chat closed before startup completed.')
      }
      await this.dispatch({
        sideSessionId: created.sessionId,
        text,
        historyPreamble: request.historyPreamble
      })
      return {
        sideSessionId: created.sessionId,
        frameworkId: initialBackend.framework.id,
        ...(initialBackend.contextUsageModel || initialBackend.sessionModel
          ? { model: initialBackend.contextUsageModel ?? initialBackend.sessionModel }
          : {})
      }
    } catch (error) {
      if (this.active?.runtime === runtime) await this.closeActive().catch(() => undefined)
      else if (!activeChat?.closing) {
        await runtime?.shutdownForQuit().catch(() => undefined)
        if (backend && !backendTransferred) await releaseUnattachedBackend(backend)
        if (jobRoot) await rm(jobRoot, { recursive: true, force: true }).catch(() => undefined)
      }
      throw error
    } finally {
      if (this.starting === starting) {
        this.starting = undefined
        starting.done.resolve()
      }
      this.closeRequestedParents.delete(request.parentSessionId)
    }
  }

  send(request: SideChatPromptRequest): Promise<void> {
    return this.dispatch(request)
  }

  async requestProviderReconnect(): Promise<void> {
    const active = this.active
    if (!active || active.closing) return
    const previous = active.reconnect?.catch(() => undefined) ?? Promise.resolve()
    const reconnect = previous.then(() => active.runtime.requestProviderReconnect())
    active.reconnect = reconnect
    await reconnect
  }

  async applyModelChange(target: AgentModelChangeTarget): Promise<boolean> {
    const active = this.active
    if (!active || active.closing) return true
    const applied = await active.runtime.applyModelChange(target)
    // applyModelChange may hot-switch the attached Session or reconnect internally. The next
    // follow-up checks attachment continuity after its model barrier; an attached Session returns
    // unchanged, while an adopted Session reports contextReset and receives the fallback transcript.
    if (applied && this.active === active && !active.closing && !active.reconnect) {
      active.reconnect = Promise.resolve()
    }
    return applied
  }

  applyReasoningEffortChange(effort: ResolvedReasoningEffort): Promise<boolean> {
    const active = this.active
    return active && !active.closing
      ? active.runtime.applyReasoningEffortChange(effort)
      : Promise.resolve(true)
  }

  async cancel(request: SideChatSessionRequest): Promise<void> {
    const active = this.requireActive(request.sideSessionId)
    if (active.turn) await active.runtime.cancelPrompt({ sessionId: active.sideSessionId })
  }

  async close(request: SideChatSessionRequest): Promise<void> {
    this.requireActive(request.sideSessionId)
    await this.closeActive()
  }

  async closeActiveForParent(parentSessionId: string): Promise<void> {
    const starting = this.starting?.parentSessionId === parentSessionId ? this.starting : undefined
    if (starting) this.closeRequestedParents.add(parentSessionId)
    if (this.active?.parentSessionId === parentSessionId) {
      await this.closeActive()
    }
    if (starting) {
      await starting.done.promise
      if (this.active?.parentSessionId === parentSessionId) await this.closeActive()
    }
  }

  async closeForParent(parentSessionId: string): Promise<void> {
    try {
      await this.closeActiveForParent(parentSessionId)
    } finally {
      this.options.relay.releaseParent(parentSessionId)
    }
  }

  async invalidateParents(parentSessionIds: readonly string[]): Promise<void> {
    for (const parentSessionId of parentSessionIds) this.invalidatedParents.add(parentSessionId)
    await Promise.all(
      parentSessionIds.map((parentSessionId) => this.closeForParent(parentSessionId))
    )
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    const starting = this.starting
    if (starting) this.closeRequestedParents.add(starting.parentSessionId)
    await this.closeActive()
    await starting?.done.promise
    await this.closeActive()
    await this.closing
  }

  private async dispatch(
    request: SideChatPromptRequest & { historyPreamble?: string }
  ): Promise<void> {
    const active = this.requireActive(request.sideSessionId)
    if (active.turn) throw new Error('A Side chat prompt is already running.')
    const text = request.text.trim()
    if (!text) throw new Error('Side chat text must be non-empty.')
    let historyPreamble = request.historyPreamble
    while (active.reconnect) {
      const reconnect = active.reconnect
      await reconnect
      if (active.reconnect !== reconnect) continue
      const resumed = await active.runtime.resumeSession({
        sessionId: active.sideSessionId,
        cwd: join(active.jobRoot, 'cwd'),
        projectName: active.projectId
      })
      if (active.reconnect === reconnect) active.reconnect = undefined
      if (resumed.contextReset) historyPreamble = buildResumeFallback(active)
    }
    const resumeFallback = buildResumeFallback(active)
    active.transcript.push({
      id: `user-${active.transcript.length + 1}`,
      role: 'user',
      text
    })
    const accepted = deferred()
    active.turnAccepted = accepted
    const turn = active.runtime.sendPrompt({
      sessionId: active.sideSessionId,
      text,
      ...(historyPreamble ? { historyPreamble } : {}),
      ...(resumeFallback ? { resumeFallback: { historyPreamble: resumeFallback } } : {})
    })
    active.turn = turn
    const finish = (): void => {
      if (this.active === active && active.turn === turn) {
        active.turn = undefined
        active.turnAccepted = undefined
      }
    }
    void turn.then(
      () => {
        accepted.reject(new Error('Side chat prompt ended before provider admission.'))
        finish()
      },
      (error) => {
        accepted.reject(error)
        finish()
      }
    )
    await accepted.promise
  }

  private sendToMain(
    routingId: string,
    request: SideChatSendMessageRequest
  ): ReturnType<SideChatRelayOwner['send']> {
    const active = this.active
    if (!active || active.closing) throw new Error('Side chat sender is no longer active.')
    if (!active.relaySenderId) {
      active.relaySenderId = routingId
      this.options.relay.bind({
        sideSessionId: routingId,
        parentSessionId: active.parentSessionId,
        projectId: active.projectId
      })
    }
    if (active.relaySenderId !== routingId) {
      throw new Error('Side chat sender binding does not match the active capability.')
    }
    return this.options.relay.send({ sideSessionId: routingId, ...request })
  }

  private handlePermission(
    runtime: SideChatRuntimePort | undefined,
    request: AcpPermissionRequest
  ): void {
    const allow =
      request.mcpIdentity === HOST_MESSAGE_IDENTITY
        ? (request.options.find((option) => option.kind === 'allow_once') ??
          request.options.find((option) => option.kind === 'allow_always'))
        : undefined
    void runtime
      ?.respondToPermission({
        requestId: request.requestId,
        ...(allow ? { optionId: allow.optionId } : { cancelled: true })
      })
      .catch(() => undefined)
  }

  private handleRuntimeEvent(event: AcpRuntimeEvent): void {
    const active = this.active
    if (!active || active.closing) return
    if (event.kind === 'message' && event.role === 'assistant') {
      const text = getAcpRuntimeEventText(event)
      if (text) {
        const id = event.messageId ?? event.id
        const existing = active.transcript.find((entry) => entry.id === id)
        if (existing) existing.text += text
        else active.transcript.push({ id, role: 'assistant', text })
      }
    }
    this.options.onEvent({
      parentSessionId: active.parentSessionId,
      sideSessionId: active.sideSessionId,
      event
    })
  }

  private handleRuntimeClosed(reason: 'connection-error' | 'connection-closed'): void {
    const active = this.active
    if (!active || active.closing) return
    this.options.onEvent({
      parentSessionId: active.parentSessionId,
      sideSessionId: active.sideSessionId,
      event: { kind: 'closed', reason }
    })
  }

  private requireActive(sideSessionId: string): ActiveSideChat {
    const active = this.active
    if (!active || active.sideSessionId !== sideSessionId || active.closing) {
      throw new Error('Side chat Session is not active.')
    }
    return active
  }

  private async closeActive(): Promise<void> {
    if (this.closing) return this.closing
    const active = this.active
    if (!active || active.closing) return
    active.closing = true
    this.active = undefined
    const closing = this.disposeActive(active)
    this.closing = closing
    try {
      await closing
    } finally {
      if (this.closing === closing) this.closing = undefined
    }
  }

  private async disposeActive(active: ActiveSideChat): Promise<void> {
    active.turnAccepted?.reject(new Error('Side chat closed.'))
    if (active.relaySenderId) this.options.relay.releaseSide(active.relaySenderId)
    if (active.turn) {
      await active.runtime.cancelPrompt({ sessionId: active.sideSessionId }).catch(() => undefined)
    }
    await active.runtime.deleteSession({ sessionId: active.sideSessionId }).catch(() => undefined)
    await active.runtime.shutdownForQuit().catch(() => undefined)
    for (const bridge of active.bridgeScopes) {
      bridge.unregisterHostMessageSession?.(active.sideSessionId)
    }
    await rm(active.jobRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

export { SIDE_CHAT_SYSTEM_PROMPT, SideChatRuntimeOwner, prepareSideChatBackend }
export type { SideChatRuntimeOwnerOptions, SideChatRuntimePort, SideChatRuntimeStartRequest }
