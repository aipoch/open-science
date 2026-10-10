import { beforeEach, expect, it, vi } from 'vitest'
import type { ManagedProjectRecordingRegistration } from '../notebook/managed-execution-service'
import type { ProjectRecordingOptions } from './recorder'
import { startManagedProjectRecording } from './managed-adapter'
import type { readObservationProjectExport } from '../run-observation/project-export-reader'

const seam = vi.hoisted(() => ({ start: vi.fn(), sample: vi.fn(), finish: vi.fn() }))
vi.mock('./recorder', () => ({ startProjectRecording: seam.start }))
beforeEach(() => {
  vi.clearAllMocks()
  seam.sample.mockResolvedValue(undefined)
  seam.finish.mockResolvedValue({
    status: 'saved',
    artifact: { artifactId: 'artifact', versionId: 'version' },
    warnings: []
  })
  seam.start.mockReturnValue({ sample: seam.sample, finish: seam.finish })
})
const input = (
  outputs: ManagedProjectRecordingRegistration['outputs']
): ManagedProjectRecordingRegistration => ({
  target: {
    projectId: 'project',
    sessionId: 'session',
    operationId: 'operation',
    executionInvocationId: 'execution'
  },
  outputAuthority: {} as ManagedProjectRecordingRegistration['outputAuthority'],
  outputs,
  saveAuxiliaryOutput: vi.fn(),
  signal: new AbortController().signal
})

it('binds only explicitly declared image/data paths to their original output authority without requiring a Run or viewer', async () => {
  const registration = input([
    { filename: 'World frame.png', path: 'frames/world.png' },
    { filename: 'project-recording-data.json', path: 'data/declared.json' },
    { filename: 'other.json', path: 'do-not-read.json' },
    { filename: 'program.html', path: 'do-not-open.html' }
  ])
  const read = vi.fn<typeof readObservationProjectExport>(async () => ({
    bytes: new Uint8Array([1, 2, 3])
  }))
  const guard = vi.fn()
  const handle = startManagedProjectRecording(registration, guard, read)!
  const options = seam.start.mock.calls[0][0] as ProjectRecordingOptions
  expect(options.sources).toHaveLength(1)
  expect(options.declarations).toHaveLength(1)
  expect(options.source).not.toHaveProperty('runId')
  expect(options.assertCurrent).toBe(guard)
  await options.sources[0].read(registration.signal)
  await options.declarations![0].read(registration.signal)
  expect(read.mock.calls.map(([request]) => request.path)).toEqual([
    'frames/world.png',
    'data/declared.json'
  ])
  for (const [request] of read.mock.calls)
    expect(request).toMatchObject({
      authority: registration.outputAuthority,
      scope: registration.target,
      signal: registration.signal
    })
  expect(await handle.close()).toEqual({
    status: 'saved',
    artifactId: 'artifact',
    versionId: 'version',
    warnings: []
  })
  await handle.close()
  expect(seam.sample).toHaveBeenCalledOnce()
  expect(seam.finish).toHaveBeenCalledOnce()
})

it('does not guess recording content from arbitrary outputs and rejects duplicate declaration identities', () => {
  expect(
    startManagedProjectRecording(
      input([{ filename: 'result.json', path: 'result.json' }]),
      () => {}
    )
  ).toBeUndefined()
  expect(seam.start).not.toHaveBeenCalled()
  expect(() =>
    startManagedProjectRecording(
      input([
        { filename: 'project-recording-data.json', path: 'a.json' },
        { filename: 'project-recording-data.json', path: 'b.json' }
      ]),
      () => {}
    )
  ).toThrow('Ambiguous')
})

it('retains partial recording diagnostics as separate from the experiment outcome', async () => {
  seam.finish.mockResolvedValue({ status: 'unavailable', warnings: ['publication-failed'] })
  const handle = startManagedProjectRecording(
    input([{ filename: 'frame.png', path: 'frame.png' }]),
    () => {}
  )!
  expect(await handle.close()).toEqual({ status: 'unavailable', warnings: ['publication-failed'] })
})
