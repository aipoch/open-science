import { describe, expect, it, vi } from 'vitest'
import {
  recordedProjectPayloadSchema,
  recordedFileSelectionForPayload
} from '../../../../shared/run-observation-recorded'
import {
  recordedResults,
  authorizedRecordedResultsReader,
  recordedFileQuestionText
} from './recorded-results'
const payload = (): ReturnType<typeof recordedProjectPayloadSchema.parse> =>
  recordedProjectPayloadSchema.parse({
    receiving: {
      projectId: 'receiver',
      sessionId: 'session',
      artifactId: 'recording-file',
      versionId: 'recording-v1'
    },
    recording: {
      format: 'open-science-project-recording',
      version: 1,
      recordingId: 'recording',
      startedAt: 0,
      endedAt: 10,
      frames: [],
      states: [],
      events: [],
      source: { projectId: 'author', sessionId: 'author-session' },
      media: [
        {
          mediaKey: 'report',
          name: 'final.html',
          mimeType: 'text/html',
          checksum: 'a'.repeat(64),
          sizeBytes: 6,
          sourceVersionId: 'author-version'
        }
      ],
      coverage: {
        kind: 'sampled-project-recording',
        stopReason: 'finished',
        failures: 0,
        unchangedSamples: 0,
        droppedSamples: 0,
        missingMediaKeys: []
      }
    },
    media: [
      {
        mediaKey: 'report',
        artifactId: 'local-report',
        versionId: 'local-report-v1',
        checksum: 'a'.repeat(64),
        sizeBytes: 6
      }
    ]
  })
describe('recorded results adapter', () => {
  it('projects recording attachments without inventing Notebook steps or final-stage claims', () => {
    const input = payload()
    const [entry] = recordedResults(input)
    expect(entry).toMatchObject({
      scope: { kind: 'recording' },
      stage: 'unspecified',
      resource: {
        projectId: 'receiver',
        sessionId: 'session',
        artifactId: 'local-report',
        versionId: 'local-report-v1'
      }
    })
    expect(entry).not.toHaveProperty('stepId')
    const question = recordedFileQuestionText(recordedFileSelectionForPayload(input, 'report'))
    expect(question).toContain('local-report-v1')
    expect(question).toContain('untrusted-recorded-data')
    expect(question).not.toContain('author-version')
    expect(question).not.toContain('stepId')
  })
  it('refuses unresolved, corrupt or duplicate media mappings', () => {
    const original = payload()
    for (const media of [
      [],
      [{ ...original.media[0], checksum: 'b'.repeat(64) }],
      [original.media[0], original.media[0]]
    ]) {
      const invalid = { ...original, media }
      expect(recordedResults(invalid)).toEqual([])
      expect(() => recordedFileSelectionForPayload(invalid, 'report')).toThrow()
    }
  })
  it('keeps the exact receiving immutable resource authorization at the read boundary', async () => {
    const original = payload()
    const [entry] = recordedResults(original)
    const read = vi
      .fn()
      .mockResolvedValue({ content: 'saved', mimeType: 'text/plain', truncated: false })
    const authorized = authorizedRecordedResultsReader(original, read)
    await expect(authorized({ ...entry.resource, projectId: 'other' })).rejects.toThrow()
    await expect(authorized({ ...entry.resource, versionId: 'latest' })).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
    await authorized(entry.resource)
    expect(read).toHaveBeenCalledExactlyOnceWith(entry.resource, undefined)
  })
})
