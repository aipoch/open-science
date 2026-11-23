import type { ProcessTreeKillResult } from '../process-tree'
import type { NotebookOwnedMemorySample } from './resource-memory'

// Main-only handles. Resource truth and retry closures remain with the original owner.
export type NotebookResourceCleanupResult = ProcessTreeKillResult & {
  processesTerminated?: boolean
  networkClosed?: boolean
  temporaryResourcesRemoved?: boolean
  projection?: 'complete' | 'failed'
  error?: unknown
}

export type NotebookOwnedResource = {
  identity: object
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
  release: () => Promise<NotebookResourceCleanupResult>
}

export const releaseNotebookResources = async (
  resources: readonly NotebookOwnedResource[]
): Promise<Array<{ resource: NotebookOwnedResource; result: NotebookResourceCleanupResult }>> => {
  const outcomes = await Promise.allSettled(
    resources.map((resource) => {
      try {
        return resource.release()
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
