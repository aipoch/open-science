// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { recordingTransportMessage } from '../../../../../shared/browser-recording-transport'
import {
  useBrowserRecordingTransportHost,
  useBrowserRecordingTransportReceiver,
  type EmbeddedBrowserRecordingPlayback
} from './use-browser-recording-transport'

class Port {
  onmessage: ((event: MessageEvent) => void) | null = null
  postMessage = vi.fn()
  start = vi.fn()
  close = vi.fn()
  receive(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent)
  }
}
const channels: { port1: Port; port2: Port }[] = []
class Channel {
  port1 = new Port()
  port2 = new Port()
  constructor() {
    channels.push(this)
  }
}
const origin = 'http://viewer-recording.localhost:12345'
const makeFrame = (): {
  iframeRef: { current: HTMLIFrameElement }
  postMessage: ReturnType<typeof vi.fn>
} => {
  const postMessage = vi.fn()
  return {
    iframeRef: { current: { contentWindow: { postMessage } } as unknown as HTMLIFrameElement },
    postMessage
  }
}
const state = (onSeekRecordedAt = vi.fn()): EmbeddedBrowserRecordingPlayback => ({
  recordedAt: 1000,
  playing: false,
  speed: 1,
  onSeekRecordedAt
})
const offer = (source: MessageEventSource, port: Port): void => {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: recordingTransportMessage({ type: 'offer' }),
      source,
      origin: 'null', // The installed Electron parent can have an opaque file origin.
      ports: [port as unknown as MessagePort]
    })
  )
}

