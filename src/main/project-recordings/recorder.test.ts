import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseProjectRecording } from '../../shared/project-recording'
import type { AuxiliaryOutput, AuxiliaryOutputResult } from '../notebook/managed-auxiliary-output'
import {
  startProjectRecording,
  type ProjectRecordingHandle,
  type ProjectRecordingOptions
} from './recorder'

const handles: ProjectRecordingHandle[] = []
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }))
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.abort()
  vi.useRealTimers()
})
const image = (color = '#457ac1'): Promise<Buffer> =>
  sharp({ create: { width: 10, height: 8, channels: 3, background: color } })
    .png()
    .toBuffer()
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const deferred = <T>(): { promise: Promise<T>; resolve(value: T): void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function setup(overrides: Partial<ProjectRecordingOptions> = {}) {
  let clock = 100
  const outputs: { input: AuxiliaryOutput; bytes: Buffer }[] = []
  const save = vi.fn(async (input: AuxiliaryOutput): Promise<AuxiliaryOutputResult> => {
    const bytes = Buffer.from(
      input.source.content,
      input.source.encoding === 'base64' ? 'base64' : 'utf8'
    )
    outputs.push({ input, bytes })
    const versionId = `version-${outputs.length}`
    return {
      status: 'saved',
      artifact: {
        id: versionId,
        artifactId: `artifact-${outputs.length}`,
        versionId,
        versionNumber: 1,
        projectId: 'project',
        sessionId: 'session',
        name: input.filename,
        path: '',
        fileUrl: '',
        size: bytes.length,
        checksum: digest(bytes),
        mtimeMs: clock,
        createdAt: new Date(clock).toISOString()
      }
    }
  })
  const assertCurrent = vi.fn()
  const handle = startProjectRecording({
    recordingId: 'recording',
    source: { projectId: 'project', sessionId: 'session' },
    sources: [],
    save,
    assertCurrent,
    now: () => clock++,
    ...overrides
  })
  handles.push(handle)
  return { handle, outputs, save, assertCurrent }
}

describe('independent execution-time project recorder', () => {
  it('automatically reads explicitly declared state/event output without a viewer or images', async () => {
    let current = Buffer.from(
      JSON.stringify({
        format: 'open-science-project-recording-data',
        version: 1,
        states: [{ id: 'tick-0', sequence: 0, reportedAt: 7, value: { score: 1 } }],
        events: [
          { id: 'action-0', sequence: 0, reportedAt: 8, name: 'move', data: { direction: 'left' } }
        ]
      })
    )
    const read = vi.fn(async () => current)
    const h = setup({ declarations: [{ key: 'project-recording-data.json', read }] })
    await vi.advanceTimersByTimeAsync(0)
    await h.handle.sample()
    expect(read).toHaveBeenCalled()
    current = Buffer.from(
      JSON.stringify({
        format: 'open-science-project-recording-data',
        version: 1,
        states: [{ id: 'tick-1', sequence: 1, reportedAt: 9, value: { score: 2 } }],
        events: []
      })
    )
    const calls = read.mock.calls.length
    await vi.advanceTimersByTimeAsync(2000)
    expect(read.mock.calls.length).toBeGreaterThan(calls)
    await h.handle.sample()
    const result = await h.handle.finish()
    expect(result.status).toBe('saved')
    if (result.status !== 'saved') throw new Error('Expected recording')
    expect(result.recording.states.map((entry) => [entry.sourceId, entry.reportedAt])).toEqual([
      ['tick-0', 7],
      ['tick-1', 9]
    ])
    expect(result.recording.states.every((entry) => entry.recordedAt >= 100)).toBe(true)
    expect(result.recording.events).toHaveLength(1)
    expect(result.recording.frames).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
  it('captures declared images without any Notebook/viewer and deduplicates unchanged samples', async () => {
    const first = await image()
    let current = first
    const read = vi.fn(async () => ({ bytes: current, reportedCapturedAt: 10 }))
    const h = setup({ sources: [{ key: 'frame.png', kind: 'project-export', read }] })
    await h.handle.sample()
    await h.handle.sample()
    current = await image('#ff0000')
    await h.handle.sample()
    const result = await h.handle.finish()
    expect(result.status).toBe('saved')
    if (result.status !== 'saved') throw new Error('Expected recording')
    expect(result.recording.frames).toHaveLength(2)
    expect(result.recording.coverage.unchangedSamples).toBe(1)
    expect(result.recording.source?.runId).toBeUndefined()
    expect(result.recording.media.map((entry) => entry.checksum)).toEqual([
      digest(first),
      digest(current)
    ])
    expect(result.recording.media.map((entry) => entry.sourceVersionId)).toEqual([
      'version-1',
      'version-2'
    ])
    expect(result.recording.frames[0].provenance).toMatchObject({
      kind: 'capture',
      source: 'project-export',
      reportedCapturedAt: 10
    })
    expect(parseProjectRecording(h.outputs.at(-1)!.bytes.toString())).toEqual(result.recording)
    expect(vi.getTimerCount()).toBe(0)
    expect(await h.handle.finish()).toBe(result)
    expect(h.save).toHaveBeenCalledTimes(3)
  })
  it('drains explicitly admitted state/event evidence, without executing or interpreting its values', async () => {
    const h = setup()
    const data = { command: 'curl https://example.invalid', score: 3 }
    const state = h.handle.recordState({ label: 'Saved state', value: data })
    data.score = 99
    const event = h.handle.recordEvent({ name: 'selected direction', data: { direction: 'left' } })
    const finished = h.handle.finish()
    await Promise.all([state, event])
    const result = await finished
    expect(result.status).toBe('saved')
    if (result.status !== 'saved') throw new Error('Expected recording')
    expect(result.recording.frames).toEqual([])
    expect(result.recording.states[0]).toMatchObject({
      source: 'author-declared',
      value: { score: 3 }
    })
    expect(result.recording.events[0]).toMatchObject({
      source: 'author-declared',
      name: 'selected direction'
    })
    expect(h.save).toHaveBeenCalledTimes(1)
  })
  it('bounds image admission and stops automatically at capacity while retaining published evidence', async () => {
    let bytes = await image()
    const h = setup({
      sources: [{ key: 'frame', kind: 'project-export', read: async () => ({ bytes }) }],
      limits: { frames: 1 }
    })
    await h.handle.sample()
    bytes = await image('#ff0000')
    await h.handle.sample()
    const result = await h.handle.finish()
    expect(result.status).toBe('saved')
    if (result.status !== 'saved') throw new Error('Expected recording')
    expect(result.recording.frames).toHaveLength(1)
    expect(result.recording.coverage).toMatchObject({ stopReason: 'capacity', droppedSamples: 1 })
    expect(result.warnings).toContain('capacity')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('reports a failed source without poisoning the next source or requiring a project restart', async () => {
    const bytes = await image()
    const bad = vi.fn(async () => ({ bytes: Buffer.from('<script>not an image</script>') }))
    const good = vi.fn(async () => ({ bytes }))
    const h = setup({
      sources: [
        { key: 'bad', kind: 'project-export', read: bad },
        { key: 'good', kind: 'project-export', read: good }
      ]
    })
    await expect(h.handle.sample()).resolves.toBeUndefined()
    const result = await h.handle.finish()
    expect(result.status).toBe('saved')
    if (result.status !== 'saved') throw new Error('Expected recording')
    expect(result.recording.frames).toHaveLength(1)
    expect(result.recording.coverage.failures).toBe(1)
    expect(bad).toHaveBeenCalledTimes(1)
    expect(good).toHaveBeenCalledTimes(1)
  })
  it('drains an admitted artifact write before finishing, even when capture is aborted', async () => {
    const bytes = await image()
    const gate = deferred<void>()
    const entered = deferred<void>()
    const h = setup({
      sources: [{ key: 'frame', kind: 'project-export', read: async () => ({ bytes }) }]
    })
    const writer = h.save.getMockImplementation()!
    h.save.mockImplementationOnce(async (output) => {
      entered.resolve()
      await gate.promise
      return writer(output)
    })
    const sampling = h.handle.sample()
    await entered.promise
    const ending = h.handle.finish('stopped')
    let finished = false
    void ending.then(() => {
      finished = true
    })
    await Promise.resolve()
    expect(finished).toBe(false)
    gate.resolve()
    await sampling
    const result = await ending
    expect(result.status).toBe('saved')
    if (result.status !== 'saved') throw new Error('Expected recording')
    expect(result.recording.frames).toHaveLength(1)
    expect(result.recording.coverage.stopReason).toBe('stopped')
  })
  it('cancels bounded reads, discards late bytes and leaves no sampling timers', async () => {
    const gate = deferred<{ bytes: Buffer }>()
    const entered = deferred<AbortSignal>()
    const parent = new AbortController()
    const h = setup({
      signal: parent.signal,
      sources: [
        {
          key: 'frame',
          kind: 'project-export',
          read: (signal) => {
            entered.resolve(signal)
            return gate.promise
          }
        }
      ]
    })
    const sampling = h.handle.sample()
    const signal = await entered.promise
    parent.abort()
    await sampling
    expect(signal.aborted).toBe(true)
    const result = await h.handle.finish()
    gate.resolve({ bytes: await image() })
    await Promise.resolve()
    expect(h.outputs).toHaveLength(1)
    expect(result.status).toBe('saved')
    if (result.status !== 'saved') throw new Error('Expected recording')
    expect(result.recording.frames).toEqual([])
    expect(result.recording.coverage.stopReason).toBe('interrupted')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not repeat an uncertain publication and only saves an index with exact version checks', async () => {
    const bytes = await image()
    const h = setup({
      sources: [{ key: 'frame', kind: 'project-export', read: async () => ({ bytes }) }]
    })
    h.save.mockImplementationOnce(async () => {
      throw new Error('uncertain writer result')
    })
    await h.handle.sample()
    await h.handle.sample()
    expect(h.save).toHaveBeenCalledTimes(1)
    const result = await h.handle.finish()
    expect(result.status).toBe('saved')
    if (result.status !== 'saved') throw new Error('Expected recording')
    expect(result.recording.frames).toEqual([])
    expect(result.recording.coverage.failures).toBe(2)
    expect(h.save).toHaveBeenCalledTimes(2)
  })
  it('rejects mismatched artifact identities without exposing them as recorded evidence', async () => {
    const bytes = await image()
    const h = setup({
      sources: [{ key: 'frame', kind: 'project-export', read: async () => ({ bytes }) }]
    })
    const writer = h.save.getMockImplementation()!
    h.save.mockImplementationOnce(async (output) => {
      const result = await writer(output)
      if (result.status === 'saved') result.artifact.sessionId = 'other-session'
      return result
    })
    await h.handle.sample()
    const result = await h.handle.finish()
    expect(result.status).toBe('saved')
    if (result.status !== 'saved') throw new Error('Expected recording')
    expect(result.recording.media).toEqual([])
    expect(result.recording.frames).toEqual([])
    expect(result.warnings).toContain('capture-failed')
  })
})
