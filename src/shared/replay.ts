import type { NotebookRunRecord } from './notebook'
import type {
  PersistedChatMessage,
  PersistedChatSession,
  PersistedToolActivity
} from './session-persistence'

// Derived presentation only. These types are deliberately outside the .science contract.
export const REPLAY_GENERATOR_VERSION = 2
export const REPLAY_PRESENTATION_VERSION = 2
export const REPLAY_SPEEDS = [0.5, 1, 1.5, 2] as const
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number]

export type ReplaySourceIdentity = {
  projectId: string
  sessionId: string
  title: string
  fingerprint: string
  workspaceCwd?: string
  packageOrigin?: PersistedChatSession['packageOrigin']
}

export type ReplayEvidenceReference = {
  kind: 'message' | 'activity' | 'notebook-run' | 'artifact-version' | 'upload-version'
  id: string
  projectId: string
  sessionId: string
  branchId?: string
  agentFrameId?: string
  artifactId?: string
  fileId?: string
  versionId?: string
  // The record may contain more information than was visible at the captured playback position.
  part?: 'input' | 'result' | 'record'
}

// Full code, outputs, environment manifests and captured files are loaded only near the playhead.
export type ReplayRunIndex = Pick<
  NotebookRunRecord,
  | 'runId'
  | 'cellId'
  | 'source'
  | 'kernelKind'
  | 'status'
  | 'startedAt'
  | 'endedAt'
  | 'executionInvocationId'
  | 'rootFrameId'
  | 'agentFrameId'
  | 'messageBranchId'
  | 'runtimeSegmentId'
  | 'promptMessageId'
  | 'truncated'
> & {
  scriptCharacters?: number
  detailBytes?: number
  environmentUnavailable?: boolean
  hasOutput?: boolean
}

export type ReplayNotebookRunDetails =
  | { status: 'ready'; run: NotebookRunRecord; bytes: number }
  | {
      status: 'unavailable'
      reason: 'not-recorded' | 'load-failed' | 'identity-mismatch' | 'too-large'
    }

export type ReplayPhase = 'input' | 'activity' | 'result'

export type ReplayIssue = {
  code:
    | 'notebook-unavailable'
    | 'incomplete-history'
    | 'artifact-unavailable'
    | 'unversioned-artifact'
    | 'missing-time'
    | 'truncated-output'
    | 'missing-environment'
    | 'unattributed-record'
    | 'excluded-files'
  sourceId?: string
  detail?: string
}

export type ReplayResource = {
  source?: 'artifact' | 'upload'
  id: string
  name: string
  projectId: string
  sessionId: string
  artifactId?: string
  fileId?: string
  versionId?: string
  versionNumber?: number
  locator?: string
  mimeType?: string
  size?: number
  checksum?: string
  createdAt?: number
  messageId?: string
  messageIds?: string[]
  producerRunId?: string
  availability: 'recorded' | 'unavailable'
}

export type ReplayStep = {
  id: string
  kind: 'message' | 'activity' | 'notebook' | 'artifact'
  branchId: string
  agentFrameId?: string
  promptMessageId?: string
  title?: string
  status?: string
  evidence: ReplayEvidenceReference[]
  message?: PersistedChatMessage
  activities: PersistedToolActivity[]
  runs: ReplayRunIndex[]
  resourceIds: string[]
  issues: ReplayIssue[]
  recordedAt?: number
  recordedEndAt?: number
  startMs: number
  durationMs: number
  endMs: number
}

export type ReplayBranch = {
  id: string
  agentFrameId?: string
  parentBranchId?: string
  label?: string
  kind: 'conversation' | 'unattributed'
  steps: ReplayStep[]
  durationMs: number
}

export type ReplayDocument = {
  generatorVersion: typeof REPLAY_GENERATOR_VERSION
  presentationVersion: typeof REPLAY_PRESENTATION_VERSION
  source: ReplaySourceIdentity
  defaultBranchId: string
  branches: ReplayBranch[]
  resources: ReplayResource[]
  issues: ReplayIssue[]
}

export type ReplayScene = {
  branchId: string
  positionMs: number
  durationMs: number
  stepIndex: number
  step?: ReplayStep
  stepProgress: number
  phase: ReplayPhase
  showResults: boolean
  messageCharacters: number
  visibleEvidence: ReplayEvidenceReference[]
  visibleSteps: ReplayStep[]
  visibleResourceIds: string[]
  ended: boolean
}

export type ReplayPosition = {
  branchId: string
  stepId?: string
  stepOffsetMs: number
}

export type ReplayClock = {
  positionMs: number
  speed: ReplaySpeed
  playing: boolean
}
