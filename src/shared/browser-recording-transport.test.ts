import { describe, expect, it } from 'vitest'
import {
  isBrowserRecordingPlaybackState,
  isBrowserRecordingTransportMessage,
  recordingTransportMessage
} from './browser-recording-transport'

describe('recording presentation transport', () => {
  it('accepts bounded decoded-frame context and rejects malformed metadata', () => {
    const action = recordingTransportMessage({
      type: 'action',
      revision: 1,
      disabled: false,
      pending: false,
      recordedAt: 2346,
      title: 'Experiment'
    })
    expect(isBrowserRecordingTransportMessage(action)).toBe(true)
    for (const recordedAt of [-1, Infinity, NaN, '2346'])
      expect(isBrowserRecordingTransportMessage({ ...action, recordedAt })).toBe(false)
    for (const title of [null, {}, 'a'.repeat(513)])
      expect(isBrowserRecordingTransportMessage({ ...action, title })).toBe(false)
  })
  it('accepts only the small presentation envelope and finite bounded clock values', () => {
    for (const type of ['offer', 'ready', 'close'] as const)
      expect(isBrowserRecordingTransportMessage(recordingTransportMessage({ type }))).toBe(true)
    expect(
      isBrowserRecordingTransportMessage(
        recordingTransportMessage({
          type: 'state',
          revision: 1,
          playback: { recordedAt: 1700000000000.25, playing: true, speed: 4 }
        })
      )
    ).toBe(true)
    expect(isBrowserRecordingPlaybackState({ playing: false, speed: 1 })).toBe(true)
    for (const recordedAt of [-1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '42', null])
      expect(isBrowserRecordingPlaybackState({ recordedAt, playing: false, speed: 1 })).toBe(false)
    for (const speed of [-1, 0, 0.01, 17, Infinity, NaN, '2'])
      expect(isBrowserRecordingPlaybackState({ playing: false, speed })).toBe(false)
  })
  it('rejects commands, grants, resource contents, stale protocols, and malformed revisions', () => {
    const state = recordingTransportMessage({
      type: 'state',
      revision: 1,
      playback: { recordedAt: 1000, playing: false, speed: 1 }
    })
    for (const value of [
      null,
      [],
      { ...state, channel: 'other' },
      { ...state, version: 2 },
      { ...state, type: 'run' },
      { ...state, grant: 'credential' },
      { ...state, revision: 0 },
      { ...state, revision: 1.5 },
      { ...state, revision: Infinity },
      { ...state, playback: { playing: true, speed: 1, artifactId: 'secret' } }
    ])
      expect(isBrowserRecordingTransportMessage(value)).toBe(false)
    expect(
      isBrowserRecordingTransportMessage(
        recordingTransportMessage({ type: 'seek', revision: 5, recordedAt: 1000 })
      )
    ).toBe(true)
  })
})
