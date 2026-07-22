import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  OFFICE_PREVIEW_MAX_FILE_BYTES,
  OFFICE_PREVIEW_PROCESS_MEMORY_LIMIT_BYTES
} from '../../shared/office-preview'
import { OfficePreviewSupervisor } from './office-preview-supervisor'

const request = {
  requestId: 'request-1',
  source: 'artifact' as const,
  path: 'project/session/report.xlsx',
  name: 'report.xlsx',
  extension: 'xlsx' as const,
  attempt: 0
}

describe('OfficePreviewSupervisor', () => {
  afterEach(() => vi.useRealTimers())

  it('rejects a file above 40 MiB before creating a view or capability', async () => {
    const createView = vi.fn()
    const acquireResource = vi.fn()
    const supervisor = new OfficePreviewSupervisor({
      inspectResource: vi.fn().mockResolvedValue({
        size: OFFICE_PREVIEW_MAX_FILE_BYTES + 1,
        version: 1
      }),
      acquireResource,
      releaseResource: vi.fn(),
      createView,
      createSessionId: () => 'session-1'
    })

    await expect(supervisor.open(7, request)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'FILE_TOO_LARGE',
      size: OFFICE_PREVIEW_MAX_FILE_BYTES + 1,
      limit: OFFICE_PREVIEW_MAX_FILE_BYTES
    })
    expect(createView).not.toHaveBeenCalled()
    expect(acquireResource).not.toHaveBeenCalled()
  })

  it('returns a download-only result when the file grows above 40 MiB during admission', async () => {
    const view = {
      ownerId: 91,
      start: vi.fn(),
      setBounds: vi.fn(),
      setVisible: vi.fn(),
      close: vi.fn()
    }
    const supervisor = new OfficePreviewSupervisor({
      inspectResource: vi.fn().mockResolvedValue({ size: 1024, version: 1 }),
      acquireResource: vi.fn().mockRejectedValue(
        Object.assign(new Error('Managed preview file is too large.'), {
          code: 'FILE_TOO_LARGE',
          size: OFFICE_PREVIEW_MAX_FILE_BYTES + 1,
          limit: OFFICE_PREVIEW_MAX_FILE_BYTES
        })
      ),
      releaseResource: vi.fn(),
      createView: vi.fn().mockReturnValue(view),
      createSessionId: () => 'session-1'
    })

    await expect(supervisor.open(7, request)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'FILE_TOO_LARGE',
      size: OFFICE_PREVIEW_MAX_FILE_BYTES + 1,
      limit: OFFICE_PREVIEW_MAX_FILE_BYTES
    })
    expect(view.close).toHaveBeenCalledOnce()
    expect(view.start).not.toHaveBeenCalled()
  })

  it('starts an isolated view for a file exactly at the 40 MiB limit', async () => {
    const snapshot = { size: OFFICE_PREVIEW_MAX_FILE_BYTES, version: 12 }
    const resource = {
      id: 'resource-1',
      url: 'open-science-preview://resource-1/report.xlsx',
      size: snapshot.size,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      version: snapshot.version
    }
    const view = {
      ownerId: 91,
      start: vi.fn().mockResolvedValue(undefined),
      setBounds: vi.fn(),
      setVisible: vi.fn(),
      close: vi.fn()
    }
    const acquireResource = vi.fn().mockResolvedValue(resource)
    const createView = vi.fn().mockReturnValue(view)
    const publishState = vi.fn()
    const supervisor = new OfficePreviewSupervisor({
      inspectResource: vi.fn().mockResolvedValue(snapshot),
      acquireResource,
      releaseResource: vi.fn(),
      createView,
      createSessionId: () => 'session-1',
      publishState
    })

    await expect(supervisor.open(7, request)).resolves.toEqual({
      kind: 'started',
      sessionId: 'session-1',
      size: OFFICE_PREVIEW_MAX_FILE_BYTES,
      limit: OFFICE_PREVIEW_MAX_FILE_BYTES
    })
    expect(createView).toHaveBeenCalledWith(
      expect.objectContaining({ parentOwnerId: 7, sessionId: 'session-1' })
    )
    expect(view.setVisible).toHaveBeenCalledWith(false)
    expect(publishState).toHaveBeenCalledWith(7, {
      sessionId: 'session-1',
      requestId: 'request-1',
      phase: 'starting',
      title: 'Starting Office preview'
    })
    expect(acquireResource).toHaveBeenCalledWith(
      91,
      request,
      snapshot,
      OFFICE_PREVIEW_MAX_FILE_BYTES
    )
    expect(view.start).toHaveBeenCalledWith({
      sessionId: 'session-1',
      resource,
      extension: 'xlsx',
      name: 'report.xlsx',
      attempt: 0
    })
  })

  it('closes a session idempotently and releases its child-owned capability', async () => {
    const resource = {
      id: 'resource-1',
      url: 'open-science-preview://resource-1/report.xlsx',
      size: 1024,
      mimeType: 'application/octet-stream',
      version: 2
    }
    const view = {
      ownerId: 91,
      start: vi.fn().mockResolvedValue(undefined),
      setBounds: vi.fn(),
      setVisible: vi.fn(),
      close: vi.fn()
    }
    const releaseResource = vi.fn()
    const supervisor = new OfficePreviewSupervisor({
      inspectResource: vi
        .fn()
        .mockResolvedValue({ size: resource.size, version: resource.version }),
      acquireResource: vi.fn().mockResolvedValue(resource),
      releaseResource,
      createView: vi.fn().mockReturnValue(view),
      createSessionId: () => 'session-1'
    })

    await supervisor.open(7, request)
    await supervisor.close(7, 'session-1')
    await supervisor.close(7, 'session-1')

    expect(view.setVisible).toHaveBeenLastCalledWith(false)
    expect(view.close).toHaveBeenCalledTimes(1)
    expect(releaseResource).toHaveBeenCalledTimes(1)
    expect(releaseResource).toHaveBeenCalledWith(91, 'resource-1')
  })

  it('publishes child runtime state and reveals the view only when content is ready', async () => {
    const resource = {
      id: 'resource-1',
      url: 'open-science-preview://resource-1/report.xlsx',
      size: 1024,
      mimeType: 'application/octet-stream',
      version: 2
    }
    const view = {
      ownerId: 91,
      start: vi.fn().mockResolvedValue(undefined),
      setBounds: vi.fn(),
      setVisible: vi.fn(),
      close: vi.fn()
    }
    let viewOptions: Record<string, unknown> | undefined
    const publishState = vi.fn()
    const supervisor = new OfficePreviewSupervisor({
      inspectResource: vi
        .fn()
        .mockResolvedValue({ size: resource.size, version: resource.version }),
      acquireResource: vi.fn().mockResolvedValue(resource),
      releaseResource: vi.fn(),
      createView: vi.fn((options) => {
        viewOptions = options as unknown as Record<string, unknown>
        return view
      }),
      createSessionId: () => 'session-1',
      publishState
    })

    await supervisor.open(7, request)
    const ready = { sessionId: 'session-1', phase: 'ready' as const }
    ;(viewOptions?.onState as ((state: typeof ready) => void) | undefined)?.(ready)

    expect(publishState).toHaveBeenCalledWith(7, { ...ready, requestId: 'request-1' })
    expect(view.setVisible).toHaveBeenLastCalledWith(true)
  })

  it('turns a child process exit into a recoverable error and releases the session', async () => {
    const resource = {
      id: 'resource-1',
      url: 'open-science-preview://resource-1/report.xlsx',
      size: 1024,
      mimeType: 'application/octet-stream',
      version: 2
    }
    const view = {
      ownerId: 91,
      start: vi.fn().mockResolvedValue(undefined),
      setBounds: vi.fn(),
      setVisible: vi.fn(),
      close: vi.fn()
    }
    let viewOptions: Record<string, unknown> | undefined
    const publishState = vi.fn()
    const releaseResource = vi.fn()
    const supervisor = new OfficePreviewSupervisor({
      inspectResource: vi
        .fn()
        .mockResolvedValue({ size: resource.size, version: resource.version }),
      acquireResource: vi.fn().mockResolvedValue(resource),
      releaseResource,
      createView: vi.fn((options) => {
        viewOptions = options as unknown as Record<string, unknown>
        return view
      }),
      createSessionId: () => 'session-1',
      publishState
    })

    await supervisor.open(7, request)
    await (viewOptions?.onGone as (() => Promise<void>) | undefined)?.()

    expect(publishState).toHaveBeenCalledWith(7, {
      sessionId: 'session-1',
      requestId: 'request-1',
      phase: 'error',
      error: 'PREVIEW_PROCESS_CRASHED'
    })
    expect(releaseResource).toHaveBeenCalledWith(91, 'resource-1')
  })

  it('normalizes child view bounds and rejects updates from another owner', async () => {
    const resource = {
      id: 'resource-1',
      url: 'open-science-preview://resource-1/report.xlsx',
      size: 1024,
      mimeType: 'application/octet-stream',
      version: 2
    }
    const view = {
      ownerId: 91,
      start: vi.fn().mockResolvedValue(undefined),
      setBounds: vi.fn(),
      setVisible: vi.fn(),
      close: vi.fn()
    }
    const supervisor = new OfficePreviewSupervisor({
      inspectResource: vi
        .fn()
        .mockResolvedValue({ size: resource.size, version: resource.version }),
      acquireResource: vi.fn().mockResolvedValue(resource),
      releaseResource: vi.fn(),
      createView: vi.fn().mockReturnValue(view),
      createSessionId: () => 'session-1'
    })

    await supervisor.open(7, request)
    supervisor.setBounds(7, 'session-1', {
      x: 10.4,
      y: 20.6,
      width: 500.2,
      height: 300.7,
      visible: true
    })
    supervisor.setBounds(8, 'session-1', {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      visible: true
    })

    expect(view.setBounds).toHaveBeenCalledTimes(1)
    expect(view.setBounds).toHaveBeenCalledWith({ x: 10, y: 21, width: 500, height: 301 })
    expect(view.setVisible).toHaveBeenLastCalledWith(false)
  })

  it('destroys an unfinished child when its size-based deadline expires', async () => {
    vi.useFakeTimers()
    const resource = {
      id: 'resource-1',
      url: 'open-science-preview://resource-1/report.docx',
      size: 1024,
      mimeType: 'application/octet-stream',
      version: 2
    }
    const view = {
      ownerId: 91,
      start: vi.fn().mockResolvedValue(undefined),
      setBounds: vi.fn(),
      setVisible: vi.fn(),
      close: vi.fn()
    }
    const publishState = vi.fn()
    const releaseResource = vi.fn()
    const supervisor = new OfficePreviewSupervisor({
      inspectResource: vi
        .fn()
        .mockResolvedValue({ size: resource.size, version: resource.version }),
      acquireResource: vi.fn().mockResolvedValue(resource),
      releaseResource,
      createView: vi.fn().mockReturnValue(view),
      createSessionId: () => 'session-1',
      publishState
    })

    await supervisor.open(7, request)
    await vi.advanceTimersByTimeAsync(30_000)

    expect(publishState).toHaveBeenCalledWith(7, {
      sessionId: 'session-1',
      requestId: 'request-1',
      phase: 'error',
      error: 'PREVIEW_TIMEOUT'
    })
    expect(view.close).toHaveBeenCalledOnce()
    expect(releaseResource).toHaveBeenCalledWith(91, 'resource-1')
  })

  it('closes the child after publishing a runtime render error', async () => {
    const resource = {
      id: 'resource-1',
      url: 'open-science-preview://resource-1/report.docx',
      size: 1024,
      mimeType: 'application/octet-stream',
      version: 2
    }
    const view = {
      ownerId: 91,
      start: vi.fn().mockResolvedValue(undefined),
      setBounds: vi.fn(),
      setVisible: vi.fn(),
      close: vi.fn()
    }
    let viewOptions: Record<string, unknown> | undefined
    const publishState = vi.fn()
    const releaseResource = vi.fn()
    const supervisor = new OfficePreviewSupervisor({
      inspectResource: vi
        .fn()
        .mockResolvedValue({ size: resource.size, version: resource.version }),
      acquireResource: vi.fn().mockResolvedValue(resource),
      releaseResource,
      createView: vi.fn((options) => {
        viewOptions = options as unknown as Record<string, unknown>
        return view
      }),
      createSessionId: () => 'session-1',
      publishState
    })

    await supervisor.open(7, request)
    const error = {
      sessionId: 'session-1',
      phase: 'error' as const,
      error: 'RENDER_FAILED' as const
    }
    ;(viewOptions?.onState as ((state: typeof error) => void) | undefined)?.(error)
    await Promise.resolve()

    expect(publishState).toHaveBeenCalledWith(7, { ...error, requestId: 'request-1' })
    expect(view.close).toHaveBeenCalledOnce()
    expect(releaseResource).toHaveBeenCalledWith(91, 'resource-1')
  })

  it('replaces the existing Office preview owned by the same host request', async () => {
    const releaseResource = vi.fn()
    const views = [91, 92].map((ownerId) => ({
      ownerId,
      start: vi.fn().mockResolvedValue(undefined),
      setBounds: vi.fn(),
      setVisible: vi.fn(),
      close: vi.fn()
    }))
    const pendingViews = [...views]
    let nextSession = 0
    const supervisor = new OfficePreviewSupervisor({
      inspectResource: vi.fn().mockResolvedValue({ size: 1024, version: 1 }),
      acquireResource: vi.fn((ownerId) =>
        Promise.resolve({
          id: `resource-${ownerId}`,
          url: `open-science-preview://resource-${ownerId}/report.xlsx`,
          size: 1024,
          mimeType: 'application/octet-stream',
          version: 1
        })
      ),
      releaseResource,
      createView: vi.fn(() => pendingViews.shift()!),
      createSessionId: () => `session-${++nextSession}`
    })

    await supervisor.open(7, request)
    await supervisor.open(7, request)

    expect(views[0].close).toHaveBeenCalledOnce()
    expect(releaseResource).toHaveBeenCalledWith(91, 'resource-91')
    expect(views[1].close).not.toHaveBeenCalled()
  })

  it('keeps one isolated runtime lease per parent window across distinct hosts', async () => {
    const releaseResource = vi.fn()
    const views = [91, 92].map((ownerId) => ({
      ownerId,
      start: vi.fn().mockResolvedValue(undefined),
      setBounds: vi.fn(),
      setVisible: vi.fn(),
      close: vi.fn()
    }))
    const pendingViews = [...views]
    let nextSession = 0
    const supervisor = new OfficePreviewSupervisor({
      inspectResource: vi.fn().mockResolvedValue({ size: 1024, version: 1 }),
      acquireResource: vi.fn((ownerId) =>
        Promise.resolve({
          id: `resource-${ownerId}`,
          url: `open-science-preview://resource-${ownerId}/report.xlsx`,
          size: 1024,
          mimeType: 'application/octet-stream',
          version: 1
        })
      ),
      releaseResource,
      createView: vi.fn(() => pendingViews.shift()!),
      createSessionId: () => `session-${++nextSession}`
    })

    await supervisor.open(7, request)
    await supervisor.open(7, { ...request, requestId: 'request-2' })

    expect(views[0].close).toHaveBeenCalledOnce()
    expect(releaseResource).toHaveBeenCalledWith(91, 'resource-91')
    expect(views[1].close).not.toHaveBeenCalled()
  })

  it('does not reuse an open generation after owner teardown', async () => {
    let resolveFirstInspection: ((value: { size: number; version: number }) => void) | undefined
    const firstInspection = new Promise<{ size: number; version: number }>((resolve) => {
      resolveFirstInspection = resolve
    })
    let inspectionCount = 0
    const supervisor = new OfficePreviewSupervisor({
      inspectResource: vi.fn(() => {
        inspectionCount += 1
        return inspectionCount === 1 ? firstInspection : Promise.resolve({ size: 1024, version: 2 })
      }),
      acquireResource: vi.fn().mockResolvedValue({
        id: 'resource-2',
        url: 'open-science-preview://resource-2/report.xlsx',
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 2
      }),
      releaseResource: vi.fn(),
      createView: vi.fn().mockReturnValue({
        ownerId: 92,
        start: vi.fn().mockResolvedValue(undefined),
        setBounds: vi.fn(),
        setVisible: vi.fn(),
        close: vi.fn()
      }),
      createSessionId: () => 'session-2'
    })

    const staleOpen = supervisor.open(7, request)
    await supervisor.closeOwner(7)
    await expect(supervisor.open(7, request)).resolves.toMatchObject({ kind: 'started' })
    resolveFirstInspection?.({ size: 1024, version: 1 })

    await expect(staleOpen).rejects.toThrow(/superseded/i)
  })

  it('closes every session when its parent renderer is destroyed', async () => {
    const releaseResource = vi.fn()
    const view = {
      ownerId: 91,
      start: vi.fn().mockResolvedValue(undefined),
      setBounds: vi.fn(),
      setVisible: vi.fn(),
      close: vi.fn()
    }
    const supervisor = new OfficePreviewSupervisor({
      inspectResource: vi.fn().mockResolvedValue({ size: 1024, version: 1 }),
      acquireResource: vi.fn().mockResolvedValue({
        id: 'resource-1',
        url: 'open-science-preview://resource-1/report.xlsx',
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 1
      }),
      releaseResource,
      createView: vi.fn().mockReturnValue(view),
      createSessionId: () => 'session-1'
    })

    await supervisor.open(7, request)
    await supervisor.closeOwner(7)

    expect(view.close).toHaveBeenCalledOnce()
    expect(releaseResource).toHaveBeenCalledWith(91, 'resource-1')
  })

  it('terminates a child at the 1,536 MiB process-memory high-water mark', async () => {
    vi.useFakeTimers()
    const publishState = vi.fn()
    const releaseResource = vi.fn()
    const view = {
      ownerId: 91,
      start: vi.fn().mockResolvedValue(undefined),
      setBounds: vi.fn(),
      setVisible: vi.fn(),
      close: vi.fn(),
      getMemoryUsageBytes: vi.fn().mockResolvedValue(OFFICE_PREVIEW_PROCESS_MEMORY_LIMIT_BYTES)
    }
    const supervisor = new OfficePreviewSupervisor({
      inspectResource: vi.fn().mockResolvedValue({ size: 1024, version: 1 }),
      acquireResource: vi.fn().mockResolvedValue({
        id: 'resource-1',
        url: 'open-science-preview://resource-1/report.xlsx',
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 1
      }),
      releaseResource,
      createView: vi.fn().mockReturnValue(view),
      createSessionId: () => 'session-1',
      publishState
    })

    await supervisor.open(7, request)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(publishState).toHaveBeenCalledWith(7, {
      sessionId: 'session-1',
      requestId: 'request-1',
      phase: 'error',
      error: 'RESOURCE_LIMIT_EXCEEDED'
    })
    expect(view.close).toHaveBeenCalledOnce()
    expect(releaseResource).toHaveBeenCalledWith(91, 'resource-1')
  })

  it('cancels an older open request that loses the host request generation race', async () => {
    let resolveFirstInspection: ((value: { size: number; version: number }) => void) | undefined
    const firstInspection = new Promise<{ size: number; version: number }>((resolve) => {
      resolveFirstInspection = resolve
    })
    const createView = vi.fn().mockReturnValue({
      ownerId: 92,
      start: vi.fn().mockResolvedValue(undefined),
      setBounds: vi.fn(),
      setVisible: vi.fn(),
      close: vi.fn()
    })
    let inspectionCount = 0
    const supervisor = new OfficePreviewSupervisor({
      inspectResource: vi.fn(() => {
        inspectionCount += 1
        return inspectionCount === 1 ? firstInspection : Promise.resolve({ size: 1024, version: 2 })
      }),
      acquireResource: vi.fn().mockResolvedValue({
        id: 'resource-2',
        url: 'open-science-preview://resource-2/report.xlsx',
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 2
      }),
      releaseResource: vi.fn(),
      createView,
      createSessionId: () => 'session-2'
    })

    const staleOpen = supervisor.open(7, request)
    await expect(supervisor.open(7, request)).resolves.toMatchObject({
      kind: 'started',
      sessionId: 'session-2'
    })
    resolveFirstInspection?.({ size: 1024, version: 1 })

    await expect(staleOpen).rejects.toThrow(/superseded/i)
    expect(createView).toHaveBeenCalledOnce()
  })
})
