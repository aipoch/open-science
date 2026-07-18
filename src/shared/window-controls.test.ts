import { describe, expect, it } from 'vitest'

import { isCloseWindowChord, type KeyChordInput } from './window-controls'

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
