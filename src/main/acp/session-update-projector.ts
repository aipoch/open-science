import type { SessionNotification } from '@agentclientprotocol/sdk'

import type { AcpContextUsage, AcpRuntimeEvent } from '../../shared/acp'
import type { SessionPermissionProfileState } from '../../shared/permission-profiles'
import type { AgentFrameworkId } from '../../shared/settings'
import { resolveCanonicalMcpToolIdentity } from '../agent-framework/app-mcp-names'
import { CodexSkillActivityProjector } from './codex-skill-activity'
import type { AcpContextUsagePolicy } from './context-usage-policy'
import type { ContextUsageTracker, SessionUpdateObservation } from './context-usage-tracker'
import { isMcpToolName } from './permission-policy'
import { applyCurrentModeUpdate } from './permission-profile-controller'
import {
  extractProviderToolName,
  extractToolFailureText,
  toAcpRuntimeEvent
} from './runtime-events'
import type { AcpSessionRegistry } from './session-registry'
import { isRecord } from '../value-guards'
import { CodeBuddyOutputAdapter } from './codebuddy-output-adapter'

const CODEX_COMPACTION_WARNING =
  'Warning: Heads up: Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible to keep threads small and targeted.'
const CODEX_LEGACY_COMPACTION_NOTICE = "*Context compacted to fit the model's context window.*"
const AGENT_USER_CHOICE_TOOL = 'open-science-notebook/ask_user_question'

const isCodexAppOwnedUserChoiceTool = (
  notification: Readonly<SessionNotification>,
  event: Readonly<AcpRuntimeEvent>,
  routing: AcpSessionUpdateRouting
): boolean => {
  if (routing.framework !== 'codex' || event.kind !== 'tool' || !isRecord(event.rawInput)) {
    return false
  }
  const meta = (notification.update as SessionNotification['update'] & { _meta?: unknown })._meta
  if (!isRecord(meta) || meta.is_mcp_tool_call !== true) return false

  const server = event.rawInput.server
  const tool = event.rawInput.tool
  if (typeof server !== 'string' || typeof tool !== 'string') return false
  return (
    resolveCanonicalMcpToolIdentity(`mcp.${server}.${tool}`, routing.mcpServerNames) ===
    AGENT_USER_CHOICE_TOOL
  )
}

type AcpSessionUpdateRouting = Readonly<{
  framework?: AgentFrameworkId
  appSessionId?: string
  eventId: string
  timestamp?: number
  visible: boolean
  reconnectPending: boolean
  mcpServerNames: readonly string[]
}>

type AcpSessionUpdateRouteInput = Readonly<{
  appSessionId?: string
  visible?: boolean
  emitState?: () => void
}>

type AcpSessionUpdateProjectorOptions = Readonly<{
  registry: Pick<AcpSessionRegistry, 'lookup'>
  contextUsage: Pick<
    ContextUsageTracker,
    | 'beginSession'
    | 'confirmProviderCompaction'
    | 'observeSessionUpdate'
    | 'reconcileProviderUsage'
    | 'refreshUsage'
    | 'usage'
  >
  contextPolicy: Pick<AcpContextUsagePolicy, 'resolve'>
  hasActiveSession: (sessionId: string) => boolean
  currentFramework: () => AgentFrameworkId
  reconnectPending: () => boolean
  mcpServerNamesFor: (sessionId: string) => readonly string[]
  presentationToolCallId: (
    notification: SessionNotification,
    context: Readonly<{
      sessionId: string
      framework: AgentFrameworkId
      mcpServerNames: readonly string[]
    }>,
    providerToolCallId: string
  ) => string
  nextEventId: () => string
  setProviderPermissionProfile: (
    sessionId: string,
    profile: Readonly<SessionPermissionProfileState>
  ) => boolean
  emitState: () => void
  pushEvent: (event: Readonly<AcpRuntimeEvent>) => void
  reportToolFailure: (
    effect: Extract<AcpSessionUpdateEffect, { kind: 'tool-failure-diagnostic' }>
  ) => void
}>

