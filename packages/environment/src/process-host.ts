import type { ChildProcess } from 'node:child_process'

/** A host-owned process supervisor. Success means the complete owned tree has stopped. */
export type ProcessTreeKillResult = { reaped: boolean }
export type EnvironmentProcessHost = {
  createOwnership: (
    env: NodeJS.ProcessEnv | undefined,
    platform: NodeJS.Platform
  ) => { env: NodeJS.ProcessEnv | undefined; token: string | undefined }
  trackOwnership: (child: ChildProcess, token: string | undefined) => void
  terminateTree: (child: ChildProcess) => Promise<ProcessTreeKillResult>
  nodeEnvironment?: () => NodeJS.ProcessEnv
}
