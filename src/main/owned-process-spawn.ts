import type { ChildProcess } from 'node:child_process'
import type { AgentProcessSpawner } from './agent-framework/types'
import { createPosixProcessTreeOwnership, trackOwnedPosixProcessTree } from './process-tree'

// The marker must reach the child at creation, and the tracker must pin its identity before callers
// can observe or await the handle. A delegated spawner already owns this boundary and bypasses it.
export const spawnWithPosixOwnership = <T extends ChildProcess>(
  env: NodeJS.ProcessEnv | undefined,
  launch: (ownership: { env: NodeJS.ProcessEnv | undefined; detached: boolean }) => T,
  platform: NodeJS.Platform = process.platform
): T => {
  const ownership = createPosixProcessTreeOwnership(env, platform)
  const child = launch({ env: ownership.env, detached: platform !== 'win32' })
  if (platform !== 'win32') trackOwnedPosixProcessTree(child, ownership.token)
  return child
}

export const createTrackedAgentSpawner =
  (spawn: AgentProcessSpawner, platform: NodeJS.Platform = process.platform): AgentProcessSpawner =>
  (command, args, options) =>
    spawnWithPosixOwnership(
      options.env,
      (ownership) => spawn(command, args, { ...options, ...ownership }),
      platform
    )
