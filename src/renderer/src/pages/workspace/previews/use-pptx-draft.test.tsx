// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { ManagedFileIdentity } from '../../../../../shared/managed-file-versions'
import type { PptxDraftChangedEvent, PptxDraftSummary } from '../../../../../shared/pptx-draft'
import { usePptxDraft } from './use-pptx-draft'

const fileA: ManagedFileIdentity = { source: 'artifact', projectId: 'p', fileId: 'a' }
const fileB: ManagedFileIdentity = { source: 'artifact', projectId: 'p', fileId: 'b' }
const draftOf = (draftId: string): PptxDraftSummary => ({
  draftId,
  basedOnVersionId: 'v1',
  summary: `Draft ${draftId}`,
  opCount: 1,
  createdAt: 1,
  operations: [{ op: 'deleteShape', slideId: 256, shapeId: 2 }]
})
const version = { versionId: 'v2' } as never

let listener: ((event: PptxDraftChangedEvent) => void) | undefined
const api = {
  get: vi.fn(),
  accept: vi.fn(),
  reject: vi.fn(),
  onChanged: vi.fn((next: (event: PptxDraftChangedEvent) => void) => {
    listener = next
    return () => {
      listener = undefined
    }
  })
}

beforeEach(() => {
  api.get.mockImplementation(async (identity: ManagedFileIdentity) =>
    identity.fileId === 'a' ? draftOf('d1') : null
  )
  Object.assign(window, { api: { pptxDraft: api } })
})
afterEach(() => {
  vi.clearAllMocks()
  listener = undefined
})

it('loads the draft for the file and drops it when switching files', async () => {
  const { result, rerender } = renderHook(({ id }) => usePptxDraft(id), {
    initialProps: { id: fileA }
  })
  await waitFor(() => expect(result.current.draft?.draftId).toBe('d1'))
  rerender({ id: fileB })
  expect(result.current.draft).toBeNull()
  await waitFor(() => expect(api.get).toHaveBeenLastCalledWith(fileB))
  expect(result.current.draft).toBeNull()
})

it('follows change events for the same file only', async () => {
  const { result } = renderHook(() => usePptxDraft(fileA))
  await waitFor(() => expect(result.current.draft?.draftId).toBe('d1'))
  act(() => listener?.({ identity: fileB, draft: draftOf('other'), reason: 'proposed' }))
  expect(result.current.draft?.draftId).toBe('d1')
  act(() => listener?.({ identity: fileA, draft: null, reason: 'rejected' }))
  expect(result.current.draft).toBeNull()
})

it('returns the saved result on accept and reports stale or conflicting saves', async () => {
  const { result } = renderHook(() => usePptxDraft(fileA))
  await waitFor(() => expect(result.current.draft?.draftId).toBe('d1'))

  const saved = { kind: 'created', version, headVersionId: 'v2', replayed: false }
  api.accept.mockResolvedValueOnce({ kind: 'saved', result: saved })
  await expect(act(() => result.current.accept())).resolves.toEqual(saved)
  expect(api.accept).toHaveBeenCalledWith({ identity: fileA, draftId: 'd1' })
  expect(result.current.problem).toBeUndefined()

  api.accept.mockResolvedValueOnce({ kind: 'stale', headVersionId: 'v3' })
  await expect(act(() => result.current.accept())).resolves.toBeUndefined()
  expect(result.current.problem).toBe('stale')

  const conflict = { kind: 'conflict', expectedHeadVersionId: 'v1', actualHead: version }
  api.accept.mockResolvedValueOnce({ kind: 'saved', result: conflict })
  await act(() => result.current.accept())
  expect(result.current.problem).toBe('conflict')

  api.accept.mockRejectedValueOnce(new Error('ipc'))
  await act(() => result.current.accept())
  expect(result.current.problem).toBe('failed')
  expect(result.current.busy).toBe(false)
})

it('rejects the current draft and clears a reported problem', async () => {
  const { result } = renderHook(() => usePptxDraft(fileA))
  await waitFor(() => expect(result.current.draft?.draftId).toBe('d1'))
  api.accept.mockResolvedValueOnce({ kind: 'stale', headVersionId: 'v3' })
  await act(() => result.current.accept())
  api.reject.mockResolvedValueOnce(undefined)
  await act(() => result.current.reject())
  expect(api.reject).toHaveBeenCalledWith({ identity: fileA, draftId: 'd1' })
  expect(result.current.problem).toBeUndefined()
})
