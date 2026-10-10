// @vitest-environment jsdom
import { useEffect } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReplayResearchLayout, type ResearchReplayLayout } from './ReplayResearchLayout'

const paneIds = ['conversation', 'notebook', 'project', 'results']
const groupWidth = 1603
const panes = paneIds.map((id) => ({ id, label: id, content: <input aria-label={`${id} note`} /> }))
const slot = (container: HTMLElement, id: string): HTMLElement =>
  container.querySelector(`[data-replay-pane-slot="${id}"]`)!
const panePixels = (container: HTMLElement, id: string): number =>
  Number.parseFloat(slot(container, id).style.flexGrow)
const separator = (container: HTMLElement, id: string): HTMLElement =>
  container.querySelector(`[data-replay-resize-after="${id}"]`)!

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    return new DOMRect(0, 0, this.hasAttribute('data-replay-pane-group') ? groupWidth : 0, 800)
  })
  vi.stubGlobal(
    'PointerEvent',
    class extends MouseEvent {
      readonly pointerId: number
      constructor(type: string, options: PointerEventInit = {}) {
        super(type, options)
        this.pointerId = options.pointerId ?? 1
      }
    }
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    }
  )
  const captured = new WeakSet<HTMLElement>()
  Object.defineProperties(HTMLElement.prototype, {
    setPointerCapture: {
      configurable: true,
      value: function (this: HTMLElement) {
        captured.add(this)
      }
    },
    hasPointerCapture: {
      configurable: true,
      value: function (this: HTMLElement) {
        return captured.has(this)
      }
    },
    releasePointerCapture: {
      configurable: true,
      value: function (this: HTMLElement) {
        captured.delete(this)
      }
    }
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete (HTMLElement.prototype as Partial<HTMLElement>).setPointerCapture
  delete (HTMLElement.prototype as Partial<HTMLElement>).hasPointerCapture
  delete (HTMLElement.prototype as Partial<HTMLElement>).releasePointerCapture
})

