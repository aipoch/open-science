// @vitest-environment jsdom
import { StrictMode, useLayoutEffect } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { browserRecordingFixture } from './BrowserRecording.test-support'
import { BrowserRecordingPlayer, type BrowserRecordingTransport } from './BrowserRecordingPlayer'
import { segmentAt } from './browser-recording-playback'

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(2)
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const mediaUrl = (key: string): string => `/api/recording/media?mediaKey=${key}`
it('seeks into exact segments and asks at the selected time without any runtime', async () => {
  const ask = vi.fn()
  render(
    <BrowserRecordingPlayer
      recording={browserRecordingFixture()}
      mediaUrl={mediaUrl}
      onAskMoment={ask}
    />
  )
  fireEvent.change(screen.getByRole('slider'), { target: { value: '3200' } })
  const video = screen.getByLabelText('Recorded webpage') as HTMLVideoElement
  expect(video.getAttribute('src')).toBe('/api/recording/media?mediaKey=media-1')
  fireEvent.loadedMetadata(video)
  fireEvent.loadedData(video)
  expect(video.currentTime).toBe(1.2)
  fireEvent.click(screen.getByRole('button', { name: 'Ask about this moment' }))
  await act(async () => {})
  expect(ask).toHaveBeenCalledWith(3200)
  expect(document.querySelector('iframe')).toBeNull()
})
it('does not retain an earlier image over an unrecorded interval or allow citing a gap', () => {
  render(
    <BrowserRecordingPlayer
      recording={browserRecordingFixture()}
      mediaUrl={mediaUrl}
      onAskMoment={vi.fn()}
    />
  )
  fireEvent.change(screen.getByRole('slider'), { target: { value: '4500' } })
  expect(screen.getByText('Recording was paused at this time.')).toBeTruthy()
  expect(screen.queryByLabelText('Recorded webpage')).toBeNull()
  expect(
    screen.getByRole('button', { name: 'Ask about this moment' }).hasAttribute('disabled')
  ).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Go to next recorded moment' }))
  expect(screen.getByRole('slider').getAttribute('value')).toBe('5000')
})
it('advances contiguous media but stops at a recording gap', async () => {
  render(<BrowserRecordingPlayer recording={browserRecordingFixture()} mediaUrl={mediaUrl} />)
  fireEvent.click(screen.getByRole('button', { name: 'Play replay' }))
  await act(async () => {})
  fireEvent.ended(screen.getByLabelText('Recorded webpage'))
  expect(screen.getByLabelText('Recorded webpage').getAttribute('src')).toContain('media-1')
  expect(screen.getByRole('button', { name: 'Pause replay' })).toBeTruthy()
  fireEvent.ended(screen.getByLabelText('Recorded webpage'))
  expect(screen.getByText('Recording was paused at this time.')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Play replay' })).toBeTruthy()
})
it('unloads media when inactive and returns paused at the same time', async () => {
  const recording = browserRecordingFixture()
  const { rerender } = render(<BrowserRecordingPlayer recording={recording} mediaUrl={mediaUrl} />)
  fireEvent.change(screen.getByRole('slider'), { target: { value: '1500' } })
  fireEvent.click(screen.getByRole('button', { name: 'Play replay' }))
  await act(async () => {})
  const element = screen.getByLabelText('Recorded webpage')
  rerender(<BrowserRecordingPlayer recording={recording} mediaUrl={mediaUrl} active={false} />)
  expect(element.hasAttribute('src')).toBe(false)
  expect(screen.queryByLabelText('Recorded webpage')).toBeNull()
  rerender(<BrowserRecordingPlayer recording={recording} mediaUrl={mediaUrl} active />)
  expect(screen.getByRole('slider').getAttribute('value')).toBe('1500')
  expect(screen.getByRole('button', { name: 'Play replay' })).toBeTruthy()
})
it('keeps exact end-exclusive segment boundaries and resets when source identity changes', () => {
  const recording = browserRecordingFixture()
  expect(segmentAt(recording, 2000)?.segmentId).toBe('segment-1')
  expect(segmentAt(recording, 4000)).toBeUndefined()
  const { rerender } = render(<BrowserRecordingPlayer recording={recording} mediaUrl={mediaUrl} />)
  fireEvent.change(screen.getByRole('slider'), { target: { value: '3200' } })
  rerender(
    <BrowserRecordingPlayer
      recording={{ ...recording, recordingId: 'another' }}
      mediaUrl={mediaUrl}
    />
  )
  expect(screen.getByRole('slider').getAttribute('value')).toBe('0')
})
it('advances over a small encoder boundary without inventing frames, but preserves explicit gaps', () => {
  const recording = browserRecordingFixture()
  recording.segments[1].startMs += 4
  render(<BrowserRecordingPlayer recording={recording} mediaUrl={mediaUrl} />)
  fireEvent.ended(screen.getByLabelText('Recorded webpage'))
  expect(screen.getByRole('slider').getAttribute('value')).toBe('2004')
  expect(screen.getByLabelText('Recorded webpage').getAttribute('src')).toContain('media-1')
})
it('starts at the first captured timestamp and releases media when the browser tab is hidden', () => {
  const recording = browserRecordingFixture()
  recording.segments[0].startMs = 24
  render(<BrowserRecordingPlayer recording={recording} mediaUrl={mediaUrl} />)
  expect(screen.getByRole('slider').getAttribute('value')).toBe('24')
  const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  fireEvent(document, new Event('visibilitychange'))
  expect(screen.queryByLabelText('Recorded webpage')).toBeNull()
  visible.mockReturnValue('visible')
  fireEvent(document, new Event('visibilitychange'))
  expect(screen.getByLabelText('Recorded webpage')).toBeTruthy()
  expect(screen.getByRole('slider').getAttribute('value')).toBe('24')
  expect(screen.getByRole('button', { name: 'Play replay' })).toBeTruthy()
})
it('uses the newest visibility record when a hidden iframe becomes visible in one observer batch', () => {
  let deliver: (entries: IntersectionObserverEntry[]) => void = () => undefined
  let target: Element
  class Observer implements IntersectionObserver {
    readonly root = null
    readonly rootMargin = '0px'
    readonly scrollMargin = '0px'
    readonly thresholds = [0]
    constructor(callback: IntersectionObserverCallback) {
      deliver = (entries) => callback(entries, this)
    }
    observe(element: Element): void {
      target = element
    }
    unobserve = vi.fn()
    disconnect = vi.fn()
    takeRecords(): IntersectionObserverEntry[] {
      return []
    }
  }
  vi.stubGlobal('IntersectionObserver', Observer)
  render(<BrowserRecordingPlayer recording={browserRecordingFixture()} mediaUrl={mediaUrl} />)
  const entry = (visible: boolean, time: number, element = target): IntersectionObserverEntry =>
    ({ target: element, isIntersecting: visible, time }) as IntersectionObserverEntry
  act(() => deliver([entry(false, 1), entry(true, 2)]))
  expect(screen.getByLabelText('Recorded webpage')).toBeTruthy()
  // Ignore an older entry or an entry for another observed surface, even if listed last.
  act(() => deliver([entry(true, 4), entry(false, 3), entry(false, 5, document.body)]))
  expect(screen.getByLabelText('Recorded webpage')).toBeTruthy()
  act(() => deliver([entry(true, 6), entry(false, 6)]))
  expect(screen.queryByLabelText('Recorded webpage')).toBeNull()
  act(() => deliver([entry(false, 7), entry(true, 8)]))
  expect(screen.getByLabelText('Recorded webpage')).toBeTruthy()
})
it('resynchronizes visibility when the document is shown before passive effects subscribe', () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  function ShowDuringCommit(): null {
    useLayoutEffect(() => {
      visibility.mockReturnValue('visible')
      document.dispatchEvent(new Event('visibilitychange'))
    }, [])
    return null
  }
  render(
    <>
      <BrowserRecordingPlayer recording={browserRecordingFixture()} mediaUrl={mediaUrl} />
      <ShowDuringCommit />
    </>
  )
  expect(screen.getByLabelText('Recorded webpage')).toBeTruthy()
})
it('distinguishes unavailable receiving media from activity that was never recorded', () => {
  render(<BrowserRecordingPlayer recording={browserRecordingFixture()} mediaUrl={() => null} />)
  expect(screen.getByText('Could not read the recorded material.')).toBeTruthy()
  expect(screen.queryByText('No webpage footage was recorded at this time.')).toBeNull()
})
it('pauses before asking and cites the actual media time between sparse timeupdate events', async () => {
  const ask = vi.fn()
  render(
    <BrowserRecordingPlayer
      recording={browserRecordingFixture()}
      mediaUrl={mediaUrl}
      onAskMoment={ask}
    />
  )
  fireEvent.change(screen.getByRole('slider'), { target: { value: '3200' } })
  const video = screen.getByLabelText('Recorded webpage') as HTMLVideoElement
  Object.defineProperty(video, 'readyState', { configurable: true, value: 2 })
  fireEvent.loadedMetadata(video)
  fireEvent.loadedData(video)
  fireEvent.click(screen.getByRole('button', { name: 'Play replay' }))
  await act(async () => {})
  video.currentTime = 1.375
  // The media has advanced 175 ms since the last React timeline update.
  expect(screen.getByRole('slider').getAttribute('value')).toBe('3200')
  const pause = vi.mocked(HTMLMediaElement.prototype.pause)
  pause.mockClear()
  fireEvent.click(screen.getByRole('button', { name: 'Ask about this moment' }))
  await act(async () => {})
  expect(ask).toHaveBeenCalledWith(3375)
  expect(pause.mock.invocationCallOrder[0]).toBeLessThan(ask.mock.invocationCallOrder[0])
  expect(screen.getByRole('slider').getAttribute('value')).toBe('3375')
  expect(screen.getByRole('button', { name: 'Play replay' })).toBeTruthy()
})
it('distinguishes host observations, browser interactions and author declarations', () => {
  const recording = browserRecordingFixture()
  recording.events = [
    { eventId: 'host', offsetMs: 0, kind: 'navigation', source: 'host-observed' },
    { eventId: 'browser', offsetMs: 1000, kind: 'click', source: 'browser-observed' },
    { eventId: 'author', offsetMs: 1500, kind: 'author', source: 'author-declared' }
  ]
  render(<BrowserRecordingPlayer recording={recording} mediaUrl={mediaUrl} />)
  fireEvent.click(screen.getByText('Recorded actions and events'))
  expect(screen.getByText(/navigation · Host-observed event/)).toBeTruthy()
  expect(screen.getByText(/click · Browser-observed action/)).toBeTruthy()
  expect(screen.getByText(/author · Author-declared event/)).toBeTruthy()
})

