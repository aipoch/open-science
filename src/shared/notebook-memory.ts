// Live policy/notification data only. These values never belong to run.json or portable packages.
export type NotebookMemoryPolicyDiagnostic = 'linux-procfs' | 'linux-cgroup-visibility'

export type NotebookMemoryCgroupConstraint = Readonly<{
  path: string
  currentBytes: number
  maxBytes?: number
  highBytes?: number
}>

export type NotebookMemoryPolicyState = Readonly<{
  status: 'healthy' | 'pressured' | 'unavailable'
  reason: string
  detail?: string
  diagnostic?: NotebookMemoryPolicyDiagnostic
  source: string
  executionScope: string
  checkedAt: number
  sampleAgeMs?: number
  retryAfterMs?: number
  recoveryRemainingMs?: number
  remainingThresholdRatio?: number
  pressureLevel?: 'normal' | 'warning' | 'critical'
  limitingCgroupPath?: string
  cgroupConstraints?: NotebookMemoryCgroupConstraint[]
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
