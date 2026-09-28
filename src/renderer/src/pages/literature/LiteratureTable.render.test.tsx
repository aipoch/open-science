// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { LiteratureTableScrollArea, LiteratureTextTooltip } from './LiteratureTable'
import { TooltipProvider } from '@/components/ui/tooltip'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
it('updates the fixed column edge only while content remains to the right, without rerendering children', () => {
  let resized!: () => void
  const disconnect = vi.fn()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resized = callback
      }
      observe = vi.fn()
      disconnect = disconnect
    }
  )
  const child = vi.fn(() => (
    <table>
      <tbody>
        <tr>
          <td>{'Synthetic row'}</td>
        </tr>
      </tbody>
    </table>
  ))
  const Child = child
  const view = render(
    <LiteratureTableScrollArea>
      <Child />
    </LiteratureTableScrollArea>
  )
  const viewport = view.container.firstElementChild as HTMLDivElement
  Object.defineProperties(viewport, {
    clientWidth: { value: 300, configurable: true },
    scrollWidth: { value: 600, configurable: true }
  })
  resized()
  expect(viewport.dataset.overflowRight).toBe('true')
  viewport.scrollLeft = 300
  fireEvent.scroll(viewport)
  expect(viewport.dataset.overflowRight).toBe('false')
  viewport.scrollLeft = 100
  fireEvent.scroll(viewport)
  expect(viewport.dataset.overflowRight).toBe('true')
  Object.defineProperty(viewport, 'clientWidth', { value: 600 })
  viewport.scrollLeft = 0
  resized()
  expect(viewport.dataset.overflowRight).toBe('false')
  expect(child).toHaveBeenCalledOnce()
  view.unmount()
  expect(disconnect).toHaveBeenCalledOnce()
})

it('only opens overflow hints for clipped text and checks again after resizing', async () => {
  render(
    <TooltipProvider>
      <LiteratureTextTooltip text="0.9" overflowOnly>
        <span tabIndex={0}>{'0.9'}</span>
      </LiteratureTextTooltip>
    </TooltipProvider>
  )
  const trigger = screen.getByText('0.9')
  Object.defineProperties(trigger, {
    clientWidth: { value: 100, configurable: true },
    scrollWidth: { value: 100, configurable: true }
  })
  fireEvent.focus(trigger)
  expect(screen.queryByRole('tooltip')).toBeNull()
  fireEvent.blur(trigger)

  Object.defineProperty(trigger, 'scrollWidth', { value: 150, configurable: true })
  fireEvent.focus(trigger)
  expect((await screen.findByRole('tooltip')).textContent).toBe('0.9')
  fireEvent.blur(trigger)

  Object.defineProperty(trigger, 'clientWidth', { value: 200 })
  fireEvent.focus(trigger)
  expect(screen.queryByRole('tooltip')).toBeNull()
})

it('reveals a clipped nested badge while preserving ordinary text hints', async () => {
  render(
    <TooltipProvider>
      <LiteratureTextTooltip text="Long category name" overflowOnly>
        <span tabIndex={0} data-testid="category-cell">
          <span>{'Long category name'}</span>
        </span>
      </LiteratureTextTooltip>
      <LiteratureTextTooltip text="Reference title">
        <span tabIndex={0}>{'Reference title'}</span>
      </LiteratureTextTooltip>
    </TooltipProvider>
  )
  Object.defineProperties(screen.getByText('Long category name'), {
    clientWidth: { value: 80 },
    scrollWidth: { value: 160 }
  })
  const trigger = screen.getByTestId('category-cell')
  fireEvent.focus(trigger)
  expect((await screen.findByRole('tooltip')).textContent).toBe('Long category name')
  fireEvent.blur(trigger)
  fireEvent.focus(screen.getByText('Reference title'))
  expect((await screen.findByRole('tooltip')).textContent).toBe('Reference title')
})
