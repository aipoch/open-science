// Transient Compute projections. These fields never enter run.json or a Session package.
export type NotebookResourceMemory = {
  sampledAt?: number
  coverage: 'complete' | 'partial' | 'unknown'
  metric: 'rss' | 'private-bytes-and-working-set'
  rssBytes?: number
  privateBytes?: number
  workingSetBytes?: number
}

export type NotebookResource = {
  id: string
  group: 'kernel' | 'shell' | 'operation' | 'reproduction' | 'installer' | 'batch'
  kind?: string
  phase: 'starting' | 'running' | 'idle' | 'ready' | 'cleanup-pending'
  startedAt?: number
  laneKey?: string
  environment?: string
  memory: NotebookResourceMemory
}

export type NotebookPendingDecision = {
  projectId: string
  sessionId: string
  refusalId: string
  messageBranchId?: string
  kind?: 'memory'
}

export type NotebookSessionResources = {
  projectId: string
  sessionId: string
  revision: string
  resources: NotebookResource[]
  releaseBlockedReason?: string
  operationId?: string
}

export type NotebookResourceRelease = {
  operationId: string
  projectId: string
  sessionId: string
  revision: string
  status: 'releasing' | 'released' | 'partial'
  startedAt: number
  finishedAt?: number
  resources: Array<{
    id: string
    group: NotebookResource['group']
    kind?: string
    laneKey?: string
    environment?: string
    status: 'pending' | 'released' | 'incomplete'
    processesTerminated?: boolean
    networkClosed?: boolean
    temporaryResourcesRemoved?: boolean
    projection?: 'complete' | 'failed'
    error?: string
  }>
  continuations: NotebookPendingDecision[]
}

export type NotebookProjectResources = {
  groups: NotebookSessionResources[]
  pendingDecisions: NotebookPendingDecision[]
  releases: NotebookResourceRelease[]
}

export type NotebookProjectResourcesRequest = { projectId: string }
export type ReleaseNotebookSessionResourcesRequest = {
  projectId: string
  sessionId: string
  revision: string
}
export type NotebookResourceReleaseRequest = {
  projectId: string
  sessionId: string
  operationId: string
}