type AcpSessionUpdateEffect =
  | Readonly<{
      kind: 'context-observation'
      sessionId: string
      notification: Readonly<SessionNotification>
      observation: Readonly<SessionUpdateObservation>
    }>
  | Readonly<{
      kind: 'context-refresh'
      sessionId: string
    }>
  | Readonly<{
      kind: 'provider-usage'
      sessionId: string
      usage: Readonly<AcpContextUsage>
    }>
  | Readonly<{
      kind: 'provider-compaction-completed'
      sessionId: string
    }>
  | Readonly<{
      kind: 'current-mode'
      sessionId: string
      currentModeId: string
      framework: AgentFrameworkId
    }>
  | Readonly<{
      kind: 'tool-failure-diagnostic'
      tool?: string
      toolCallId?: string
      sessionId: string
      reason?: string
    }>
  | Readonly<{
      kind: 'visible-event'
      event: Readonly<AcpRuntimeEvent>
    }>

const deepFreeze = <Value>(value: Value): Value => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

const toolObservation = (
  notification: Readonly<SessionNotification>,
  mcpServerNames: readonly string[]
): SessionUpdateObservation => {
  const update = notification.update
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return {}

  const providerToolName = extractProviderToolName(update)
  if (
    isMcpToolName(update.title, mcpServerNames) ||
    isMcpToolName(providerToolName, mcpServerNames)
  ) {
    return { toolCategory: 'mcp' }
  }
  return update.sessionUpdate === 'tool_call' || update.title || providerToolName
    ? { toolCategory: 'tools' }
    : {}
}

// Translates provider Session notifications into immutable effects and applies them once in order;
// event retention, aggregates, and ContextUsageTracker remain the actual state writers.
class AcpSessionUpdateProjector {
  private readonly codexSkillActivity = new CodexSkillActivityProjector()
  private readonly appOwnedUserChoiceToolCallIds = new Map<string, Set<string>>()
  private readonly codeBuddyOutput = new CodeBuddyOutputAdapter()

  constructor(private readonly options: AcpSessionUpdateProjectorOptions) {}

  beginGeneration(codexSkillsRoot?: string): void {
    this.codexSkillActivity.setSkillsRoot(codexSkillsRoot)
  }

  clearGeneration(): void {
    this.codexSkillActivity.setSkillsRoot(undefined)
    this.appOwnedUserChoiceToolCallIds.clear()
    this.codeBuddyOutput.clear()
  }

  clearSession(sessionId: string): void {
    this.codexSkillActivity.clearSession(sessionId)
    this.appOwnedUserChoiceToolCallIds.delete(sessionId)
    this.codeBuddyOutput.clearSession(sessionId)
  }

  dispose(): void {
    this.clearGeneration()
  }

  route(notification: SessionNotification, input: AcpSessionUpdateRouteInput = {}): void {
    const sessionId = input.appSessionId ?? notification.sessionId
    const emitState = input.emitState ?? this.options.emitState
    const effects = this.project(notification, {
      framework:
        this.options.registry.lookup(sessionId)?.aggregate.snapshot().frameworkId ??
        this.options.currentFramework(),
      appSessionId: input.appSessionId,
      eventId: this.options.nextEventId(),
      visible: input.visible ?? true,
      reconnectPending: this.options.reconnectPending(),
      mcpServerNames: this.options.mcpServerNamesFor(sessionId)
    })

    for (const effect of effects) this.apply(effect, emitState)
  }

