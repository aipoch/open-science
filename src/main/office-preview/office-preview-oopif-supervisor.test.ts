import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  OFFICE_PREVIEW_MAX_FILE_BYTES,
  OFFICE_PREVIEW_PROCESS_MEMORY_LIMIT_BYTES,
  OFFICE_PREVIEW_PROCESS_MEMORY_POLL_MS
} from '../../shared/office-preview'
import type { OfficePreviewSupervisorDependencies } from './office-preview-supervisor'
import { OfficePreviewSupervisor } from './office-preview-supervisor'

const request = {
  requestId: 'request-1',
  source: 'artifact' as const,
  path: 'project/session/report.docx',
  name: 'report.docx',
  extension: 'docx' as const,
  attempt: 0
}

const resource = {
  id: 'resource-1',
  url: 'open-science-preview://resource-1/report.docx',
  size: 1024,
  mimeType: 'application/octet-stream',
  version: 1
}

const createDependencies = (
  overrides: Partial<OfficePreviewSupervisorDependencies> = {}
): OfficePreviewSupervisorDependencies => ({
  inspectResource: vi.fn().mockResolvedValue({ size: 1024, version: 1 }),
  acquireResource: vi.fn().mockResolvedValue(resource),
  releaseResource: vi.fn(),
  createSessionId: () => 'session-1',
  createRuntimeUrl: (sessionId) =>
    `open-science-office-preview://runtime/office-preview.html?sessionId=${sessionId}`,
  resolveFrameProcess: vi.fn().mockReturnValue({ frameProcessId: 91, parentProcessId: 7 }),
  publishState: vi.fn(),
  ...overrides
})

afterEach(() => {
  vi.useRealTimers()
})

