import { describe, expect, it } from 'vitest'
import {
  MAX_PROJECT_RECORDING_DATA_BYTES,
  parseProjectRecordingData
} from '../../shared/project-recording-data'
import { ProjectRecordingDeclarations } from './declarations'

const bytes = (states: unknown[] = [], events: unknown[] = []): Uint8Array =>
  Buffer.from(
    JSON.stringify({
      format: 'open-science-project-recording-data',
      version: 1,
      states,
      events
    })
  )
describe('declared project state and event intake', () => {
  it('keeps author timestamps and IDs, deduplicates exact retained declarations and reports gaps', () => {
    const input = new ProjectRecordingDeclarations()
    const first = { id: 'turn-0', sequence: 0, reportedAt: 10, value: { x: 1 } }
    expect(input.read(bytes([first])).states).toEqual([first])
    expect(input.read(bytes([first])).states).toEqual([])
    const next = { id: 'turn-3', sequence: 3, value: { x: 2 } }
    expect(input.read(bytes([first, next]))).toMatchObject({ states: [next], missingSequences: 2 })
  })
  it('rejects mutation and sequence reuse without accepting the other channel in the bad batch', () => {
    const input = new ProjectRecordingDeclarations()
    const event = { id: 'event', sequence: 0, name: 'saved operation' }
    input.read(bytes([], [event]))
    const state = { id: 'state', sequence: 0, value: { x: 1 } }
    expect(() => input.read(bytes([state], [{ ...event, name: 'replaced operation' }]))).toThrow()
    expect(input.read(bytes([state], [event])).states).toHaveLength(1)
    expect(() => input.read(bytes([{ ...state, id: 'new-identity' }], [event]))).toThrow()
  })
  it('only accepts bounded strict declarative JSON, never code or extra launch fields', () => {
    expect(() =>
      parseProjectRecordingData(
        Buffer.from(
          '{"format":"open-science-project-recording-data","version":1,"states":[],"events":[],"execute":"run"}'
        )
      )
    ).toThrow()
    expect(() =>
      parseProjectRecordingData(new Uint8Array(MAX_PROJECT_RECORDING_DATA_BYTES + 1))
    ).toThrow()
    expect(() => parseProjectRecordingData(Buffer.from('runExperiment()'))).toThrow()
    expect(() =>
      parseProjectRecordingData(
        bytes([{ id: 'too-large', sequence: 0, value: 'x'.repeat(70_000) }])
      )
    ).toThrow()
    expect(() =>
      parseProjectRecordingData(
        bytes(
          [],
          [
            { id: 'repeat', sequence: 0, name: 'first' },
            { id: 'repeat', sequence: 1, name: 'again' }
          ]
        )
      )
    ).toThrow()
    expect(
      parseProjectRecordingData(
        bytes(
          [],
          [{ id: 'text', sequence: 0, name: 'shown as text', data: { command: 'do not execute' } }]
        )
      ).events[0].data
    ).toEqual({ command: 'do not execute' })
  })
})
