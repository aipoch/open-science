// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'

import { anchorRangeTrigger, isBackwardSelection } from './annotation-trigger-anchor'

const rect = (left: number, top: number, right: number, bottom: number): DOMRect =>
  ({
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
    toJSON: () => ({})
  }) as DOMRect

describe('anchorRangeTrigger', () => {
  const viewport = { width: 500, height: 300, triggerWidth: 88, triggerHeight: 28 }

  afterEach(() => {
    document.body.innerHTML = ''
    document.getSelection()?.removeAllRanges()
  })

  const selectWithRects = (rects: DOMRect[], bounding: DOMRect, backward = false): Selection => {
    const paragraph = document.createElement('p')
    paragraph.textContent = 'first line then second line'
    document.body.appendChild(paragraph)
    const text = paragraph.firstChild!
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 5)
    Object.defineProperty(range, 'getClientRects', {
      configurable: true,
      value: () => rects
    })
    Object.defineProperty(range, 'getBoundingClientRect', {
      configurable: true,
      value: () => bounding
    })
    const selection = document.getSelection()!
    selection.removeAllRanges()
    if (backward) {
      // The user dragged backwards: the focus end sits earlier in the document.
      selection.setBaseAndExtent(text, 5, text, 0)
    } else {
      selection.setBaseAndExtent(text, 0, text, 5)
    }
    Object.defineProperty(selection, 'getRangeAt', {
      configurable: true,
      value: () => range
    })
    return selection
  }

  it('anchors a forward selection at its last line in viewport coordinates', () => {
    const selection = selectWithRects(
      [rect(100, 20, 300, 40), rect(100, 50, 120, 70)],
      rect(100, 20, 300, 70)
    )

    expect(anchorRangeTrigger(selection.getRangeAt(0), false, viewport)).toEqual({
      left: 126,
      top: 76
    })
  })

  it('anchors a backward selection at its first line', () => {
    const selection = selectWithRects(
      [rect(100, 20, 300, 40), rect(100, 50, 120, 70)],
      rect(100, 20, 300, 70),
      true
    )

    expect(isBackwardSelection(selection)).toBe(true)
    expect(anchorRangeTrigger(selection.getRangeAt(0), true, viewport)).toEqual({
      left: 306,
      top: 46
    })
  })

  it('keeps the complete trigger inside the viewport', () => {
    const selection = selectWithRects([rect(100, 20, 480, 40)], rect(100, 20, 480, 40))

    expect(anchorRangeTrigger(selection.getRangeAt(0), false, viewport)).toEqual({
      left: 404,
      top: 46
    })
  })

  it('flips above a selection near the bottom edge', () => {
    const selection = selectWithRects([rect(100, 270, 200, 290)], rect(100, 270, 200, 290))

    expect(anchorRangeTrigger(selection.getRangeAt(0), false, viewport)).toEqual({
      left: 206,
      top: 236
    })
  })
})
