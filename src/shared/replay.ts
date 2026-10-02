import type { ReviewWithChecks } from './reviewer'
import type { NotebookRunRecord } from './notebook'
import type {
  PersistedChatMessage,
  PersistedChatSession,
  PersistedToolActivity
} from './session-persistence'

// Derived presentation only. These types are deliberately outside the .science contract.
export const REPLAY_GENERATOR_VERSION = 3
export const REPLAY_PRESENTATION_VERSION = 2
export const REPLAY_SPEEDS = [1, 2, 4] as const
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
  kind: 'message' | 'activity' | 'notebook-run' | 'artifact-version' | 'upload-version' | 'review'
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
    | 'review-unavailable'
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
  kind: 'message' | 'activity' | 'notebook' | 'artifact' | 'review'
  branchId: string
  agentFrameId?: string
  promptMessageId?: string
  title?: string
  status?: string
  evidence: ReplayEvidenceReference[]
  review?: ReviewWithChecks
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

// Conservative resident-size estimate without allocating a second full JSON string.
export const estimateReplayBytes = (value: unknown): number => {
  const pending = [value]
  const seen = new Set<object>()
  let bytes = 0
  while (pending.length) {
    const current = pending.pop()
    if (typeof current === 'string') bytes += current.length * 2
    else if (current === null || current === undefined) bytes += 4
    else if (typeof current !== 'object') bytes += 8
    else if (!seen.has(current)) {
      seen.add(current)
      bytes += 32
      for (const [key, entry] of Object.entries(current)) {
        bytes += key.length * 2
        pending.push(entry)
      }
    }
  }
  return bytes
}

export const indexReplayRun = (run: ReplayRunIndex | NotebookRunRecord): ReplayRunIndex => ({
  runId: run.runId,
  cellId: run.cellId,
  source: run.source,
  kernelKind: run.kernelKind,
  status: run.status,
  startedAt: run.startedAt,
  endedAt: run.endedAt,
  executionInvocationId: run.executionInvocationId,
  rootFrameId: run.rootFrameId,
  agentFrameId: run.agentFrameId,
  messageBranchId: run.messageBranchId,
  runtimeSegmentId: run.runtimeSegmentId,
  promptMessageId: run.promptMessageId,
  truncated: run.truncated,
  ...('script' in run
    ? {
        scriptCharacters: run.script.length,
        detailBytes: estimateReplayBytes(run),
        environmentUnavailable: run.environmentCapture?.state === 'unavailable',
        hasOutput: Boolean(
          run.outputs.length ||
          run.text.stdout ||
          run.text.stderr ||
          run.text.traceback ||
          run.text.plain.length
        )
      }
    : {
        scriptCharacters: run.scriptCharacters,
        detailBytes: run.detailBytes,
        environmentUnavailable: run.environmentUnavailable,
        hasOutput: run.hasOutput
      })
})