  private project(
    notification: SessionNotification,
    routing: AcpSessionUpdateRouting
  ): readonly AcpSessionUpdateEffect[] {
    const routed = structuredClone(notification)
    if (routing.appSessionId) routed.sessionId = routing.appSessionId
    deepFreeze(routed)

    const projection = this.codexSkillActivity.projectWithContext(
      toAcpRuntimeEvent(
        routed,
        routing.eventId,
        routing.timestamp,
        routing.framework === 'claude-code'
      )
    )
    const originalEvent = projection.event
    let projectedEvent =
      routing.framework === 'codebuddy' && originalEvent.kind === 'tool'
        ? this.codeBuddyOutput.projectToolEvent(
            routed.sessionId,
            originalEvent,
            routed.update.sessionUpdate === 'tool_call'
          )
        : originalEvent
    let codeBuddyVisibleEvents: readonly AcpRuntimeEvent[] | undefined
    if (
      routing.framework === 'codebuddy' &&
      routed.update.sessionUpdate === 'agent_message_chunk' &&
      originalEvent.kind === 'message' &&
      originalEvent.role === 'assistant' &&
      typeof originalEvent.text === 'string'
    ) {
      codeBuddyVisibleEvents = this.codeBuddyOutput.projectAssistantChunk(
        routed.sessionId,
        originalEvent
      )
      projectedEvent = codeBuddyVisibleEvents.at(-1) ?? {
        ...originalEvent,
        text: '',
        raw: undefined
      }
    }
    const unaliasedEvent =
      routing.framework === 'codex' &&
      projectedEvent.kind === 'message' &&
      projectedEvent.messageId === undefined &&
      projectedEvent.text?.trim() === CODEX_LEGACY_COMPACTION_NOTICE
        ? {
            id: projectedEvent.id,
            timestamp: projectedEvent.timestamp,
            level: projectedEvent.level,
            kind: 'compaction' as const,
            sessionId: projectedEvent.sessionId,
            status: 'completed',
            title: 'Context compacted',
            toolCallId: `context-compaction:${routing.eventId}`
          }
        : projectedEvent
    const event = deepFreeze(
      unaliasedEvent.kind === 'tool' && unaliasedEvent.toolCallId
        ? {
            ...unaliasedEvent,
            toolCallId: this.options.presentationToolCallId(
              notification,
              {
                sessionId: routed.sessionId,
                framework: routing.framework ?? this.options.currentFramework(),
                mcpServerNames: routing.mcpServerNames
              },
              unaliasedEvent.toolCallId
            )
          }
        : unaliasedEvent
    )
    // codex-acp 1.1.4 flattens Codex's post-compaction warning into an unscoped assistant chunk.
    // Keep the separate compaction notice, but do not attribute this adapter-authored warning to the model.
    if (
      routing.framework === 'codex' &&
      routed.update.sessionUpdate === 'agent_message_chunk' &&
      event.kind === 'message' &&
      event.messageId === undefined &&
      event.text?.trim() === CODEX_COMPACTION_WARNING
    ) {
      return Object.freeze([])
    }
    if (event.contextUsage && routing.reconnectPending) return Object.freeze([])

    const effects: AcpSessionUpdateEffect[] = []
    if (!routing.reconnectPending) {
      effects.push(
        deepFreeze({
          kind: 'context-observation' as const,
          sessionId: routed.sessionId,
          notification: routed,
          observation: projection.skillFile
            ? { toolCategory: 'skills', skillFilePath: projection.skillFile.path }
            : toolObservation(routed, routing.mcpServerNames)
        })
      )
    }

    if (routed.update.sessionUpdate === 'current_mode_update') {
      effects.push(
        deepFreeze({
          kind: 'current-mode' as const,
          sessionId: routed.sessionId,
          currentModeId: routed.update.currentModeId,
          framework: routing.framework ?? this.options.currentFramework()
        })
      )
    }

    if (
      !routing.reconnectPending &&
      routing.framework === 'codex' &&
      event.kind === 'compaction' &&
      event.status === 'completed'
    ) {
      effects.push(
        deepFreeze({
          kind: 'provider-compaction-completed' as const,
          sessionId: routed.sessionId
        })
      )
    }

    if (event.contextUsage) {
      effects.push(
        deepFreeze({
          kind: 'provider-usage' as const,
          sessionId: routed.sessionId,
          usage: event.contextUsage
        })
      )
      return Object.freeze(effects)
    }

    let appOwnedUserChoiceTool =
      event.kind === 'tool' &&
      ([event.providerToolName, event.title].some(
        (name) =>
          resolveCanonicalMcpToolIdentity(name, routing.mcpServerNames) === AGENT_USER_CHOICE_TOOL
      ) ||
        isCodexAppOwnedUserChoiceTool(routed, event, routing))
    if (event.kind === 'tool' && event.toolCallId) {
      const trackedToolCallIds = this.appOwnedUserChoiceToolCallIds.get(routed.sessionId)
      appOwnedUserChoiceTool ||= trackedToolCallIds?.has(event.toolCallId) === true
      if (appOwnedUserChoiceTool) {
        const nextToolCallIds = trackedToolCallIds ?? new Set<string>()
        nextToolCallIds.add(event.toolCallId)
        this.appOwnedUserChoiceToolCallIds.set(routed.sessionId, nextToolCallIds)
        if (event.status === 'completed' || event.status === 'failed') {
          nextToolCallIds.delete(event.toolCallId)
          if (nextToolCallIds.size === 0) {
            this.appOwnedUserChoiceToolCallIds.delete(routed.sessionId)
          }
        }
      }
    }

    if (routing.visible) {
      if (!routing.reconnectPending) {
        effects.push(deepFreeze({ kind: 'context-refresh' as const, sessionId: routed.sessionId }))
      }
      if (appOwnedUserChoiceTool) return Object.freeze(effects)
      if (event.kind === 'tool' && event.status === 'failed') {
        const canonicalTool = event.providerToolName
          ? resolveCanonicalMcpToolIdentity(event.providerToolName, routing.mcpServerNames)
          : undefined
        effects.push(
          deepFreeze({
            kind: 'tool-failure-diagnostic' as const,
            tool: canonicalTool ?? event.providerToolName ?? event.toolKind,
            toolCallId: event.toolCallId,
            sessionId: routed.sessionId,
            reason: extractToolFailureText(event.toolContent, event.rawOutput)
          })
        )
      }
      for (const visibleEvent of codeBuddyVisibleEvents ?? [event]) {
        if (
          (visibleEvent.kind === 'message' || visibleEvent.kind === 'thought') &&
          !visibleEvent.text
        ) {
          continue
        }
        effects.push(deepFreeze({ kind: 'visible-event' as const, event: visibleEvent }))
      }
    }

    return Object.freeze(effects)
  }

