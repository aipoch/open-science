import { describe, expect, it, vi } from 'vitest'
import { createCallerContext } from '../caller-context'
import { browserRecordedFixture } from '../run-observation/browser-recorded.test-support'
import { createBrowserRecordingExternalPort } from './external-port'

const viewerId = '12345678-1234-4234-8234-123456789012'
const setup = (): {
  port: ReturnType<typeof createBrowserRecordingExternalPort>
  dependencies: Parameters<typeof createBrowserRecordingExternalPort>[0]
  caller: ReturnType<typeof createCallerContext>
  revoke(): void
} => {
  let current = true
  const fixture = browserRecordedFixture()
  const status = {
    state: 'recording' as const,
    recordingId: 'recording-a',
    elapsedMs: 100,
    bytes: 0,
    segments: 0,
    droppedFrames: 0
  }
  const caller = createCallerContext({
    clientId: 'c',
    lifecycleClientId: 'c',
    leaseId: 'l',
    surface: 'task',
    location: 'local',
    principalKind: 'automation',
    actionOrigin: 'automation',
    isAuthorizationCurrent: () => current
  })
  const dependencies: Parameters<typeof createBrowserRecordingExternalPort>[0] = {
    assertOpen: vi.fn(),
    host: {
      browserRecording: vi.fn(async (method) =>
        method === 'inspect' ? { supported: true } : status
      ),
      openRecorded: vi.fn(async (target) => ({
        mode: 'recorded' as const,
        format: 'web-recording' as const,
        viewerId,
        target,
        expiresAt: 1000,
        url: 'http://viewer.localhost:12345/'
      })),
      closeViewer: vi.fn()
    },
    viewers: {
      selectBrowserMoment: vi.fn(async () => fixture.moment),
      browserMomentSelection: vi.fn(async () => fixture.moment),
      revoke: vi.fn(async () => undefined)
    },
    reader: { readBrowser: vi.fn(async () => fixture.payload) }
  }
  return {
    port: createBrowserRecordingExternalPort(dependencies),
    dependencies,
    caller,
    revoke: () => {
      current = false
    }
  }
}

describe('browser recording external port', () => {
  it('routes bounded commands and receiver-side evidence through separate main-owned capabilities', async () => {
    const h = setup()
    const fixture = browserRecordedFixture()
    await expect(h.port.call('inspect', { viewerId }, h.caller)).resolves.toEqual({
      supported: true
    })
    await h.port.call('start', { viewerId, request: { requestId: 'record-1' } }, h.caller)
    expect(h.dependencies.host.browserRecording).toHaveBeenLastCalledWith(
      'start',
      viewerId,
      { requestId: 'record-1' },
      h.caller
    )
    await h.port.call(
      'pause',
      { viewerId, request: { requestId: 'pause-1', recordingId: 'recording-a' } },
      h.caller
    )
    await expect(
      h.port.call('read', { target: fixture.payload.receiving }, h.caller)
    ).resolves.toEqual(fixture.payload)
    const opened = await h.port.call(
      'openRecorded',
      { target: fixture.payload.receiving },
      h.caller
    )
    expect(opened).toMatchObject({ mode: 'recorded', format: 'web-recording' })
    expect(h.dependencies.host.openRecorded).toHaveBeenCalledWith(
      fixture.payload.receiving,
      h.caller,
      { format: 'web-recording' }
    )
    await expect(
      h.port.call('selectMoment', { viewerId, offsetMs: 1500 }, h.caller)
    ).resolves.toEqual(fixture.moment)
    await expect(h.port.call('selection', { viewerId }, h.caller)).resolves.toEqual(fixture.moment)
    expect(h.dependencies.viewers.selectBrowserMoment).toHaveBeenCalledWith(viewerId, 1500, {
      caller: h.caller
    })
  })
  it('rejects remote/revoked callers and forged targets before any capability is invoked', async () => {
    const h = setup()
    await expect(h.port.call('status', { viewerId })).rejects.toMatchObject({
      code: 'unauthorized'
    })
    await expect(
      h.port.call('status', { viewerId }, { ...h.caller, location: 'remote' })
    ).rejects.toMatchObject({ code: 'unsupported_location' })
    for (const [method, payload] of [
      ['start', { viewerId, request: { requestId: 'request', url: 'http://evil' } }],
      ['pause', { viewerId, request: { requestId: 'request' } }],
      ['status', { viewerId, target: browserRecordedFixture().payload.receiving }],
      ['read', { target: { ...browserRecordedFixture().payload.receiving, path: '/private' } }],
      ['selectMoment', { viewerId, offsetMs: -1 }]
    ] as const)
      await expect(h.port.call(method, payload, h.caller)).rejects.toMatchObject({
        code: 'invalid_request'
      })
    h.revoke()
    await expect(h.port.call('status', { viewerId }, h.caller)).rejects.toMatchObject({
      code: 'unauthorized'
    })
    expect(h.dependencies.host.browserRecording).not.toHaveBeenCalled()
    expect(h.dependencies.reader.readBrowser).not.toHaveBeenCalled()
  })
  it('rechecks a caller after read and closes a newly opened viewer if authority was revoked while awaiting', async () => {
    const h = setup()
    const fixture = browserRecordedFixture()
    vi.mocked(h.dependencies.reader.readBrowser).mockImplementation(async () => {
      h.revoke()
      return fixture.payload
    })
    await expect(
      h.port.call('read', { target: fixture.payload.receiving }, h.caller)
    ).rejects.toMatchObject({ code: 'unauthorized' })
    const opened = setup()
    vi.mocked(opened.dependencies.host.openRecorded).mockImplementation(async (target) => {
      opened.revoke()
      return {
        mode: 'recorded',
        format: 'web-recording',
        viewerId,
        target,
        expiresAt: 1000,
        url: 'http://viewer.localhost:123/'
      }
    })
    await expect(
      opened.port.call('openRecorded', { target: fixture.payload.receiving }, opened.caller)
    ).rejects.toMatchObject({ code: 'unauthorized' })
    expect(opened.dependencies.host.closeViewer).toHaveBeenCalledWith(viewerId)
    expect(opened.dependencies.viewers.revoke).toHaveBeenCalledWith(viewerId, {
      caller: opened.caller
    })
  })
})
