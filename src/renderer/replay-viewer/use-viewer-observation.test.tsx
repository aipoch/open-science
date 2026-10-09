// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunObservationSnapshot } from '../../shared/run-observation'
import { ReplayViewerClient, ReplayViewerRequestError } from './client'
import { useViewerObservation } from './use-viewer-observation'
const record = (sequence = 1): RunObservationSnapshot => ({
  identity: { projectId: 'p', sessionId: 's', operationId: 'op', runId: 'run' },
  cursor: { epoch: 'epoch', sequence },
  observedAt: 1000 + sequence,
  phase: 'running',
  stepId: 'run:run',
  run: {
    runId: 'run',
    kernelKind: 'bash',
    status: 'running',
    startedAt: 1000,
    logs: {
      stdout: { text: `line ${sequence}`, truncated: false, redacted: false },
      stderr: { text: '', truncated: false, redacted: false },
      traceback: { text: '', truncated: false, redacted: false }
    }
  },
  artifacts: [],
  artifactsTruncated: false
})
const context = {
  viewerId: 'viewer',
  target: { projectId: 'p', sessionId: 's', operationId: 'op' },
  expiresAt: 999999,
  canInteract: false,
  canCancel: false,
  canReadArtifacts: false
}
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
describe('browser observation lifecycle', () => {
  it('resumes from the same cursor after a network failure without executing, cancelling or opening a project', async () => {
    const client = new ReplayViewerClient()
    vi.spyOn(client, 'context').mockResolvedValue(context)
    vi.spyOn(client, 'history').mockResolvedValue({
      coverage: 'process-local',
      truncated: false,
      snapshots: [record()]
    })
    const changes = vi
      .spyOn(client, 'changes')
      .mockRejectedValueOnce(new ReplayViewerRequestError('network'))
      .mockResolvedValue({
        kind: 'delta',
        from: record().cursor,
        cursor: record(2).cursor,
        changes: [record(2)]
      })
    const project = vi.spyOn(client, 'projectView'),
      cancel = vi.spyOn(client, 'cancel')
    const { result, unmount } = renderHook(() => useViewerObservation(client, 0))
    await waitFor(() => expect(result.current.connection).toBe('connected'))
    await waitFor(() => expect(result.current.connection).toBe('reconnecting'), { timeout: 2000 })
    await waitFor(() => expect(result.current.history?.snapshots.at(-1)?.cursor.sequence).toBe(2), {
      timeout: 2500
    })
    expect(changes.mock.calls[0][0].cursor).toEqual(record().cursor)
    expect(changes.mock.calls[1][0].cursor).toEqual(record().cursor)
    expect(project).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
    unmount()
    expect(changes.mock.calls.at(-1)?.[1]?.aborted).toBe(true)
  })
  it('ends an expired authorization loop without exposing an old actionable view', async () => {
    const client = new ReplayViewerClient()
    vi.spyOn(client, 'context').mockRejectedValue(
      new ReplayViewerRequestError('authorization', 401)
    )
    const history = vi.spyOn(client, 'history')
    const { result } = renderHook(() => useViewerObservation(client, 0))
    await waitFor(() => expect(result.current.error).toBe('authorization'))
    expect(result.current.context).toBeUndefined()
    expect(result.current.history).toBeUndefined()
    expect(history).not.toHaveBeenCalled()
  })
  it('keeps the last valid evidence if resynchronization returns a foreign scope', async () => {
    const client = new ReplayViewerClient(),
      foreign = {
        ...record(),
        identity: {
          ...record().identity,
          sessionId: 'another-session'
        }
      }
    vi.spyOn(client, 'context').mockResolvedValue(context)
    vi.spyOn(client, 'history')
      .mockResolvedValueOnce({ coverage: 'process-local', truncated: false, snapshots: [record()] })
      .mockResolvedValue({ coverage: 'process-local', truncated: false, snapshots: [foreign] })
    vi.spyOn(client, 'changes').mockResolvedValue({
      kind: 'resync',
      reason: 'epoch-changed',
      snapshot: foreign
    })
    const { result } = renderHook(() => useViewerObservation(client, 0))
    await waitFor(() => expect(result.current.connection).toBe('connected'))
    await waitFor(() => expect(result.current.connection).toBe('reconnecting'), { timeout: 2000 })
    expect(result.current.history?.snapshots).toEqual([record()])
  })
  it('drops an old epoch buffer when the server asks for resynchronization', async () => {
    const client = new ReplayViewerClient(),
      fresh = { ...record(0), cursor: { epoch: 'new', sequence: 0 } }
    vi.spyOn(client, 'context').mockResolvedValue(context)
    vi.spyOn(client, 'history')
      .mockResolvedValueOnce({ coverage: 'process-local', truncated: false, snapshots: [record()] })
      .mockResolvedValue({ coverage: 'process-local', truncated: true, snapshots: [fresh] })
    vi.spyOn(client, 'changes').mockResolvedValue({
      kind: 'resync',
      reason: 'epoch-changed',
      snapshot: fresh
    })
    const { result } = renderHook(() => useViewerObservation(client, 0))
    await waitFor(() => expect(result.current.history?.snapshots[0].cursor.epoch).toBe('new'), {
      timeout: 2000
    })
    expect(result.current.history?.snapshots).toEqual([fresh])
  })
})
