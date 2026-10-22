import { randomUUID } from 'node:crypto'
import type { AgentProcessSpawner } from '../agent-framework/types'

type MainAgentProcessOwnership = {
  recover(
    selection?: { projectId?: string; sessionId?: string; frameId?: string; attemptId?: string },
    terminateLive?: boolean
  ): Promise<void>
  spawn(
    scope: {
      projectId: string
      sessionId: string
      frameId: string
      attemptId: string
      frameworkId: string
    },
    ...args: Parameters<AgentProcessSpawner>
  ): ReturnType<AgentProcessSpawner>
}

let owner: MainAgentProcessOwnership | undefined
let recoveryFailure: unknown
let closed = false
let closing: Promise<void> | undefined
const scope = { projectId: 'main-agents', sessionId: 'service' }

/** Called only after the service acquires Config Root ownership, before accepting agent work. */
export async function configureMainAgentProcessOwnership(
  ownership: MainAgentProcessOwnership
): Promise<void> {
  closed = false
  closing = undefined
  owner = ownership
  try {
    await owner.recover()
    recoveryFailure = undefined
  } catch (error) {
    recoveryFailure = error
    throw error
  }
}

/** Stop the trees owned by this running service before releasing its directory ownership. */
export function closeMainAgentProcessOwnership(): Promise<void> {
  closed = true
  return (closing ??= owner?.recover({}, true) ?? Promise.resolve())
}

export function mainAgentProcessSpawner(frameworkId: string): AgentProcessSpawner | undefined {
  const current = owner
  if (recoveryFailure) throw recoveryFailure
  if (closed) throw new Error('Main agent process ownership is closed.')
  if (!current) return undefined
  const attemptId = randomUUID()
  return (command, args, options) => {
    if (closed || owner !== current) throw new Error('Main agent process ownership is closed.')
    return current.spawn(
      { ...scope, frameworkId, frameId: 'main-agent', attemptId },
      command,
      args,
      options
    )
  }
}
