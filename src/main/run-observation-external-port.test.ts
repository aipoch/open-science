import { describe, expect, it, vi } from 'vitest'
import { createTaskCallerContext } from './caller-context'
import { createRunObservationExternalPort } from './run-observation-external-port'
import type { ObservationViewers } from './run-observation/viewers'
import type {
  ObservationCaptureContent,
  ObservationViewerCapture
} from '../shared/run-observation-capture'
import { recordedFixture } from './run-observation/recorded-viewer.test-support'
import { recordedFileSelectionForPayload } from '../shared/run-observation-recorded'

const viewerId = '9df13077-848f-412b-a2bc-e77ea2d07f48'
const target = { projectId: 'project', sessionId: 'session', runId: 'run' }
const frame: ObservationViewerCapture = {
  captureId: 'capture-1',
  recordingId: 'recording-1',
  stepKey: 'observation-7',
  artifactId: 'artifact-1',
  versionId: 'version-1',
  checksum: 'a'.repeat(64),
  sizeBytes: 6,
  mimeType: 'image/png',
  publication: 'awaiting-publication',
  capture: {
    source: 'project-export',
    association: 'current-observation',
    startedAt: 100,
    finishedAt: 110,
    observedAt: 80,
    width: 2,
    height: 1
  },
  viewerEvidence: { cursor: { epoch: 'viewer-1', sequence: 2 }, observedAt: 90, stepId: 'run:run' }
}
const chunk: ObservationCaptureContent = {
  captureId: frame.captureId,
  mimeType: 'image/png',
  checksum: frame.checksum,
  sizeBytes: 6,
  offset: 0,
  dataBase64: 'YWJj',
  nextOffset: 3
}
// Preserve the fixture's inferred mock signatures for dependency replacement tests.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const harness = () => {
  const viewers = {
    snapshot: vi.fn().mockResolvedValue({ phase: 'running' }),
    history: vi.fn(),
    changes: vi.fn(),
    select: vi.fn(),
    selection: vi.fn(),
    revoke: vi.fn(),
    recording: vi.fn(),
    selectRecording: vi.fn(),
    recordingSelection: vi.fn()
  }
  const openViewer = vi.fn().mockResolvedValue({ viewerId, target, url: 'local-viewer' })
  const openRecordedViewer = vi.fn().mockResolvedValue({ viewerId, mode: 'recorded' })
  const recordingStatus = vi.fn().mockResolvedValue({ target, state: 'recording' })
  const capture = vi.fn().mockResolvedValue(frame)
  const captures = vi.fn().mockResolvedValue([frame])
  const captureContent = vi.fn().mockResolvedValue(chunk)
  return {
    capture,
    captures,
    captureContent,
    recordingStatus,
    openRecordedViewer,
    viewers,
    openViewer,
    port: createRunObservationExternalPort({
      viewers: viewers as unknown as ObservationViewers,
      openViewer,
      openRecordedViewer,
      recordingStatus,
      capture,
      captures,
      captureContent,
      assertOpen: vi.fn()
    })
  }
}
describe('local observation public adapter', () => {
  it('loads immutable recorded content and selects exact files without opening any live viewer', async () => {
    const { payload } = recordedFixture()
    const selection = recordedFileSelectionForPayload(payload, 'export-a')
    const readRecorded = vi.fn(async () => payload)
    const selectRecordedFile = vi.fn(async () => selection)
    const openViewer = vi.fn(),
      openRecordedViewer = vi.fn()
    const port = createRunObservationExternalPort({
      viewers: {} as ObservationViewers,
      assertOpen: vi.fn(),
      openViewer,
      openRecordedViewer,
      readRecorded,
      selectRecordedFile
    })
    const caller = createTaskCallerContext()
    expect(await port.call('readRecorded', { target: payload.receiving }, caller)).toEqual(payload)
    expect(
      await port.call(
        'selectRecordedFile',
        { target: payload.receiving, mediaKey: 'export-a' },
        caller
      )
    ).toEqual(selection)
    expect(selectRecordedFile).toHaveBeenCalledExactlyOnceWith(
      { target: payload.receiving, mediaKey: 'export-a', format: 'run-observation' },
      caller
    )
    expect(openViewer).not.toHaveBeenCalled()
    expect(openRecordedViewer).not.toHaveBeenCalled()
    for (const additional of [
      { path: '/private/file' },
      { command: 'run' },
      { stepId: 'invented' },
      { versionId: 'replacement' }
    ])
      await expect(
        port.call(
          'selectRecordedFile',
          { target: payload.receiving, mediaKey: 'export-a', ...additional },
          caller
        )
      ).rejects.toMatchObject({ code: 'invalid_request' })
    expect(selectRecordedFile).toHaveBeenCalledTimes(1)
    selectRecordedFile.mockResolvedValueOnce({ ...selection, mediaKey: 'replacement' })
    await expect(
      port.call('selectRecordedFile', { target: payload.receiving, mediaKey: 'export-a' }, caller)
    ).rejects.toMatchObject({ code: 'unavailable' })
  })
  it('discards a recorded-file read if the caller lease expires during authorization', async () => {
    const { payload } = recordedFixture()
    let current = true
    const caller = createTaskCallerContext({ isAuthorizationCurrent: () => current })
    const readRecorded = vi.fn(async () => {
      current = false
      return payload
    })
    const port = createRunObservationExternalPort({
      viewers: {} as ObservationViewers,
      assertOpen: vi.fn(),
      openViewer: vi.fn(),
      readRecorded
    })
    await expect(
      port.call('readRecorded', { target: payload.receiving }, caller)
    ).rejects.toMatchObject({ code: 'unauthorized' })
  })
  it('reads current capture metadata and exact bounded chunks through the caller-owned viewer', async () => {
    const h = harness(),
      caller = createTaskCallerContext()
    await expect(h.port.call('captures', { viewerId }, caller)).resolves.toEqual([frame])
    expect(h.captures).toHaveBeenCalledExactlyOnceWith(viewerId, caller)
    const input = { viewerId, captureId: frame.captureId, offset: 0, length: 3 }
    await expect(h.port.call('captureContent', input, caller)).resolves.toEqual(chunk)
    expect(h.captureContent).toHaveBeenCalledExactlyOnceWith(
      viewerId,
      { captureId: frame.captureId, offset: 0, length: 3 },
      caller
    )
    await expect(
      h.port.call('captureContent', { viewerId, captureId: frame.captureId }, caller)
    ).resolves.toEqual(chunk)
    expect(h.captureContent).toHaveBeenLastCalledWith(
      viewerId,
      { captureId: frame.captureId },
      caller
    )
    expect(h.capture).not.toHaveBeenCalled()
    expect(h.openViewer).not.toHaveBeenCalled()
  })

  it('preserves explicit viewer evidence on capture results without accepting a caller-provided association', async () => {
    const h = harness(),
      caller = createTaskCallerContext()
    const request = {
      source: 'project-export',
      exportKey: 'frame.png',
      idempotencyKey: 'request-1'
    }
    await expect(h.port.call('capture', { viewerId, request }, caller)).resolves.toEqual(frame)
    await expect(
      h.port.call(
        'capture',
        { viewerId, request: { ...request, viewerEvidence: frame.viewerEvidence } },
        caller
      )
    ).rejects.toMatchObject({ code: 'invalid_request' })
    expect(h.capture).toHaveBeenCalledExactlyOnceWith(viewerId, request, caller)
  })

  it('refuses arbitrary paths, replacement scope and malformed capture chunk ranges before dispatch', async () => {
    const h = harness(),
      caller = createTaskCallerContext()
    for (const extra of [
      { path: '/private/frame.png' },
      { url: 'http://localhost' },
      { target },
      { captureId: '../image' },
      { offset: -1 },
      { offset: 0.25 },
      { offset: Number.MAX_SAFE_INTEGER + 1 },
      { length: 0 },
      { length: 1048577 },
      { length: '3' },
      { length: 1.5 }
    ])
      await expect(
        h.port.call('captureContent', { viewerId, captureId: frame.captureId, ...extra }, caller)
      ).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(h.port.call('captures', { viewerId, target }, caller)).rejects.toMatchObject({
      code: 'invalid_request'
    })
    expect(h.captures).not.toHaveBeenCalled()
    expect(h.captureContent).not.toHaveBeenCalled()
  })

  it.each(['captures', 'captureContent'] as const)(
    'checks %s authorization before and after content reads',
    async (method) => {
      const h = harness()
      const request =
        method === 'captures' ? { viewerId } : { viewerId, captureId: frame.captureId }
      await expect(h.port.call(method, request)).rejects.toMatchObject({ code: 'unauthorized' })
      await expect(
        h.port.call(method, request, createTaskCallerContext({ location: 'remote' }))
      ).rejects.toMatchObject({ code: 'unsupported_location' })
      expect(h[method]).not.toHaveBeenCalled()
      let current = true
      h[method].mockImplementationOnce(async () => {
        current = false
        return method === 'captures' ? [frame] : chunk
      })
      await expect(
        h.port.call(
          method,
          request,
          createTaskCallerContext({ isAuthorizationCurrent: () => current })
        )
      ).rejects.toMatchObject({ code: 'unauthorized' })
    }
  )

  it('rejects inconsistent byte receipts and private response fields instead of leaking them', async () => {
    const h = harness(),
      caller = createTaskCallerContext()
    for (const extra of [
      { captureId: 'other' },
      { offset: 1 },
      { dataBase64: 'YWJjZA==', nextOffset: 4 },
      { nextOffset: 5 },
      { dataBase64: 'not/base64!' },
      { path: '/private/secret' }
    ]) {
      h.captureContent.mockResolvedValueOnce({ ...chunk, ...extra })
      await expect(
        h.port.call('captureContent', { viewerId, captureId: frame.captureId, length: 3 }, caller)
      ).rejects.toMatchObject({
        code: 'unavailable',
        message: 'The requested observation is unavailable. Reopen its viewer.'
      })
    }
    h.captures.mockResolvedValueOnce([{ ...frame, secret: 'private' }])
    await expect(h.port.call('captures', { viewerId }, caller)).rejects.toMatchObject({
      code: 'unavailable'
    })
  })

  it('reads exact recording status without issuing a viewer or execution and rechecks its caller', async () => {
    const h = harness()
    const caller = createTaskCallerContext()
    await expect(h.port.call('recordingStatus', { target }, caller)).resolves.toEqual({
      target,
      state: 'recording'
    })
    expect(h.recordingStatus).toHaveBeenCalledWith(target, caller)
    expect(h.openViewer).not.toHaveBeenCalled()
    await expect(
      h.port.call('recordingStatus', { target, latest: true }, caller)
    ).rejects.toMatchObject({ code: 'invalid_request' })
    let authorized = true
    h.recordingStatus.mockImplementationOnce(async () => {
      authorized = false
      return { target, state: 'recording' }
    })
    await expect(
      h.port.call(
        'recordingStatus',
        { target },
        createTaskCallerContext({ isAuthorizationCurrent: () => authorized })
      )
    ).rejects.toMatchObject({ code: 'unauthorized' })
  })
  it('defaults to reading permission and never broadens the exact target', async () => {
    const h = harness(),
      caller = createTaskCallerContext()
    await expect(h.port.call('open', { target }, caller)).resolves.toMatchObject({ viewerId })
    expect(h.openViewer).toHaveBeenCalledWith(target, caller, {
      target,
      allowInteraction: false,
      allowRecording: false,
      allowCancel: false,
      allowCapture: false
    })
    for (const input of [
      { target: { projectId: 'project', sessionId: 'session' } },
      { target, destination: 'http://localhost:1' },
      { target, allowInteraction: 'true' }
    ])
      await expect(h.port.call('open', input, caller)).rejects.toMatchObject({
        code: 'invalid_request'
      })
    expect(h.openViewer).toHaveBeenCalledOnce()
  })
  it('rejects remote, absent and revoked callers before querying evidence', async () => {
    const h = harness()
    await expect(h.port.call('snapshot', { viewerId })).rejects.toMatchObject({
      code: 'unauthorized'
    })
    await expect(
      h.port.call('snapshot', { viewerId }, createTaskCallerContext({ location: 'remote' }))
    ).rejects.toMatchObject({ code: 'unsupported_location' })
    await expect(
      h.port.call(
        'snapshot',
        { viewerId },
        createTaskCallerContext({ isAuthorizationCurrent: () => false })
      )
    ).rejects.toMatchObject({ code: 'unauthorized' })
    expect(h.viewers.snapshot).not.toHaveBeenCalled()
  })
  it('rechecks current authorization after a delayed observation and filters internal errors', async () => {
    const h = harness()
    let current = true
    h.viewers.snapshot.mockImplementationOnce(async () => {
      current = false
      return { phase: 'running' }
    })
    await expect(
      h.port.call(
        'snapshot',
        { viewerId },
        createTaskCallerContext({ isAuthorizationCurrent: () => current })
      )
    ).rejects.toMatchObject({ code: 'unauthorized' })
    h.viewers.snapshot.mockRejectedValueOnce(new Error('/private/secret?grant=raw'))
    await expect(
      h.port.call('snapshot', { viewerId }, createTaskCallerContext())
    ).rejects.toMatchObject({
      code: 'unavailable',
      message: 'The requested observation is unavailable. Reopen its viewer.'
    })
  })
  it('validates viewer-bound cursor/step requests and cannot accept a replacement scope', async () => {
    const h = harness(),
      caller = createTaskCallerContext()
    const cursor = { epoch: 'epoch', sequence: 2 }
    await h.port.call('select', { viewerId, cursor, stepId: 'step' }, caller)
    expect(h.viewers.select).toHaveBeenCalledWith(
      viewerId,
      { viewerId, cursor, stepId: 'step' },
      { caller }
    )
    await expect(
      h.port.call('select', { viewerId, cursor, stepId: 'step', target }, caller)
    ).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(
      h.port.call('changes', { viewerId, cursor: { epoch: 'epoch', sequence: -1 } }, caller)
    ).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(h.port.call('selection', { viewerId }, caller)).resolves.toBeNull()
    await h.port.call('revoke', { viewerId }, caller)
    expect(h.viewers.revoke).toHaveBeenCalledWith(viewerId, { caller })
  })
})

