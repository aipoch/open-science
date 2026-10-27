import { randomUUID } from 'node:crypto'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { AgentProcessSpawner } from '../agent-framework/types'

type MainAgentScope = {
  projectId: string
  sessionId: string
  frameId: string
  attemptId: string
  frameworkId: string
}

type MainAgentProcessOwnership = {
  assertClear?(scope: MainAgentScope): void
  assertMainAgentSessionResumeAllowed(
    frameworkId: string,
    providerSessionId?: string
  ): Promise<void>
  recordMainAgentContext?(child: ChildProcessWithoutNullStreams, providerSessionId: string): void
  recover(
    selection?: { projectId?: string; sessionId?: string; frameId?: string; attemptId?: string },
    terminateLive?: boolean
  ): Promise<void>
  spawn(
    scope: MainAgentScope,
    ...args: Parameters<AgentProcessSpawner>
  ): ReturnType<AgentProcessSpawner>
}

export class PreviousAgentContextUnavailableError extends Error {}

const connections = new WeakMap<object, ChildProcessWithoutNullStreams>()
export function bindMainAgentConnection(
  connection: object,
  child: ChildProcessWithoutNullStreams
): void {
  connections.set(connection, child)
}
export function recordMainAgentContext(connection: object, providerSessionId: string): void {
  const child = connections.get(connection)
  if (child) owner?.recordMainAgentContext?.(child, providerSessionId)
}

let owner: MainAgentProcessOwnership | undefined
let generation = 0
let closed = false
let closing: Promise<void> | undefined
const projectId = 'main-agents'

const failedStarts = new Set<{
  owner: MainAgentProcessOwnership
  scope: MainAgentScope
  release: () => void
}>()

const settleFailedStarts = (ownership: MainAgentProcessOwnership): void => {
  if (!ownership.assertClear) return
  for (const pending of failedStarts) {
    if (pending.owner !== ownership) continue
    try {
      ownership.assertClear(pending.scope)
    } catch {
      continue
    }
    failedStarts.delete(pending)
    pending.release()
  }
}

/** Called only after the service acquires Config Root ownership, before accepting agent work. */
export async function configureMainAgentProcessOwnership(
  ownership: MainAgentProcessOwnership
): Promise<void> {
  closed = false
  closing = undefined
  generation++
  owner = ownership
  try {
    await ownership.recover()
  } finally {
    settleFailedStarts(ownership)
  }
}

/** Stop the trees owned by this running service before releasing its directory ownership. */
export function closeMainAgentProcessOwnership(): Promise<void> {
  closed = true
  const current = owner
  return (closing ??= (current?.recover({}, true) ?? Promise.resolve()).finally(() => {
    if (current) settleFailedStarts(current)
  }))
}

export async function spawnMainAgentProcess(
  frameworkId: string,
  spawnConnection: (
    spawnProcess: AgentProcessSpawner | undefined
  ) => ChildProcessWithoutNullStreams,
  onFailedStartRecovered?: () => void
): Promise<ChildProcessWithoutNullStreams> {
  const current = owner
  const currentGeneration = generation
  if (closed) throw new Error('Main agent process ownership is closed.')
  if (!current) return spawnConnection(undefined)
  const attemptId = randomUUID()
  const scope = { projectId, sessionId: attemptId, frameworkId, frameId: 'main-agent', attemptId }
  const assertCurrent = (): void => {
    if (closed || owner !== current || generation !== currentGeneration)
      throw new Error('Main agent process ownership is closed.')
  }
  // Connections can host independent provider sessions concurrently. Historical cleanup debt
  // is not a service-wide connection lease. Isolate publication from other attempts' torn files.
  assertCurrent()
  let active = true
  try {
    return spawnConnection((command, args, options) => {
      assertCurrent()
      if (!active) throw new Error('Main agent process admission has expired.')
      active = false
      try {
        return current.spawn(scope, command, args, options)
      } catch (error) {
        // Receipt publication can fail after creation, before the caller receives a child handle.
        if (onFailedStartRecovered) {
          failedStarts.add({ owner: current, scope, release: onFailedStartRecovered })
          settleFailedStarts(current)
        }
        throw error
      }
    })
  } finally {
    active = false
  }
}

/** Only restoring an old provider session can reacquire a historical writer's context. */
export async function assertMainAgentSessionResumeAllowed(
  frameworkId: string,
  providerSessionId?: string
): Promise<void> {
  const current = owner
  const currentGeneration = generation
  if (closed) throw new Error('Main agent process ownership is closed.')
  if (!current) return
  try {
    await current.assertMainAgentSessionResumeAllowed(frameworkId, providerSessionId)
  } catch (cause) {
    if (
      cause &&
      typeof cause === 'object' &&
      'code' in cause &&
      cause.code === 'main-agent-context-conflict'
    )
      throw cause
    if (closed || owner !== current || generation !== currentGeneration)
      throw new Error('Main agent process ownership is closed.')
    throw new PreviousAgentContextUnavailableError('Previous agent cleanup is unconfirmed.', {
      cause
    })
  } finally {
    settleFailedStarts(current)
  }
  if (closed || owner !== current || generation !== currentGeneration)
    throw new Error('Main agent process ownership is closed.')
}
