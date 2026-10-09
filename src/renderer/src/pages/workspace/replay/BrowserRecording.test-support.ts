import type {
  BrowserRecording,
  RecordedBrowserPayload,
  BrowserRecordingMoment
} from '../../../../../shared/browser-recording'
export const browserRecordingFixture = (): BrowserRecording => ({
  format: 'open-science-web-recording',
  version: 1,
  recordingId: 'browser-recording',
  startedAt: 1000,
  durationMs: 7000,
  media: [0, 1, 2].map((n) => ({
    mediaKey: `media-${n}`,
    name: `segment-${n}.webm`,
    mimeType: 'video/webm',
    checksum: 'a'.repeat(64),
    sizeBytes: 200,
    sourceVersionId: `version-${n}`
  })),
  segments: [0, 1, 2].map((n) => ({
    segmentId: `segment-${n}`,
    mediaKey: `media-${n}`,
    startMs: n === 2 ? 5000 : n * 2000,
    endMs: n === 2 ? 7000 : n * 2000 + 2000,
    width: 1280,
    height: 720,
    codec: 'vp8',
    frameRate: 10
  })),
  events: [
    { eventId: 'click', offsetMs: 1500, kind: 'click', source: 'host-observed', label: 'Start' }
  ],
  coverage: {
    stopReason: 'stopped',
    gaps: [{ startMs: 4000, endMs: 5000, reason: 'paused' }],
    droppedFrames: 0
  }
})
export const browserPayloadFixture = (): RecordedBrowserPayload => ({
  receiving: {
    projectId: 'local-project',
    sessionId: 'local-session',
    artifactId: 'index',
    versionId: 'index-version'
  },
  indexChecksum: 'b'.repeat(64),
  recording: browserRecordingFixture(),
  media: browserRecordingFixture().media.map((media, n) => ({
    mediaKey: media.mediaKey,
    artifactId: `file-${n}`,
    versionId: `local-version-${n}`,
    checksum: media.checksum,
    sizeBytes: media.sizeBytes
  }))
})
export const browserMomentFixture = (offsetMs = 1200): BrowserRecordingMoment => {
  const payload = browserPayloadFixture()
  const segment = payload.recording.segments.find(
    (item) => offsetMs >= item.startMs && offsetMs < item.endMs
  )!
  const media = payload.media.find((item) => item.mediaKey === segment.mediaKey)!
  const declared = payload.recording.media.find((item) => item.mediaKey === segment.mediaKey)!
  return {
    kind: 'recorded-project-moment',
    selectionId: 'selection',
    selectedAt: 9000,
    receiving: payload.receiving,
    indexChecksum: payload.indexChecksum,
    recordingId: payload.recording.recordingId,
    offsetMs,
    segmentOffsetMs: offsetMs - segment.startMs,
    segmentId: segment.segmentId,
    mediaKey: segment.mediaKey,
    resource: {
      projectId: payload.receiving.projectId,
      sessionId: payload.receiving.sessionId,
      artifactId: media.artifactId,
      versionId: media.versionId,
      name: declared.name,
      mimeType: declared.mimeType,
      checksum: media.checksum,
      sizeBytes: media.sizeBytes
    }
  }
}
