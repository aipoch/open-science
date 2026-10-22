import { randomUUID } from 'node:crypto'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { AgentProcessSpawner } from '../agent-framework/types'

type MainAgentProcessOwnership = {
  admitMainAgentConnection(
    spawnConnection: () => ChildProcessWithoutNullStreams
  ): Promise<ChildProcessWithoutNullStreams>
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
let generation = 0
let closed = false
let closing: Promise<void> | undefined
const scope = { projectId: 'main-agents', sessionId: 'service' }

/** Called only after the service acquires Config Root ownership, before accepting agent work. */
export async function configureMainAgentProcessOwnership(
  ownership: MainAgentProcessOwnership
): Promise<void> {
  closed = false
  closing = undefined
  generation++
  owner = ownership
  await owner.recover()
}

/** Stop the trees owned by this running service before releasing its directory ownership. */
export function closeMainAgentProcessOwnership(): Promise<void> {
  closed = true
  return (closing ??= owner?.recover({}, true) ?? Promise.resolve())
}

export async function spawnMainAgentProcess(
  frameworkId: string,
  spawnConnection: (spawnProcess: AgentProcessSpawner | undefined) => ChildProcessWithoutNullStreams
): Promise<ChildProcessWithoutNullStreams> {
  const current = owner
  const currentGeneration = generation
  if (closed) throw new Error('Main agent process ownership is closed.')
  if (!current) return spawnConnection(undefined)
  const attemptId = randomUUID()
  const assertCurrent = (): void => {
    if (closed || owner !== current || generation !== currentGeneration)
      throw new Error('Main agent process ownership is closed.')
  }
  return current.admitMainAgentConnection(() => {
    assertCurrent()
    let active = true
    try {
      return spawnConnection((command, args, options) => {
        assertCurrent()
        if (!active) throw new Error('Main agent process admission has expired.')
        active = false
        return current.spawn(
          { ...scope, frameworkId, frameId: 'main-agent', attemptId },
          command,
          args,
          options
        )
      })
    } finally {
      active = false
    }
  })
}
