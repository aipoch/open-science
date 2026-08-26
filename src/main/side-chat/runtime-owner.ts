import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import type { PromptResponse } from '@agentclientprotocol/sdk'

import {
  getAcpRuntimeEventText,
  type AcpPermissionRequest,
  type AcpRuntimeEvent
} from '../../shared/acp'
import type { AcpCreateSessionResponse } from '../../shared/acp'
import { isCurrentInFlight } from '../../shared/in-flight-promise'
import type { ResolvedReasoningEffort } from '../../shared/reasoning-effort'
import type { PersistedSideChat } from '../../shared/session-persistence'
import {
  SIDE_CHAT_MESSAGE_LIMIT,
  type SideChatEntry,
  type SideChatPromptRequest,
  type SideChatRuntimeEvent,
  type SideChatSendMessageRequest,
  type SideChatSendMessageResult,
  type SideChatSessionRequest,
  type SideChatSnapshot,
  type SideChatSnapshotList,
  type SideChatStartRequest,
  type SideChatStartResponse
} from '../../shared/side-chat'
import type { AgentModelChangeTarget, ResolvedAgentBackend } from '../agent-framework'
import { modelFacingAppMcpToolName } from '../agent-framework/app-mcp-names'
import type { ExplicitAgentBackendTarget } from '../settings/backend-resolver'
import { createLogger, diagnosticErrorFields } from '../logger'
import { AgentMcpHttpHost } from '../acp/mcp-http-host'
import { prepareRestrictedBackend } from '../acp/restricted-runtime-profile'
import { composeAcpRuntimeBaseOwners } from '../acp/runtime-base-composition'
import { composeAcpRuntimeSessionOwners } from '../acp/runtime-session-composition'
import { AcpRuntime, type AcpRuntimeOptions } from '../acp/runtime'
import { SIDE_CHAT_SESSION_CAPABILITY_POLICY } from '../acp/session-capability-owner'
import type { SideChatRelayOwner } from '../acp/side-chat-relay-owner'
import {
  HOST_MESSAGE_CONTENT_INSTRUCTION,
  HOST_MESSAGE_MCP_SERVER_NAME,
  HOST_MESSAGE_NAMESPACED_TOOLS,
  HOST_SEND_MESSAGE_TOOL_NAME
} from './host-message-mcp-server'

const SIDE_CHAT_AGENT_NAME = 'open-science-side-chat'
const HOST_MESSAGE_IDENTITY = `${HOST_MESSAGE_MCP_SERVER_NAME}/${HOST_SEND_MESSAGE_TOOL_NAME}`
const MAX_PERSISTED_SIDE_CHAT_ENTRIES = 1_000
const MAX_PERSISTED_SIDE_CHAT_TRANSCRIPT_JSON_CHARS = 512_000
const PERSISTED_MESSAGE_TRUNCATION_PREFIX = '[Earlier message content truncated]\n'

