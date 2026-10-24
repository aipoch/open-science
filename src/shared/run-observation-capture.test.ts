import { describe, expect, it } from 'vitest'
import {
  observationMediaCaptureOptionsSchema,
  observationMediaCaptureRequestSchema,
  observationMediaCaptureResultSchema,
  observationViewerCaptureSchema,
  observationCaptureContentRequestSchema,
  observationCaptureContentSchema,
  observationViewerCaptureContentRequestSchema,
  MAX_OBSERVATION_CAPTURE_CHUNK_BYTES
} from './run-observation-capture'

const result = {
  captureId: 'capture-1',
  recordingId: 'recording-1',
  stepKey: 'observation-1',
  artifactId: 'artifact-1',
  versionId: 'version-1',
  checksum: 'a'.repeat(64),
  sizeBytes: 123,
  mimeType: 'image/png',
  publication: 'awaiting-publication',
  capture: {
    source: 'project-export',
    association: 'current-observation',
    startedAt: 100,
    finishedAt: 110,
    observedAt: 80,
    width: 10,
    height: 8
  }
}
describe('observation image capture transport contracts', () => {
  it('bounds content requests without adding filesystem or destination authority', () => {
    expect(observationCaptureContentRequestSchema.parse({ captureId: 'capture-1' })).toEqual({
      captureId: 'capture-1'
    })
    const viewerId = 'ad69e821-8439-4e9c-bdc1-41e8d484f600'
    expect(
      observationViewerCaptureContentRequestSchema.parse({
        viewerId,
        captureId: 'capture-1',
        length: MAX_OBSERVATION_CAPTURE_CHUNK_BYTES,
        offset: 0
      })
    ).toHaveProperty('viewerId', viewerId)
    for (const extra of [
      { offset: -1 },
      { offset: 0.5 },
      { length: 0 },
      { length: MAX_OBSERVATION_CAPTURE_CHUNK_BYTES + 1 },
      { path: '/image' },
      { viewerId }
    ])
      expect(
        observationCaptureContentRequestSchema.safeParse({ captureId: 'capture-1', ...extra })
          .success
      ).toBe(false)
  })

  it('verifies canonical bounded chunks, exact continuation and EOF shape', () => {
    const content = {
      captureId: 'capture-1',
      mimeType: 'image/png',
      checksum: 'a'.repeat(64),
      sizeBytes: 6,
      offset: 0,
      dataBase64: 'YWJj',
      nextOffset: 3
    }
    expect(observationCaptureContentSchema.parse(content)).toEqual(content)
    expect(
      observationCaptureContentSchema.safeParse({ ...content, offset: 3, nextOffset: undefined })
        .success
    ).toBe(true)
    expect(
      observationCaptureContentSchema.safeParse({
        ...content,
        offset: 6,
        dataBase64: '',
        nextOffset: undefined
      }).success
    ).toBe(true)
    for (const extra of [
      { nextOffset: undefined },
      { nextOffset: 4 },
      { offset: 5 },
      { dataBase64: '' },
      { dataBase64: '/x==', nextOffset: 1 },
      { dataBase64: '/w=', nextOffset: 1 },
      { dataBase64: 'YQ==\n', nextOffset: 1 },
      { sizeBytes: 16 * 1024 * 1024 + 1 }
    ])
      expect(observationCaptureContentSchema.safeParse({ ...content, ...extra }).success).toBe(
        false
      )
    const full = Buffer.alloc(MAX_OBSERVATION_CAPTURE_CHUNK_BYTES).toString('base64')
    expect(
      observationCaptureContentSchema.safeParse({
        ...content,
        sizeBytes: MAX_OBSERVATION_CAPTURE_CHUNK_BYTES,
        dataBase64: full,
        nextOffset: undefined
      }).success
    ).toBe(true)
    const over = Buffer.alloc(MAX_OBSERVATION_CAPTURE_CHUNK_BYTES + 1).toString('base64')
    expect(
      observationCaptureContentSchema.safeParse({
        ...content,
        sizeBytes: MAX_OBSERVATION_CAPTURE_CHUNK_BYTES + 1,
        dataBase64: over,
        nextOffset: undefined
      }).success
    ).toBe(false)
  })
  it('accepts explicit acquisition capabilities and rejects path, frame, step and producer authority', () => {
    const request = { source: 'project-export', exportKey: 'image.png', idempotencyKey: 'retry-1' }
    expect(observationMediaCaptureRequestSchema.parse(request)).toEqual(request)
    for (const extra of [
      { path: '/image.png' },
      { stepKey: 'old' },
      { producerRunId: 'run' },
      { url: 'https://example.test' }
    ])
      expect(observationMediaCaptureRequestSchema.safeParse({ ...request, ...extra }).success).toBe(
        false
      )
    for (const exportKey of ['../image.png', 'dir/image.png', '\\image.png', '\0frame', '.'])
      expect(
        observationMediaCaptureRequestSchema.safeParse({ ...request, exportKey }).success
      ).toBe(false)
    expect(
      observationMediaCaptureRequestSchema.safeParse({
        source: 'host-view',
        idempotencyKey: 'retry-2',
        exportKey: 'image.png'
      }).success
    ).toBe(false)
  })

  it('distinguishes acquisition time from unchanged evidence time and refuses impossible acquisition metadata', () => {
    expect(observationMediaCaptureResultSchema.parse(result)).toEqual(result)
    for (const capture of [
      { ...result.capture, finishedAt: 99 },
      { ...result.capture, width: 16_000_000, height: 2 },
      { ...result.capture, source: 'host-view', reportedCapturedAt: 1 }
    ])
      expect(observationMediaCaptureResultSchema.safeParse({ ...result, capture }).success).toBe(
        false
      )
  })

  it('permits only an explicit viewer-local association, separately from the recorded step key', () => {
    const viewerEvidence = {
      cursor: { epoch: 'viewer-epoch', sequence: 3 },
      observedAt: 90,
      stepId: 'run:run-1'
    }
    expect(observationViewerCaptureSchema.parse({ ...result, viewerEvidence })).toEqual({
      ...result,
      viewerEvidence
    })
    expect(
      observationMediaCaptureResultSchema.safeParse({ ...result, viewerEvidence }).success
    ).toBe(false)
    expect(
      observationViewerCaptureSchema.safeParse({
        ...result,
        viewerEvidence: { ...viewerEvidence, url: 'http://localhost' }
      }).success
    ).toBe(false)
    expect(
      observationMediaCaptureOptionsSchema.safeParse({
        hostView: false,
        projectExports: ['frame.png'],
        path: '/private'
      }).success
    ).toBe(false)
  })
})
