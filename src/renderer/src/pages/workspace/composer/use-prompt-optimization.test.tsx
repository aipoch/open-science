// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePromptOptimization } from './use-prompt-optimization'
import { docFromText, docToText, docToMessageParts, type ComposerDoc } from './composer-doc'
import type { OptimizePromptRequest } from '../../../../../shared/prompt-optimization'

afterEach(() => vi.unstubAllGlobals())

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
const harness = (initial = docFromText('Original'), attachmentIds: string[] = []) => {
  const request = deferred()
  const optimize = vi.fn<(request: OptimizePromptRequest) => Promise<{ text: string }>>(
    () => request.promise
  )
  const event = vi.fn(async () => {})
  const hook = renderHook(
    ({ sessionKey, attachmentIds }) => {
      const [doc, setDoc] = useState<ComposerDoc>(initial)
      return {
        doc,
        setDoc,
        optimization: usePromptOptimization({
          projectId: 'project',
          modelConfiguration: {
            providerId: 'session',
            model: 'session-model',
            reasoningEffort: 'high'
          },
          attachmentIds,
          sessionKey,
          doc,
          onChange: setDoc,
          optimize,
          recordEvent: event
        })
      }
    },
    { initialProps: { sessionKey: 'one', attachmentIds } }
  )
  return { ...hook, request, optimize, event }
}

describe('composer prompt optimization', () => {
  it('cancels immediately and ignores a late result while a new request is running', async () => {
    const cancel = vi.fn(async () => {})
    vi.stubGlobal('api', { projects: { cancelPromptOptimization: cancel } })
    const { result, request, optimize, unmount } = harness()
    act(() => {
      void result.current.optimization.optimize()
    })
    act(() => result.current.optimization.cancel())
    expect(cancel).toHaveBeenCalledExactlyOnceWith({
      projectId: 'project',
      requestId: optimize.mock.calls[0][0].requestId
    })
    expect(result.current.optimization.pending).toBe(false)
    expect(docToText(result.current.doc)).toBe('Original')
    const next = deferred()
    optimize.mockImplementationOnce(() => next.promise)
    act(() => {
      void result.current.optimization.optimize()
    })
    await act(async () => request.resolve({ text: 'Cancelled result' }))
    expect(result.current.optimization.pending).toBe(true)
    expect(docToText(result.current.doc)).toBe('Original')
    await act(async () => next.resolve({ text: 'Fresh result' }))
    expect(docToText(result.current.doc)).toBe('Fresh result')
    unmount()
  })

  it('keeps the previous undo snapshot when a repeat optimization is cancelled', async () => {
    const { result, request, optimize, unmount } = harness()
    act(() => {
      void result.current.optimization.optimize()
    })
    await act(async () => request.resolve({ text: 'Improved' }))
    const next = deferred()
    optimize.mockImplementationOnce(() => next.promise)
    act(() => {
      void result.current.optimization.optimize()
    })
    act(() => result.current.optimization.cancel())
    await act(async () => next.resolve({ text: 'Cancelled result' }))
    expect(docToText(result.current.doc)).toBe('Improved')
    expect(result.current.optimization.notice).toBeUndefined()
    act(() => result.current.optimization.undo())
    expect(docToText(result.current.doc)).toBe('Original')
    unmount()
  })
  it('does not count send preparation clearing and restoration as user edits', async () => {
    const { result, request, event, unmount } = harness()
    act(() => {
      void result.current.optimization.optimize()
    })
    await act(async () => request.resolve({ text: 'Improved' }))
    act(() => result.current.setDoc({ nodes: [] }))
    act(() => result.current.setDoc(docFromText('Improved')))
    expect(event).not.toHaveBeenCalledWith({ action: 'edit' })
    act(() => {
      result.current.optimization.edited()
      result.current.setDoc(docFromText('Edited'))
    })
    expect(event).toHaveBeenCalledExactlyOnceWith({ action: 'edit' })
    unmount()
  })

  it('sends the effective composer configuration with the optimization request', async () => {
    const { result, request, optimize, unmount } = harness()
    act(() => {
      void result.current.optimization.optimize()
    })
    expect(optimize).toHaveBeenCalledWith({
      projectId: 'project',
      requestId: expect.any(String),
      input: 'Original',
      agentConfiguration: { providerId: 'session', model: 'session-model', reasoningEffort: 'high' }
    })
    await act(async () => request.resolve({ text: 'Improved' }))
    unmount()
  })
  it.each([false, true])(
    'restores pasted text without losing content when attachment removed=%s',
    async (removed) => {
      const text = 'research data\n'.repeat(1000)
      const pasted = { type: 'pasted-text' as const, id: 'paste', attachmentId: 'upload', text }
      const original = { nodes: [{ type: 'text' as const, text: 'Analyze ' }, pasted] }
      const { result, request, optimize, rerender, unmount } = harness(original, ['upload'])
      act(() => {
        void result.current.optimization.optimize()
      })
      await act(async () =>
        request.resolve({ text: `Improved: ${optimize.mock.calls[0][0].input}` })
      )
      if (removed) {
        act(() => result.current.setDoc(docFromText('Improved: Analyze ')))
        rerender({ sessionKey: 'one', attachmentIds: [] })
      }
      act(() => result.current.optimization.undo())
      if (removed) {
        expect(docToText(result.current.doc)).toBe(`Analyze ${text}`)
        expect(docToMessageParts(result.current.doc)).toEqual([
          { type: 'text', text: 'Analyze ' },
          { type: 'text', text }
        ])
      } else expect(result.current.doc).toEqual(original)
      unmount()
    }
  )

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
    rerender({ sessionKey: 'two', attachmentIds: [] })
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