it('reserves the viewport and holds one bounded decoded frame only while the next segment loads', () => {
  vi.useFakeTimers()
  const drawImage = vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage
  } as unknown as CanvasRenderingContext2D)
  const recording = browserRecordingFixture()
  const { unmount } = render(
    <BrowserRecordingPlayer recording={recording} mediaUrl={mediaUrl} onAskMoment={vi.fn()} />
  )
  const first = screen.getByLabelText('Recorded webpage') as HTMLVideoElement
  Object.defineProperties(first, {
    readyState: { configurable: true, value: 2 },
    videoWidth: { configurable: true, value: 3840 },
    videoHeight: { configurable: true, value: 2160 }
  })
  fireEvent.loadedMetadata(first)
  fireEvent.loadedData(first)
  fireEvent.click(screen.getByRole('button', { name: 'Play replay' }))
  first.currentTime = 1.999
  fireEvent.timeUpdate(first)
  fireEvent.ended(first)
  const canvas = screen.getByTestId('held-recorded-frame') as HTMLCanvasElement
  expect(canvas.width).toBe(1280)
  expect(canvas.height).toBe(720)
  expect(drawImage).toHaveBeenCalledWith(first, 0, 0, 1280, 720)
  expect(canvas.hidden).toBe(false)
  expect(screen.getByTestId('recorded-video-surface').style.aspectRatio).toBe('1280 / 720')
  expect(screen.queryByTestId('recorded-segment-loading')).toBeNull()
  act(() => vi.advanceTimersByTime(180))
  expect(screen.getByTestId('recorded-segment-loading').className).toContain('bottom-3')
  expect(screen.getByRole('slider').getAttribute('value')).toBe('1999')
  expect(
    screen.getByRole('button', { name: 'Ask about this moment' }).hasAttribute('disabled')
  ).toBe(false)
  const second = screen.getByLabelText('Recorded webpage') as HTMLVideoElement
  fireEvent.loadedMetadata(second)
  expect(canvas.hidden).toBe(false)
  second.currentTime = 0.3
  fireEvent.timeUpdate(second)
  expect(screen.getByRole('slider').getAttribute('value')).toBe('1999')
  fireEvent.loadedData(second)
  expect(screen.queryByTestId('recorded-segment-loading')).toBeNull()
  expect(canvas.width).toBe(0)
  expect(canvas.height).toBe(0)
  expect(canvas.hidden).toBe(true)
  fireEvent.ended(second)
  expect((screen.getByTestId('held-recorded-frame') as HTMLCanvasElement).hidden).toBe(true)
  expect(screen.getByText('Recording was paused at this time.')).toBeTruthy()
  unmount()
  expect(canvas.width).toBe(0)
})

it('waits for the remounted video to decode even if two segments resolve to the same media URL', async () => {
  render(
    <BrowserRecordingPlayer
      recording={browserRecordingFixture()}
      mediaUrl={() => '/recorded/shared.webm'}
      onAskMoment={vi.fn()}
    />
  )
  const first = screen.getByLabelText('Recorded webpage')
  fireEvent.loadedMetadata(first)
  fireEvent.loadedData(first)
  fireEvent.click(screen.getByRole('button', { name: 'Play replay' }))
  await act(async () => {})
  const play = vi.mocked(HTMLMediaElement.prototype.play)
  play.mockClear()
  fireEvent.ended(first)
  const second = screen.getByLabelText('Recorded webpage')
  expect(second).not.toBe(first)
  expect(screen.queryByTestId('recorded-segment-loading')).toBeNull()
  expect(
    screen.getByRole('button', { name: 'Ask about this moment' }).hasAttribute('disabled')
  ).toBe(true)
  expect(play).not.toHaveBeenCalled()
  fireEvent.loadedMetadata(second)
  fireEvent.loadedData(second)
  await act(async () => {})
  expect(screen.queryByTestId('recorded-segment-loading')).toBeNull()
  expect(play).toHaveBeenCalledTimes(1)
  expect(play.mock.contexts[0]).toBe(second)
})

it('uses the research transport without a second clock or transport controls', async () => {
  const recording = browserRecordingFixture()
  const onSeek = vi.fn()
  const { rerender } = render(
    <BrowserRecordingPlayer
      recording={recording}
      mediaUrl={mediaUrl}
      transport={{ offsetMs: 1200, playing: true, speed: 1.5, onSeek }}
    />
  )
  expect(screen.queryByRole('slider')).toBeNull()
  expect(screen.queryByRole('combobox')).toBeNull()
  expect(screen.queryByRole('button', { name: /(?:Play|Pause) replay/ })).toBeNull()
  const video = screen.getByLabelText('Recorded webpage') as HTMLVideoElement
  Object.defineProperty(video, 'readyState', { configurable: true, value: 2 })
  fireEvent.loadedMetadata(video)
  fireEvent.loadedData(video)
  await act(async () => {})
  expect(video.currentTime).toBe(1.2)
  expect(video.playbackRate).toBe(1.5)
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalled()
  video.currentTime = 1.9
  fireEvent.timeUpdate(video)
  fireEvent.ended(video)
  expect(screen.getByLabelText('Recorded webpage')).toBe(video)
  expect(onSeek).not.toHaveBeenCalled()
  rerender(
    <BrowserRecordingPlayer
      recording={recording}
      mediaUrl={mediaUrl}
      transport={{ offsetMs: 500, playing: false, speed: 2, onSeek }}
    />
  )
  expect(video.currentTime).toBe(0.5)
  expect(video.playbackRate).toBe(2)
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled()
})

