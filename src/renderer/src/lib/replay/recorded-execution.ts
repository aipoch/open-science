import type { ReplayDocument } from '../../../../shared/replay'
import type { ResearchReplayObservationBinding } from '../../../../shared/research-replay'
import type {
  RecordedEvidencePayload,
  RecordedRunObservationSelection
} from '../../../../shared/run-observation-recorded'
import type { RunObservationArchive } from '../../../../shared/run-observation-archive'
import type { RunObservationSnapshot } from '../../../../shared/run-observation'
import { projectRecordedObservation } from './recorded-observation'

export type RecordedExecutionTrack = Readonly<{
  id: string
  branchId: string
  runId: string
  stepId: string
  origin: number
  coverage: RunObservationArchive['coverage']
  snapshots: readonly RunObservationSnapshot[]
  select: (snapshot: RunObservationSnapshot) => RecordedRunObservationSelection
}>
export type RecordedExecutionState = Readonly<{
  track: RecordedExecutionTrack
  snapshot?: RunObservationSnapshot
  next?: RunObservationSnapshot
}>
export type RecordedExecutionAskContext = {
  branchId: string
  stepId: string
  runId: string
  /** Current watching position; selection.record.observedAt remains the evidence time. */
  timeMs: number
}
const sameTarget = (
  a: ResearchReplayObservationBinding['target'],
  b: ResearchReplayObservationBinding['target']
): boolean =>
  a.projectId === b.projectId &&
  a.sessionId === b.sessionId &&
  a.artifactId === b.artifactId &&
  a.versionId === b.versionId

/** Consume host-verified associations only. Sender Run IDs and clock proximity are not authority. */
export function buildRecordedExecutionTracks(
  document: ReplayDocument,
  payloads: readonly RecordedEvidencePayload[],
  bindings: readonly ResearchReplayObservationBinding[],
  origins: Readonly<Record<string, number>>
): readonly RecordedExecutionTrack[] {
  const candidates: RecordedExecutionTrack[] = []
  for (const binding of bindings) {
    if (
      binding.target.projectId !== document.source.projectId ||
      binding.target.sessionId !== document.source.sessionId
    )
      continue
    if (
      bindings.some(
        (other) => sameTarget(other.target, binding.target) && other.runId !== binding.runId
      )
    )
      continue
    const matches = payloads.filter(
      (payload) =>
        'archive' in payload &&
        sameTarget(payload.receiving, binding.target) &&
        payload.archive.recordingId === binding.recordingId
    )
    if (matches.length !== 1 || !('archive' in matches[0])) continue
    const payload = matches[0]
    const resource = document.resources.find(
      (resource) =>
        resource.artifactId === binding.target.artifactId &&
        resource.versionId === binding.target.versionId
    )
    if (resource?.checksum && resource.checksum !== binding.archiveChecksum) continue
    let projection: ReturnType<typeof projectRecordedObservation>
    try {
      projection = projectRecordedObservation(payload.archive, payload.receiving, payload.media)
    } catch {
      continue
    }
    for (const branchId of new Set(binding.branchIds)) {
      const branch = document.branches.find((branch) => branch.id === branchId)
      const origin = origins[branchId]
      const step = branch?.steps.find((step) =>
        step.runs.some((run) => run.runId === binding.runId)
      )
      if (!branch || !step || !Number.isSafeInteger(origin) || origin < 0) continue
      // Never extend or reinterpret the original research clock to fit an observation archive.
      const snapshots = projection.snapshots.filter(
        (snapshot) =>
          snapshot.observedAt >= origin && snapshot.observedAt <= origin + branch.durationMs
      )
      if (!snapshots.length) continue
      candidates.push(
        Object.freeze({
          id: `${projection.sourceIdentity}:${branchId}`,
          branchId,
          runId: binding.runId,
          stepId: step.id,
          origin,
          coverage: Object.freeze({ ...payload.archive.coverage }),
          snapshots: Object.freeze(snapshots),
          select: projection.select
        })
      )
    }
  }
  const unique = [...new Map(candidates.map((track) => [track.id, track])).values()]
  // Conflicting archives for one Run must not be silently combined or selected by latest time.
  return Object.freeze(
    unique.filter(
      (track) =>
        unique.filter((other) => other.branchId === track.branchId && other.runId === track.runId)
          .length === 1
    )
  )
}

const stateCache = new WeakMap<RecordedExecutionTrack, Map<number, RecordedExecutionState>>()

/** Binary search over immutable samples; logs are whole snapshots, never append-only deltas. */
export function recordedExecutionAt(
  track: RecordedExecutionTrack,
  recordedAt: number
): RecordedExecutionState {
  let low = 0
  let high = track.snapshots.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (track.snapshots[middle].observedAt <= recordedAt) low = middle + 1
    else high = middle
  }
  let cache = stateCache.get(track)
  if (!cache) {
    cache = new Map()
    stateCache.set(track, cache)
  }
  let state = cache.get(low)
  if (!state) {
    state = Object.freeze({ track, snapshot: track.snapshots[low - 1], next: track.snapshots[low] })
    cache.set(low, state)
  }
  return state
}

export function recordedExecutionTimes(
  tracks: readonly RecordedExecutionTrack[],
  branchId: string
): readonly number[] {
  return [
    ...new Set(
      tracks
        .filter((track) => track.branchId === branchId)
        .flatMap((track) => track.snapshots.map((snapshot) => snapshot.observedAt))
    )
  ].sort((a, b) => a - b)
}
