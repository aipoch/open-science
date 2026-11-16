// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

import type { ManagedFileIdentity } from '../../../../../shared/managed-file-versions'
import type { PptxDraftSummary } from '../../../../../shared/pptx-draft'
import { usePptxDraftPreview } from './use-pptx-draft-preview'

const file: ManagedFileIdentity = { source: 'upload', projectId: 'p', fileId: 'f' }
const draft: PptxDraftSummary = {
  draftId: 'd1',
  basedOnVersionId: 'v1',
  summary: 'Edit',
  opCount: 1,
  createdAt: 1,
  operations: [{ op: 'deleteShape', slideId: 256, shapeId: 2 }]
}
const view = { sessionId: 's1', stagedKey: 'k1' }
const api = { open: vi.fn(), apply: vi.fn(), close: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
  api.open.mockResolvedValue({ ok: true, value: { sessionId: 's1' } })
  api.apply.mockResolvedValue({ ok: true, value: view })
  api.close.mockResolvedValue(undefined)
  Object.assign(window, { api: { pptxEdit: api } })
})

it('replays the draft on its base version and closes the session afterwards', async () => {
  const { result, unmount } = renderHook(() => usePptxDraftPreview(file, draft, true))
  await waitFor(() => expect(result.current.view).toBe(view))
  expect(api.open).toHaveBeenCalledWith({ ...file, versionId: 'v1' })
  expect(api.apply).toHaveBeenCalledWith({ sessionId: 's1', operations: draft.operations })
  unmount()
  expect(api.close).toHaveBeenCalledWith('s1')
})

it('stays idle until review starts and reports replay failures', async () => {
  const { result, rerender } = renderHook(({ on }) => usePptxDraftPreview(file, draft, on), {
    initialProps: { on: false }
  })
  expect(api.open).not.toHaveBeenCalled()
  api.apply.mockResolvedValueOnce({ ok: false, error: { code: 'SHAPE_NOT_FOUND' } })
  rerender({ on: true })
  await waitFor(() => expect(result.current.failed).toBe(true))
  expect(result.current.view).toBeUndefined()
})

it('closes a session that finished opening after review ended', async () => {
  let finishOpen: (value: unknown) => void = () => undefined
  api.open.mockReturnValueOnce(new Promise((resolve) => (finishOpen = resolve)))
  const { unmount } = renderHook(() => usePptxDraftPreview(file, draft, true))
  unmount()
  finishOpen({ ok: true, value: { sessionId: 'late' } })
  await waitFor(() => expect(api.close).toHaveBeenCalledWith('late'))
  expect(api.apply).not.toHaveBeenCalled()
})