it('settles controlled seeks and pauses exactly without seeking on every playback tick', () => {
  const recording = browserRecordingFixture()
  const onSeek = vi.fn()
  const props = { recording, mediaUrl, onAskMoment: vi.fn() }
  const { rerender } = render(
    <BrowserRecordingPlayer
      {...props}
      transport={{ offsetMs: 1000, playing: true, speed: 1, onSeek }}
    />
  )
  const video = screen.getByLabelText('Recorded webpage') as HTMLVideoElement
  Object.defineProperty(video, 'readyState', { configurable: true, value: 2 })
  fireEvent.loadedMetadata(video)
  fireEvent.loadedData(video)
  video.currentTime = 1.03
  rerender(
    <BrowserRecordingPlayer
      {...props}
      transport={{ offsetMs: 1100, playing: true, speed: 1, onSeek }}
    />
  )
  expect(video.currentTime).toBe(1.03)
  expect(screen.queryByTestId('recorded-segment-loading')).toBeNull()
  rerender(
    <BrowserRecordingPlayer
      {...props}
      transport={{ offsetMs: 1700, playing: false, speed: 1, onSeek }}
    />
  )
  expect(video.currentTime).toBe(1.7)
  expect(screen.queryByTestId('recorded-segment-loading')).toBeNull()
  expect(
    screen.getByRole('button', { name: 'Ask about this moment' }).hasAttribute('disabled')
  ).toBe(true)
  fireEvent.seeked(video)
  expect(screen.queryByTestId('recorded-segment-loading')).toBeNull()
  expect(
    screen.getByRole('button', { name: 'Ask about this moment' }).hasAttribute('disabled')
  ).toBe(false)
})

it('follows exact master segment boundaries and never carries footage into gaps or out of range', () => {
  const recording = browserRecordingFixture()
  const onSeek = vi.fn()
  const props = { recording, mediaUrl, onAskMoment: vi.fn() }
  const { rerender } = render(
    <BrowserRecordingPlayer
      {...props}
      transport={{ offsetMs: 1000, playing: true, speed: 1, onSeek }}
    />
  )
  rerender(
    <BrowserRecordingPlayer
      {...props}
      transport={{ offsetMs: 3200, playing: true, speed: 1, onSeek }}
    />
  )
  const video = screen.getByLabelText('Recorded webpage') as HTMLVideoElement
  fireEvent.loadedMetadata(video)
  expect(video.getAttribute('src')).toContain('media-1')
  expect(video.currentTime).toBe(1.2)
  for (const offsetMs of [-200, 4500, 7000]) {
    rerender(
      <BrowserRecordingPlayer
        {...props}
        transport={{ offsetMs, playing: true, speed: 1, onSeek }}
      />
    )
    expect(screen.queryByLabelText('Recorded webpage')).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Ask about this moment' }).hasAttribute('disabled')
    ).toBe(true)
    expect(
      screen.getByText(
        offsetMs === 4500
          ? 'Recording was paused at this time.'
          : 'No webpage footage was recorded at this time.'
      )
    ).toBeTruthy()
  }
  expect(onSeek).not.toHaveBeenCalled()
})

it('requests master seeks for recorded events, gaps, and the actual decoded moment', async () => {
  const recording = browserRecordingFixture()
  const onSeek = vi.fn()
  const ask = vi.fn()
  const props = { recording, mediaUrl, onAskMoment: ask }
  const { rerender } = render(
    <BrowserRecordingPlayer
      {...props}
      transport={{ offsetMs: 4500, playing: true, speed: 1, onSeek }}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Go to next recorded moment' }))
  expect(onSeek).toHaveBeenLastCalledWith(5000)
  expect(screen.queryByLabelText('Recorded webpage')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Start · Host-observed event/ }))
  expect(onSeek).toHaveBeenLastCalledWith(1500)
  rerender(
    <BrowserRecordingPlayer
      {...props}
      transport={{ offsetMs: 1500, playing: true, speed: 1, onSeek }}
    />
  )
  const video = screen.getByLabelText('Recorded webpage') as HTMLVideoElement
  Object.defineProperty(video, 'readyState', { configurable: true, value: 2 })
  fireEvent.loadedMetadata(video)
  fireEvent.loadedData(video)
  video.currentTime = 1.612
  onSeek.mockClear()
  fireEvent.click(screen.getByRole('button', { name: 'Ask about this moment' }))
  await act(async () => {})
  expect(onSeek).toHaveBeenCalledWith(1612)
  expect(ask).toHaveBeenCalledWith(1612)
  expect(onSeek.mock.invocationCallOrder[0]).toBeLessThan(ask.mock.invocationCallOrder[0])
})

it('does not invent alignment or offer autonomous playback when no time anchor exists', () => {
  const onSeek = vi.fn()
  render(
    <BrowserRecordingPlayer
      recording={browserRecordingFixture()}
      mediaUrl={mediaUrl}
      transport={{ offsetMs: undefined, playing: true, speed: 1, onSeek }}
    />
  )
  expect(
    screen.getByText('This recording cannot be aligned with the research replay timeline.')
  ).toBeTruthy()
  expect(screen.queryByLabelText('Recorded webpage')).toBeNull()
  expect(screen.queryByRole('slider')).toBeNull()
  const event = screen.getByRole('button', { name: /Start · Host-observed event/ })
  expect(event.hasAttribute('disabled')).toBe(true)
  fireEvent.click(event)
  expect(onSeek).not.toHaveBeenCalled()
})

it('holds a referenceable decoded poster at a controlled segment transition until the new frame decodes', () => {
  const drawImage = vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage
  } as unknown as CanvasRenderingContext2D)
  const recording = browserRecordingFixture()
  const onSeek = vi.fn()
  const props = { recording, mediaUrl, onAskMoment: vi.fn() }
  const { rerender } = render(
    <BrowserRecordingPlayer
      {...props}
      transport={{ offsetMs: 1900, playing: true, speed: 1, onSeek }}
    />
  )
  const first = screen.getByLabelText('Recorded webpage') as HTMLVideoElement
  Object.defineProperties(first, {
    readyState: { configurable: true, value: 2 },
    videoWidth: { configurable: true, value: 1280 },
    videoHeight: { configurable: true, value: 720 }
  })
  fireEvent.loadedMetadata(first)
  fireEvent.loadedData(first)
  first.currentTime = 1.999
  rerender(
    <BrowserRecordingPlayer
      {...props}
      transport={{ offsetMs: 2030, playing: true, speed: 1, onSeek }}
    />
  )
  const canvas = screen.getByTestId('held-recorded-frame') as HTMLCanvasElement
  expect(drawImage).toHaveBeenCalledWith(first, 0, 0, 1280, 720)
  expect(canvas.hidden).toBe(false)
  expect(
    screen.getByRole('button', { name: 'Ask about this moment' }).hasAttribute('disabled')
  ).toBe(false)
  const second = screen.getByLabelText('Recorded webpage') as HTMLVideoElement
  fireEvent.loadedMetadata(second)
  expect(second.currentTime).toBe(0.03)
  fireEvent.loadedData(second)
  expect(canvas.hidden).toBe(true)
  expect(canvas.width).toBe(0)
})

