import { describe, expect, it, vi } from 'vitest'

import {
  CLOSE_ACTIVE_PANE_CHANNEL,
  CLOSE_ACTIVE_PANE_READY_CHANNEL,
  CLOSE_ACTIVE_PANE_UNREADY_CHANNEL,
  WINDOW_FIND_READY_CHANNEL,
  WINDOW_FIND_UNREADY_CHANNEL,
  announceWindowFindReady,
  isWindowFindAppearance,
  isCloseWindowChord,
  isFindInPageChord,
  subscribeCloseActivePane,
  type KeyChordInput
} from './window-controls'

// Builds a keyDown Input with no modifiers, overridable per case.
const chord = (overrides: Partial<KeyChordInput> = {}): KeyChordInput => ({
  type: 'keyDown',
  key: 'w',
  control: false,
  meta: false,
  alt: false,
  shift: false,
  isAutoRepeat: false,
  ...overrides
})

describe('isCloseWindowChord', () => {
  it('matches Cmd+W on macOS', () => {
    expect(isCloseWindowChord(chord({ meta: true }), 'darwin')).toBe(true)
  })

  it('matches Ctrl+W on Windows and Linux', () => {
    expect(isCloseWindowChord(chord({ control: true }), 'win32')).toBe(true)
    expect(isCloseWindowChord(chord({ control: true }), 'linux')).toBe(true)
  })

  it('rejects Ctrl+W on macOS and Cmd+W off macOS (wrong primary modifier)', () => {
    expect(isCloseWindowChord(chord({ control: true }), 'darwin')).toBe(false)
    expect(isCloseWindowChord(chord({ meta: true }), 'win32')).toBe(false)
  })

  it('rejects when the other modifier is also held', () => {
    expect(isCloseWindowChord(chord({ meta: true, control: true }), 'darwin')).toBe(false)
    expect(isCloseWindowChord(chord({ control: true, meta: true }), 'linux')).toBe(false)
  })

  it('rejects when Alt or Shift is held', () => {
    expect(isCloseWindowChord(chord({ meta: true, alt: true }), 'darwin')).toBe(false)
    expect(isCloseWindowChord(chord({ meta: true, shift: true }), 'darwin')).toBe(false)
  })

  it('rejects a bare W with no primary modifier', () => {
    expect(isCloseWindowChord(chord(), 'darwin')).toBe(false)
  })

  it('rejects other keys', () => {
    expect(isCloseWindowChord(chord({ meta: true, key: 'q' }), 'darwin')).toBe(false)
  })

  it('matches by produced character, so it tracks the W key across keyboard layouts', () => {
    // AZERTY: the character 'w' sits where QWERTY has 'z' (code 'KeyZ'). Matching on the character
    // keeps the chord aligned with the OS Close accelerator, which also keys off 'w'.
    expect(isCloseWindowChord(chord({ meta: true, key: 'w' }), 'darwin')).toBe(true)
    // Uppercase (e.g. Caps Lock) still matches; Shift is rejected separately above.
    expect(isCloseWindowChord(chord({ control: true, key: 'W' }), 'win32')).toBe(true)
    // The physical W position producing another character (e.g. AZERTY 'z') must not match.
    expect(isCloseWindowChord(chord({ meta: true, key: 'z' }), 'darwin')).toBe(false)
  })

  it('ignores keyUp events', () => {
    expect(isCloseWindowChord(chord({ meta: true, type: 'keyUp' }), 'darwin')).toBe(false)
  })

  it('ignores auto-repeat so a held chord cannot close the window after the pane closes', () => {
    expect(isCloseWindowChord(chord({ meta: true, isAutoRepeat: true }), 'darwin')).toBe(false)
  })
})

