export type NotebookCellPreview = { code: string; truncated: boolean }

export function createNotebookCellPreview(code: string): NotebookCellPreview {
  const limit = 32_000
  return { code: code.slice(0, limit), truncated: code.length > limit }
}

// Observations of resources owned by this backend, never arbitrary OS PIDs.
export type NotebookProcessStatus = 'running' | 'idle' | 'cleaning' | 'cleanup-failed'

export type NotebookProcessObservation = {
  id: string
  projectId: string
  sessionId: string
  lane: string
  kind: 'python' | 'r' | 'repl' | 'shell'
  environment?: string
  status: NotebookProcessStatus
  startedAt: number
  pid?: number
  hasLastCell?: boolean
  lastCell?: NotebookCellPreview
  memoryBytes?: number
  cpuCores?: number
  processes: Array<{
    pid: number
    parentPid: number
    command: string
    memoryBytes?: number
    cpuCores?: number
  }>
}

export type NotebookProcessMonitorSnapshot = {
  sampledAt: number
  host: {
    hostname: string
    platform: string
    cpuCount: number
    cpuPercent?: number
    memoryTotalBytes: number
    memoryUsedBytes: number
    memoryCommittedBytes?: number
    memoryCommitLimitBytes?: number
    uptimeSeconds: number
  }
  processMetricsAvailable: boolean
  instances: NotebookProcessObservation[]
}

export type ManualKernelTermination = {
  id: string
  instanceId: string
  projectId: string
  sessionId: string
  kind: NotebookProcessObservation['kind']
  pid?: number
  requestedAt: number
  comment: string
  status: 'requested' | 'stopped' | 'cleanup-failed'
}

export type NotebookProcessMonitorRequest = { sourceIds?: string[] }

export type TerminateNotebookProcessRequest = ({ id: string } | { ids: string[] }) & {
  projectId: string
  sessionId: string
  comment?: string
}