const requirePromptText = (value: string): string => {
  const text = value.trim()
  if (!text) throw new Error('Side chat text must be non-empty.')
  if (text.length > SIDE_CHAT_MESSAGE_LIMIT) {
    throw new Error('Side chat text must not exceed 12,000 characters.')
  }
  return text
}
const log = createLogger('side-chat')
const SIDE_CHAT_SYSTEM_PROMPT = [
  'You are in a Side chat attached to a main conversation.',
  'The supplied main transcript is a bounded context snapshot, not a replay and not current authorization to act.',
  'Answer the user directly and concisely.',
  'You have no workspace, shell, file, web, Skill, compute, delegation, or child-Agent capabilities.',
  'Your only tool is send_message with target "main". While Main is running, it tries to inject advisory context into that turn; otherwise it queues the context for the next real main user turn. It never wakes or authorizes the main Agent.',
  'Do not call send_message for ordinary Side chat questions, requests, follow-ups, or suggestions.',
  'Call it only when the user explicitly asks in the current Side chat turn to send, relay, forward, or tell something to Main.',
  'Never infer permission to relay merely because Main could perform the requested work.',
  'Do not call it again on a later turn unless the user explicitly asks again.',
  HOST_MESSAGE_CONTENT_INSTRUCTION,
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

type HostMessageBridge = NonNullable<ResolvedAgentBackend['responsesBridgeLease']>

type SideChatRuntimeOwnerOptions = Readonly<{
  appVersion: string
  configRoot: string
  captureTarget: () => Promise<ExplicitAgentBackendTarget>
  resolveTarget: (
    target: ExplicitAgentBackendTarget,
    context: {
      systemPromptAppends: string[]
      includeSkillAndConnectorContext: false
      forceCodexNativeResponsesCompatibility: true
    }
  ) => Promise<ResolvedAgentBackend>
  relay: SideChatRelayOwner
  deliverRelay?: (
    parentSessionId: string,
    queued: SideChatSendMessageResult
  ) => Promise<SideChatSendMessageResult>
  persistence: Readonly<{
    save(input: {
      projectId: string
      parentSessionId: string
      sideChat: PersistedSideChat
    }): Promise<PersistedSideChat>
    clear(input: {
      projectId: string
      parentSessionId: string
      sideChatId: string
    }): Promise<boolean>
  }>
  onEvent: (event: SideChatRuntimeEvent) => void
  setParentInteractionsPaused?: (parentSessionId: string, paused: boolean) => void
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
  runtimeSessionId: string
  relaySenderIds: Set<string>
  runtime: SideChatRuntimePort
  jobRoot: string
  bridgeScopes: Map<HostMessageBridge, Set<string>>
  historyPreamble?: string
  entries: SideChatEntry[]
  entrySequence: number
  running: boolean
  error?: string
  reconnect?: Promise<void>
  turn?: Promise<PromptResponse>
  turnAccepted?: Deferred
  closing: boolean
  frameworkId: PersistedSideChat['frameworkId']
  backendId?: string
  providerSessionId?: string
  providerContinuityToken?: string
  model?: string
  createdAt: number
  persistTail: Promise<void>
  queuedPersist?: Promise<void>
  queuedPersistLifecycle?: PersistedSideChat['lifecycle']
  needsReplay?: boolean
}

const nextEntrySequence = (entries: readonly SideChatEntry[]): number =>
  entries.reduce((highest, entry) => {
    const match = /^user-(\d+)$/.exec(entry.id)
    const sequence = match ? Number(match[1]) : Number.NaN
    return Number.isSafeInteger(sequence) ? Math.max(highest, sequence) : highest
  }, entries.length)

type DormantSideChat = {
  revision: number
  parentSessionId: string
  projectId: string
  sideChat: PersistedSideChat
  activating?: Promise<ActiveSideChat>
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
    description: 'Restricted Side chat with one relationship-bound message tool.',
    systemPrompt: SIDE_CHAT_SYSTEM_PROMPT,
    openCodePermissions: {
      '*': 'deny',
      [modelFacingAppMcpToolName(
        'opencode',
        HOST_MESSAGE_MCP_SERVER_NAME,
        HOST_SEND_MESSAGE_TOOL_NAME
      )]: 'allow'
    },
    persistSession: true
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

const boundedPersistedEntries = (entries: readonly SideChatEntry[]): SideChatEntry[] => {
  const reversed: SideChatEntry[] = []
  let jsonChars = 2
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    const boundedEntry =
      entry.kind === 'message' && entry.text.length > SIDE_CHAT_MESSAGE_LIMIT
        ? {
            ...entry,
            text:
              PERSISTED_MESSAGE_TRUNCATION_PREFIX +
              entry.text.slice(
                -(SIDE_CHAT_MESSAGE_LIMIT - PERSISTED_MESSAGE_TRUNCATION_PREFIX.length)
              )
          }
        : { ...entry }
    const entryChars = JSON.stringify(boundedEntry).length + (reversed.length > 0 ? 1 : 0)
    if (
      reversed.length >= MAX_PERSISTED_SIDE_CHAT_ENTRIES ||
      jsonChars + entryChars > MAX_PERSISTED_SIDE_CHAT_TRANSCRIPT_JSON_CHARS
    ) {
      break
    }
    reversed.push(boundedEntry)
    jsonChars += entryChars
  }
  return reversed.reverse()
}

class SideChatRuntimeOwner {
  private readonly root: string
  private readonly createRuntime: (options: AcpRuntimeOptions) => SideChatRuntimePort
  private readonly activeByParent = new Map<string, ActiveSideChat>()
  private readonly dormantByParent = new Map<string, DormantSideChat>()
  private readonly startingByParent = new Map<string, StartingSideChat>()
  private readonly closingByParent = new Map<string, Promise<void>>()
  private readonly closeRequestedParents = new Set<string>()
  private readonly invalidatedParents = new Set<string>()
  private readonly invalidatedProjects = new Set<string>()
  private readonly pausedParents = new Set<string>()
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

  hydrate(
    records: readonly {
      projectId: string
      parentSessionId: string
      sideChat: PersistedSideChat
    }[]
  ): void {
    for (const record of records) {
      if (this.activeByParent.has(record.parentSessionId)) continue
      this.dormantByParent.set(record.parentSessionId, {
        revision: ++this.revision,
        projectId: record.projectId,
        parentSessionId: record.parentSessionId,
        sideChat: structuredClone(record.sideChat)
      })
      this.setParentInteractionsPaused(record.parentSessionId, true)
    }
  }

  async sweepStaleProfiles(
    referencedIds: ReadonlySet<string> = new Set(),
    isComplete = true
  ): Promise<void> {
    await mkdir(this.root, { recursive: true })
    if (!isComplete) return
    const entries = await readdir(this.root, { withFileTypes: true })
    await Promise.all(
      entries.flatMap((entry) => {
        if (
          !entry.isDirectory() ||
          referencedIds.has(entry.name) ||
          (!entry.name.startsWith('chat-') && !entry.name.startsWith('side-chat-'))
        ) {
          return []
        }
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
          .filter(
            (starting) =>
              !this.invalidatedProjects.has(starting.projectId) &&
              !this.activeByParent.has(starting.parentSessionId)
          )
          .map((starting) => this.snapshotStarting(starting)),
        ...[...this.activeByParent.values()]
          .filter((active) => !this.invalidatedProjects.has(active.projectId))
          .map((active) => this.snapshotActive(active)),
        ...[...this.dormantByParent.values()]
          .filter(
            (dormant) =>
              !this.invalidatedProjects.has(dormant.projectId) &&
              !this.activeByParent.has(dormant.parentSessionId)
          )
          .map((dormant) => this.snapshotDormant(dormant))
      ]
    }
  }

  async start(request: SideChatRuntimeStartRequest): Promise<SideChatStartResponse> {
    if (this.shuttingDown) throw new Error('Side chat is shutting down.')
    if (this.invalidatedParents.has(request.parentSessionId)) {
      throw new Error('The parent Session is unavailable.')
    }
    if (this.invalidatedProjects.has(request.projectId)) {
      throw new Error('The parent Project is unavailable.')
    }
    if (
      this.activeByParent.has(request.parentSessionId) ||
      this.dormantByParent.has(request.parentSessionId) ||
      this.startingByParent.has(request.parentSessionId) ||
      this.closingByParent.has(request.parentSessionId)
    ) {
      throw new Error('A Side chat is already open.')
    }
    const text = requirePromptText(request.text)

    const sideChatId = `side-chat-${randomUUID()}`
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
    this.setParentInteractionsPaused(request.parentSessionId, true)
    try {
      await mkdir(this.root, { recursive: true })
      jobRoot = join(this.root, sideChatId)
      const cwd = join(jobRoot, 'cwd')
      const profileRoot = join(jobRoot, 'profile')
      await Promise.all([mkdir(cwd, { recursive: true }), mkdir(profileRoot, { recursive: true })])
      const resolveBackend = async (): Promise<ResolvedAgentBackend> => {
        const target = await this.options.captureTarget()
        let resolved = await this.options.resolveTarget(target, {
          systemPromptAppends: [SIDE_CHAT_SYSTEM_PROMPT],
          includeSkillAndConnectorContext: false,
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
        if (bridge && activeChat?.runtimeSessionId) {
          this.registerBridgeScope(activeChat, bridge)
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
              void this.suspendActive(activeChat, 'error').catch(() => undefined)
            }
          },
          onPermissionRequest: (permission) =>
            this.handlePermission(runtimeRef.current, permission),
          onProviderPromptAccepted: (sideSessionId) => {
            if (activeChat?.runtimeSessionId === sideSessionId) activeChat.turnAccepted?.resolve()
          }
        }
      }
      runtime = this.createRuntime(runtimeOptions)
      runtimeRef.current = runtime
      const created = await runtime.createSession({ cwd, projectId: request.projectId })
      activeChat = {
        revision: 0,
        parentSessionId: request.parentSessionId,
        projectId: request.projectId,
        sideSessionId: sideChatId,
        runtimeSessionId: created.sessionId,
        runtime,
        jobRoot,
        relaySenderIds: new Set(),
        bridgeScopes: new Map(),
        historyPreamble: request.historyPreamble,
        entries: [],
        entrySequence: 0,
        running: false,
        closing: false,
        frameworkId: created.frameworkId ?? initialBackend.framework.id,
        ...((created.backendId ?? initialBackend.backendId)
          ? { backendId: created.backendId ?? initialBackend.backendId }
          : {}),
        providerSessionId: created.providerSessionId ?? created.sessionId,
        ...(created.providerContinuityToken
          ? { providerContinuityToken: created.providerContinuityToken }
          : initialBackend.providerContinuityToken
            ? { providerContinuityToken: initialBackend.providerContinuityToken }
            : {}),
        ...(initialBackend.contextUsageModel || initialBackend.sessionModel
          ? { model: initialBackend.contextUsageModel ?? initialBackend.sessionModel }
          : {}),
        createdAt: Date.now(),
        persistTail: Promise.resolve()
      }
      if (bridge) this.registerBridgeScope(activeChat, bridge)
      this.activeByParent.set(request.parentSessionId, activeChat)
      this.touch(activeChat)
      if (this.closeRequestedParents.delete(request.parentSessionId)) {
        if (this.invalidatedProjects.has(request.projectId)) {
          await this.suspendActive(activeChat, 'interrupted')
        } else {
          await this.closeActive(activeChat)
        }
        throw new Error('Side chat closed before startup completed.')
      }
      await this.dispatch({
        sideSessionId: sideChatId,
        text,
        historyPreamble: request.historyPreamble
      })
      return {
        sideSessionId: sideChatId,
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
      if (!this.hasForParent(request.parentSessionId)) {
        this.setParentInteractionsPaused(request.parentSessionId, false)
      }
    }
  }

  send(request: SideChatPromptRequest & Readonly<{ historyPreamble?: string }>): Promise<void> {
    return this.dispatch(request)
  }

  parentFor(
    sideSessionId: string
  ): Readonly<{ parentSessionId: string; projectId: string }> | undefined {
    const chat = this.findActive(sideSessionId) ?? this.findDormant(sideSessionId)
    return chat ? { parentSessionId: chat.parentSessionId, projectId: chat.projectId } : undefined
  }

  hasForParent(parentSessionId: string): boolean {
    return (
      this.activeByParent.has(parentSessionId) ||
      this.dormantByParent.has(parentSessionId) ||
      this.startingByParent.has(parentSessionId) ||
      this.closingByParent.has(parentSessionId)
    )
  }

  async requestProviderReconnect(): Promise<void> {
    await Promise.all(
      this.activeChats().map(async (active) => {
        const previous = active.reconnect?.catch(() => undefined) ?? Promise.resolve()
        const reconnect = previous.then(() => active.runtime.requestProviderReconnect())
        active.reconnect = reconnect
        try {
          await reconnect
        } catch (error) {
          if (active.reconnect === reconnect) active.reconnect = undefined
          throw error
        }
      })
    )
  }

  async applyModelChange(target: AgentModelChangeTarget): Promise<boolean> {
    const results = await Promise.all(
      this.activeChats().map(async (active) => {
        const applied = await active.runtime.applyModelChange(target)
        if (applied) {
          active.frameworkId = target.frameworkId
          active.backendId = target.backendId
          active.model = target.model
          this.queuePersist(active, 'open')
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
    if (active.turn) await active.runtime.cancelPrompt({ sessionId: active.runtimeSessionId })
  }

  async close(request: SideChatSessionRequest): Promise<void> {
    const active = this.findActive(request.sideSessionId)
    if (active) {
      await this.closeActive(active)
      return
    }
    const dormant = this.findDormant(request.sideSessionId)
    if (dormant) {
      await this.closeActiveForParent(dormant.parentSessionId)
      return
    }
    throw new Error('Side chat Session is not active.')
  }

  async closeActiveForParent(parentSessionId: string): Promise<void> {
    const starting = this.startingByParent.get(parentSessionId)
    const activating = this.dormantByParent.get(parentSessionId)?.activating
    if (starting || activating) this.closeRequestedParents.add(parentSessionId)
    const active = this.activeByParent.get(parentSessionId)
    if (active) await this.closeActive(active)
    const dormant = this.dormantByParent.get(parentSessionId)
    if (dormant && !dormant.activating) await this.closeDormant(dormant)
    if (starting) {
      await starting.done.promise
      const started = this.activeByParent.get(parentSessionId)
      if (started) await this.closeActive(started)
    }
    if (activating) {
      await activating.catch(() => undefined)
      const activated = this.activeByParent.get(parentSessionId)
      if (activated) await this.closeActive(activated)
      const stillDormant = this.dormantByParent.get(parentSessionId)
      if (stillDormant) await this.closeDormant(stillDormant)
      this.closeRequestedParents.delete(parentSessionId)
    }
  }

  async closeForParent(parentSessionId: string): Promise<void> {
    await this.closeActiveForParent(parentSessionId)
  }

  async invalidateParents(parentSessionIds: readonly string[]): Promise<void> {
    const parentSessionIdsToInvalidate = parentSessionIds.filter((parentSessionId) => {
      const dormant = this.dormantByParent.get(parentSessionId)
      return !dormant || !this.invalidatedProjects.has(dormant.projectId)
    })
    for (const parentSessionId of parentSessionIdsToInvalidate) {
      this.invalidatedParents.add(parentSessionId)
    }
    await Promise.all(
      parentSessionIdsToInvalidate.map(async (parentSessionId) => {
        try {
          await this.closeActiveForParent(parentSessionId)
        } finally {
          this.options.relay.releaseParent(parentSessionId)
        }
      })
    )
  }

  async invalidateProject(projectId: string): Promise<void> {
    this.invalidatedProjects.add(projectId)
    const starting = [...this.startingByParent.values()].filter(
      (candidate) => candidate.projectId === projectId
    )
    const activating = [...this.dormantByParent.values()].filter(
      (candidate) => candidate.projectId === projectId && candidate.activating
    )
    for (const candidate of [...starting, ...activating]) {
      this.closeRequestedParents.add(candidate.parentSessionId)
    }
    const operations = [
      ...[...this.activeByParent.values()]
        .filter((active) => active.projectId === projectId)
        .map((active) => this.suspendActive(active, 'interrupted')),
      ...starting.map((candidate) => candidate.done.promise),
      ...activating.map((candidate) =>
        candidate.activating!.then(
          () => undefined,
          () => undefined
        )
      )
    ]
    const results = await Promise.allSettled(operations)
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (failures.length > 0) {
      throw new AggregateError(failures, `Side chat Project invalidation failed: ${projectId}`)
    }
  }

  restoreProject(projectId: string): void {
    if (!this.invalidatedProjects.delete(projectId)) return
    for (const dormant of this.dormantByParent.values()) {
      if (dormant.projectId !== projectId) continue
      dormant.revision = ++this.revision
      this.closeRequestedParents.delete(dormant.parentSessionId)
      this.setParentInteractionsPaused(dormant.parentSessionId, true)
    }
  }

  async completeProjectDeletion(projectId: string): Promise<void> {
    const dormantChats = [...this.dormantByParent.values()].filter(
      (dormant) => dormant.projectId === projectId
    )
    const cleanupResults = await Promise.allSettled(
      dormantChats.map((dormant) =>
        rm(join(this.root, dormant.sideChat.id), { recursive: true, force: true })
      )
    )
    const cleanupFailures = cleanupResults.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, `Side chat Project cleanup failed: ${projectId}`)
    }

    for (const dormant of dormantChats) {
      this.options.relay.releaseParent(dormant.parentSessionId)
      this.dormantByParent.delete(dormant.parentSessionId)
      this.closeRequestedParents.delete(dormant.parentSessionId)
      this.setParentInteractionsPaused(dormant.parentSessionId, false)
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    const failures: unknown[] = []
    const settle = async (operations: readonly Promise<unknown>[]): Promise<void> => {
      const results = await Promise.allSettled(operations)
      for (const result of results) {
        if (result.status === 'rejected') failures.push(result.reason)
      }
    }
    const starting = [...this.startingByParent.values()]
    const activating = [...this.dormantByParent.values()]
      .map((dormant) => dormant.activating)
      .filter((activation): activation is Promise<ActiveSideChat> => Boolean(activation))
    for (const chat of starting) this.closeRequestedParents.add(chat.parentSessionId)
    await settle(this.activeChats().map((active) => this.suspendActive(active)))
    await Promise.all(activating.map((activation) => activation.catch(() => undefined)))
    await settle(starting.map((chat) => chat.done.promise))
    await settle(this.activeChats().map((active) => this.suspendActive(active)))
    await settle([...this.closingByParent.values()])
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Side chat shutdown did not persist every conversation.')
    }
  }

  private async dispatch(
    request: SideChatPromptRequest & { historyPreamble?: string }
  ): Promise<void> {
    const text = requirePromptText(request.text)
    const active = await this.ensureActive(request.sideSessionId)
    if (this.shuttingDown) throw new Error('Side chat is shutting down.')
    if (active.turn || active.running) throw new Error('A Side chat prompt is already running.')
    await this.flushQueuedPersistence(active)
    let historyPreamble = request.historyPreamble
    let needsReplay = active.needsReplay === true
    if (needsReplay) {
      historyPreamble = buildResumeFallback(active)
    }
    while (active.reconnect) {
      const reconnect = active.reconnect
      await reconnect
      if (active.reconnect !== reconnect) continue
      const resumed = await active.runtime.resumeSession({
        sessionId: active.runtimeSessionId,
        ...(active.providerSessionId ? { providerSessionId: active.providerSessionId } : {}),
        ...(active.providerContinuityToken
          ? { providerContinuityToken: active.providerContinuityToken }
          : {}),
        cwd: join(active.jobRoot, 'cwd'),
        projectId: active.projectId,
        previousFrameworkId: active.frameworkId,
        ...(active.backendId ? { previousBackendId: active.backendId } : {})
      })
      this.applyProviderIdentity(active, resumed)
      this.syncBridgeScopes(active)
      if (active.reconnect === reconnect) active.reconnect = undefined
      if (resumed.contextReset) {
        needsReplay = true
        active.needsReplay = true
        historyPreamble = buildResumeFallback(active)
      }
      await this.persistActive(active, 'open')
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
    try {
      await this.persistActive(active, 'open')
    } catch (error) {
      active.entries.pop()
      active.entrySequence -= 1
      active.running = false
      active.error = error instanceof Error ? error.message : 'Side chat could not be saved.'
      active.needsReplay = needsReplay
      this.touch(active)
      throw error
    }
    const accepted = deferred()
    active.turnAccepted = accepted
    const turn = active.runtime.sendPrompt({
      sessionId: active.runtimeSessionId,
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
        if (active.closing || this.activeByParent.get(active.parentSessionId) !== active) return
        if (active.running) {
          active.running = false
          this.touch(active)
          this.queuePersist(active, 'open')
        }
        finish()
      },
      (error) => {
        accepted.reject(error)
        if (active.closing || this.activeByParent.get(active.parentSessionId) !== active) return
        active.running = false
        active.error = error instanceof Error ? error.message : 'Side chat failed.'
        this.touch(active)
        this.queuePersist(active, 'error')
        finish()
      }
    )
    await accepted.promise
    if (needsReplay) active.needsReplay = false
  }

  private async ensureActive(sideSessionId: string): Promise<ActiveSideChat> {
    const active = this.findActive(sideSessionId)
    if (active) return active
    const dormant = this.findDormant(sideSessionId)
    if (!dormant) throw new Error('Side chat Session is not active.')
    if (!dormant.activating) {
      dormant.activating = this.activateDormant(dormant).finally(() => {
        dormant.activating = undefined
      })
    }
    return dormant.activating
  }

  private async activateDormant(dormant: DormantSideChat): Promise<ActiveSideChat> {
    if (this.shuttingDown) throw new Error('Side chat is shutting down.')
    const sideChat = dormant.sideChat
    const jobRoot = join(this.root, sideChat.id)
    const cwd = join(jobRoot, 'cwd')
    const profileRoot = join(jobRoot, 'profile')
    await Promise.all([mkdir(cwd, { recursive: true }), mkdir(profileRoot, { recursive: true })])

    let backend: ResolvedAgentBackend | undefined
    let backendTransferred = false
    let runtime: SideChatRuntimePort | undefined
    let activeChat: ActiveSideChat | undefined
    try {
      const resolveBackend = async (): Promise<ResolvedAgentBackend> => {
        const target = await this.options.captureTarget()
        let resolved = await this.options.resolveTarget(target, {
          systemPromptAppends: [SIDE_CHAT_SYSTEM_PROMPT],
          includeSkillAndConnectorContext: false,
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
        if (bridge && activeChat?.runtimeSessionId) {
          this.registerBridgeScope(activeChat, bridge)
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
            return this.sendToMain(activeChat, routingId, input)
          }
        },
        callbacks: {
          onEvent: (event) => {
            if (activeChat) this.handleRuntimeEvent(activeChat, event)
          },
          onStateChanged: (state) => {
            if (activeChat && (state.status === 'error' || state.status === 'closed')) {
              const reason = state.status === 'error' ? 'connection-error' : 'connection-closed'
              this.handleRuntimeClosed(activeChat, reason)
              void this.suspendActive(activeChat, 'error').catch(() => undefined)
            }
          },
          onPermissionRequest: (permission) =>
            this.handlePermission(runtimeRef.current, permission),
          onProviderPromptAccepted: (runtimeSessionId) => {
            if (activeChat?.runtimeSessionId === runtimeSessionId) {
              activeChat.turnAccepted?.resolve()
            }
          }
        }
      }
      runtime = this.createRuntime(runtimeOptions)
      runtimeRef.current = runtime
      activeChat = {
        revision: dormant.revision,
        parentSessionId: dormant.parentSessionId,
        projectId: dormant.projectId,
        sideSessionId: sideChat.id,
        runtimeSessionId: sideChat.id,
        runtime,
        jobRoot,
        relaySenderIds: new Set(),
        bridgeScopes: new Map(),
        historyPreamble: sideChat.historyPreamble,
        entries: sideChat.entries.map((entry) => ({ ...entry })),
        entrySequence: nextEntrySequence(sideChat.entries),
        running: false,
        closing: false,
        frameworkId: sideChat.frameworkId,
        ...(sideChat.backendId ? { backendId: sideChat.backendId } : {}),
        ...(sideChat.providerSessionId ? { providerSessionId: sideChat.providerSessionId } : {}),
        ...(sideChat.providerContinuityToken
          ? { providerContinuityToken: sideChat.providerContinuityToken }
          : {}),
        ...(sideChat.model ? { model: sideChat.model } : {}),
        createdAt: sideChat.createdAt,
        persistTail: Promise.resolve()
      }
      if (bridge) this.registerBridgeScope(activeChat, bridge)
      const resumed = await runtime.resumeSession({
        sessionId: sideChat.id,
        ...(sideChat.providerSessionId ? { providerSessionId: sideChat.providerSessionId } : {}),
        ...(sideChat.providerContinuityToken
          ? { providerContinuityToken: sideChat.providerContinuityToken }
          : {}),
        cwd,
        projectId: dormant.projectId,
        previousFrameworkId: sideChat.frameworkId,
        ...(sideChat.backendId ? { previousBackendId: sideChat.backendId } : {})
      })
      this.applyProviderIdentity(activeChat, resumed, initialBackend)
      this.syncBridgeScopes(activeChat)
      if (resumed.contextReset) activeChat.needsReplay = true
      this.dormantByParent.delete(dormant.parentSessionId)
      this.activeByParent.set(dormant.parentSessionId, activeChat)
      this.touch(activeChat)
      if (this.closeRequestedParents.delete(dormant.parentSessionId)) {
        if (this.invalidatedProjects.has(dormant.projectId)) {
          await this.suspendActive(activeChat, 'interrupted')
        } else {
          await this.closeActive(activeChat)
        }
        throw new Error('Side chat closed while reconnecting.')
      }
      await this.persistActive(activeChat, 'open')
      return activeChat
    } catch (error) {
      if (activeChat?.closing) throw error
      if (activeChat) {
        if (this.activeByParent.get(dormant.parentSessionId) === activeChat) {
          this.activeByParent.delete(dormant.parentSessionId)
        }
        this.unregisterBridgeScopes(activeChat)
        this.releaseRelaySenders(activeChat)
      }
      await runtime?.shutdownForQuit().catch(() => undefined)
      if (backend && !backendTransferred) await releaseUnattachedBackend(backend)
      const retryableSideChat: PersistedSideChat = activeChat
        ? {
            ...sideChat,
            lifecycle: 'error',
            frameworkId: activeChat.frameworkId,
            ...(activeChat.backendId ? { backendId: activeChat.backendId } : {}),
            ...(activeChat.providerSessionId
              ? { providerSessionId: activeChat.providerSessionId }
              : {}),
            ...(activeChat.providerContinuityToken
              ? { providerContinuityToken: activeChat.providerContinuityToken }
              : {}),
            ...(activeChat.model ? { model: activeChat.model } : {}),
            entries: boundedPersistedEntries(activeChat.entries),
            updatedAt: Math.max(sideChat.updatedAt + 1, Date.now())
          }
        : {
            ...sideChat,
            lifecycle: 'error',
            updatedAt: Math.max(sideChat.updatedAt + 1, Date.now())
          }
      const failed = await this.options.persistence
        .save({
          projectId: dormant.projectId,
          parentSessionId: dormant.parentSessionId,
          sideChat: retryableSideChat
        })
        .catch(() => undefined)
      dormant.sideChat = failed ?? retryableSideChat
      dormant.revision = ++this.revision
      this.dormantByParent.set(dormant.parentSessionId, dormant)
      throw error
    }
  }

  private applyProviderIdentity(
    active: ActiveSideChat,
    response: AcpCreateSessionResponse,
    backend?: ResolvedAgentBackend
  ): void {
    active.runtimeSessionId = response.sessionId
    active.frameworkId = response.frameworkId ?? backend?.framework.id ?? active.frameworkId
    active.backendId = response.backendId ?? backend?.backendId ?? active.backendId
    active.providerSessionId = response.providerSessionId ?? active.providerSessionId
    active.providerContinuityToken =
      response.providerContinuityToken ??
      backend?.providerContinuityToken ??
      active.providerContinuityToken
    active.model = backend?.contextUsageModel ?? backend?.sessionModel ?? active.model
  }

  private persistActive(
    active: ActiveSideChat,
    lifecycle: PersistedSideChat['lifecycle']
  ): Promise<PersistedSideChat> {
    const updatedAt = Math.max(active.createdAt, Date.now())
    const projection: PersistedSideChat = {
      version: 1,
      id: active.sideSessionId,
      lifecycle,
      frameworkId: active.frameworkId,
      ...(active.backendId ? { backendId: active.backendId } : {}),
      ...(active.providerSessionId ? { providerSessionId: active.providerSessionId } : {}),
      ...(active.providerContinuityToken
        ? { providerContinuityToken: active.providerContinuityToken }
        : {}),
      ...(active.model ? { model: active.model } : {}),
      historyPreamble: active.historyPreamble ?? '',
      entries: boundedPersistedEntries(active.entries),
      createdAt: active.createdAt,
      updatedAt
    }
    let persisted: PersistedSideChat | undefined
    const write = active.persistTail
      .catch(() => undefined)
      .then(async () => {
        persisted = await this.options.persistence.save({
          projectId: active.projectId,
          parentSessionId: active.parentSessionId,
          sideChat: projection
        })
      })
    active.persistTail = write
    return write.then(() => persisted!)
  }

  private registerBridgeScope(active: ActiveSideChat, bridge: HostMessageBridge): void {
    const providerSessionId = active.providerSessionId ?? active.runtimeSessionId
    const registered = active.bridgeScopes.get(bridge) ?? new Set<string>()
    if (registered.has(providerSessionId)) return
    bridge.registerHostMessageSession?.(
      providerSessionId,
      HOST_MESSAGE_NAMESPACED_TOOLS.map((tool) => ({ ...tool })),
      { failClosedUnknownKeys: true }
    )
    registered.add(providerSessionId)
    active.bridgeScopes.set(bridge, registered)
  }

  private syncBridgeScopes(active: ActiveSideChat): void {
    const providerSessionId = active.providerSessionId ?? active.runtimeSessionId
    for (const [bridge, registered] of active.bridgeScopes) {
      for (const staleSessionId of [...registered]) {
        if (staleSessionId === providerSessionId) continue
        bridge.unregisterHostMessageSession?.(staleSessionId)
        registered.delete(staleSessionId)
      }
      this.registerBridgeScope(active, bridge)
    }
  }

  private unregisterBridgeScopes(active: ActiveSideChat): void {
    for (const [bridge, runtimeSessionIds] of active.bridgeScopes) {
      for (const runtimeSessionId of runtimeSessionIds) {
        bridge.unregisterHostMessageSession?.(runtimeSessionId)
      }
    }
    active.bridgeScopes.clear()
  }

  private queuePersist(active: ActiveSideChat, lifecycle: PersistedSideChat['lifecycle']): void {
    active.queuedPersistLifecycle =
      lifecycle === 'error' || active.queuedPersistLifecycle === 'error' ? 'error' : lifecycle
    if (active.queuedPersist) return
    const queued = Promise.resolve().then(async () => {
      while (active.queuedPersistLifecycle) {
        const nextLifecycle = active.queuedPersistLifecycle
        active.queuedPersistLifecycle = undefined
        await this.persistActive(active, nextLifecycle)
      }
    })
    active.queuedPersist = queued
    void queued
      .catch((error) => {
        if (active.closing) return
        active.running = false
        active.error = error instanceof Error ? error.message : 'Side chat could not be saved.'
        this.touch(active)
      })
      .finally(() => {
        if (active.queuedPersist === queued) active.queuedPersist = undefined
        if (active.queuedPersistLifecycle && !active.closing) {
          this.queuePersist(active, active.queuedPersistLifecycle)
        }
      })
  }

  private async flushQueuedPersistence(active: ActiveSideChat): Promise<void> {
    while (active.queuedPersist) {
      await active.queuedPersist.catch(() => undefined)
    }
  }

  private sendToMain(
    active: ActiveSideChat,
    routingId: string,
    request: SideChatSendMessageRequest
  ): Promise<SideChatSendMessageResult> {
    if (active.closing || this.activeByParent.get(active.parentSessionId) !== active) {
      throw new Error('Side chat sender is no longer active.')
    }
    if (!active.relaySenderIds.has(routingId)) {
      this.options.relay.bind({
        sideSessionId: routingId,
        sideChatId: active.sideSessionId,
        parentSessionId: active.parentSessionId,
        projectId: active.projectId
      })
      active.relaySenderIds.add(routingId)
    }
    return this.options.relay
      .send({ sideSessionId: routingId, ...request })
      .then((queued) =>
        this.options.deliverRelay
          ? this.options.deliverRelay(active.parentSessionId, queued)
          : queued
      )
  }

  private releaseRelaySenders(active: ActiveSideChat): void {
    for (const routingId of active.relaySenderIds) this.options.relay.releaseSide(routingId)
    active.relaySenderIds.clear()
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
      .then((accepted) => {
        log.info('host message permission resolved', {
          toolCallId: request.toolCallId,
          sessionId: request.sessionId,
          decision: allow ? 'allowed' : 'cancelled',
          accepted
        })
      })
      .catch((error) => {
        log.warn('host message permission response failed', {
          toolCallId: request.toolCallId,
          sessionId: request.sessionId,
          ...diagnosticErrorFields(error)
        })
      })
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
    this.queuePersist(active, event.kind === 'error' ? 'error' : 'open')
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
    this.emitRuntimeClosed(active, reason)
  }

  private emitRuntimeClosed(
    active: ActiveSideChat,
    reason: 'closed' | 'connection-error' | 'connection-closed'
  ): void {
    this.options.onEvent({
      revision: this.touch(active),
      parentSessionId: active.parentSessionId,
      projectId: active.projectId,
      sideSessionId: active.sideSessionId,
      event: { kind: 'closed', reason }
    })
  }

  private requireActive(sideSessionId: string): ActiveSideChat {
    const active = this.findActive(sideSessionId)
    if (active) return active
    throw new Error('Side chat Session is not active.')
  }

  private findActive(sideSessionId: string): ActiveSideChat | undefined {
    for (const active of this.activeByParent.values()) {
      if (active.sideSessionId === sideSessionId && !active.closing) return active
    }
    return undefined
  }

  private findDormant(sideSessionId: string): DormantSideChat | undefined {
    for (const dormant of this.dormantByParent.values()) {
      if (dormant.sideChat.id === sideSessionId) return dormant
    }
    return undefined
  }

  private activeChats(): ActiveSideChat[] {
    return [...this.activeByParent.values()].filter((active) => !active.closing)
  }

  private touch(chat: ActiveSideChat | StartingSideChat): number {
    chat.revision = ++this.revision
    return chat.revision
  }

  private setParentInteractionsPaused(parentSessionId: string, paused: boolean): void {
    if (paused) {
      if (this.pausedParents.has(parentSessionId)) return
      this.pausedParents.add(parentSessionId)
    } else if (!this.pausedParents.delete(parentSessionId)) {
      return
    }
    this.options.setParentInteractionsPaused?.(parentSessionId, paused)
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

  private snapshotDormant(dormant: DormantSideChat): SideChatSnapshot {
    const lifecycle = dormant.sideChat.lifecycle
    return {
      revision: dormant.revision,
      parentSessionId: dormant.parentSessionId,
      projectId: dormant.projectId,
      sideSessionId: dormant.sideChat.id,
      entries: dormant.sideChat.entries.map((entry) => ({ ...entry })),
      running: false,
      ...(lifecycle === 'interrupted'
        ? { error: 'Side chat was interrupted when the app closed. Send a Follow up to continue.' }
        : lifecycle === 'error'
          ? { error: 'Side chat connection ended. Send a Follow up to reconnect.' }
          : {})
    }
  }

  private async closeActive(active: ActiveSideChat, notify = true): Promise<void> {
    const existing = this.closingByParent.get(active.parentSessionId)
    if (existing) return existing
    if (active.closing || this.activeByParent.get(active.parentSessionId) !== active) {
      return
    }
    active.closing = true
    this.touch(active)
    const closing = this.destroyActive(active)
    this.closingByParent.set(active.parentSessionId, closing)
    try {
      await closing
      this.activeByParent.delete(active.parentSessionId)
      this.setParentInteractionsPaused(active.parentSessionId, false)
      if (notify) this.emitRuntimeClosed(active, 'closed')
    } catch (error) {
      active.closing = false
      active.running = false
      active.error = error instanceof Error ? error.message : 'Side chat could not be closed.'
      this.touch(active)
      throw error
    } finally {
      if (isCurrentInFlight(this.closingByParent.get(active.parentSessionId), closing)) {
        this.closingByParent.delete(active.parentSessionId)
      }
    }
  }

  private async suspendActive(
    active: ActiveSideChat,
    lifecycle: PersistedSideChat['lifecycle'] = active.turn ? 'interrupted' : 'open'
  ): Promise<void> {
    const existing = this.closingByParent.get(active.parentSessionId)
    if (existing) return existing
    if (active.closing || this.activeByParent.get(active.parentSessionId) !== active) return
    active.closing = true
    active.turnAccepted?.reject(new Error('Side chat runtime stopped.'))
    if (active.turn) {
      await active.runtime
        .cancelPrompt({ sessionId: active.runtimeSessionId })
        .catch(() => undefined)
    }
    active.running = false
    await this.flushQueuedPersistence(active)
    let persistError: unknown
    let persisted: PersistedSideChat
    try {
      persisted = await this.persistActive(active, lifecycle)
    } catch (error) {
      persistError = error
      persisted = {
        version: 1,
        id: active.sideSessionId,
        lifecycle: 'error',
        frameworkId: active.frameworkId,
        ...(active.backendId ? { backendId: active.backendId } : {}),
        ...(active.providerSessionId ? { providerSessionId: active.providerSessionId } : {}),
        ...(active.providerContinuityToken
          ? { providerContinuityToken: active.providerContinuityToken }
          : {}),
        ...(active.model ? { model: active.model } : {}),
        historyPreamble: active.historyPreamble ?? '',
        entries: boundedPersistedEntries(active.entries),
        createdAt: active.createdAt,
        updatedAt: Math.max(active.createdAt, Date.now())
      }
    }
    await active.runtime.shutdownForQuit().catch(() => undefined)
    this.releaseRelaySenders(active)
    this.unregisterBridgeScopes(active)
    this.activeByParent.delete(active.parentSessionId)
    const dormant: DormantSideChat = {
      revision: ++this.revision,
      parentSessionId: active.parentSessionId,
      projectId: active.projectId,
      sideChat: persisted
    }
    this.dormantByParent.set(active.parentSessionId, dormant)
    if (persistError) throw persistError
  }

  private async destroyActive(active: ActiveSideChat): Promise<void> {
    await this.flushQueuedPersistence(active)
    await active.persistTail.catch(() => undefined)
    if (
      !this.invalidatedParents.has(active.parentSessionId) &&
      !this.invalidatedProjects.has(active.projectId)
    ) {
      await this.options.persistence.clear({
        projectId: active.projectId,
        parentSessionId: active.parentSessionId,
        sideChatId: active.sideSessionId
      })
    }
    active.turnAccepted?.reject(new Error('Side chat closed.'))
    this.releaseRelaySenders(active)
    if (active.turn) {
      await active.runtime
        .cancelPrompt({ sessionId: active.runtimeSessionId })
        .catch(() => undefined)
    }
    await active.runtime
      .deleteSession({ sessionId: active.runtimeSessionId })
      .catch(() => undefined)
    await active.runtime.shutdownForQuit().catch(() => undefined)
    this.unregisterBridgeScopes(active)
    await rm(active.jobRoot, { recursive: true, force: true }).catch(() => undefined)
  }

  private async closeDormant(dormant: DormantSideChat): Promise<void> {
    const existing = this.closingByParent.get(dormant.parentSessionId)
    if (existing) return existing
    dormant.revision = ++this.revision
    const closing = (async (): Promise<void> => {
      if (
        !this.invalidatedParents.has(dormant.parentSessionId) &&
        !this.invalidatedProjects.has(dormant.projectId)
      ) {
        await this.options.persistence.clear({
          projectId: dormant.projectId,
          parentSessionId: dormant.parentSessionId,
          sideChatId: dormant.sideChat.id
        })
      }
      await rm(join(this.root, dormant.sideChat.id), { recursive: true, force: true }).catch(
        () => undefined
      )
      this.dormantByParent.delete(dormant.parentSessionId)
      this.setParentInteractionsPaused(dormant.parentSessionId, false)
      this.options.onEvent({
        revision: dormant.revision,
        parentSessionId: dormant.parentSessionId,
        projectId: dormant.projectId,
        sideSessionId: dormant.sideChat.id,
        event: { kind: 'closed', reason: 'closed' }
      })
    })()
    this.closingByParent.set(dormant.parentSessionId, closing)
    try {
      await closing
    } finally {
      if (isCurrentInFlight(this.closingByParent.get(dormant.parentSessionId), closing)) {
        this.closingByParent.delete(dormant.parentSessionId)
      }
    }
  }
}

export { SIDE_CHAT_SYSTEM_PROMPT, SideChatRuntimeOwner, prepareSideChatBackend }
export type { SideChatRuntimeOwnerOptions, SideChatRuntimePort, SideChatRuntimeStartRequest }
