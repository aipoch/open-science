// @vitest-environment jsdom
import { act, renderHook, type RenderHookResult } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PptxOperation } from '../../../../../shared/pptx-edit'
import { usePptxEditSession } from './use-pptx-edit-session'

const identity = { source: 'upload', projectId: 'p', fileId: 'f' } as const
const op: PptxOperation = { op: 'deleteShape', slideId: 256, shapeId: 2 }

const viewFor = (sessionId: string, revision = 0): unknown => ({
  ok: true,
  value: { sessionId, revision, stagedKey: `${sessionId}:${revision}`, outline: { slides: [] } }
})

const api = {
  open: vi.fn(),
  apply: vi.fn(),
  save: vi.fn(),
  close: vi.fn()
}

beforeEach(() => {
  let opened = 0
  api.open.mockImplementation(async () => viewFor(`s${++opened}`))
  api.apply.mockImplementation(async ({ sessionId }: { sessionId: string }) =>
    viewFor(sessionId, 1)
  )
  api.save.mockResolvedValue({ ok: true, value: { kind: 'noop', headVersionId: 'v2' } })
  api.close.mockResolvedValue(undefined)
  Object.assign(window, { api: { pptxEdit: api } })
})
afterEach(() => vi.clearAllMocks())

type Options = Parameters<typeof usePptxEditSession>[0]

const setup = (
  initial: Options
): RenderHookResult<ReturnType<typeof usePptxEditSession>, Options> =>
  renderHook((options: Options) => usePptxEditSession(options), { initialProps: initial })

describe('usePptxEditSession', () => {
  it('restores a historical version without edits', async () => {
    const { result } = setup({ identity, baseVersionId: 'v1', headVersionId: 'v2' })
    await act(() => result.current.begin())
    expect(result.current.restoring).toBe(true)
    await act(() => result.current.save())
    expect(api.save).toHaveBeenCalledWith(
      expect.objectContaining({ operations: [], expectedHeadVersionId: 'v2', restore: true })
    )
  })

  it('keeps saving against the head it opened with', async () => {
    const { result, rerender } = setup({ identity, baseVersionId: 'v2', headVersionId: 'v2' })
    await act(() => result.current.begin())
    await act(() => result.current.addOperation(op))
    rerender({ identity, baseVersionId: 'v3', headVersionId: 'v3' })
    expect(result.current.headMoved).toBe(true)
    expect(result.current.restoring).toBe(false)
    await act(() => result.current.save())
    expect(api.save).toHaveBeenCalledWith(
      expect.not.objectContaining({ restore: expect.anything() })
    )
    expect(api.save.mock.calls[0]?.[0]).toMatchObject({ expectedHeadVersionId: 'v2' })
  })

  it('replays pending edits onto a newer head', async () => {
    const { result, rerender } = setup({ identity, baseVersionId: 'v2', headVersionId: 'v2' })
    await act(() => result.current.begin())
    await act(() => result.current.addOperation(op))
    rerender({ identity, baseVersionId: 'v2', headVersionId: 'v3' })
    await expect(act(() => result.current.rebase('v3'))).resolves.toBe(true)
    expect(api.open).toHaveBeenLastCalledWith({ ...identity, versionId: 'v3' })
    expect(api.apply).toHaveBeenLastCalledWith({ sessionId: 's2', operations: [op] })
    expect(api.close).toHaveBeenCalledWith('s1')
    expect(result.current.headMoved).toBe(false)
    expect(result.current.state.operations).toEqual([op])
    await act(() => result.current.save())
    expect(api.save.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 's2',
      expectedHeadVersionId: 'v3'
    })
  })

  it('stays on the original session when the replay is rejected', async () => {
    const { result } = setup({ identity, baseVersionId: 'v2', headVersionId: 'v2' })
    await act(() => result.current.begin())
    await act(() => result.current.addOperation(op))
    api.apply.mockResolvedValueOnce({ ok: false, error: { code: 'OPERATION_REJECTED' } })
    await expect(act(() => result.current.rebase('v3'))).resolves.toBe(false)
    expect(api.close).toHaveBeenCalledWith('s2')
    expect(result.current.phase).toBe('ready')
    expect(result.current.view?.sessionId).toBe('s1')
  })
})
