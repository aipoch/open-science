import type { SessionNotification } from '@agentclientprotocol/sdk'

import type { AcpContextUsage, AcpRuntimeEvent } from '../../shared/acp'
import type { AgentFrameworkId } from '../../shared/settings'
import { resolveCanonicalMcpToolIdentity } from '../agent-framework/app-mcp-names'
import { CodexSkillActivityProjector } from './codex-skill-activity'
import type { SessionUpdateObservation } from './context-usage-tracker'
import { isMcpToolName } from './permission-policy'
import {
  extractProviderToolName,
  extractToolFailureText,
  toAcpRuntimeEvent
} from './runtime-events'

type AcpSessionUpdateRouting = Readonly<{
  framework?: AgentFrameworkId
  appSessionId?: string
  eventId: string
  timestamp?: number
  visible: boolean
  reconnectPending: boolean
  mcpServerNames: readonly string[]
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
      kind: 'current-mode'
      sessionId: string
      currentModeId: string
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

// Translates provider Session notifications into immutable application-owner effects. The runtime
// applies them once in order; event retention and context state remain with their existing owners.
class AcpSessionUpdateProjector {
  private readonly codexSkillActivity = new CodexSkillActivityProjector()

  beginGeneration(codexSkillsRoot?: string): void {
    this.codexSkillActivity.setSkillsRoot(codexSkillsRoot)
  }

  clearGeneration(): void {
    this.codexSkillActivity.setSkillsRoot(undefined)
  }

  clearSession(sessionId: string): void {
    this.codexSkillActivity.clearSession(sessionId)
  }

  dispose(): void {
    this.clearGeneration()
  }

  project(
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
    const event = deepFreeze(projection.event)
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
          currentModeId: routed.update.currentModeId
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

    if (routing.visible) {
      if (!routing.reconnectPending) {
        effects.push(deepFreeze({ kind: 'context-refresh' as const, sessionId: routed.sessionId }))
      }
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
            reason: extractToolFailureText(event.toolContent)
          })
        )
      }
      if ((event.kind === 'message' || event.kind === 'thought') && !event.text) {
        return Object.freeze(effects)
      }
      effects.push(deepFreeze({ kind: 'visible-event' as const, event }))
    }

    return Object.freeze(effects)
  }
}

export { AcpSessionUpdateProjector }
export type { AcpSessionUpdateEffect, AcpSessionUpdateRouting }