it('ignores an interrupted play promise after a controlled pause or seek', async () => {
  let rejectPlay!: (reason: unknown) => void
  vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        rejectPlay = reject
      })
  )
  const recording = browserRecordingFixture()
  const onSeek = vi.fn()
  const { rerender } = render(
    <BrowserRecordingPlayer
      recording={recording}
      mediaUrl={mediaUrl}
      transport={{ offsetMs: 1000, playing: true, speed: 1, onSeek }}
    />
  )
  const video = screen.getByLabelText('Recorded webpage') as HTMLVideoElement
  Object.defineProperty(video, 'readyState', { configurable: true, value: 2 })
  fireEvent.loadedMetadata(video)
  fireEvent.loadedData(video)
  rerender(
    <BrowserRecordingPlayer
      recording={recording}
      mediaUrl={mediaUrl}
      transport={{ offsetMs: 1500, playing: false, speed: 1, onSeek }}
    />
  )
  await act(async () => {
    rejectPlay(new DOMException('Playback was interrupted', 'AbortError'))
  })
  expect(screen.queryByText('Could not play the recorded footage.')).toBeNull()
  fireEvent.seeked(video)
  expect(screen.queryByTestId('recorded-segment-loading')).toBeNull()
})

it('releases a departing controlled segment even when its successor uses the same media URL', () => {
  const recording = browserRecordingFixture()
  const onSeek = vi.fn()
  const sharedUrl = (): string => '/recorded/shared.webm'
  const { rerender } = render(
    <BrowserRecordingPlayer
      recording={recording}
      mediaUrl={sharedUrl}
      transport={{ offsetMs: 1900, playing: true, speed: 1, onSeek }}
    />
  )
  const first = screen.getByLabelText('Recorded webpage') as HTMLVideoElement
  fireEvent.loadedMetadata(first)
  fireEvent.loadedData(first)
  const pause = vi.mocked(HTMLMediaElement.prototype.pause)
  const load = vi.mocked(HTMLMediaElement.prototype.load)
  pause.mockClear()
  load.mockClear()
  rerender(
    <BrowserRecordingPlayer
      recording={recording}
      mediaUrl={sharedUrl}
      transport={{ offsetMs: 2050, playing: true, speed: 1, onSeek }}
    />
  )
  expect(screen.getByLabelText('Recorded webpage')).not.toBe(first)
  expect(first.hasAttribute('src')).toBe(false)
  expect(pause.mock.contexts).toContain(first)
  expect(load.mock.contexts).toContain(first)
  const second = screen.getByLabelText('Recorded webpage')
  pause.mockClear()
  load.mockClear()
  rerender(
    <BrowserRecordingPlayer
      recording={recording}
      mediaUrl={sharedUrl}
      transport={{ offsetMs: 2100, playing: true, speed: 1, onSeek }}
    />
  )
  expect(screen.getByLabelText('Recorded webpage')).toBe(second)
  expect(load).not.toHaveBeenCalled()
  expect(second.getAttribute('src')).toBe('/recorded/shared.webm')
})

