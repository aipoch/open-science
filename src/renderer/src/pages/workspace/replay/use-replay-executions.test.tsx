// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { recordedFixture } from '../../../../../main/run-observation/recorded-viewer.test-support'
import { researchFixture } from '../../../../replay-viewer/research-replay.test-support'
import type { RecordedEvidencePayload } from '../../../../../shared/run-observation-recorded'
import type { ReplayDocument } from '../../../../../shared/replay'
import { useReplayExecutions } from './use-replay-executions'
import type { ReadObservationBindingsResult } from '../../../../../shared/research-replay-observations'

const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}
function fixture(): {
  document: ReplayDocument
  payloads: RecordedEvidencePayload[]
  origins: Readonly<Record<string, number>>
} {
  const { document, timing } = researchFixture()
  const payload = {
    ...recordedFixture().payload,
    receiving: {
      projectId: document.source.projectId,
      sessionId: document.source.sessionId,
      artifactId: 'archive',
      versionId: 'archive-v1'
    }
  }
  return { document, payloads: [payload], origins: timing.recordedTimeOrigins }
}
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
describe('optional native execution associations', () => {
  it('keeps old research available without any state read', () => {
    const read = vi.fn()
    vi.stubGlobal('api', { sessionReplay: { readObservationBindings: read } })
    const { document, origins } = fixture()
    const payloads: never[] = []
    const { result } = renderHook(() => useReplayExecutions(document, payloads, origins))
    expect(result.current.executionTracks).toEqual([])
    expect(result.current.executionNotice).toBeUndefined()
    expect(read).not.toHaveBeenCalled()
  })
  it('does not delay the base clock while associations load and ignores a stale source reply', async () => {
    const pending = deferred<ReadObservationBindingsResult>()
    const read = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ sourceFingerprint: 'next', bindings: [], unavailableTargets: [] })
    vi.stubGlobal('api', { sessionReplay: { readObservationBindings: read } })
    const first = fixture()
    const { result, rerender } = renderHook(
      (props) => useReplayExecutions(props.document, props.payloads, props.origins),
      { initialProps: first }
    )
    expect(result.current.executionTracks).toEqual([])
    expect(result.current.executionNotice).toBeTruthy()
    const next = {
      ...first,
      payloads: [],
      document: { ...first.document, source: { ...first.document.source, fingerprint: 'next' } }
    }
    rerender(next)
    await waitFor(() => expect(result.current.executionNotice).toBeUndefined())
    await act(async () =>
      pending.resolve({
        sourceFingerprint: first.document.source.fingerprint,
        bindings: [],
        unavailableTargets: [first.payloads[0].receiving]
      })
    )
    expect(result.current.executionNotice).toBeUndefined()
    expect(first.document.branches[0].durationMs).toBe(next.document.branches[0].durationMs)
  })
  it('rejects a changed source fingerprint without replacing original playback', async () => {
    const read = vi
      .fn()
      .mockResolvedValue({ sourceFingerprint: 'wrong', bindings: [], unavailableTargets: [] })
    vi.stubGlobal('api', { sessionReplay: { readObservationBindings: read } })
    const value = fixture()
    const { result } = renderHook(() =>
      useReplayExecutions(value.document, value.payloads, value.origins)
    )
    await waitFor(() =>
      expect(result.current.executionNotice).toHaveProperty(
        'props.title',
        'Could not link saved execution states.'
      )
    )
    expect(result.current.executionTracks).toEqual([])
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceFingerprint: value.document.source.fingerprint,
        targets: [value.payloads[0].receiving]
      })
    )
  })
})
