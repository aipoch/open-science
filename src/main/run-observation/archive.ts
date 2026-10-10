import { createHash } from 'node:crypto'
import {
  runObservationSnapshotSchema,
  type RunObservationSnapshot,
  type RunObservationHistory
} from '../../shared/run-observation'
import {
  MAX_RUN_OBSERVATION_ARCHIVE_BYTES,
  validateRunObservationArchive,
  type RunObservationArchive,
  type RunObservationArchiveMedia
} from '../../shared/run-observation-archive'
export * from '../../shared/run-observation-archive'

const terminal = (status: string | undefined): boolean =>
  !!status && ['completed', 'failed', 'timeout', 'interrupted', 'cancelled'].includes(status)

export function buildRunObservationArchive(input: {
  recordingId: string
  history: RunObservationHistory
  capturedAt: number
  stopReason: RunObservationArchive['coverage']['stopReason']
  media?: readonly RunObservationArchiveMedia[]
  missingMediaKeys?: readonly string[]
  samplingFailures?: number
  unavailableSamples?: number
  capacityLimit?: RunObservationArchive['coverage']['capacityLimit']
}): RunObservationArchive {
  if (input.history.coverage !== 'process-local')
    throw new Error('Unsupported observation history.')
  const snapshots = input.history.snapshots.map((snapshot) =>
    runObservationSnapshotSchema.parse(snapshot)
  )
  if (!snapshots.length) throw new Error('No recorded observations are available to archive.')
  const first = snapshots[0]
  const last = snapshots.at(-1)!
  const logs = snapshots.flatMap((snapshot) =>
    snapshot.run ? Object.values(snapshot.run.logs) : []
  )
  const archive = validateRunObservationArchive({
    format: 'open-science-run-observation',
    version: 1,
    recordingId: input.recordingId,
    capturedAt: input.capturedAt,
    coverage: {
      kind: 'sampled-observations',
      includesPreObservationHistory: false,
      firstObservedAt: first.observedAt,
      lastObservedAt: last.observedAt,
      droppedEarlierObservations: input.history.truncated,
      terminalRunObserved: terminal(last.run?.status),
      stopReason: input.stopReason,
      ...(input.capacityLimit ? { capacityLimit: input.capacityLimit } : {}),
      logTruncation: logs.some((log) => log.truncated),
      redactedContent: logs.some((log) => log.redacted),
      samplingFailures: input.samplingFailures ?? 0,
      unavailableSamples: input.unavailableSamples ?? 0,
      sourceCursorGaps: snapshots
        .slice(1)
        .reduce(
          (sum, snapshot, index) =>
            sum + snapshot.cursor.sequence - snapshots[index].cursor.sequence - 1,
          0
        ),
      missingMediaKeys: input.missingMediaKeys ?? []
    },
    records: snapshots.map(projectRunObservationArchiveRecord),
    media: input.media ?? []
  })
  if (Buffer.byteLength(JSON.stringify(archive)) > MAX_RUN_OBSERVATION_ARCHIVE_BYTES)
    throw new Error('Observation archive exceeds its content limit.')
  return archive
}

/** Exact portable record projection, also used to budget durable sampling without loading older segments. */
export function projectRunObservationArchiveRecord({
  identity,
  cursor,
  stepId,
  run,
  artifacts,
  observedAt,
  phase,
  artifactsTruncated
}: RunObservationSnapshot): RunObservationArchive['records'][number] {
  const projectedRun = run
    ? {
        kernelKind: run.kernelKind,
        status: run.status,
        startedAt: run.startedAt,
        ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
        ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
        logs: run.logs
      }
    : null
  return {
    stepKey: `observation-${cursor.sequence}`,
    // Archive v1 is deliberately fixed. App-only execution context is recovered from the
    // collection receipt, and must never be spread into the portable record schema.
    observedAt,
    phase,
    artifactsTruncated,
    sourceEvidence: { identity, cursor, stepId },
    run: projectedRun,
    artifactEvidence: artifacts.map(({ artifactId, versionId, producerRunId, ...artifact }) => ({
      ...artifact,
      ...(artifactId ? { sourceArtifactId: artifactId } : {}),
      sourceVersionId: versionId,
      ...(producerRunId ? { sourceProducerRunId: producerRunId } : {})
    }))
  }
}

export type RunObservationMediaCandidate = Readonly<{
  projectId: string
  sessionId: string
  versionId: string
  name: string
  checksum: string
  sizeBytes: number
  state: string
  isPublished: boolean
}>
export type ResolvedRunObservationMedia =
  | Readonly<{ mediaKey: string; status: 'available'; versionId: string }>
  | Readonly<{ mediaKey: string; status: 'missing' | 'ambiguous' }>

/** Candidates must already be read-authorized. No global lookup, filesystem path or network fetch. */
export function resolveRunObservationMedia(
  archive: RunObservationArchive,
  scope: { projectId: string; sessionId: string },
  candidates: readonly RunObservationMediaCandidate[],
  /** Trusted read-only mapping from the retained import receipt, never parsed from this Artifact. */
  sourceVersionMapping?: Readonly<Record<string, string>>
): readonly ResolvedRunObservationMedia[] {
  return validateRunObservationArchive(archive).media.map((media) => {
    const matching = candidates.filter(
      (candidate) =>
        candidate.projectId === scope.projectId &&
        candidate.sessionId === scope.sessionId &&
        candidate.state === 'finalized' &&
        candidate.isPublished &&
        candidate.checksum === media.checksum &&
        candidate.sizeBytes === media.sizeBytes
    )
    const mapped = media.sourceVersionId && sourceVersionMapping?.[media.sourceVersionId]
    const exact = mapped ? matching.filter((candidate) => candidate.versionId === mapped) : []
    const named = matching.filter((candidate) => candidate.name === media.name)
    const selected = exact.length ? exact : named.length ? named : matching
    const ids = [...new Set(selected.map((candidate) => candidate.versionId))]
    return ids.length === 1
      ? { mediaKey: media.mediaKey, status: 'available' as const, versionId: ids[0] }
      : {
          mediaKey: media.mediaKey,
          status: ids.length ? ('ambiguous' as const) : ('missing' as const)
        }
  })
}

/** Verify fetched bytes as well as descriptor metadata before displaying captured media. */
export function verifyRunObservationMediaBytes(
  media: RunObservationArchiveMedia,
  bytes: Uint8Array
): boolean {
  return (
    bytes.byteLength === media.sizeBytes &&
    createHash('sha256').update(bytes).digest('hex') === media.checksum
  )
}