  private apply(effect: AcpSessionUpdateEffect, emitState: () => void): void {
    switch (effect.kind) {
      case 'context-observation':
        if (this.options.hasActiveSession(effect.sessionId)) {
          this.options.contextUsage.beginSession(
            effect.sessionId,
            this.options.contextPolicy.resolve(effect.sessionId).estimateInput
          )
        }
        this.options.contextUsage.observeSessionUpdate(
          effect.sessionId,
          effect.notification,
          effect.observation
        )
        break
      case 'current-mode': {
        const aggregate = this.options.registry.lookup(effect.sessionId)?.aggregate
        const profileState = aggregate?.snapshot().permissionProfile
        if (profileState) {
          const nextProfile = applyCurrentModeUpdate(
            profileState as SessionPermissionProfileState,
            effect.currentModeId,
            effect.framework === 'codebuddy' ? { fullAccessModeId: 'fullAccess' } : undefined
          )
          if (!this.options.setProviderPermissionProfile(effect.sessionId, nextProfile)) break
          aggregate.setPermissionProfile(nextProfile)
          emitState()
        }
        break
      }
      case 'provider-usage':
        this.options.contextUsage.reconcileProviderUsage(
          effect.sessionId,
          effect.usage,
          this.options.contextPolicy.resolve(effect.sessionId).selectedWindow
        )
        emitState()
        break
      case 'provider-compaction-completed':
        if (this.options.contextUsage.confirmProviderCompaction(effect.sessionId)) emitState()
        break
      case 'context-refresh':
        if (this.options.contextUsage.usage(effect.sessionId)?.breakdown?.status !== 'reconciled') {
          const resolved = this.options.contextPolicy.resolve(effect.sessionId)
          const size =
            resolved.selectedWindow ?? this.options.contextUsage.usage(effect.sessionId)?.size
          this.options.contextUsage.refreshUsage(effect.sessionId, 'preflight', size)
        }
        break
      case 'tool-failure-diagnostic':
        this.options.reportToolFailure(effect)
        break
      case 'visible-event':
        this.options.pushEvent(effect.event)
        break
    }
  }
}

export { AcpSessionUpdateProjector }
