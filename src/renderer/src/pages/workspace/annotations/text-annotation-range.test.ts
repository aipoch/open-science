// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import {
  pdfTextSelectorForRange,
  quoteOccurrenceForRange,
  reconcileTextAnnotationRanges,
  retargetTextAnnotationRange
} from './text-annotation-range'

const rangeAt = (node: Text, start: number, length = 6): Range => {
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, start + length)
  return range
}

const surfaceWithDuplicates = (): { surface: HTMLDivElement; text: Text } => {
  const surface = document.createElement('div')
  const text = document.createTextNode('repeat then repeat')
  surface.appendChild(text)
  document.body.appendChild(surface)
  return { surface, text }
}

describe('text annotation range reconciliation', () => {
  it('keeps an exact second-only selection instead of falling back to the first quote', () => {
    const { surface, text } = surfaceWithDuplicates()
    const exactSecond = rangeAt(text, 12)

    const result = reconcileTextAnnotationRanges(
      surface,
      [{ id: 'second-only', quote: 'repeat' }],
      new Map([['second-only', exactSecond]])
    )

    expect(result.get('second-only')).toBe(exactSecond)
    expect(result.get('second-only')?.startOffset).toBe(12)
    surface.remove()
  })

  it('preserves exact ranges when duplicate annotations are stored in reverse document order', () => {
    const { surface, text } = surfaceWithDuplicates()
    const exactFirst = rangeAt(text, 0)
    const exactSecond = rangeAt(text, 12)

    const result = reconcileTextAnnotationRanges(
      surface,
      [
        { id: 'second', quote: 'repeat' },
        { id: 'first', quote: 'repeat' }
      ],
      new Map([
        ['second', exactSecond],
        ['first', exactFirst]
      ])
    )

    expect(Array.from(result.values()).map((range) => range.startOffset)).toEqual([12, 0])
    surface.remove()
  })

  it('drops deleted IDs and uses deterministic quote order only after a real remount', () => {
    const first = surfaceWithDuplicates()
    const exactFirst = rangeAt(first.text, 0)
    const exactSecond = rangeAt(first.text, 12)
    const existing = new Map([
      ['second', exactSecond],
      ['first', exactFirst]
    ])

    const afterDelete = reconcileTextAnnotationRanges(
      first.surface,
      [{ id: 'first', quote: 'repeat' }],
      existing
    )
    expect(Array.from(afterDelete.keys())).toEqual(['first'])
    expect(afterDelete.get('first')).toBe(exactFirst)

    const remounted = surfaceWithDuplicates()
    first.surface.remove()
    const fallback = reconcileTextAnnotationRanges(
      remounted.surface,
      [
        { id: 'second', quote: 'repeat' },
        { id: 'first', quote: 'repeat' }
      ],
      existing
    )
    expect(Array.from(fallback.values()).map((range) => range.startOffset)).toEqual([0, 12])
    remounted.surface.remove()
  })

  it('rejects a stale owned Range after its text node mutates and falls back to the moved quote', () => {
    const { surface, text } = surfaceWithDuplicates()
    const stale = rangeAt(text, 12)
    text.data = 'prefix repeat then repeat'

    const result = reconcileTextAnnotationRanges(
      surface,
      [{ id: 'point', quote: 'repeat' }],
      new Map([['point', stale]])
    )

    expect(result.get('point')).not.toBe(stale)
    expect(result.get('point')?.toString()).toBe('repeat')
    expect(result.get('point')?.startOffset).toBe(7)
    surface.remove()
  })

  it('drops a stale owned Range when the quote disappears from the current content', () => {
    const { surface, text } = surfaceWithDuplicates()
    const stale = rangeAt(text, 12)
    text.data = 'content replaced while streaming'

    const result = reconcileTextAnnotationRanges(
      surface,
      [{ id: 'point', quote: 'repeat' }],
      new Map([['point', stale]])
    )

    expect(result.size).toBe(0)
    surface.remove()
  })
})