describe('isFindInPageChord', () => {
  it('matches Cmd+F on macOS and Ctrl+F on Windows and Linux', () => {
    expect(isFindInPageChord(chord({ key: 'f', meta: true }), 'darwin')).toBe(true)
    expect(isFindInPageChord(chord({ key: 'f', control: true }), 'win32')).toBe(true)
    expect(isFindInPageChord(chord({ key: 'F', control: true }), 'linux')).toBe(true)
  })

  it('rejects the wrong primary modifier and chords with extra modifiers', () => {
    expect(isFindInPageChord(chord({ key: 'f', control: true }), 'darwin')).toBe(false)
    expect(isFindInPageChord(chord({ key: 'f', meta: true }), 'linux')).toBe(false)
    expect(isFindInPageChord(chord({ key: 'f', meta: true, control: true }), 'darwin')).toBe(false)
    expect(isFindInPageChord(chord({ key: 'f', meta: true, shift: true }), 'darwin')).toBe(false)
    expect(isFindInPageChord(chord({ key: 'f', control: true, alt: true }), 'linux')).toBe(false)
  })

  it('rejects bare, unrelated, key-up, and auto-repeat input', () => {
    expect(isFindInPageChord(chord({ key: 'f' }), 'darwin')).toBe(false)
    expect(isFindInPageChord(chord({ key: 'q', meta: true }), 'darwin')).toBe(false)
    expect(isFindInPageChord(chord({ key: 'f', meta: true, type: 'keyUp' }), 'darwin')).toBe(false)
    expect(isFindInPageChord(chord({ key: 'f', control: true, isAutoRepeat: true }), 'linux')).toBe(
      false
    )
  })
})

describe('isWindowFindAppearance', () => {
  it('accepts the typed light/dark appearance contract', () => {
    expect(isWindowFindAppearance({ theme: 'light', followsSystem: false })).toBe(true)
    expect(isWindowFindAppearance({ theme: 'dark', followsSystem: true })).toBe(true)
  })

  it('rejects malformed appearance payloads received over IPC', () => {
    expect(isWindowFindAppearance(null)).toBe(false)
    expect(isWindowFindAppearance({ theme: 'sepia', followsSystem: false })).toBe(false)
    expect(isWindowFindAppearance({ theme: 'dark', followsSystem: 'yes' })).toBe(false)
  })
})

describe('subscribeCloseActivePane', () => {
  // Verifies the renderer handshake wiring so a wrong channel or a missing signal can't slip through
  // while main's tests fake the ready state. Main only forwards the chord when it has seen READY, so
  // subscribing on the wrong channel would silently break the whole feature.
  it('subscribes to the chord channel and announces readiness on subscribe', () => {
    const removeListener = vi.fn()
    const on = vi.fn(() => removeListener)
    const send = vi.fn()
    const listener = vi.fn()

    subscribeCloseActivePane({ on, send }, listener)

    expect(on).toHaveBeenCalledWith(CLOSE_ACTIVE_PANE_CHANNEL, listener)
    expect(send).toHaveBeenCalledWith(CLOSE_ACTIVE_PANE_READY_CHANNEL)
  })

  it('removes the listener and announces teardown on unsubscribe', () => {
    const removeListener = vi.fn()
    const on = vi.fn(() => removeListener)
    const send = vi.fn()

    const unsubscribe = subscribeCloseActivePane({ on, send }, vi.fn())
    send.mockClear()
    unsubscribe()

    expect(removeListener).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(CLOSE_ACTIVE_PANE_UNREADY_CHANNEL)
    // Teardown must not re-announce readiness, which would leave main forwarding into a gone listener.
    expect(send).not.toHaveBeenCalledWith(CLOSE_ACTIVE_PANE_READY_CHANNEL)
  })
})

describe('announceWindowFindReady', () => {
  // In the overlay-window architecture main opens the find bar directly (no OPEN message), so the
  // Workspace only needs to announce that it is mounted and can be searched — READY on mount, UNREADY on
  // teardown — so main knows whether Cmd/Ctrl+F should be intercepted at all. The helper's signature
  // (Pick<'send'>) guarantees it cannot subscribe to anything.
  it('announces readiness immediately', () => {
    const send = vi.fn()

    announceWindowFindReady({ send })

    expect(send).toHaveBeenCalledWith(WINDOW_FIND_READY_CHANNEL)
  })

  it('announces teardown when the returned unsubscribe runs', () => {
    const send = vi.fn()

    const unsubscribe = announceWindowFindReady({ send })
    send.mockClear()
    unsubscribe()

    expect(send).toHaveBeenCalledWith(WINDOW_FIND_UNREADY_CHANNEL)
  })
})