describe('ReplayResearchLayout', () => {
  it.each(paneIds)(
    'preserves content and exact visible widths when leaving the %s tab',
    (initialPane) => {
      const mounts = vi.fn()
      const unmounts = vi.fn()
      const Content = ({ id }: { id: string }): React.JSX.Element => {
        useEffect(() => {
          mounts(id)
          return () => unmounts(id)
        }, [id])
        return <input aria-label={`${id} retained note`} defaultValue="retained" />
      }
      const retainedPanes = paneIds.map((id) => ({ id, label: id, content: <Content id={id} /> }))
      const view = render(
        <ReplayResearchLayout
          layout={{ mode: 'tabs', visiblePaneIds: [initialPane] }}
          panes={retainedPanes}
        />
      )
      const nodes = [...view.container.querySelectorAll('input')]
      const notebook = screen.getByLabelText('notebook retained note') as HTMLInputElement
      fireEvent.change(notebook, { target: { value: 'Reading an earlier run' } })
      const layouts: ResearchReplayLayout[] = [
        { mode: 'split', visiblePaneIds: ['conversation', 'notebook'] },
        { mode: 'tabs', visiblePaneIds: ['project'] },
        { mode: 'split', visiblePaneIds: ['conversation', 'results'] },
        { mode: 'columns', visiblePaneIds: paneIds },
        { mode: 'tabs', visiblePaneIds: ['conversation'] },
        {
          mode: 'split',
          visiblePaneIds: ['conversation', 'notebook'],
          widths: { conversation: 42, notebook: 58 }
        }
      ]
      for (const layout of layouts) {
        view.rerender(<ReplayResearchLayout layout={layout} panes={retainedPanes} />)
        const available = groupWidth - layout.visiblePaneIds.length + 1
        for (const id of paneIds) {
          const element = slot(view.container, id)
          if (!layout.visiblePaneIds.includes(id)) {
            expect(element.style.display).toBe('none')
            expect(element.hasAttribute('inert')).toBe(true)
            expect(element.getAttribute('aria-hidden')).toBe('true')
            continue
          }
          const expected =
            layout.widths?.[id] ??
            (layout.mode === 'split'
              ? id === 'conversation'
                ? 35
                : 65
              : 100 / layout.visiblePaneIds.length)
          expect(element.style.display).toBe('flex')
          expect(element.hasAttribute('inert')).toBe(false)
          expect(panePixels(view.container, id)).toBeCloseTo((available * expected) / 100)
        }
        expect([...view.container.querySelectorAll('input')]).toEqual(nodes)
      }
      expect(notebook.value).toBe('Reading an earlier run')
      expect(mounts).toHaveBeenCalledTimes(4)
      expect(unmounts).not.toHaveBeenCalled()
    }
  )

  it('resizes across hidden intermediate panes with keyboard controls and persists the new ratios', () => {
    const onWidthsChange = vi.fn()
    const view = render(
      <ReplayResearchLayout
        layout={{ mode: 'split', visiblePaneIds: ['conversation', 'results'], onWidthsChange }}
        panes={panes}
      />
    )
    const handle = separator(view.container, 'conversation')
    expect(screen.getAllByRole('separator')).toHaveLength(1)
    expect(handle.getAttribute('aria-label')).toBe('Resize conversation and results')
    expect(handle.getAttribute('aria-valuenow')).toBe('35')
    const initialLeft = panePixels(view.container, 'conversation')
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(panePixels(view.container, 'conversation')).toBeCloseTo(initialLeft + groupWidth * 0.05)
    expect(onWidthsChange).toHaveBeenCalledTimes(1)
    expect(onWidthsChange.mock.lastCall![0].conversation).toBeGreaterThan(35)
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(panePixels(view.container, 'conversation')).toBeCloseTo(300)
    fireEvent.keyDown(handle, { key: 'End' })
    expect(panePixels(view.container, 'results')).toBeCloseTo(320)
    const leftAtEnd = panePixels(view.container, 'conversation')
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true })
    expect(panePixels(view.container, 'conversation')).toBeCloseTo(leftAtEnd - groupWidth * 0.01)
  })

  it('keeps other columns fixed while dragging and persists only the completed drag', () => {
    const onWidthsChange = vi.fn()
    const view = render(
      <ReplayResearchLayout
        layout={{ mode: 'columns', visiblePaneIds: paneIds, onWidthsChange }}
        panes={panes}
      />
    )
    const handle = separator(view.container, 'notebook')
    fireEvent.pointerDown(handle, { button: 0, clientX: 800 })
    expect(handle.hasPointerCapture(1)).toBe(true)
    fireEvent.pointerMove(handle, { clientX: 860 })
    expect(panePixels(view.container, 'conversation')).toBeCloseTo(400)
    expect(panePixels(view.container, 'notebook')).toBeCloseTo(460)
    expect(panePixels(view.container, 'project')).toBeCloseTo(340)
    expect(panePixels(view.container, 'results')).toBeCloseTo(400)
    expect(onWidthsChange).not.toHaveBeenCalled()
    fireEvent.pointerUp(handle)
    expect(handle.hasPointerCapture(1)).toBe(false)
    expect(onWidthsChange).toHaveBeenCalledTimes(1)
    expect(onWidthsChange.mock.lastCall![0]).toEqual({
      conversation: 25,
      notebook: expect.closeTo(28.75),
      project: 21.25,
      results: 25
    })
  })

  it('restores the previous widths on pointer cancellation and accepts a later drag', () => {
    const onWidthsChange = vi.fn()
    const view = render(
      <ReplayResearchLayout
        layout={{ mode: 'columns', visiblePaneIds: paneIds, onWidthsChange }}
        panes={panes}
      />
    )
    const handle = separator(view.container, 'conversation')
    fireEvent.pointerDown(handle, { button: 0, clientX: 400 })
    fireEvent.pointerMove(handle, { clientX: 430 })
    expect(panePixels(view.container, 'conversation')).toBeCloseTo(430)
    fireEvent.pointerCancel(handle)
    expect(panePixels(view.container, 'conversation')).toBeCloseTo(400)
    expect(handle.hasPointerCapture(1)).toBe(false)
    expect(onWidthsChange).not.toHaveBeenCalled()
    expect(
      view.container.querySelector('[data-replay-pane-group]')?.classList.contains('select-none')
    ).toBe(false)
    fireEvent.pointerDown(handle, { button: 0, clientX: 400 })
    fireEvent.pointerMove(handle, { clientX: 410 })
    fireEvent.pointerUp(handle)
    expect(onWidthsChange).toHaveBeenCalledTimes(1)
    expect(panePixels(view.container, 'conversation')).toBeCloseTo(410)
  })

  it('releases an interrupted drag and discards its draft when leaving and returning to a layout', () => {
    const onWidthsChange = vi.fn()
    const columns: ResearchReplayLayout = {
      mode: 'columns',
      visiblePaneIds: paneIds,
      onWidthsChange
    }
    const view = render(<ReplayResearchLayout layout={columns} panes={panes} />)
    const handle = separator(view.container, 'notebook')
    const group = view.container.querySelector('[data-replay-pane-group]')!
    fireEvent.pointerDown(handle, { button: 0, clientX: 800 })
    fireEvent.pointerMove(handle, { clientX: 860 })
    expect(panePixels(view.container, 'notebook')).toBeCloseTo(460)
    expect(group.classList.contains('select-none')).toBe(true)

    view.rerender(
      <ReplayResearchLayout
        layout={{ mode: 'tabs', visiblePaneIds: ['results'], onWidthsChange }}
        panes={panes}
      />
    )
    expect(handle.hasPointerCapture(1)).toBe(false)
    expect(group.classList.contains('select-none')).toBe(false)
    expect(onWidthsChange).not.toHaveBeenCalled()

    view.rerender(<ReplayResearchLayout layout={columns} panes={panes} />)
    expect(group.classList.contains('select-none')).toBe(false)
    expect(panePixels(view.container, 'notebook')).toBeCloseTo(400)
    expect(panePixels(view.container, 'project')).toBeCloseTo(400)
    expect(onWidthsChange).not.toHaveBeenCalled()
    const restoredHandle = separator(view.container, 'notebook')
    fireEvent.pointerDown(restoredHandle, { button: 0, clientX: 800 })
    fireEvent.pointerMove(restoredHandle, { clientX: 820 })
    fireEvent.pointerUp(restoredHandle)
    expect(panePixels(view.container, 'notebook')).toBeCloseTo(420)
    expect(onWidthsChange).toHaveBeenCalledTimes(1)
  })

  it('changes question focus only on interaction with a visible pane', () => {
    const onFocusPane = vi.fn()
    const view = render(
      <ReplayResearchLayout
        layout={{ mode: 'tabs', visiblePaneIds: ['conversation'] }}
        panes={panes}
        onFocusPane={onFocusPane}
      />
    )
    expect(onFocusPane).not.toHaveBeenCalled()
    fireEvent.pointerDown(screen.getByLabelText('conversation note'))
    expect(onFocusPane).toHaveBeenLastCalledWith('conversation')
    onFocusPane.mockClear()
    fireEvent.focus(screen.getByLabelText('notebook note'))
    expect(onFocusPane).not.toHaveBeenCalled()
    view.rerender(
      <ReplayResearchLayout
        layout={{ mode: 'split', visiblePaneIds: ['conversation', 'notebook'] }}
        panes={panes}
        onFocusPane={onFocusPane}
      />
    )
    fireEvent.focus(screen.getByLabelText('notebook note'))
    expect(onFocusPane).toHaveBeenCalledWith('notebook')
  })
})