describe('OfficePreviewSupervisor OOPIF sessions', () => {
  it('opens a resource-backed runtime URL without allocating a native child view', async () => {
    const dependencies = createDependencies()
    const supervisor = new OfficePreviewSupervisor(dependencies)

    await expect(supervisor.open(7, request)).resolves.toEqual({
      kind: 'started',
      sessionId: 'session-1',
      runtimeUrl: 'open-science-office-preview://runtime/office-preview.html?sessionId=session-1',
      size: 1024,
      limit: OFFICE_PREVIEW_MAX_FILE_BYTES
    })
    expect(dependencies.acquireResource).toHaveBeenCalledWith(
      7,
      request,
      { size: 1024, version: 1 },
      OFFICE_PREVIEW_MAX_FILE_BYTES
    )
    await supervisor.close(7, 'session-1')
  })

  it('rejects an oversized file before acquiring a capability or creating a runtime URL', async () => {
    const createRuntimeUrl = vi.fn()
    const dependencies = createDependencies({
      inspectResource: vi
        .fn()
        .mockResolvedValue({ size: OFFICE_PREVIEW_MAX_FILE_BYTES + 1, version: 1 }),
      createRuntimeUrl
    })
    const supervisor = new OfficePreviewSupervisor(dependencies)

    await expect(supervisor.open(7, request)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'FILE_TOO_LARGE',
      size: OFFICE_PREVIEW_MAX_FILE_BYTES + 1,
      limit: OFFICE_PREVIEW_MAX_FILE_BYTES
    })
    expect(dependencies.acquireResource).not.toHaveBeenCalled()
    expect(createRuntimeUrl).not.toHaveBeenCalled()
  })

  it('fails closed when Chromium does not isolate the frame process', async () => {
    const dependencies = createDependencies({
      resolveFrameProcess: vi.fn().mockReturnValue({ frameProcessId: 7, parentProcessId: 7 })
    })
    const supervisor = new OfficePreviewSupervisor(dependencies)

    await supervisor.open(7, request)
    await expect(supervisor.attachFrame(7, 'session-1')).resolves.toEqual({
      kind: 'unavailable',
      reason: 'PREVIEW_PROCESS_NOT_ISOLATED'
    })

    expect(dependencies.publishState).toHaveBeenLastCalledWith(7, {
      sessionId: 'session-1',
      requestId: 'request-1',
      phase: 'error',
      error: 'PREVIEW_PROCESS_NOT_ISOLATED'
    })
    expect(dependencies.releaseResource).toHaveBeenCalledWith(7, 'resource-1')
  })

  it('releases the session when frame process resolution throws', async () => {
    const dependencies = createDependencies({
      resolveFrameProcess: vi.fn(() => {
        throw new Error('frame disappeared')
      })
    })
    const supervisor = new OfficePreviewSupervisor(dependencies)

    await supervisor.open(7, request)
    await expect(supervisor.attachFrame(7, 'session-1')).resolves.toEqual({
      kind: 'unavailable',
      reason: 'PREVIEW_PROCESS_NOT_ISOLATED'
    })

    expect(dependencies.releaseResource).toHaveBeenCalledWith(7, 'resource-1')
  })

  it('rejects a renderer process replacement after the session has attached', async () => {
    const dependencies = createDependencies({
      resolveFrameProcess: vi
        .fn()
        .mockReturnValueOnce({ frameProcessId: 91, parentProcessId: 7 })
        .mockReturnValueOnce({ frameProcessId: 92, parentProcessId: 7 })
    })
    const supervisor = new OfficePreviewSupervisor(dependencies)

    await supervisor.open(7, request)
    await expect(supervisor.attachFrame(7, 'session-1')).resolves.toEqual({
      kind: 'attached',
      start: expect.objectContaining({ sessionId: 'session-1', resource })
    })
    await expect(supervisor.attachFrame(7, 'session-1')).resolves.toEqual({
      kind: 'unavailable',
      reason: 'PREVIEW_PROCESS_NOT_ISOLATED'
    })

    expect(dependencies.releaseResource).toHaveBeenCalledWith(7, 'resource-1')
  })

  it('accepts runtime state only after attachment and clears the start timeout when ready', async () => {
    vi.useFakeTimers()
    const dependencies = createDependencies()
    const supervisor = new OfficePreviewSupervisor(dependencies)

    await supervisor.open(7, request)
    supervisor.reportState(7, 'session-1', { sessionId: 'session-1', phase: 'ready' })
    expect(dependencies.publishState).toHaveBeenCalledTimes(1)

    await supervisor.attachFrame(7, 'session-1')
    supervisor.reportState(7, 'session-1', { sessionId: 'session-1', phase: 'ready' })
    await vi.advanceTimersByTimeAsync(30_000)

    expect(dependencies.publishState).toHaveBeenLastCalledWith(7, {
      sessionId: 'session-1',
      requestId: 'request-1',
      phase: 'ready'
    })
    expect(dependencies.publishState).not.toHaveBeenCalledWith(
      7,
      expect.objectContaining({ error: 'PREVIEW_TIMEOUT' })
    )
    await supervisor.close(7, 'session-1')
  })

  it('restarts the readiness timeout when an attached frame reloads', async () => {
    vi.useFakeTimers()
    const dependencies = createDependencies()
    const supervisor = new OfficePreviewSupervisor(dependencies)

    await supervisor.open(7, request)
    await supervisor.attachFrame(7, 'session-1')
    supervisor.reportState(7, 'session-1', { sessionId: 'session-1', phase: 'ready' })
    await supervisor.attachFrame(7, 'session-1')
    await vi.advanceTimersByTimeAsync(30_000)

    expect(dependencies.publishState).toHaveBeenLastCalledWith(7, {
      sessionId: 'session-1',
      requestId: 'request-1',
      phase: 'error',
      error: 'PREVIEW_TIMEOUT'
    })
    expect(dependencies.releaseResource).toHaveBeenCalledWith(7, 'resource-1')
  })

  it('times out an unready runtime and releases its capability', async () => {
    vi.useFakeTimers()
    const dependencies = createDependencies()
    const supervisor = new OfficePreviewSupervisor(dependencies)

    await supervisor.open(7, request)
    await vi.advanceTimersByTimeAsync(30_000)

    expect(dependencies.publishState).toHaveBeenLastCalledWith(7, {
      sessionId: 'session-1',
      requestId: 'request-1',
      phase: 'error',
      error: 'PREVIEW_TIMEOUT'
    })
    expect(dependencies.releaseResource).toHaveBeenCalledWith(7, 'resource-1')
  })

  it('terminates a frame that reaches the renderer memory limit', async () => {
    vi.useFakeTimers()
    const dependencies = createDependencies({
      getProcessMemoryUsageBytes: vi
        .fn()
        .mockResolvedValue(OFFICE_PREVIEW_PROCESS_MEMORY_LIMIT_BYTES)
    })
    const supervisor = new OfficePreviewSupervisor(dependencies)

    await supervisor.open(7, request)
    await supervisor.attachFrame(7, 'session-1')
    await vi.advanceTimersByTimeAsync(OFFICE_PREVIEW_PROCESS_MEMORY_POLL_MS)

    expect(dependencies.publishState).toHaveBeenLastCalledWith(7, {
      sessionId: 'session-1',
      requestId: 'request-1',
      phase: 'error',
      error: 'RESOURCE_LIMIT_EXCEEDED'
    })
    expect(dependencies.releaseResource).toHaveBeenCalledWith(7, 'resource-1')
  })

  it('detects a missing frame on a memory poll as a process crash', async () => {
    vi.useFakeTimers()
    const dependencies = createDependencies({
      resolveFrameProcess: vi
        .fn()
        .mockReturnValueOnce({ frameProcessId: 91, parentProcessId: 7 })
        .mockReturnValueOnce(undefined),
      getProcessMemoryUsageBytes: vi.fn().mockReturnValue(0)
    })
    const supervisor = new OfficePreviewSupervisor(dependencies)

    await supervisor.open(7, request)
    await supervisor.attachFrame(7, 'session-1')
    await vi.advanceTimersByTimeAsync(OFFICE_PREVIEW_PROCESS_MEMORY_POLL_MS)

    expect(dependencies.publishState).toHaveBeenLastCalledWith(7, {
      sessionId: 'session-1',
      requestId: 'request-1',
      phase: 'error',
      error: 'PREVIEW_PROCESS_CRASHED'
    })
    expect(dependencies.releaseResource).toHaveBeenCalledWith(7, 'resource-1')
  })

  it('detects a replaced parent renderer on a memory poll as a process crash', async () => {
    vi.useFakeTimers()
    const dependencies = createDependencies({
      resolveFrameProcess: vi
        .fn()
        .mockReturnValueOnce({ frameProcessId: 91, parentProcessId: 7 })
        .mockReturnValueOnce({ frameProcessId: 91, parentProcessId: 8 }),
      getProcessMemoryUsageBytes: vi.fn().mockReturnValue(0)
    })
    const supervisor = new OfficePreviewSupervisor(dependencies)

    await supervisor.open(7, request)
    await supervisor.attachFrame(7, 'session-1')
    await vi.advanceTimersByTimeAsync(OFFICE_PREVIEW_PROCESS_MEMORY_POLL_MS)

    expect(dependencies.publishState).toHaveBeenLastCalledWith(7, {
      sessionId: 'session-1',
      requestId: 'request-1',
      phase: 'error',
      error: 'PREVIEW_PROCESS_CRASHED'
    })
    expect(dependencies.releaseResource).toHaveBeenCalledWith(7, 'resource-1')
  })

  it('releases only the owning session and makes repeated closes idempotent', async () => {
    const dependencies = createDependencies()
    const supervisor = new OfficePreviewSupervisor(dependencies)

    await supervisor.open(7, request)
    await supervisor.close(8, 'session-1')
    await supervisor.closeOwner(7)
    await supervisor.closeOwner(7)

    expect(dependencies.releaseResource).toHaveBeenCalledTimes(1)
    expect(dependencies.releaseResource).toHaveBeenCalledWith(7, 'resource-1')
  })
})
