// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

import { useFileDropZone } from './useFileDropZone'

// React's act() refuses to run unless the environment opts in to act-aware scheduling.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Minimal renderHook mirroring the repo's other hook tests (no @testing-library/react dependency).
const renderHook = <Value>(hook: () => Value): { result: { current: Value } } => {
  const container = document.createElement('div')
  const root = createRoot(container)
  const result = { current: undefined as unknown as Value }

  const HookHarness = (): null => {
    result.current = hook()
    return null
  }

  act(() => {
    root.render(createElement(HookHarness))
  })

  return { result }
}

// Builds a drag event stub whose dataTransfer exposes the requested types and files.
const createDragEvent = (types: string[], files: File[] = []): React.DragEvent<HTMLElement> => {
  const dataTransfer = {
    types,
    files,
    dropEffect: 'none' as DataTransfer['dropEffect']
  }

  return {
    preventDefault: vi.fn(),
    dataTransfer
  } as unknown as React.DragEvent<HTMLElement>
}

describe('useFileDropZone', () => {
  it('sets isDragging on file dragenter and clears it on dragleave at zero depth', () => {
    const onFiles = vi.fn()
    const { result } = renderHook(() => useFileDropZone({ enabled: true, onFiles }))

    act(() => {
      result.current.dropZoneProps.onDragEnter(createDragEvent(['Files']))
    })
    expect(result.current.isDragging).toBe(true)

    act(() => {
      result.current.dropZoneProps.onDragLeave(createDragEvent(['Files']))
    })
    expect(result.current.isDragging).toBe(false)
  })

  it('keeps the overlay stable across nested enter/leave pairs (no flicker)', () => {
    const onFiles = vi.fn()
    const { result } = renderHook(() => useFileDropZone({ enabled: true, onFiles }))

    act(() => {
      result.current.dropZoneProps.onDragEnter(createDragEvent(['Files']))
      result.current.dropZoneProps.onDragEnter(createDragEvent(['Files']))
    })
    expect(result.current.isDragging).toBe(true)

    // Leaving the child still leaves one outstanding enter, so the overlay stays visible.
    act(() => {
      result.current.dropZoneProps.onDragLeave(createDragEvent(['Files']))
    })
    expect(result.current.isDragging).toBe(true)

    act(() => {
      result.current.dropZoneProps.onDragLeave(createDragEvent(['Files']))
    })
    expect(result.current.isDragging).toBe(false)
  })

  it('ignores non-file drags such as selected text or elements', () => {
    const onFiles = vi.fn()
    const { result } = renderHook(() => useFileDropZone({ enabled: true, onFiles }))

    act(() => {
      result.current.dropZoneProps.onDragEnter(createDragEvent(['text/plain']))
    })
    expect(result.current.isDragging).toBe(false)
  })

  it('forwards dropped files and resets dragging state', () => {
    const onFiles = vi.fn()
    const { result } = renderHook(() => useFileDropZone({ enabled: true, onFiles }))
    const file = new File(['content'], 'note.txt', { type: 'text/plain' })

    act(() => {
      result.current.dropZoneProps.onDragEnter(createDragEvent(['Files']))
      result.current.dropZoneProps.onDrop(createDragEvent(['Files'], [file]))
    })

    expect(onFiles).toHaveBeenCalledWith([file])
    expect(result.current.isDragging).toBe(false)
  })

  it('never activates or reports dragging when disabled', () => {
    const onFiles = vi.fn()
    const { result } = renderHook(() => useFileDropZone({ enabled: false, onFiles }))

    act(() => {
      result.current.dropZoneProps.onDragEnter(createDragEvent(['Files']))
    })
    expect(result.current.isDragging).toBe(false)

    const file = new File(['x'], 'x.txt')
    act(() => {
      result.current.dropZoneProps.onDrop(createDragEvent(['Files'], [file]))
    })
    expect(onFiles).not.toHaveBeenCalled()
  })
})
