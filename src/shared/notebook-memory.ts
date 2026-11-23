// Live policy/notification data only. These values never belong to run.json or portable packages.
export type NotebookMemoryCgroupConstraint = {
  path: string
  currentBytes: number
  maxBytes?: number
  highBytes?: number
}

export type NotebookMemoryPolicyState = Readonly<{
  status: 'healthy' | 'pressured' | 'unavailable'
  reason: string
  remainingThresholdRatio?: number
  detail?: string
  source: string
  executionScope: string
  checkedAt: number
  sampleAgeMs?: number
  retryAfterMs?: number
  recoveryRemainingMs?: number
  limitingCgroupPath?: string
  cgroupConstraints?: readonly NotebookMemoryCgroupConstraint[]
  pressureLevel?: 'normal' | 'warning' | 'critical'
  availableBytes?: number
  totalBytes?: number
  committedBytes?: number
  commitLimitBytes?: number
}>

export type NotebookMemoryRejectedEvent = Readonly<{
  projectId: string
  sessionId: string
  workspaceCwd?: string
  source?: string
  inputKind?: string
  refusalId?: string
  messageBranchId?: string
  terminalTarget?: string
  memory: NotebookMemoryPolicyState
}>

export type NotebookMemoryPolicyChangedEvent = Readonly<{
  hasLiveResources: boolean
  memory: NotebookMemoryPolicyState
}>

export type NotebookMemoryPolicyStateRequest = Readonly<{ executionScope?: string }>
