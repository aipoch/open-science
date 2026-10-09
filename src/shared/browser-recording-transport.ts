/** Presentation-only transport for an embedded, already-authorized recording viewer.
 * It carries no artifact identities, viewer grants, runtime actions, or resource contents. */
export const BROWSER_RECORDING_TRANSPORT_CHANNEL = 'open-science-browser-recording-transport'
export const BROWSER_RECORDING_TRANSPORT_VERSION = 1

export type BrowserRecordingPlaybackState = {
  recordedAt?: number
  playing: boolean
  speed: number
  presentation?: 'research'
}

type Envelope = {
  channel: typeof BROWSER_RECORDING_TRANSPORT_CHANNEL
  version: typeof BROWSER_RECORDING_TRANSPORT_VERSION
}
type TransportBody =
  | { type: 'offer' | 'ready' | 'close' }
  | { type: 'state'; revision: number; playback: BrowserRecordingPlaybackState }
  | { type: 'seek'; revision: number; recordedAt: number }
  | {
      type: 'action'
      revision: number
      disabled: boolean
      pending: boolean
      recordedAt?: number
      title?: string
    }
  | { type: 'ask'; revision: number }
export type BrowserRecordingTransportMessage = Envelope & TransportBody

export const isBrowserRecordingRecordedAt = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= Number.MAX_SAFE_INTEGER

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const keysWithin = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key))

export const isBrowserRecordingPlaybackState = (
  value: unknown
): value is BrowserRecordingPlaybackState =>
  object(value) &&
  keysWithin(value, ['recordedAt', 'playing', 'speed', 'presentation']) &&
  (value.presentation === undefined || value.presentation === 'research') &&
  (value.recordedAt === undefined || isBrowserRecordingRecordedAt(value.recordedAt)) &&
  typeof value.playing === 'boolean' &&
  typeof value.speed === 'number' &&
  Number.isFinite(value.speed) &&
  value.speed >= 0.1 &&
  value.speed <= 16

export const isBrowserRecordingTransportMessage = (
  value: unknown
): value is BrowserRecordingTransportMessage => {
  if (
    !object(value) ||
    value.channel !== BROWSER_RECORDING_TRANSPORT_CHANNEL ||
    value.version !== BROWSER_RECORDING_TRANSPORT_VERSION
  )
    return false
  const envelope = ['channel', 'version', 'type']
  if (value.type === 'offer' || value.type === 'ready' || value.type === 'close')
    return keysWithin(value, envelope)
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) return false
  if (value.type === 'ask') return keysWithin(value, [...envelope, 'revision'])
  if (value.type === 'action')
    return (
      keysWithin(value, [...envelope, 'revision', 'disabled', 'pending', 'recordedAt', 'title']) &&
      typeof value.disabled === 'boolean' &&
      typeof value.pending === 'boolean' &&
      (value.recordedAt === undefined || isBrowserRecordingRecordedAt(value.recordedAt)) &&
      (value.title === undefined || (typeof value.title === 'string' && value.title.length <= 512))
    )
  if (value.type === 'state')
    return (
      keysWithin(value, [...envelope, 'revision', 'playback']) &&
      isBrowserRecordingPlaybackState(value.playback)
    )
  return (
    value.type === 'seek' &&
    keysWithin(value, [...envelope, 'revision', 'recordedAt']) &&
    isBrowserRecordingRecordedAt(value.recordedAt)
  )
}

export const recordingTransportMessage = (
  message: TransportBody
): BrowserRecordingTransportMessage => ({
  channel: BROWSER_RECORDING_TRANSPORT_CHANNEL,
  version: BROWSER_RECORDING_TRANSPORT_VERSION,
  ...message
})