describe('retargetTextAnnotationRange', () => {
  it('keeps a still-connected exact range', () => {
    const { surface, text } = surfaceWithDuplicates()
    const existing = rangeAt(text, 0)

    expect(retargetTextAnnotationRange(surface, 'repeat', existing)).toBe(existing)
    surface.remove()
  })

  it('rebuilds the quote after highlight spans replace the original text node', () => {
    const surface = document.createElement('div')
    const code = document.createElement('code')
    code.appendChild(document.createTextNode('printf shell-command'))
    surface.appendChild(code)
    document.body.appendChild(surface)
    const existing = document.createRange()
    existing.selectNodeContents(code.firstChild!)

    code.replaceChildren()
    const token = document.createElement('span')
    token.appendChild(document.createTextNode('printf shell-command'))
    code.appendChild(token)

    const restored = retargetTextAnnotationRange(surface, 'printf shell-command', existing)
    expect(restored).not.toBe(existing)
    expect(restored?.toString()).toBe('printf shell-command')
    expect(restored?.startContainer.isConnected).toBe(true)
    surface.remove()
  })

  it('rebuilds a duplicate quote onto the selected occurrence after highlight spans replace it', () => {
    const surface = document.createElement('div')
    const code = document.createElement('code')
    const original = document.createTextNode('repeat then repeat')
    code.appendChild(original)
    surface.appendChild(code)
    document.body.appendChild(surface)
    const existing = rangeAt(original, 12)
    const occurrence = quoteOccurrenceForRange(surface, 'repeat', existing)
    expect(occurrence).toBe(1)

    code.replaceChildren()
    for (const part of ['repeat', ' then ', 'repeat']) {
      const token = document.createElement('span')
      token.appendChild(document.createTextNode(part))
      code.appendChild(token)
    }

    const restored = retargetTextAnnotationRange(surface, 'repeat', existing, occurrence)
    expect(restored).not.toBe(existing)
    expect(restored?.toString()).toBe('repeat')
    expect(restored?.startContainer).toBe(code.lastChild?.firstChild)
    expect(quoteOccurrenceForRange(surface, 'repeat', restored!)).toBe(1)
    surface.remove()
  })

  it('counts the first duplicate quote as occurrence 0', () => {
    const { surface, text } = surfaceWithDuplicates()
    expect(quoteOccurrenceForRange(surface, 'repeat', rangeAt(text, 0))).toBe(0)
    surface.remove()
  })

  it('returns undefined when the quote is no longer in the surface', () => {
    const { surface, text } = surfaceWithDuplicates()
    const existing = rangeAt(text, 0)
    text.data = 'stream replaced the quote'

    expect(retargetTextAnnotationRange(surface, 'repeat', existing)).toBeUndefined()
    surface.remove()
  })
})

describe('pdfTextSelectorForRange', () => {
  it('captures text quote, context, position, and normalized page quads', () => {
    const surface = document.createElement('div')
    const text = document.createTextNode('Before selected evidence after')
    surface.appendChild(text)
    const range = rangeAt(text, 7, 17)
    Object.defineProperty(range, 'getClientRects', {
      value: () => [
        {
          left: 120,
          top: 240,
          right: 320,
          bottom: 270,
          width: 200,
          height: 30
        }
      ]
    })
    Object.defineProperty(surface, 'getBoundingClientRect', {
      value: () => ({ left: 100, top: 200, width: 400, height: 600 })
    })

    expect(pdfTextSelectorForRange(surface, range, 5, 'pdfjs-5.4.624')).toEqual({
      kind: 'text',
      pageNumber: 5,
      exact: 'selected evidence',
      prefix: 'Before ',
      suffix: ' after',
      position: { start: 7, end: 24 },
      quads: [{ x: 0.05, y: 1 / 15, width: 0.5, height: 0.05 }],
      extractorVersion: 'pdfjs-5.4.624'
    })
  })

  it('drops PDF line-break sentinels and merges duplicate fragments on the same line', () => {
    const surface = document.createElement('div')
    const text = document.createTextNode('selected evidence')
    surface.appendChild(text)
    const range = rangeAt(text, 0, text.data.length)
    Object.defineProperty(range, 'getClientRects', {
      value: () => [
        // PDF.js line-break sentinel: it must never become a page-edge highlight.
        { left: 100, top: 100, right: 100, bottom: 120, width: 0, height: 20 },
        // Chromium can report the same text line twice with slightly different heights.
        { left: 120, top: 240, right: 220, bottom: 270, width: 100, height: 30 },
        { left: 120, top: 242, right: 220, bottom: 268, width: 100, height: 26 },
        // A PDF.js whitespace span between two text fragments should join the line.
        { left: 220, top: 242, right: 226, bottom: 268, width: 6, height: 26 },
        { left: 232, top: 242, right: 320, bottom: 268, width: 88, height: 26 }
      ]
    })
    Object.defineProperty(surface, 'getBoundingClientRect', {
      value: () => ({ left: 100, top: 200, right: 500, bottom: 800, width: 400, height: 600 })
    })

    expect(pdfTextSelectorForRange(surface, range, 5, 'pdfjs-5.4.624')?.quads).toEqual([
      { x: 0.05, y: 1 / 15, width: 0.5, height: 0.05 }
    ])
  })
})
