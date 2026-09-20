import type { SessionNotification } from '@agentclientprotocol/sdk'
import { resolveCanonicalMcpToolIdentity } from '../agent-framework/app-mcp-names'
import { extractProviderToolName } from './runtime-events'
import { isRecord } from '../value-guards'

// Providers may report a tool timeout without cancelling the MCP request. Correlate the
// terminal update with its earlier tool identity; unrelated failures must not pause a Plan.
export class PlanToolWaitObserver {
  private readonly toolCallIds = new Set<string>()

  failed(notification: SessionNotification): boolean {
    const update = notification.update
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update')
      return false
    const input = isRecord(update.rawInput) ? update.rawInput : undefined
    const envelopeName =
      typeof input?.server === 'string' && typeof input.tool === 'string'
        ? `mcp.${input.server}.${input.tool}`
        : undefined
    const matches = [extractProviderToolName(update), update.title, envelopeName].some(
      (name) =>
        name === 'generate_plan' ||
        resolveCanonicalMcpToolIdentity(name, ['open-science-plan']) ===
          'open-science-plan/generate_plan'
    )
    if (matches) {
      // One observer lives for one logical turn; retain a bounded set of concurrent Plan calls.
      if (this.toolCallIds.size >= 64)
        this.toolCallIds.delete(this.toolCallIds.values().next().value!)
      this.toolCallIds.add(update.toolCallId)
    }
    const tracked = this.toolCallIds.has(update.toolCallId)
    if (update.status === 'completed' || update.status === 'failed')
      this.toolCallIds.delete(update.toolCallId)
    return tracked && update.status === 'failed'
  }
}

type PlanReviewStopFailure = 'unavailable' | 'notification-failed' | 'stop-unconfirmed'

// Cancels only the Provider turn. Do not use the user-cancellation owner here: the logical
// interaction, its AbortSignal, artifacts, and queued review response must remain alive.
export const requestPlanReviewProviderStop = (
  input: Readonly<{
    notify?: () => Promise<void>
    isCurrent: () => boolean
    onUnconfirmed: (reason: PlanReviewStopFailure) => void
  }>
): (() => void) => {
  let disposed = false
  const fail = (reason: PlanReviewStopFailure): void => {
    if (disposed || !input.isCurrent()) return
    disposed = true
    clearTimeout(timer)
    input.onUnconfirmed(reason)
  }
  const timer = setTimeout(() => fail('stop-unconfirmed'), 5_000)
  if (!input.notify) fail('unavailable')
  else {
    try {
      void input.notify().catch(() => fail('notification-failed'))
    } catch {
      fail('notification-failed')
    }
  }
  // Only a Provider terminal observation (or interaction teardown) should dispose this timer.
  // Sending the cancellation notification alone is not proof of a stopped Provider.
  return () => {
    disposed = true
    clearTimeout(timer)
  }
}
