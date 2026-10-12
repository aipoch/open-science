import { describe, expect, it, vi } from 'vitest'
import {
  validateRunObservationArchive,
  type RunObservationArchive
} from '../../../../shared/run-observation-archive'
import {
  projectRecordedObservation,
  authorizedRecordedResourceReader
} from './recorded-observation'
const receiving = {
  projectId: 'local-project',
  sessionId: 'local-session',
  artifactId: 'local-recording',
  versionId: 'local-recording-v1'
}
const fixture = (): RunObservationArchive =>
  validateRunObservationArchive({
    format: 'open-science-run-observation',
    version: 1,
    recordingId: 'recording',
    capturedAt: 300,
    coverage: {
      kind: 'sampled-observations',
      includesPreObservationHistory: false,
      firstObservedAt: 100,
      lastObservedAt: 200,
      droppedEarlierObservations: false,
      terminalRunObserved: false,
      stopReason: 'manual',
      logTruncation: false,
      redactedContent: false,
      sourceCursorGaps: 1,
      missingMediaKeys: ['missing-file']
    },
    records: [0, 2].map((sequence, index) => ({
      stepKey: `step-${index}`,
      observedAt: index ? 200 : 100,
      phase: 'running',
      sourceEvidence: {
        identity: { projectId: 'sender-project', sessionId: 'sender-session', runId: 'sender-run' },
        cursor: { epoch: 'sender-epoch', sequence },
        stepId: 'run:sender-run'
      },
      run: {
        kernelKind: 'bash',
        status: 'running',
        startedAt: 90,
        logs: {
          stdout: {
            text: index ? 'later output' : 'first output',
            truncated: false,
            redacted: false
          },
          stderr: { text: '', truncated: false, redacted: false },
          traceback: { text: '', truncated: false, redacted: false }
        }
      },
      artifactEvidence: [
        {
          name: 'source.txt',
          sourceArtifactId: 'sender-artifact',
          sourceVersionId: 'sender-version'
        }
      ],
      artifactsTruncated: false
    })),
    media: [
      {
        mediaKey: 'text',
        name: 'saved.txt',
        mimeType: 'text/plain',
        checksum: 'a'.repeat(64),
        sizeBytes: 5,
        sourceVersionId: 'sender-version',
        stepKeys: ['step-0']
      }
    ]
  })
const media = [
  {
    mediaKey: 'text',
    artifactId: 'local-media',
    versionId: 'local-media-v1',
    checksum: 'a'.repeat(64),
    sizeBytes: 5
  }
]

describe('portable observation UI projection', () => {
  it.each(['completed', 'failed', 'cancelled', 'interrupted', 'timeout'] as const)(
    'presents a %s recorded Run while preserving the sampled publication phase in evidence',
    (status) => {
      const archive = fixture()
      const last = archive.records.at(-1)!
      last.phase = 'collecting'
      last.run!.status = status
      const projected = projectRecordedObservation(archive, receiving, media)
      expect(projected.snapshots.at(-1)!.phase).toBe(status)
      expect(projected.snapshots[0].phase).toBe('running')
      expect(projected.select(projected.snapshots.at(-1)!).record).toEqual(last)
      expect(last.phase).toBe('collecting')
    }
  )
  it('retains sender evidence separately and authorizes only exact receiver media Versions', async () => {
    const archive = fixture(),
      projected = projectRecordedObservation(archive, receiving, media)
    expect(projected.snapshots[0].identity).toMatchObject({
      projectId: 'local-project',
      sessionId: 'local-session'
    })
    expect(projected.snapshots[0].run?.runId).toMatch(/^recording-local-/)
    expect(JSON.stringify(projected.snapshots)).not.toContain('sender-run')
    expect(projected.snapshots[0].artifacts[0]).toMatchObject({
      artifactId: 'local-media',
      versionId: 'local-media-v1'
    })
    expect(projected.snapshots[1].artifacts).toEqual([])
    expect(projected.unresolvedMediaKeys).toEqual(['missing-file'])
    const resource = projected.resources.get('local-media-v1')!
    const read = vi.fn().mockResolvedValue({ status: 'ready', kind: 'text', content: 'bytes' })
    const guarded = authorizedRecordedResourceReader(projected.resolveResource, read)
    await guarded(resource)
    expect(read).toHaveBeenCalledExactlyOnceWith(resource)
    await expect(
      guarded({ ...resource, projectId: 'sender-project', versionId: 'sender-version' })
    ).resolves.toEqual({ status: 'unavailable', reason: 'not-recorded' })
    await expect(guarded({ ...resource, locator: '/tmp/arbitrary-path' })).resolves.toEqual({
      status: 'unavailable',
      reason: 'not-recorded'
    })
    expect(read).toHaveBeenCalledTimes(1)
  })
  it('freezes the selected archive record and source cursor instead of referring to a local current Run', () => {
    const archive = fixture(),
      projected = projectRecordedObservation(archive, receiving, media)
    archive.records[0].run!.logs.stdout.text = 'mutated after projection'
    const selected = projected.select(projected.snapshots[0])
    expect(selected).toMatchObject({
      kind: 'recorded-run-observation',
      receiving,
      stepKey: 'step-0',
      record: { sourceEvidence: { cursor: { epoch: 'sender-epoch', sequence: 0 } } }
    })
    expect(selected.record.run!.logs.stdout.text).toBe('first output')
    expect(selected.mediaKeys).toEqual(['text'])
    expect(Object.isFrozen(selected.record.run!.logs.stdout)).toBe(true)
    expect(() => {
      selected.record.run!.logs.stdout.text = 'replacement'
    }).toThrow()
    expect(() =>
      projected.select({ ...projected.snapshots[0], cursor: { epoch: 'foreign', sequence: 0 } })
    ).toThrow()
  })
  it('does not accept invented, duplicate or hash-mismatched media resolutions', () => {
    expect(() =>
      projectRecordedObservation(fixture(), receiving, [{ ...media[0], checksum: 'b'.repeat(64) }])
    ).toThrow('declared content')
    expect(() =>
      projectRecordedObservation(fixture(), receiving, [{ ...media[0], mediaKey: 'invented' }])
    ).toThrow('declared content')
    expect(() => projectRecordedObservation(fixture(), receiving, [media[0], media[0]])).toThrow(
      'declared content'
    )
    const projected = projectRecordedObservation(fixture(), receiving, [])
    expect(projected.resources.size).toBe(0)
    expect(projected.unresolvedMediaKeys).toEqual(['missing-file', 'text'])
  })
})
