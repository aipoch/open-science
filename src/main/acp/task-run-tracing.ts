import { setTimeout as wait } from 'node:timers/promises'
import { TaskRunTracingError } from '../../shared/task-api'
import type { ClientConnection } from '@agentclientprotocol/sdk'
import type { AgentFrameworkId } from '../../shared/settings'
import { HARNESS_TRACE_READINESS_METHOD } from '../harness-acp/config'

// A wire request or renderer IPC payload cannot supply this Main-owned symbol.
export const taskRunTracing = Symbol('Task Run tracing')
export function requiresTaskRunTracing(request: object): boolean {
  return (request as { [taskRunTracing]?: true })[taskRunTracing] === true
}

export function requireTracingFramework(frameworkId: AgentFrameworkId): void {
  if (frameworkId !== 'open-science-agent')
    throw new TaskRunTracingError(
      '--otel-traces requires the built-in Open-Science Agent. Select open-science-agent in agent routing or omit --otel-traces.'
    )
}

// Exporters resolve their configuration once per helper process. Query that exact connection,
// including for an already attached Session. A positive check also applies to its later turns.
const readyConnections = new WeakSet<ClientConnection>()
export async function assertTaskRunTracingReady(
  frameworkId: AgentFrameworkId,
  connection: ClientConnection | undefined
): Promise<void> {
  requireTracingFramework(frameworkId)
  if (!connection) throw new TaskRunTracingError()
  if (readyConnections.has(connection)) return
  const lifetime = new AbortController()
  try {
    const result = await Promise.race([
      connection.agent.request<{ ready: boolean }>(
        HARNESS_TRACE_READINESS_METHOD,
        {},
        { cancellationSignal: lifetime.signal }
      ),
      wait(2_000, undefined, { ref: false, signal: lifetime.signal })
    ]).catch(() => undefined)
    if (result?.ready !== true) throw new TaskRunTracingError()
    readyConnections.add(connection)
  } finally {
    lifetime.abort()
  }
}
