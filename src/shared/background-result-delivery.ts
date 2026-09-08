import type { ComputeJobStatus } from './compute'
import type { NotebookRunStatus } from './notebook'

export type BackgroundResultSourceKind = 'local-run' | 'compute-job'

export type BackgroundResultDeliveryState =
  'waiting-result' | 'pending' | 'claimed' | 'dispatching' | 'consumed' | 'needs-attention'

export type AgentResultFollowUpDelivery = 'pending' | 'suppressed' | 'committed'

export type BackgroundResultExecutionType = 'python' | 'r' | 'repl' | 'shell' | 'compute-job'

export type BackgroundResultSourceRef = Readonly<{
  sourceKind: BackgroundResultSourceKind
  sourceId: string
  projectId: string
  sessionId: string
  agentFrameId?: string
}>

export type BackgroundResultDelivery = BackgroundResultSourceRef &
  Readonly<{
    id: string
    state: BackgroundResultDeliveryState
    attemptCount: number
    claimToken?: string
    claimExpiresAt?: number
    continuationMessageId?: string
    createdAt: number
    updatedAt: number
  }>

export type BackgroundResultActivityItem = BackgroundResultSourceRef &
  Readonly<{
    id: string
    executionType?: BackgroundResultExecutionType
    title?: string
    lane?: string
    status?:
      | NotebookRunStatus
      | ComputeJobStatus
      | 'cancelling'
      | 'cancelled'
      | 'pending-delivery'
      | 'needs-attention'
      | 'result-unavailable'
    active: boolean
    needsAttention: boolean
    outcomeStatus?:
      | Exclude<NotebookRunStatus, 'queued' | 'running'>
      | ComputeJobStatus
      | 'cancelling'
      | 'cancelled'
    updatedAt: number
  }>

export type ProjectBackgroundActivityItem = BackgroundResultActivityItem

export type SessionBackgroundResultActivity = Readonly<{
  active: readonly []
  awaitingAgent: readonly BackgroundResultActivityItem[]
}>

export type BackgroundResultDeliverySessionRequest = Readonly<{ sessionId: string }>
export type BackgroundResultDeliveryProjectRequest = Readonly<{ projectId: string }>

export type ProjectBackgroundActivity = Readonly<{
  items: readonly BackgroundResultActivityItem[]
  truncated: boolean
}>

export type ProjectBackgroundActivityChangedEvent = Readonly<{ projectId: string }>