it('keeps a failed or retried recording moment unavailable until a fresh frame decodes', () => {
  const onAskMoment = vi.fn()
  render(
    <BrowserRecordingPlayer
      recording={browserRecordingFixture()}
      mediaUrl={mediaUrl}
      onAskMoment={onAskMoment}
      transport={{ offsetMs: 1200, playing: false, speed: 1, onSeek: vi.fn() }}
    />
  )
  const video = screen.getByLabelText('Recorded webpage') as HTMLVideoElement
  Object.defineProperty(video, 'readyState', { configurable: true, value: 2 })
  fireEvent.loadedMetadata(video)
  fireEvent.loadedData(video)
  const ask = screen.getByRole('button', { name: 'Ask about this moment' })
  expect(ask.hasAttribute('disabled')).toBe(false)
  fireEvent.error(video)
  expect(ask.hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(screen.queryByText('Could not play the recorded footage.')).toBeNull()
  expect(screen.queryByTestId('recorded-segment-loading')).toBeNull()
  expect(ask.hasAttribute('disabled')).toBe(true)
  fireEvent.click(ask)
  expect(onAskMoment).not.toHaveBeenCalled()
  fireEvent.loadedMetadata(video)
  expect(ask.hasAttribute('disabled')).toBe(true)
  fireEvent.loadedData(video)
  expect(ask.hasAttribute('disabled')).toBe(false)
})

it('registers the research footer action with current decoded time and revokes it across gaps', async () => {
  const recording = browserRecordingFixture()
  const ask = vi.fn()
  const onSeek = vi.fn()
  const onActionChange = vi.fn()
  const props = {
    recording,
    mediaUrl,
    onAskMoment: ask,
    presentationMode: 'research' as const,
    onActionChange
  }
  const { rerender, unmount } = render(
    <BrowserRecordingPlayer
      {...props}
      transport={{ offsetMs: 1000, playing: false, speed: 1, onSeek }}
    />
  )
  expect(screen.queryByRole('button', { name: 'Ask about this moment' })).toBeNull()
  expect(onActionChange.mock.lastCall?.[0].disabled).toBe(true)
  const video = screen.getByLabelText('Recorded webpage') as HTMLVideoElement
  fireEvent.loadedMetadata(video)
  fireEvent.loadedData(video)
  const action = onActionChange.mock.lastCall?.[0]
  expect(action.disabled).toBe(false)
  video.currentTime = 1.346
  await act(async () => action.onAsk())
  expect(ask).toHaveBeenCalledWith(1346)
  ask.mockClear()
  rerender(
    <BrowserRecordingPlayer
      {...props}
      transport={{ offsetMs: 4500, playing: false, speed: 1, onSeek }}
    />
  )
  expect(onActionChange.mock.lastCall?.[0].disabled).toBe(true)
  await act(async () => action.onAsk())
  expect(ask).not.toHaveBeenCalled()
  unmount()
  expect(onActionChange).toHaveBeenLastCalledWith(undefined)
})

it('disables a buffered or seeking frame and restores it only after decoding resumes', () => {
  render(
    <BrowserRecordingPlayer
      recording={browserRecordingFixture()}
      mediaUrl={mediaUrl}
      onAskMoment={vi.fn()}
    />
  )
  const video = screen.getByLabelText('Recorded webpage')
  fireEvent.loadedMetadata(video)
  fireEvent.loadedData(video)
  const ask = screen.getByRole('button', { name: 'Ask about this moment' })
  expect(ask.hasAttribute('disabled')).toBe(false)
  fireEvent.waiting(video)
  expect(ask.hasAttribute('disabled')).toBe(true)
  fireEvent.canPlay(video)
  expect(ask.hasAttribute('disabled')).toBe(false)
  fireEvent.seeking(video)
  expect(ask.hasAttribute('disabled')).toBe(true)
  fireEvent.seeked(video)
  expect(ask.hasAttribute('disabled')).toBe(false)
})

it('uses decoded native dimensions and does not reload media when changing fit mode', () => {
  render(
    <BrowserRecordingPlayer
      recording={browserRecordingFixture()}
      mediaUrl={mediaUrl}
      presentationMode="research"
    />
  )
  const video = screen.getByLabelText('Recorded webpage') as HTMLVideoElement
  Object.defineProperties(video, {
    videoWidth: { configurable: true, value: 540 },
    videoHeight: { configurable: true, value: 960 }
  })
  fireEvent.loadedMetadata(video)
  fireEvent.loadedData(video)
  vi.mocked(HTMLMediaElement.prototype.load).mockClear()
  fireEvent.click(screen.getByRole('button', { name: 'Actual size (100%)' }))
  expect(screen.getByTestId('recorded-video-surface').style.width).toBe('540px')
  expect(screen.getByTestId('recorded-video-surface').style.height).toBe('960px')
  Object.defineProperties(video, {
    videoWidth: { configurable: true, value: 1920 },
    videoHeight: { configurable: true, value: 1080 }
  })
  fireEvent(video, new Event('resize'))
  expect(screen.getByTestId('recorded-video-surface').style.width).toBe('1920px')
  fireEvent.click(screen.getByRole('button', { name: 'Fit to window' }))
  expect(screen.getByLabelText('Recorded webpage')).toBe(video)
  expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled()
})

it('pauses the research clock on decode failure and retries the same source, time, speed and size', () => {
  const recording = browserRecordingFixture()
  const onSeek = vi.fn()
  const onPlaybackError = vi.fn()
  const props = {
    recording,
    mediaUrl,
    onPlaybackError,
    presentationMode: 'research' as const,
    transport: { offsetMs: 3200, playing: true, speed: 1.5, onSeek }
  }
  const { rerender } = render(<BrowserRecordingPlayer {...props} />)
  const video = screen.getByLabelText('Recorded webpage') as HTMLVideoElement
  fireEvent.loadedMetadata(video)
  fireEvent.loadedData(video)
  fireEvent.click(screen.getByRole('button', { name: 'Actual size (100%)' }))
  fireEvent.error(video)
  expect(onSeek).toHaveBeenCalledExactlyOnceWith(3200)
  expect(onPlaybackError).toHaveBeenCalledTimes(1)
  rerender(<BrowserRecordingPlayer {...props} transport={{ ...props.transport, playing: false }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  fireEvent.loadedMetadata(video)
  expect(screen.getByLabelText('Recorded webpage')).toBe(video)
  expect(video.getAttribute('src')).toContain('media-1')
  expect(video.currentTime).toBe(1.2)
  expect(video.playbackRate).toBe(1.5)
  expect(screen.getByTestId('recorded-media-scroll').dataset.sizeMode).toBe('actual')
  expect(onSeek).toHaveBeenCalledTimes(1)
})

it('pauses through the transport callback when playback is rejected, then recovers in place', async () => {
  vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new Error('decoder unavailable'))
  const onPause = vi.fn(),
    onSeek = vi.fn(),
    onPlaybackError = vi.fn()
  const recording = browserRecordingFixture()
  const props = {
    recording,
    mediaUrl,
    onPlaybackError,
    transport: { offsetMs: 1200, playing: true, speed: 2, onPause, onSeek }
  }
  const { rerender } = render(<BrowserRecordingPlayer {...props} />)
  const video = screen.getByLabelText('Recorded webpage') as HTMLVideoElement
  fireEvent.loadedMetadata(video)
  fireEvent.loadedData(video)
  await act(async () => {})
  expect(onPause).toHaveBeenCalledTimes(1)
  expect(onSeek).not.toHaveBeenCalled()
  expect(onPlaybackError).toHaveBeenCalledTimes(1)
  rerender(<BrowserRecordingPlayer {...props} active={false} />)
  rerender(
    <BrowserRecordingPlayer
      {...props}
      retryRevision={1}
      transport={{ ...props.transport, playing: false }}
    />
  )
  const recovered = screen.getByLabelText('Recorded webpage') as HTMLVideoElement
  fireEvent.loadedMetadata(recovered)
  fireEvent.loadedData(recovered)
  expect(onPlaybackError).toHaveBeenCalledTimes(1)
  expect(screen.queryByText('Could not play the recorded footage.')).toBeNull()
  expect(recovered.currentTime).toBe(1.2)
  expect(recovered.playbackRate).toBe(2)
})

it('distinguishes explicitly absent media from retryable access failures without changing the time', () => {
  const onPause = vi.fn(),
    onPlaybackError = vi.fn()
  const recording = browserRecordingFixture()
  const props = {
    recording,
    mediaUrl: () => null,
    onPlaybackError,
    transport: { offsetMs: 1200, playing: true, speed: 1, onPause, onSeek: vi.fn() }
  }
  const { rerender } = render(<BrowserRecordingPlayer {...props} missingMediaKeys={['media-0']} />)
  expect(screen.getByText('This recorded media file is not included.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  expect(onPause).toHaveBeenCalledTimes(1)
  expect(onPlaybackError).not.toHaveBeenCalled()
  rerender(<BrowserRecordingPlayer {...props} missingMediaKeys={[]} />)
  expect(screen.getByText('Could not read the recorded material.')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  expect(onPlaybackError).toHaveBeenCalledTimes(1)
})

it('does not apply an old playback rejection to a new segment', async () => {
  let reject!: (error: Error) => void
  vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail
      })
  )
  const recording = browserRecordingFixture(),
    onPlaybackError = vi.fn(),
    onSeek = vi.fn()
  const props = { recording, mediaUrl, onPlaybackError }
  const { rerender } = render(
    <BrowserRecordingPlayer
      {...props}
      transport={{ offsetMs: 1200, playing: true, speed: 1, onSeek }}
    />
  )
  const first = screen.getByLabelText('Recorded webpage')
  fireEvent.loadedMetadata(first)
  fireEvent.loadedData(first)
  rerender(
    <BrowserRecordingPlayer
      {...props}
      transport={{ offsetMs: 3200, playing: true, speed: 1, onSeek }}
    />
  )
  await act(async () => reject(new Error('old source')))
  expect(screen.getByLabelText('Recorded webpage').getAttribute('src')).toContain('media-1')
  expect(screen.queryByText('Could not play the recorded footage.')).toBeNull()
  expect(onPlaybackError).not.toHaveBeenCalled()
  expect(onSeek).not.toHaveBeenCalled()
})

it('publishes decoded media time for the footer and withdraws it while buffering', () => {
  const onActionChange = vi.fn(),
    recording = browserRecordingFixture()
  recording.title = 'Recorded experiment'
  render(
    <BrowserRecordingPlayer
      recording={recording}
      mediaUrl={mediaUrl}
      presentationMode="research"
      onActionChange={onActionChange}
      onAskMoment={vi.fn()}
      transport={{ offsetMs: 1200, playing: false, speed: 1, onSeek: vi.fn() }}
    />
  )
  const video = screen.getByLabelText('Recorded webpage') as HTMLVideoElement
  fireEvent.loadedMetadata(video)
  fireEvent.loadedData(video)
  video.currentTime = 1.346
  fireEvent.timeUpdate(video)
  expect(onActionChange.mock.lastCall?.[0]).toMatchObject({
    recordedAt: 2346,
    title: 'Recorded experiment',
    disabled: false
  })
  fireEvent.waiting(video)
  expect(onActionChange.mock.lastCall?.[0]).toMatchObject({ recordedAt: undefined, disabled: true })
})

it('updates footer timestamps without transiently withdrawing the action and clears stale callbacks on unmount', async () => {
  const onActionChange = vi.fn(),
    onAskMoment = vi.fn()
  const { unmount } = render(
    <BrowserRecordingPlayer
      recording={browserRecordingFixture()}
      mediaUrl={mediaUrl}
      onActionChange={onActionChange}
      onAskMoment={onAskMoment}
    />
  )
  const video = screen.getByLabelText('Recorded webpage') as HTMLVideoElement
  fireEvent.loadedData(video)
  const action = onActionChange.mock.lastCall?.[0]
  onActionChange.mockClear()
  for (const time of [0.2, 0.4, 0.6]) {
    video.currentTime = time
    fireEvent.timeUpdate(video)
  }
  expect(onActionChange.mock.calls.map(([value]) => value?.recordedAt)).toEqual([1200, 1400, 1600])
  expect(onActionChange.mock.calls.every(([value]) => value && !value.disabled)).toBe(true)
  unmount()
  expect(onActionChange).toHaveBeenLastCalledWith(undefined)
  await act(async () => action.onAsk())
  expect(onAskMoment).not.toHaveBeenCalled()
})

it.each(['hole', 'next-loading', 'drift'] as const)(
  'asks about the actual displayed held frame during %s, never the clock or undecoded target',
  async (kind) => {
    mockCanvas()
    const recording = browserRecordingFixture()
    recording.segments[1].startMs = 2130
    const onAskMoment = vi.fn(),
      onSeek = vi.fn(),
      onActionChange = vi.fn()
    const props = {
      recording,
      mediaUrl,
      onAskMoment,
      onActionChange,
      presentationMode: 'research' as const
    }
    const transport = (offsetMs: number): BrowserRecordingTransport => ({
      offsetMs,
      playing: true,
      speed: 1,
      onSeek
    })
    const { rerender } = render(
      <BrowserRecordingPlayer {...props} transport={transport(kind === 'drift' ? 500 : 1900)} />
    )
    const video = screen.getByLabelText('Recorded webpage') as HTMLVideoElement
    decodedVideo(video)
    video.currentTime = kind === 'drift' ? 0.4 : 1.999
    fireEvent.timeUpdate(video)
    const initialCalls = onActionChange.mock.calls.length
    rerender(
      <BrowserRecordingPlayer {...props} transport={transport(kind === 'drift' ? 700 : 2010)} />
    )
    if (kind === 'next-loading')
      rerender(<BrowserRecordingPlayer {...props} transport={transport(2140)} />)
    const canvas = screen.getByTestId('held-recorded-frame') as HTMLCanvasElement
    expect(canvas.hidden).toBe(false)
    const moment = kind === 'drift' ? 400 : 1999
    const action = onActionChange.mock.lastCall?.[0]
    expect(action).toMatchObject({ disabled: false, recordedAt: recording.startedAt + moment })
    expect(
      onActionChange.mock.calls.slice(initialCalls).every(([value]) => value && !value.disabled)
    ).toBe(true)
    await act(async () => action.onAsk())
    expect(onSeek).toHaveBeenCalledExactlyOnceWith(moment)
    expect(onAskMoment).toHaveBeenCalledExactlyOnceWith(moment)
    expect(onSeek.mock.invocationCallOrder[0]).toBeLessThan(onAskMoment.mock.invocationCallOrder[0])
    rerender(<BrowserRecordingPlayer {...props} active={false} transport={transport(2200)} />)
    onAskMoment.mockClear()
    await act(async () => action.onAsk())
    expect(onAskMoment).not.toHaveBeenCalled()
  }
)

it('promotes the already decoded next node without reloading it and keeps only two decoders', async () => {
  const { rerender, unmount } = render(
    <BrowserRecordingPlayer
      recording={browserRecordingFixture()}
      mediaUrl={mediaUrl}
      onAskMoment={vi.fn()}
    />
  )
  const first = screen.getByLabelText('Recorded webpage') as HTMLVideoElement
  const next = screen.getByTestId('preloaded-recorded-segment') as HTMLVideoElement
  expect(document.querySelectorAll('video')).toHaveLength(2)
  expect(next.style.visibility).toBe('hidden')
  fireEvent.loadedMetadata(first)
  fireEvent.loadedData(first)
  fireEvent.loadedMetadata(next)
  fireEvent.loadedData(next)
  fireEvent.click(screen.getByRole('button', { name: 'Play replay' }))
  await act(async () => {})
  const load = vi.mocked(HTMLMediaElement.prototype.load)
  const play = vi.mocked(HTMLMediaElement.prototype.play)
  load.mockClear()
  play.mockClear()
  fireEvent.ended(first)
  await act(async () => {})
  expect(screen.getByLabelText('Recorded webpage')).toBe(next)
  expect(next.style.visibility).toBe('visible')
  expect(screen.queryByTestId('recorded-segment-loading')).toBeNull()
  expect(load.mock.contexts).not.toContain(next)
  expect(load.mock.contexts).toContain(first)
  expect(first.hasAttribute('src')).toBe(false)
  expect(play.mock.contexts).toContain(next)
  expect(document.querySelectorAll('video')).toHaveLength(2)
  const following = screen.getByTestId('preloaded-recorded-segment')
  rerender(
    <BrowserRecordingPlayer
      recording={browserRecordingFixture()}
      mediaUrl={mediaUrl}
      active={false}
    />
  )
  expect(document.querySelectorAll('video')).toHaveLength(0)
  expect(next.hasAttribute('src')).toBe(false)
  expect(following.hasAttribute('src')).toBe(false)
  expect(load.mock.contexts.filter((element) => element === next)).toHaveLength(1)
  expect(load.mock.contexts.filter((element) => element === following)).toHaveLength(1)
  unmount()
})

it('evicts distant seek sources, preloads across gaps without showing or citing them, and releases on unmount', () => {
  const { unmount } = render(
    <BrowserRecordingPlayer
      recording={browserRecordingFixture()}
      mediaUrl={mediaUrl}
      onAskMoment={vi.fn()}
    />
  )
  const initial = Array.from(document.querySelectorAll('video'))
  fireEvent.change(screen.getByRole('slider'), { target: { value: '4500' } })
  expect(document.querySelectorAll('video')).toHaveLength(1)
  expect(initial.every((element) => !element.hasAttribute('src'))).toBe(true)
  const future = screen.getByTestId('preloaded-recorded-segment') as HTMLVideoElement
  fireEvent.loadedMetadata(future)
  fireEvent.loadedData(future)
  expect(screen.queryByLabelText('Recorded webpage')).toBeNull()
  expect(future.style.visibility).toBe('hidden')
  expect(
    screen.getByRole('button', { name: 'Ask about this moment' }).hasAttribute('disabled')
  ).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Go to next recorded moment' }))
  expect(screen.getByLabelText('Recorded webpage')).toBe(future)
  expect(future.style.visibility).toBe('visible')
  unmount()
  expect(future.hasAttribute('src')).toBe(false)
})

it('ignores next-node waiting/seeking/errors until promotion and surfaces a failed preload only then', () => {
  render(
    <BrowserRecordingPlayer
      recording={browserRecordingFixture()}
      mediaUrl={mediaUrl}
      onAskMoment={vi.fn()}
    />
  )
  const first = screen.getByLabelText('Recorded webpage')
  const next = screen.getByTestId('preloaded-recorded-segment')
  fireEvent.loadedMetadata(first)
  fireEvent.loadedData(first)
  fireEvent.waiting(next)
  fireEvent.seeking(next)
  fireEvent.error(next)
  expect(screen.queryByTestId('recorded-segment-loading')).toBeNull()
  expect(
    screen.getByRole('button', { name: 'Ask about this moment' }).hasAttribute('disabled')
  ).toBe(false)
  expect(screen.queryByText('Could not play the recorded footage.')).toBeNull()
  fireEvent.ended(first)
  expect(screen.getByText('Could not play the recorded footage.')).toBeTruthy()
  expect(
    screen.getByRole('button', { name: 'Ask about this moment' }).hasAttribute('disabled')
  ).toBe(true)
})

it('does not pause or repeatedly seek a buffering decoder while the research clock advances', async () => {
  vi.useFakeTimers()
  const recording = browserRecordingFixture()
  const props = { recording, mediaUrl, onAskMoment: vi.fn() }
  const onSeek = vi.fn()
  const { rerender } = render(
    <BrowserRecordingPlayer
      {...props}
      transport={{ offsetMs: 500, playing: true, speed: 1, onSeek }}
    />
  )
  const element = screen.getByLabelText('Recorded webpage') as HTMLVideoElement
  fireEvent.loadedMetadata(element)
  fireEvent.loadedData(element)
  await act(async () => {})
  const pause = vi.mocked(HTMLMediaElement.prototype.pause)
  pause.mockClear()
  fireEvent.waiting(element)
  expect(element.style.visibility).toBe('visible')
  expect(screen.queryByTestId('recorded-segment-loading')).toBeNull()
  rerender(
    <BrowserRecordingPlayer
      {...props}
      transport={{ offsetMs: 900, playing: true, speed: 1, onSeek }}
    />
  )
  expect(element.currentTime).toBe(0.5)
  expect(pause).not.toHaveBeenCalled()
  expect(
    screen.getByRole('button', { name: 'Ask about this moment' }).hasAttribute('disabled')
  ).toBe(true)
  act(() => vi.advanceTimersByTime(180))
  expect(screen.getByTestId('recorded-segment-loading').className).toContain('bottom-3')
  Object.defineProperty(element, 'seeking', { configurable: true, value: true })
  fireEvent.seeking(element)
  rerender(
    <BrowserRecordingPlayer
      {...props}
      transport={{ offsetMs: 1100, playing: true, speed: 1, onSeek }}
    />
  )
  expect(element.currentTime).toBe(0.5)
  expect(pause).not.toHaveBeenCalled()
  rerender(
    <BrowserRecordingPlayer
      {...props}
      transport={{ offsetMs: 1100, playing: false, speed: 1, onSeek }}
    />
  )
  expect(pause).toHaveBeenCalled()
  Object.defineProperty(element, 'seeking', { configurable: true, value: false })
  fireEvent.seeked(element)
  expect(element.currentTime).toBe(1.1)
})

it('does not flash a loading message for a quickly decoded source, including without a retained frame', () => {
  vi.useFakeTimers()
  render(<BrowserRecordingPlayer recording={browserRecordingFixture()} mediaUrl={mediaUrl} />)
  const element = screen.getByLabelText('Recorded webpage')
  expect(screen.queryByTestId('recorded-segment-loading')).toBeNull()
  act(() => vi.advanceTimersByTime(100))
  fireEvent.loadedMetadata(element)
  fireEvent.loadedData(element)
  act(() => vi.advanceTimersByTime(200))
  expect(screen.queryByTestId('recorded-segment-loading')).toBeNull()
  fireEvent.change(screen.getByRole('slider'), { target: { value: '3200' } })
  act(() => vi.advanceTimersByTime(180))
  expect(screen.getByTestId('recorded-segment-loading').className).toContain('inset-0')
})

it('restores both media sources after development StrictMode replays effect cleanup', () => {
  const { unmount } = render(
    <StrictMode>
      <BrowserRecordingPlayer recording={browserRecordingFixture()} mediaUrl={mediaUrl} />
    </StrictMode>
  )
  const videos = Array.from(document.querySelectorAll('video'))
  expect(videos).toHaveLength(2)
  expect(videos.every((element) => element.hasAttribute('src'))).toBe(true)
  unmount()
  expect(videos.every((element) => !element.hasAttribute('src'))).toBe(true)
})

it('pauses a current node demoted by a backward seek while keeping its buffer for reuse', async () => {
  render(<BrowserRecordingPlayer recording={browserRecordingFixture()} mediaUrl={mediaUrl} />)
  const next = screen.getByTestId('preloaded-recorded-segment') as HTMLVideoElement
  fireEvent.loadedMetadata(next)
  fireEvent.loadedData(next)
  fireEvent.ended(screen.getByLabelText('Recorded webpage'))
  fireEvent.click(screen.getByRole('button', { name: 'Play replay' }))
  await act(async () => {})
  expect(screen.getByLabelText('Recorded webpage')).toBe(next)
  const pause = vi.mocked(HTMLMediaElement.prototype.pause)
  const load = vi.mocked(HTMLMediaElement.prototype.load)
  pause.mockClear()
  load.mockClear()
  fireEvent.change(screen.getByRole('slider'), { target: { value: '500' } })
  expect(screen.getByTestId('preloaded-recorded-segment')).toBe(next)
  expect(pause.mock.contexts).toContain(next)
  expect(load.mock.contexts).not.toContain(next)
  expect(next.hasAttribute('src')).toBe(true)
  expect(next.style.visibility).toBe('hidden')
  fireEvent.change(screen.getByRole('slider'), { target: { value: '2000' } })
  expect(screen.getByLabelText('Recorded webpage')).toBe(next)
  expect(next.style.visibility).toBe('visible')
  expect(load.mock.contexts).not.toContain(next)
})

const decodedVideo = (element: HTMLVideoElement): void => {
  Object.defineProperties(element, {
    videoWidth: { configurable: true, value: 1280 },
    videoHeight: { configurable: true, value: 720 }
  })
  fireEvent.loadedMetadata(element)
  fireEvent.loadedData(element)
}
const mockCanvas = (): ReturnType<typeof vi.fn> => {
  const drawImage = vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage
  } as unknown as CanvasRenderingContext2D)
  return drawImage
}

