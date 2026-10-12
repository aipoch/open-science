import { createHash } from 'node:crypto'
import {
  validateBrowserRecording,
  type RecordedBrowserPayload,
  type BrowserRecordingMoment
} from '../../shared/browser-recording'

export function browserRecordedFixture(): {
  bytes: Buffer
  payload: RecordedBrowserPayload
  moment: BrowserRecordingMoment
} {
  const bytes = Buffer.from('test-webm-segment-bytes')
  const checksum = createHash('sha256').update(bytes).digest('hex')
  const receiving = {
    projectId: 'project-a',
    sessionId: 'session-a',
    artifactId: 'index-a',
    versionId: 'index-v1'
  }
  const recording = validateBrowserRecording({
    format: 'open-science-web-recording',
    version: 1,
    recordingId: 'web-a',
    startedAt: 1000,
    durationMs: 3000,
    media: [
      {
        mediaKey: 'segment-a',
        name: 'segment-a.webm',
        mimeType: 'video/webm',
        checksum,
        sizeBytes: bytes.length,
        sourceVersionId: 'author-v1'
      }
    ],
    segments: [
      {
        segmentId: 'part-a',
        mediaKey: 'segment-a',
        startMs: 0,
        endMs: 3000,
        width: 640,
        height: 480,
        codec: 'vp8',
        frameRate: 15
      }
    ],
    events: [
      {
        eventId: 'click-a',
        offsetMs: 1000,
        kind: 'click',
        source: 'browser-observed',
        x: 42,
        y: 33
      }
    ],
    coverage: { stopReason: 'stopped', gaps: [], droppedFrames: 0 }
  })
  const payload = {
    receiving,
    recording,
    indexChecksum: createHash('sha256').update(JSON.stringify(recording)).digest('hex'),
    media: [
      {
        mediaKey: 'segment-a',
        artifactId: 'media-a',
        versionId: 'media-v1',
        checksum,
        sizeBytes: bytes.length
      }
    ]
  }
  const moment: BrowserRecordingMoment = {
    kind: 'recorded-project-moment',
    selectionId: 'selection-a',
    selectedAt: 2000,
    receiving,
    indexChecksum: payload.indexChecksum,
    recordingId: 'web-a',
    offsetMs: 1500,
    segmentId: 'part-a',
    mediaKey: 'segment-a',
    segmentOffsetMs: 1500,
    resource: {
      ...receiving,
      artifactId: 'media-a',
      versionId: 'media-v1',
      name: 'segment-a.webm',
      mimeType: 'video/webm',
      checksum,
      sizeBytes: bytes.length
    }
  }
  return { bytes, payload, moment }
}
