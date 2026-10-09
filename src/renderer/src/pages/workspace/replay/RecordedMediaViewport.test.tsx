// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RecordedMediaViewport } from './RecordedMediaViewport'

let resize: () => void
let width = 720
let height = 400
beforeEach(() => {
  width = 720
  height = 400
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.dataset.testid === 'recorded-media-scroll' ? width : 0
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.dataset.testid === 'recorded-media-scroll' ? height : 0
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback
      }
      observe = vi.fn()
      disconnect = vi.fn()
    }
  )
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
it('contains landscape, portrait and ultrawide recordings inside the actual remaining stage', () => {
  const { rerender } = render(
    <RecordedMediaViewport width={1280} height={720} surfaceTestId="surface">
      <video />
    </RecordedMediaViewport>
  )
  const surface = screen.getByTestId('surface')
  expect(parseFloat(surface.style.width)).toBeCloseTo(711.111)
  expect(surface.style.height).toBe('400px')
  rerender(
    <RecordedMediaViewport width={540} height={960} surfaceTestId="surface">
      <video />
    </RecordedMediaViewport>
  )
  expect(surface.style.width).toBe('225px')
  expect(surface.style.height).toBe('400px')
  rerender(
    <RecordedMediaViewport width={3440} height={1440} surfaceTestId="surface">
      <video />
    </RecordedMediaViewport>
  )
  expect(surface.style.width).toBe('720px')
  expect(parseFloat(surface.style.height)).toBeCloseTo(301.395)
  width = 360
  height = 180
  act(resize)
  expect(surface.style.width).toBe('360px')
  expect(parseFloat(surface.style.height)).toBeCloseTo(150.698)
})
it('keeps the same media element and actual pixels when sizing modes or resolution change', () => {
  const { rerender } = render(
    <RecordedMediaViewport width={1280} height={720} surfaceTestId="surface">
      <video data-testid="media" />
    </RecordedMediaViewport>
  )
  const media = screen.getByTestId('media') as HTMLVideoElement
  media.currentTime = 12.34
  fireEvent.click(screen.getByRole('button', { name: 'Actual size (100%)' }))
  expect(screen.getByTestId('surface').style.width).toBe('1280px')
  expect(screen.getByTestId('surface').style.height).toBe('720px')
  expect(screen.getByTestId('recorded-media-scroll').dataset.sizeMode).toBe('actual')
  rerender(
    <RecordedMediaViewport width={720} height={1280} surfaceTestId="surface">
      <video data-testid="media" />
    </RecordedMediaViewport>
  )
  expect(screen.getByTestId('surface').style.height).toBe('1280px')
  fireEvent.click(screen.getByRole('button', { name: 'Fit to window' }))
  expect(screen.getByTestId('media')).toBe(media)
  expect(media.currentTime).toBe(12.34)
  expect(screen.getByTestId('surface').style.width).toBe('225px')
})

it('uses one size action in the research toolbar without remounting the media', () => {
  render(
    <RecordedMediaViewport
      compact
      width={1280}
      height={720}
      metadata="1280 × 720 · WebM"
      surfaceTestId="surface"
    >
      <video data-testid="media" />
    </RecordedMediaViewport>
  )
  const media = screen.getByTestId('media')
  expect(screen.getAllByRole('button')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Actual size (100%)' }))
  expect(screen.getAllByRole('button')).toHaveLength(1)
  expect(screen.getByTestId('surface').style.width).toBe('1280px')
  fireEvent.click(screen.getByRole('button', { name: 'Fit to window' }))
  expect(screen.getByTestId('media')).toBe(media)
  expect(screen.getByTestId('recorded-media-scroll').dataset.sizeMode).toBe('fit')
})