it.each([130, 480])(
  'silently holds a referenceable real frame through a %sms segment hole without changing the clock',
  (hole) => {
    const drawImage = mockCanvas()
    const recording = browserRecordingFixture()
    recording.segments[1].startMs = 2000 + hole
    const props = {
      recording,
      mediaUrl,
      onAskMoment: vi.fn(),
      presentationMode: 'research' as const
    }
    const onSeek = vi.fn()
    const transport = (offsetMs: number, playing = true): BrowserRecordingTransport => ({
      offsetMs,
      playing,
      speed: 1,
      onSeek
    })
    const { rerender } = render(<BrowserRecordingPlayer {...props} transport={transport(1900)} />)
    const first = screen.getByLabelText('Recorded webpage') as HTMLVideoElement
    const next = screen.getByTestId('preloaded-recorded-segment') as HTMLVideoElement
    decodedVideo(first)
    decodedVideo(next)
    first.currentTime = 1.999
    const canvas = screen.getByTestId('held-recorded-frame') as HTMLCanvasElement
    expect(canvas.width).toBe(0) // no earlier held state: the gap-entry layout must capture it
    const viewport = screen.getByTestId('recorded-media-viewport')
    const metadata = screen.getByText('1280 × 720 · WebM · VP8')
    const aspect = screen.getByTestId('recorded-video-surface').style.aspectRatio
    rerender(<BrowserRecordingPlayer {...props} transport={transport(2010)} />)
    expect(screen.getByTestId('held-recorded-frame')).toBe(canvas)
    expect(canvas.hidden).toBe(false)
    expect(canvas.width).toBe(1280)
    expect(drawImage).toHaveBeenCalledWith(first, 0, 0, 1280, 720)
    expect(screen.getByText('1280 × 720 · WebM · VP8')).toBe(metadata)
    expect(screen.queryByTestId('recorded-segment-gap')).toBeNull()
    expect(viewport.querySelector('[role="status"], [aria-live]')).toBeNull()
    expect(viewport.textContent).not.toContain('No footage at this time.')
    expect(screen.queryByLabelText('Recorded webpage')).toBeNull()
    expect(screen.getByTestId('recorded-video-surface').style.aspectRatio).toBe(aspect)
    expect(
      screen.getByRole('button', { name: 'Ask about this moment' }).hasAttribute('disabled')
    ).toBe(false)
    // Advance through a longer hole in ordinary clock ticks, then promote the ready decoder.
    if (hole > 250) {
      rerender(<BrowserRecordingPlayer {...props} transport={transport(2250)} />)
      expect(canvas.hidden).toBe(false)
      expect(viewport.querySelector('[role="status"], [aria-live]')).toBeNull()
      expect(screen.getByText('1280 × 720 · WebM · VP8')).toBe(metadata)
    }
    rerender(<BrowserRecordingPlayer {...props} transport={transport(2000 + hole + 20)} />)
    expect(screen.getByLabelText('Recorded webpage')).toBe(next)
    expect(next.currentTime).toBe(0) // a 20ms master tick does not start a redundant seek
    expect(next.style.visibility).toBe('visible')
    expect(canvas.hidden).toBe(true)
    expect(screen.getByText('1280 × 720 · WebM · VP8')).toBe(metadata)
    expect(screen.queryByTestId('recorded-segment-gap')).toBeNull()
    expect(viewport.querySelector('[role="status"], [aria-live]')).toBeNull()
    expect(onSeek).not.toHaveBeenCalled()
  }
)

