import type { ResearchRecordingCoverage } from '@/lib/replay/recorded-time'

type Target = ResearchRecordingCoverage['target']

export const recordingTargetKey = (target: Target): string =>
  JSON.stringify([target.projectId, target.sessionId, target.artifactId, target.versionId])

export type RecordingAtTime =
  { kind: 'recording'; target: Target } | { kind: 'gap' | 'ambiguous' | 'unaligned' }

/** Only verified coverage from the owning branch may select footage. Names, publication
 * order and nearby timestamps are not evidence. Segment intervals are half-open so adjacent
 * recordings switch deterministically; the final endpoint remains inspectable. */
export const recordingAtTime = (
  coverage: readonly ResearchRecordingCoverage[],
  recordedAt: number | undefined
): RecordingAtTime => {
  if (recordedAt === undefined || !Number.isFinite(recordedAt)) return { kind: 'unaligned' }
  let matches = coverage.filter((item) =>
    item.ranges.some((range) => recordedAt >= range.startedAt && recordedAt < range.endedAt)
  )
  if (!matches.length)
    matches = coverage.filter(
      (item) =>
        item.endedAt === recordedAt &&
        item.ranges.some((range) => range.endedAt === recordedAt && range.startedAt < recordedAt)
    )
  const targets = new Map(matches.map((item) => [recordingTargetKey(item.target), item.target]))
  if (targets.size > 1) return { kind: 'ambiguous' }
  const target = targets.values().next().value
  return target ? { kind: 'recording', target } : { kind: 'gap' }
}