beforeEach(() => {
  channels.length = 0
  vi.useFakeTimers()
  vi.stubGlobal('MessageChannel', Channel)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('sends only to the exact origin, publishes after ACK, and uses fresh state/callback without reconnecting', () => {
  const { iframeRef, postMessage } = makeFrame()
  const firstSeek = vi.fn()
  const nextSeek = vi.fn()
  const { rerender, unmount } = renderHook(
    ({ playback }) =>
      useBrowserRecordingTransportHost({ iframeRef, origin, enabled: true, playback }),
    { initialProps: { playback: state(firstSeek) } }
  )
  expect(postMessage).toHaveBeenCalledWith(recordingTransportMessage({ type: 'offer' }), origin, [
    channels[0].port2
  ])
  expect(channels[0].port1.postMessage).not.toHaveBeenCalled()
  act(() => channels[0].port1.receive(recordingTransportMessage({ type: 'ready' })))
  expect(channels[0].port1.postMessage).toHaveBeenLastCalledWith(
    recordingTransportMessage({
      type: 'state',
      revision: 1,
      playback: { recordedAt: 1000, playing: false, speed: 1 }
    })
  )
  rerender({ playback: { ...state(nextSeek), recordedAt: 2000, playing: true, speed: 4 } })
  expect(channels).toHaveLength(1)
  expect(channels[0].port1.postMessage).toHaveBeenLastCalledWith(
    recordingTransportMessage({
      type: 'state',
      revision: 2,
      playback: { recordedAt: 2000, playing: true, speed: 4 }
    })
  )
  act(() =>
    channels[0].port1.receive(
      recordingTransportMessage({ type: 'seek', revision: 2, recordedAt: 2500 })
    )
  )
  expect(firstSeek).not.toHaveBeenCalled()
  expect(nextSeek).toHaveBeenCalledWith(2500)
  act(() =>
    channels[0].port1.receive(
      recordingTransportMessage({ type: 'seek', revision: 999, recordedAt: 3000 })
    )
  )
  expect(nextSeek).toHaveBeenCalledTimes(1)
  unmount()
  expect(channels[0].port1.postMessage).toHaveBeenLastCalledWith(
    recordingTransportMessage({ type: 'close' })
  )
  expect(channels[0].port1.close).toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('retries child-startup races, rejects old port events, and starts fresh on iframe load', () => {
  const { iframeRef } = makeFrame()
  const seek = vi.fn()
  const { result } = renderHook(() =>
    useBrowserRecordingTransportHost({ iframeRef, origin, enabled: true, playback: state(seek) })
  )
  const stale = channels[0].port1.onmessage!
  act(() => vi.advanceTimersByTime(500))
  expect(channels).toHaveLength(2)
  expect(channels[0].port1.close).toHaveBeenCalled()
  act(() => stale({ data: recordingTransportMessage({ type: 'ready' }) } as MessageEvent))
  expect(channels[1].port1.postMessage).not.toHaveBeenCalled()
  act(() => channels[1].port1.receive(recordingTransportMessage({ type: 'ready' })))
  expect(vi.getTimerCount()).toBe(0)
  act(() => result.current.onLoad())
  expect(channels[1].port1.close).toHaveBeenCalled()
  expect(channels).toHaveLength(3)
  act(() =>
    stale({
      data: recordingTransportMessage({ type: 'seek', revision: 1, recordedAt: 2500 })
    } as MessageEvent)
  )
  expect(seek).not.toHaveBeenCalled()
})

it('limits handshake retry time and never sends to broad or malformed origins', () => {
  const { iframeRef, postMessage } = makeFrame()
  const { rerender } = renderHook(
    ({ targetOrigin, enabled }) =>
      useBrowserRecordingTransportHost({
        iframeRef,
        origin: targetOrigin,
        enabled,
        playback: state()
      }),
    { initialProps: { targetOrigin: '*', enabled: true } }
  )
  for (const targetOrigin of ['null', '', `${origin}/`, `${origin}/page`, 'file:///page'])
    rerender({ targetOrigin, enabled: true })
  rerender({ targetOrigin: origin, enabled: false })
  expect(postMessage).not.toHaveBeenCalled()
  rerender({ targetOrigin: origin, enabled: true })
  act(() => vi.advanceTimersByTime(31_000))
  expect(postMessage).toHaveBeenCalledTimes(60)
  expect(vi.getTimerCount()).toBe(0)
})

it('receives only an admitted parent channel, ignores malformed/stale messages, and sends timestamp seeks', () => {
  const parent = {} as Window
  vi.spyOn(window, 'parent', 'get').mockReturnValue(parent)
  const { result, unmount } = renderHook(() =>
    useBrowserRecordingTransportReceiver({ enabled: true })
  )
  const port = new Port()
  act(() => offer(window, port))
  expect(port.postMessage).not.toHaveBeenCalled()
  expect(result.current.playback).toBeUndefined()
  act(() => offer(parent, port))
  expect(port.postMessage).toHaveBeenLastCalledWith(recordingTransportMessage({ type: 'ready' }))
  act(() => result.current.onSeekRecordedAt(3000))
  expect(port.postMessage).toHaveBeenCalledTimes(1)
  act(() =>
    port.receive(
      recordingTransportMessage({
        type: 'state',
        revision: 2,
        playback: { recordedAt: 2000, playing: true, speed: 2 }
      })
    )
  )
  expect(result.current.playback).toEqual({ recordedAt: 2000, playing: true, speed: 2 })
  act(() =>
    port.receive(
      recordingTransportMessage({
        type: 'state',
        revision: 1,
        playback: { recordedAt: 1000, playing: false, speed: 1 }
      })
    )
  )
  expect(result.current.playback?.recordedAt).toBe(2000)
  act(() => {
    result.current.onSeekRecordedAt(Infinity)
    result.current.onSeekRecordedAt(3000)
  })
  expect(port.postMessage).toHaveBeenLastCalledWith(
    recordingTransportMessage({ type: 'seek', revision: 2, recordedAt: 3000 })
  )
  unmount()
  expect(port.close).toHaveBeenCalled()
})

it('closes replaced/disabled ports and clears the clock when the host detaches', () => {
  const parent = {} as Window
  vi.spyOn(window, 'parent', 'get').mockReturnValue(parent)
  const { result, rerender } = renderHook(
    ({ enabled }) => useBrowserRecordingTransportReceiver({ enabled }),
    { initialProps: { enabled: true } }
  )
  const first = new Port()
  const second = new Port()
  act(() => offer(parent, first))
  const stale = first.onmessage!
  act(() => offer(parent, second))
  expect(first.close).toHaveBeenCalled()
  act(() =>
    stale({
      data: recordingTransportMessage({
        type: 'state',
        revision: 1,
        playback: { recordedAt: 2000, playing: true, speed: 2 }
      })
    } as MessageEvent)
  )
  expect(result.current.playback).toBeUndefined()
  act(() =>
    second.receive(
      recordingTransportMessage({
        type: 'state',
        revision: 1,
        playback: { recordedAt: 2000, playing: true, speed: 2 }
      })
    )
  )
  act(() => second.receive(recordingTransportMessage({ type: 'close' })))
  expect(second.close).toHaveBeenCalled()
  expect(result.current.playback).toBeUndefined()
  const third = new Port()
  act(() => offer(parent, third))
  rerender({ enabled: false })
  expect(third.close).toHaveBeenCalled()
  const ignored = new Port()
  act(() => offer(parent, ignored))
  expect(ignored.postMessage).not.toHaveBeenCalled()
})

it('does not accept a bridge in a top-level standalone viewer', () => {
  const { result } = renderHook(() => useBrowserRecordingTransportReceiver({ enabled: true }))
  const port = new Port()
  act(() => offer(window, port))
  expect(port.postMessage).not.toHaveBeenCalled()
  expect(result.current.playback).toBeUndefined()
})

it('routes a research footer request only through the current admitted recording channel', () => {
  const { iframeRef } = makeFrame()
  const { result } = renderHook(() =>
    useBrowserRecordingTransportHost({
      iframeRef,
      origin,
      enabled: true,
      playback: { ...state(), presentation: 'research' }
    })
  )
  expect(result.current.action).toBeUndefined()
  act(() => result.current.ask())
  expect(channels[0].port1.postMessage).not.toHaveBeenCalled()
  act(() => channels[0].port1.receive(recordingTransportMessage({ type: 'ready' })))
  act(() =>
    channels[0].port1.receive(
      recordingTransportMessage({ type: 'action', revision: 1, disabled: false, pending: false })
    )
  )
  expect(result.current.action).toEqual({ disabled: false, pending: false })
  act(() => result.current.ask())
  expect(channels[0].port1.postMessage).toHaveBeenLastCalledWith(
    recordingTransportMessage({ type: 'ask', revision: 1 })
  )
  const stale = channels[0].port1.onmessage!
  act(() => result.current.onLoad())
  expect(result.current.action).toBeUndefined()
  act(() =>
    stale({
      data: recordingTransportMessage({
        type: 'action',
        revision: 1,
        disabled: false,
        pending: false
      })
    } as MessageEvent)
  )
  expect(result.current.action).toBeUndefined()
})

it('captures a decoded moment only for the current research clock revision and enabled action', () => {
  const parent = {} as Window
  vi.spyOn(window, 'parent', 'get').mockReturnValue(parent)
  const { result } = renderHook(() => useBrowserRecordingTransportReceiver({ enabled: true }))
  const port = new Port(),
    ask = vi.fn()
  act(() => offer(parent, port))
  act(() => result.current.onActionChange({ label: 'Ask', onAsk: ask }))
  act(() =>
    port.receive(
      recordingTransportMessage({
        type: 'state',
        revision: 2,
        playback: { playing: false, speed: 1, presentation: 'research' }
      })
    )
  )
  expect(port.postMessage).toHaveBeenLastCalledWith(
    recordingTransportMessage({ type: 'action', revision: 2, disabled: false, pending: false })
  )
  act(() => port.receive(recordingTransportMessage({ type: 'ask', revision: 1 })))
  expect(ask).not.toHaveBeenCalled()
  act(() => port.receive(recordingTransportMessage({ type: 'ask', revision: 2 })))
  expect(ask).toHaveBeenCalledTimes(1)
  act(() => result.current.onActionChange({ label: 'Ask', disabled: true, onAsk: ask }))
  act(() => port.receive(recordingTransportMessage({ type: 'ask', revision: 2 })))
  expect(ask).toHaveBeenCalledTimes(1)
  act(() =>
    port.receive(
      recordingTransportMessage({
        type: 'state',
        revision: 3,
        playback: { playing: false, speed: 1 }
      })
    )
  )
  act(() => result.current.onActionChange({ label: 'Ask', onAsk: ask }))
  act(() => port.receive(recordingTransportMessage({ type: 'ask', revision: 3 })))
  expect(ask).toHaveBeenCalledTimes(1)
})

it('carries decoded media context to the host and clears it with the unavailable action', () => {
  const parent = {} as Window
  vi.spyOn(window, 'parent', 'get').mockReturnValue(parent)
  const { result: child } = renderHook(() =>
    useBrowserRecordingTransportReceiver({ enabled: true })
  )
  const childPort = new Port()
  act(() => offer(parent, childPort))
  act(() =>
    childPort.receive(
      recordingTransportMessage({
        type: 'state',
        revision: 1,
        playback: { playing: false, speed: 1, presentation: 'research' }
      })
    )
  )
  act(() =>
    child.current.onActionChange({
      label: 'Ask',
      recordedAt: 2346,
      title: 'Experiment',
      onAsk: vi.fn()
    })
  )
  const message = childPort.postMessage.mock.lastCall?.[0]
  expect(message).toMatchObject({ type: 'action', recordedAt: 2346, title: 'Experiment' })
  const { iframeRef } = makeFrame()
  const { result: host } = renderHook(() =>
    useBrowserRecordingTransportHost({
      iframeRef,
      origin,
      enabled: true,
      playback: { ...state(), presentation: 'research' }
    })
  )
  act(() => channels[0].port1.receive(recordingTransportMessage({ type: 'ready' })))
  act(() => channels[0].port1.receive(message))
  expect(host.current.action).toEqual({
    disabled: false,
    pending: false,
    recordedAt: 2346,
    title: 'Experiment'
  })
  act(() => child.current.onActionChange(undefined))
  act(() => channels[0].port1.receive(childPort.postMessage.mock.lastCall?.[0]))
  expect(host.current.action).toEqual({ disabled: true, pending: false })
})