it('clears a held hole frame when paused or seeking backwards and does not show it after jumping into a hole', () => {
  mockCanvas()
  const recording = browserRecordingFixture()
  recording.segments[1].startMs = 2130
  const onSeek = vi.fn()
  const props = { recording, mediaUrl, onAskMoment: vi.fn() }
  const transport = (offsetMs: number, playing: boolean): BrowserRecordingTransport => ({
    offsetMs,
    playing,
    speed: 1,
    onSeek
  })
  const { rerender } = render(
    <BrowserRecordingPlayer {...props} transport={transport(1900, true)} />
  )
  const first = screen.getByLabelText('Recorded webpage') as HTMLVideoElement
  decodedVideo(first)
  first.currentTime = 1.99
  rerender(<BrowserRecordingPlayer {...props} transport={transport(2010, true)} />)
  const canvas = screen.getByTestId('held-recorded-frame') as HTMLCanvasElement
  expect(canvas.hidden).toBe(false)
  rerender(<BrowserRecordingPlayer {...props} transport={transport(2010, false)} />)
  expect(canvas.hidden).toBe(true)
  expect(canvas.width).toBe(0)
  expect(screen.getByText('No webpage footage was recorded at this time.')).toBeTruthy()
  rerender(<BrowserRecordingPlayer {...props} transport={transport(2050, true)} />)
  expect(canvas.hidden).toBe(true)
  expect(screen.queryByTestId('recorded-segment-gap')).toBeNull()
  rerender(<BrowserRecordingPlayer {...props} transport={transport(1000, false)} />)
  expect(canvas.width).toBe(0)
})