it('opens exact receiving recordings without live authority and returns server-held selection', async () => {
  const h = harness(),
    caller = createTaskCallerContext()
  const target = { projectId: 'p', sessionId: 's', artifactId: 'a', versionId: 'v' }
  await expect(h.port.call('openRecorded', { target }, caller)).resolves.toMatchObject({
    mode: 'recorded'
  })
  expect(h.openRecordedViewer).toHaveBeenCalledExactlyOnceWith(target, caller)
  await expect(
    h.port.call('openRecorded', { target, allowInteraction: true }, caller)
  ).rejects.toMatchObject({ code: 'invalid_request' })
  await expect(
    h.port.call('openRecorded', { target: { ...target, runId: 'author-run' } }, caller)
  ).rejects.toMatchObject({ code: 'invalid_request' })
  await h.port.call('recording', { viewerId }, caller)
  await h.port.call('selectRecording', { viewerId, stepKey: 'observation-0' }, caller)
  await h.port.call('recordingSelection', { viewerId }, caller)
  expect(h.viewers.selectRecording).toHaveBeenCalledWith(viewerId, 'observation-0', { caller })
  expect(h.viewers.recordingSelection).toHaveBeenCalledWith(viewerId, { caller })
  expect(h.openViewer).not.toHaveBeenCalled()
  expect(h.viewers.snapshot).not.toHaveBeenCalled()
})

it('pins the optional project-recording format without granting live authority', async () => {
  const h = harness(),
    caller = createTaskCallerContext()
  const target = { projectId: 'p', sessionId: 's', artifactId: 'a', versionId: 'v' }
  await h.port.call('openRecorded', { target, format: 'project-recording' }, caller)
  expect(h.openRecordedViewer).toHaveBeenCalledExactlyOnceWith(target, caller, 'project-recording')
  await expect(
    h.port.call('openRecorded', { target, format: 'live' }, caller)
  ).rejects.toMatchObject({ code: 'invalid_request' })
  expect(h.openRecordedViewer).toHaveBeenCalledOnce()
  expect(h.openViewer).not.toHaveBeenCalled()
})
