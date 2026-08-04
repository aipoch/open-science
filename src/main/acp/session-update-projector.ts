import type { SessionNotification } from '@agentclientprotocol/sdk'

import type { AcpContextUsage, AcpRuntimeEvent } from '../../shared/acp'
import { resolveCanonicalMcpToolIdentity } from '../agent-framework/app-mcp-names'
import { CodexSkillActivityProjector } from './codex-skill-activity'
import type { SessionUpdateObservation } from './context-usage-tracker'
import type { PermissionToolContext } from './permission-context'
import { isMcpToolName } from './permission-policy'
import {
  extractProviderToolName,
  extractToolFailureText,
  toAcpRuntimeEvent
} from './runtime-events'

type RuntimeProjectionRouting = Readonly<{
  kind: 'runtime'
  appSessionId?: string
  eventId: string
  timestamp?: number
  visible: boolean
  reconnectPending: boolean
  mcpServerNames: readonly string[]
}>

type PermissionProjectionRouting = Readonly<{
  kind: 'permission'
  appSessionId: string
  framework: PermissionToolContext['framework']
  mcpServerNames: readonly string[]
}>

type AcpSessionUpdateRouting = RuntimeProjectionRouting | PermissionProjectionRouting

type AcpSessionUpdateEffect =
  | Readonly<{
      kind: 'permission-tool-correlation'
      notification: Readonly<SessionNotification>
      context: Readonly<PermissionToolContext>
    }>
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

    if (routing.kind === 'permission') {
      return Object.freeze([
        deepFreeze({
          kind: 'permission-tool-correlation' as const,
          notification: routed,
          context: {
            sessionId: routed.sessionId,
            framework: routing.framework,
            mcpServerNames: [...routing.mcpServerNames]
          }
        })
      ])
    }

    const projection = this.codexSkillActivity.projectWithContext(
      toAcpRuntimeEvent(routed, routing.eventId, routing.timestamp)
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