it.each(['long', 'explicit', 'resized', 'missing'] as const)('does not bridge a %s gap', (kind) => {
  mockCanvas()
  const recording = browserRecordingFixture()
  recording.segments[1].startMs = kind === 'long' ? 2600 : 2130
  if (kind === 'explicit')
    recording.coverage.gaps.unshift({ startMs: 2000, endMs: 2130, reason: 'paused' })
  if (kind === 'resized') recording.segments[1].width = 640
  const onSeek = vi.fn()
  const props = { recording, mediaUrl, missingMediaKeys: kind === 'missing' ? ['media-1'] : [] }
  const { rerender } = render(
    <BrowserRecordingPlayer
      {...props}
      transport={{ offsetMs: 1900, playing: true, speed: 1, onSeek }}
    />
  )
  const first = screen.getByLabelText('Recorded webpage') as HTMLVideoElement
  decodedVideo(first)
  first.currentTime = 1.99
  fireEvent.timeUpdate(first)
  rerender(
    <BrowserRecordingPlayer
      {...props}
      transport={{ offsetMs: 2010, playing: true, speed: 1, onSeek }}
    />
  )
  const canvas = screen.getByTestId('held-recorded-frame') as HTMLCanvasElement
  expect(canvas.hidden).toBe(true)
  expect(canvas.width).toBe(0)
  expect(screen.queryByTestId('recorded-segment-gap')).toBeNull()
  expect(
    screen.getByText(
      kind === 'explicit'
        ? 'Recording was paused at this time.'
        : 'No webpage footage was recorded at this time.'
    )
  ).toBeTruthy()
  expect(onSeek).not.toHaveBeenCalled()
})

it('holds the last decoded frame during internal drift correction but clears it for a paused seek', () => {
  const drawImage = mockCanvas()
  const recording = browserRecordingFixture()
  const props = { recording, mediaUrl, onAskMoment: vi.fn() }
  const onSeek = vi.fn()
  const transport = (offsetMs: number, playing = true): BrowserRecordingTransport => ({
    offsetMs,
    playing,
    speed: 1,
    onSeek
  })
  const { rerender } = render(<BrowserRecordingPlayer {...props} transport={transport(500)} />)
  const element = screen.getByLabelText('Recorded webpage') as HTMLVideoElement
  decodedVideo(element)
  element.currentTime = 0.4
  rerender(<BrowserRecordingPlayer {...props} transport={transport(700)} />)
  const canvas = screen.getByTestId('held-recorded-frame') as HTMLCanvasElement
  expect(element.currentTime).toBe(0.7)
  expect(canvas.hidden).toBe(false)
  expect(drawImage).toHaveBeenCalledWith(element, 0, 0, 1280, 720)
  expect(
    screen.getByRole('button', { name: 'Ask about this moment' }).hasAttribute('disabled')
  ).toBe(false)
  fireEvent.seeking(element)
  expect(canvas.hidden).toBe(false)
  fireEvent.seeked(element)
  expect(canvas.hidden).toBe(true)
  expect(element.style.visibility).toBe('visible')
  rerender(<BrowserRecordingPlayer {...props} transport={transport(1200, false)} />)
  expect(element.currentTime).toBe(1.2)
  expect(canvas.width).toBe(0)
  expect(canvas.hidden).toBe(true)
})

it('uses its one cached actual frame when the departing decoder has lost readyState at the tail', () => {
  mockCanvas()
  const recording = browserRecordingFixture()
  recording.segments[1].startMs = 2130
  const onSeek = vi.fn()
  const props = { recording, mediaUrl }
  const { rerender } = render(
    <BrowserRecordingPlayer
      {...props}
      transport={{ offsetMs: 1900, playing: true, speed: 1, onSeek }}
    />
  )
  const first = screen.getByLabelText('Recorded webpage') as HTMLVideoElement
  decodedVideo(first)
  first.currentTime = 1.95
  fireEvent.timeUpdate(first)
  const canvas = screen.getByTestId('held-recorded-frame') as HTMLCanvasElement
  expect(canvas.width).toBe(1280)
  expect(canvas.hidden).toBe(true)
  Object.defineProperty(first, 'readyState', { configurable: true, value: 1 })
  rerender(
    <BrowserRecordingPlayer
      {...props}
      transport={{ offsetMs: 2010, playing: true, speed: 1, onSeek }}
    />
  )
  expect(canvas.width).toBe(1280)
  expect(canvas.hidden).toBe(false)
  expect(screen.queryByTestId('recorded-segment-gap')).toBeNull()
  expect(
    screen.getByTestId('recorded-media-viewport').querySelector('[role="status"], [aria-live]')
  ).toBeNull()
})

it.each([1.7, Infinity])(
  'does not seek beyond the decoder endpoint when duration is %s',
  (duration) => {
    const recording = browserRecordingFixture()
    const props = { recording, mediaUrl, onAskMoment: vi.fn() }
    const onSeek = vi.fn()
    const { rerender } = render(
      <BrowserRecordingPlayer
        {...props}
        transport={{ offsetMs: 1600, playing: true, speed: 1, onSeek }}
      />
    )
    const element = screen.getByLabelText('Recorded webpage') as HTMLVideoElement
    Object.defineProperty(element, 'duration', { configurable: true, value: duration })
    decodedVideo(element)
    element.currentTime = Number.isFinite(duration) ? 1.699 : 1.7
    Object.defineProperty(element, 'ended', {
      configurable: true,
      value: !Number.isFinite(duration)
    })
    const endedAt = element.currentTime
    rerender(
      <BrowserRecordingPlayer
        {...props}
        transport={{ offsetMs: 1800, playing: true, speed: 1, onSeek }}
      />
    )
    rerender(
      <BrowserRecordingPlayer
        {...props}
        transport={{ offsetMs: 1990, playing: true, speed: 1, onSeek }}
      />
    )
    expect(element.currentTime).toBe(endedAt)
    expect(element.style.visibility).toBe('visible')
    expect(
      screen.getByRole('button', { name: 'Ask about this moment' }).hasAttribute('disabled')
    ).toBe(false)
  }
)
