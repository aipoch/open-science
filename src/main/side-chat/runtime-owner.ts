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
  SideChatEntry,
  SideChatPromptRequest,
  SideChatRuntimeEvent,
  SideChatSendMessageRequest,
  SideChatSessionRequest,
  SideChatSnapshot,
  SideChatSnapshotList,
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
  revision: number
  parentSessionId: string
  projectId: string
  sideSessionId: string
  relaySenderId?: string
  runtime: SideChatRuntimePort
  jobRoot: string
  bridgeScopes: Set<NonNullable<ResolvedAgentBackend['responsesBridgeLease']>>
  historyPreamble?: string
  entries: SideChatEntry[]
  entrySequence: number
  running: boolean
  error?: string
  reconnect?: Promise<void>
  turn?: Promise<PromptResponse>
  turnAccepted?: Deferred
  closing: boolean
}

type StartingSideChat = {
  revision: number
  parentSessionId: string
  projectId: string
  text: string
  done: Deferred
}

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
  const transcript = active.entries
    .filter(
      (entry): entry is Extract<SideChatEntry, { kind: 'message' }> => entry.kind === 'message'
    )
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
  private readonly activeByParent = new Map<string, ActiveSideChat>()
  private readonly startingByParent = new Map<string, StartingSideChat>()
  private readonly closingByParent = new Map<string, Promise<void>>()
  private readonly closeRequestedParents = new Set<string>()
  private readonly invalidatedParents = new Set<string>()
  private revision = 0
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

  list(): SideChatSnapshotList {
    return {
      revision: this.revision,
      chats: [
        ...[...this.startingByParent.values()]
          .filter((starting) => !this.activeByParent.has(starting.parentSessionId))
          .map((starting) => this.snapshotStarting(starting)),
        ...[...this.activeByParent.values()].map((active) => this.snapshotActive(active))
      ]
    }
  }

  async start(request: SideChatRuntimeStartRequest): Promise<SideChatStartResponse> {
    if (this.shuttingDown) throw new Error('Side chat is shutting down.')
    if (this.invalidatedParents.has(request.parentSessionId)) {
      throw new Error('The parent Session is unavailable.')
    }
    if (
      this.activeByParent.has(request.parentSessionId) ||
      this.startingByParent.has(request.parentSessionId) ||
      this.closingByParent.has(request.parentSessionId)
    ) {
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
      revision: ++this.revision,
      parentSessionId: request.parentSessionId,
      projectId: request.projectId,
      text,
      done: deferred()
    }
    this.startingByParent.set(request.parentSessionId, starting)
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
          sendMessage: (routingId, input) => {
            if (!activeChat) throw new Error('Side chat sender is not active yet.')
            return Promise.resolve(this.sendToMain(activeChat, routingId, input))
          }
        },
        callbacks: {
          onEvent: (event) => {
            if (activeChat) this.handleRuntimeEvent(activeChat, event)
          },
          onStateChanged: (state) => {
            if (activeChat && (state.status === 'error' || state.status === 'closed')) {
              this.handleRuntimeClosed(
                activeChat,
                state.status === 'error' ? 'connection-error' : 'connection-closed'
              )
              void this.closeActive(activeChat, false).catch(() => undefined)
            }
          },
          onPermissionRequest: (permission) =>
            this.handlePermission(runtimeRef.current, permission),
          onProviderPromptAccepted: (sideSessionId) => {
            if (activeChat?.sideSessionId === sideSessionId) activeChat.turnAccepted?.resolve()
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
        revision: 0,
        parentSessionId: request.parentSessionId,
        projectId: request.projectId,
        sideSessionId: created.sessionId,
        runtime,
        jobRoot,
        bridgeScopes: new Set(),
        historyPreamble: request.historyPreamble,
        entries: [],
        entrySequence: 0,
        running: false,
        closing: false
      }
      if (bridge) activeChat.bridgeScopes.add(bridge)
      this.activeByParent.set(request.parentSessionId, activeChat)
      this.touch(activeChat)
      if (this.closeRequestedParents.delete(request.parentSessionId)) {
        await this.closeActive(activeChat)
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
      if (activeChat && this.activeByParent.get(request.parentSessionId) === activeChat) {
        await this.closeActive(activeChat).catch(() => undefined)
      } else if (!activeChat?.closing) {
        await runtime?.shutdownForQuit().catch(() => undefined)
        if (backend && !backendTransferred) await releaseUnattachedBackend(backend)
        if (jobRoot) await rm(jobRoot, { recursive: true, force: true }).catch(() => undefined)
      }
      throw error
    } finally {
      if (this.startingByParent.get(request.parentSessionId) === starting) {
        this.startingByParent.delete(request.parentSessionId)
        starting.done.resolve()
      }
      this.closeRequestedParents.delete(request.parentSessionId)
    }
  }

  send(request: SideChatPromptRequest): Promise<void> {
    return this.dispatch(request)
  }

  async requestProviderReconnect(): Promise<void> {
    await Promise.all(
      this.activeChats().map(async (active) => {
        const previous = active.reconnect?.catch(() => undefined) ?? Promise.resolve()
        const reconnect = previous.then(() => active.runtime.requestProviderReconnect())
        active.reconnect = reconnect
        await reconnect
      })
    )
  }

  async applyModelChange(target: AgentModelChangeTarget): Promise<boolean> {
    const results = await Promise.all(
      this.activeChats().map(async (active) => {
        const applied = await active.runtime.applyModelChange(target)
        // A hot switch keeps the attached Session. A reconnect may adopt a replacement Session;
        // dispatch verifies continuity and supplies this chat's bounded fallback only if needed.
        if (
          applied &&
          this.activeByParent.get(active.parentSessionId) === active &&
          !active.closing &&
          !active.reconnect
        ) {
          active.reconnect = Promise.resolve()
        }
        return applied
      })
    )
    return results.every(Boolean)
  }

  async applyReasoningEffortChange(effort: ResolvedReasoningEffort): Promise<boolean> {
    const results = await Promise.all(
      this.activeChats().map((active) => active.runtime.applyReasoningEffortChange(effort))
    )
    return results.every(Boolean)
  }

  async cancel(request: SideChatSessionRequest): Promise<void> {
    const active = this.requireActive(request.sideSessionId)
    if (active.turn) await active.runtime.cancelPrompt({ sessionId: active.sideSessionId })
  }

  async close(request: SideChatSessionRequest): Promise<void> {
    await this.closeActive(this.requireActive(request.sideSessionId))
  }

  async closeActiveForParent(parentSessionId: string): Promise<void> {
    const starting = this.startingByParent.get(parentSessionId)
    if (starting) this.closeRequestedParents.add(parentSessionId)
    const active = this.activeByParent.get(parentSessionId)
    if (active) await this.closeActive(active)
    if (starting) {
      await starting.done.promise
      const started = this.activeByParent.get(parentSessionId)
      if (started) await this.closeActive(started)
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
    const starting = [...this.startingByParent.values()]
    for (const chat of starting) this.closeRequestedParents.add(chat.parentSessionId)
    await Promise.all(this.activeChats().map((active) => this.closeActive(active)))
    await Promise.all(starting.map((chat) => chat.done.promise))
    await Promise.all(this.activeChats().map((active) => this.closeActive(active)))
    await Promise.all(this.closingByParent.values())
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
    active.entrySequence += 1
    active.entries.push({
      id: `user-${active.entrySequence}`,
      kind: 'message',
      role: 'user',
      text
    })
    active.running = true
    active.error = undefined
    this.touch(active)
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
      if (this.activeByParent.get(active.parentSessionId) === active && active.turn === turn) {
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
    active: ActiveSideChat,
    routingId: string,
    request: SideChatSendMessageRequest
  ): ReturnType<SideChatRelayOwner['send']> {
    if (active.closing || this.activeByParent.get(active.parentSessionId) !== active) {
      throw new Error('Side chat sender is no longer active.')
    }
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

  private handleRuntimeEvent(active: ActiveSideChat, event: AcpRuntimeEvent): void {
    if (active.closing || this.activeByParent.get(active.parentSessionId) !== active) return
    if (event.kind === 'message' && event.role === 'assistant') {
      const text = getAcpRuntimeEventText(event)
      if (text) {
        const id = event.messageId ?? event.id
        const existing = active.entries.find(
          (entry) => entry.kind === 'message' && entry.role === 'assistant' && entry.id === id
        )
        if (existing?.kind === 'message') {
          const index = active.entries.indexOf(existing)
          active.entries[index] = { ...existing, text: existing.text + text }
        } else {
          active.entries.push({ id, kind: 'message', role: 'assistant', text })
        }
      }
    } else if (event.kind === 'tool' && event.toolCallId) {
      const tool = {
        id: event.toolCallId,
        kind: 'tool' as const,
        title: event.title ?? event.providerToolName ?? 'Tool',
        ...(event.status ? { status: event.status } : {})
      }
      const existing = active.entries.findIndex(
        (entry) => entry.kind === 'tool' && entry.id === event.toolCallId
      )
      if (existing >= 0) active.entries[existing] = tool
      else active.entries.push(tool)
    } else if (event.kind === 'error') {
      active.running = false
      active.error = event.text ?? event.title ?? 'Side chat failed.'
    } else if (event.kind === 'stop') {
      active.running = false
    }
    const revision = this.touch(active)
    this.options.onEvent({
      revision,
      parentSessionId: active.parentSessionId,
      projectId: active.projectId,
      sideSessionId: active.sideSessionId,
      event
    })
  }

  private handleRuntimeClosed(
    active: ActiveSideChat,
    reason: 'closed' | 'connection-error' | 'connection-closed'
  ): void {
    if (active.closing || this.activeByParent.get(active.parentSessionId) !== active) return
    this.options.onEvent({
      revision: this.touch(active),
      parentSessionId: active.parentSessionId,
      projectId: active.projectId,
      sideSessionId: active.sideSessionId,
      event: { kind: 'closed', reason }
    })
  }

  private requireActive(sideSessionId: string): ActiveSideChat {
    for (const active of this.activeByParent.values()) {
      if (active.sideSessionId === sideSessionId && !active.closing) return active
    }
    throw new Error('Side chat Session is not active.')
  }

  private activeChats(): ActiveSideChat[] {
    return [...this.activeByParent.values()].filter((active) => !active.closing)
  }

  private touch(chat: ActiveSideChat | StartingSideChat): number {
    chat.revision = ++this.revision
    return chat.revision
  }

  private snapshotStarting(starting: StartingSideChat): SideChatSnapshot {
    return {
      revision: starting.revision,
      parentSessionId: starting.parentSessionId,
      projectId: starting.projectId,
      entries: [{ id: 'user-1', kind: 'message', role: 'user', text: starting.text }],
      running: true
    }
  }

  private snapshotActive(active: ActiveSideChat): SideChatSnapshot {
    return {
      revision: active.revision,
      parentSessionId: active.parentSessionId,
      projectId: active.projectId,
      sideSessionId: active.sideSessionId,
      entries: active.entries.map((entry) => ({ ...entry })),
      running: active.running,
      ...(active.error ? { error: active.error } : {})
    }
  }

  private async closeActive(active: ActiveSideChat, notify = true): Promise<void> {
    const existing = this.closingByParent.get(active.parentSessionId)
    if (existing) return existing
    if (active.closing || this.activeByParent.get(active.parentSessionId) !== active) {
      return
    }
    if (notify) this.handleRuntimeClosed(active, 'closed')
    active.closing = true
    this.activeByParent.delete(active.parentSessionId)
    this.touch(active)
    const closing = this.disposeActive(active)
    this.closingByParent.set(active.parentSessionId, closing)
    try {
      await closing
    } finally {
      if (this.closingByParent.get(active.parentSessionId) === closing) {
        this.closingByParent.delete(active.parentSessionId)
      }
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
