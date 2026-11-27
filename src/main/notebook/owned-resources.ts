import { ChildProcess } from 'node:child_process'
import {
  hasVerifiedPosixProcessTreeMember,
  terminateProcessTree,
  type ProcessTreeKillResult
} from '../process-tree'
import type { NotebookOwnedMemorySample } from './resource-memory'

// Main-only handles. Resource truth and retry closures remain with the original owner.
export type NotebookResourceCleanupResult = ProcessTreeKillResult & {
  processesTerminated?: boolean
  networkClosed?: boolean
  temporaryResourcesRemoved?: boolean
  projection?: 'complete' | 'failed'
  environmentRecoveryRequired?: true
  error?: unknown
}

export type NotebookOwnedResource = {
  identity: object
  // A captured child can finish before its owning reproduction attempt is done cleaning up.
  parentIdentity?: object
  group: 'kernel' | 'shell' | 'operation' | 'reproduction' | 'installer' | 'batch'
  kind?: string
  phase: 'starting' | 'running' | 'idle' | 'ready' | 'cleanup-pending'
  startedAt: number
  projectId?: string
  sessionId?: string
  laneKey?: string
  executorGeneration?: symbol
  executionDomain?: 'host'
  processKey?: string
  environment?: string
  kernelEpochId?: string
  sampleMemory?: (signal: AbortSignal) => Promise<NotebookOwnedMemorySample>
  retainForRelease?: () => void
  processIdentity?: object
  hasLiveProcess?: () => boolean
  release: (force?: boolean) => Promise<NotebookResourceCleanupResult>
}

export const hasVerifiedRetainedInstaller = (
  identity: object | undefined
): identity is ChildProcess =>
  identity instanceof ChildProcess && hasVerifiedPosixProcessTreeMember(identity)

export const forceCloseRetainedInstaller = async (identity: object): Promise<void> => {
  if (hasVerifiedRetainedInstaller(identity)) await terminateProcessTree(identity, 'SIGKILL')
}

export const releaseNotebookResources = async (
  resources: readonly NotebookOwnedResource[],
  force?: boolean
): Promise<Array<{ resource: NotebookOwnedResource; result: NotebookResourceCleanupResult }>> => {
  const outcomes = await Promise.allSettled(
    resources.map((resource) => {
      try {
        return force ? resource.release(true) : resource.release()
      } catch (error) {
        return Promise.reject(error)
      }
    })
  )
  return outcomes.map((outcome, index) => ({
    resource: resources[index],
    result:
      outcome.status === 'fulfilled' ? outcome.value : { reaped: false, error: outcome.reason }
  }))
}
