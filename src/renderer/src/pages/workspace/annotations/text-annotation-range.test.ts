// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import { reconcileTextAnnotationRanges } from './text-annotation-range'

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
