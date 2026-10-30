// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { usePromptOptimization } from './use-prompt-optimization'
import { docFromText, docToText, type ComposerDoc } from './composer-doc'
import type { OptimizePromptRequest } from '../../../../../shared/prompt-optimization'

const deferred = (): {
  promise: Promise<{ text: string }>
  resolve: (value: { text: string }) => void
} => {
  let resolve!: (value: { text: string }) => void
  const promise = new Promise<{ text: string }>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
// Keep the inferred renderHook and spy types for assertions.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const harness = (initial = docFromText('Original')) => {
  const request = deferred()
  const optimize = vi.fn<(request: OptimizePromptRequest) => Promise<{ text: string }>>(
    () => request.promise
  )
  const event = vi.fn(async () => {})
  const hook = renderHook(
    ({ sessionKey }) => {
      const [doc, setDoc] = useState<ComposerDoc>(initial)
      return {
        doc,
        setDoc,
        optimization: usePromptOptimization({
          projectId: 'project',
          sessionKey,
          doc,
          onChange: setDoc,
          optimize,
          recordEvent: event
        })
      }
    },
    { initialProps: { sessionKey: 'one' } }
  )
  return { ...hook, request, optimize }
}

describe('composer prompt optimization', () => {
  it('replaces the draft only after success and restores the complete original on undo', async () => {
    const { result, request, unmount } = harness()
    act(() => {
      void result.current.optimization.optimize()
    })
    expect(docToText(result.current.doc)).toBe('Original')
    await act(async () => request.resolve({ text: 'Improved' }))
    expect(docToText(result.current.doc)).toBe('Improved')
    act(() => result.current.setDoc(docFromText('Edited improved')))
    act(() => result.current.optimization.undo())
    expect(docToText(result.current.doc)).toBe('Original')
    unmount()
  })
  it('discards results even if the user edits away and back to the original input', async () => {
    const { result, request, unmount } = harness()
    act(() => {
      void result.current.optimization.optimize()
    })
    act(() => result.current.setDoc(docFromText('New')))
    act(() => result.current.setDoc(docFromText('Original')))
    await act(async () => request.resolve({ text: 'Obsolete' }))
    expect(docToText(result.current.doc)).toBe('Original')
    expect(result.current.optimization.notice).toBe('changed')
    unmount()
  })
  it('ignores results from another session and coalesces repeated clicks', async () => {
    const { result, request, optimize, rerender, unmount } = harness()
    act(() => {
      void result.current.optimization.optimize()
      void result.current.optimization.optimize()
    })
    expect(optimize).toHaveBeenCalledTimes(1)
    rerender({ sessionKey: 'two' })
    await act(async () => request.resolve({ text: 'Obsolete' }))
    expect(docToText(result.current.doc)).toBe('Original')
    expect(result.current.optimization.canUndo).toBe(false)
    unmount()
  })
  it('retains reference chips and rejects output which drops a chip', async () => {
    const chip = { type: 'skill' as const, id: 'science', name: 'Science' }
    const initial = { nodes: [{ type: 'text' as const, text: 'Use ' }, chip] }
    const { result, request, unmount } = harness(initial)
    act(() => {
      void result.current.optimization.optimize()
    })
    await act(async () => request.resolve({ text: 'Dropped reference' }))
    expect(result.current.doc).toEqual(initial)
    await waitFor(() => expect(result.current.optimization.notice).toBe('failed'))
    unmount()
  })
  it('invalidates in-flight optimization when sending and never restores a sent draft', async () => {
    const { result, request, unmount } = harness()
    act(() => {
      void result.current.optimization.optimize()
    })
    act(() => result.current.optimization.sent())
    await act(async () => request.resolve({ text: 'Late result' }))
    expect(docToText(result.current.doc)).toBe('Original')
    expect(result.current.optimization.canUndo).toBe(false)
    expect(result.current.optimization.pending).toBe(false)
    unmount()
  })
  it('preserves successful reference chips through optimization and undo', async () => {
    const chip = { type: 'skill' as const, id: 'science', name: 'Science' }
    const original = { nodes: [{ type: 'text' as const, text: 'Use ' }, chip] }
    const { result, request, optimize, unmount } = harness(original)
    act(() => {
      void result.current.optimization.optimize()
    })
    const input = optimize.mock.calls[0]?.[0] as { input: string } | undefined
    await act(async () => request.resolve({ text: `Improved: ${input!.input}` }))
    expect(result.current.doc.nodes).toContainEqual(chip)
    act(() => result.current.optimization.undo())
    expect(result.current.doc).toEqual(original)
    unmount()
  })
})
