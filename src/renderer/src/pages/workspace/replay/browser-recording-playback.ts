import type {
  BrowserRecording,
  BrowserRecordingSegment
} from '../../../../../shared/browser-recording'

export const recordingTime = (ms: number): string => {
  const seconds = Math.floor(Math.max(0, ms) / 1000)
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}
export const segmentAt = (
  recording: BrowserRecording,
  offsetMs: number
): BrowserRecordingSegment | undefined =>
  recording.segments.find((segment) => offsetMs >= segment.startMs && offsetMs < segment.endMs)
