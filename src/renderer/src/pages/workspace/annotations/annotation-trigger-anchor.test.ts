// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'

import {
  anchorRangeTrigger,
  isBackwardSelection,
  isRangeTriggerVisible
} from './annotation-trigger-anchor'

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

describe('isRangeTriggerVisible', () => {
  const viewport = { width: 500, height: 300 }

  afterEach(() => {
    document.body.innerHTML = ''
    document.getSelection()?.removeAllRanges()
  })

  const selectWithRects = (rects: DOMRect[], bounding: DOMRect): Range => {
    const paragraph = document.createElement('p')
    paragraph.textContent = 'selectable agent reply'
    document.body.appendChild(paragraph)
    const text = paragraph.firstChild!
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 10)
    Object.defineProperty(range, 'getClientRects', {
      configurable: true,
      value: () => rects
    })
    Object.defineProperty(range, 'getBoundingClientRect', {
      configurable: true,
      value: () => bounding
    })
    return range
  }

  it('keeps the trigger when geometry methods are missing', () => {
    const paragraph = document.createElement('p')
    paragraph.textContent = 'selectable agent reply'
    document.body.appendChild(paragraph)
    const range = document.createRange()
    range.selectNodeContents(paragraph.firstChild!)
    Object.defineProperty(range, 'getClientRects', { configurable: true, value: undefined })
    Object.defineProperty(range, 'getBoundingClientRect', { configurable: true, value: undefined })

    expect(isRangeTriggerVisible(range, false, viewport)).toBe(true)
  })

  it('keeps the trigger when jsdom reports a zero-size rectangle', () => {
    const range = selectWithRects([], new DOMRect())

    expect(isRangeTriggerVisible(range, false, viewport)).toBe(true)
  })

  it('hides the trigger when the cloned range was never connected', () => {
    const paragraph = document.createElement('p')
    paragraph.textContent = 'selectable agent reply'
    const range = document.createRange()
    range.setStart(paragraph.firstChild!, 0)
    range.setEnd(paragraph.firstChild!, 10)
    Object.defineProperty(range, 'getClientRects', {
      configurable: true,
      value: () => [rect(100, 20, 180, 40)]
    })
    Object.defineProperty(range, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(100, 20, 180, 40)
    })

    expect(range.commonAncestorContainer.isConnected).toBe(false)
    expect(isRangeTriggerVisible(range, false, viewport)).toBe(false)
  })

  it('hides the trigger when removing the quoted nodes collapses the cloned range', () => {
    const range = selectWithRects([rect(100, 20, 180, 40)], rect(100, 20, 180, 40))
    range.commonAncestorContainer.parentElement?.remove()

    expect(range.collapsed).toBe(true)
    expect(isRangeTriggerVisible(range, false, viewport)).toBe(false)
  })

  it('keeps the trigger when client rects are empty boxes and only the bounding box is empty', () => {
    const range = selectWithRects([new DOMRect()], new DOMRect())

    expect(isRangeTriggerVisible(range, false, viewport)).toBe(true)
  })

  it('keeps the trigger when the selection intersects the window', () => {
    const range = selectWithRects([rect(100, 20, 180, 40)], rect(100, 20, 180, 40))

    expect(isRangeTriggerVisible(range, false, viewport)).toBe(true)
  })

  it('hides the trigger when the selection leaves the window', () => {
    const range = selectWithRects([rect(100, 400, 180, 420)], rect(100, 400, 180, 420))

    expect(isRangeTriggerVisible(range, false, viewport)).toBe(false)
  })

  it('hides the trigger when an overflow ancestor clips the selection', () => {
    const viewportElement = document.createElement('div')
    viewportElement.style.overflow = 'auto'
    const paragraph = document.createElement('p')
    paragraph.textContent = 'selectable agent reply'
    viewportElement.appendChild(paragraph)
    document.body.appendChild(viewportElement)
    Object.defineProperty(viewportElement, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(0, 0, 200, 80)
    })
    const range = document.createRange()
    range.selectNodeContents(paragraph.firstChild!)
    Object.defineProperty(range, 'getClientRects', {
      configurable: true,
      value: () => [rect(10, 120, 120, 140)]
    })
    Object.defineProperty(range, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(10, 120, 120, 140)
    })

    expect(isRangeTriggerVisible(range, false, viewport)).toBe(false)
  })

  it('keeps the trigger when an overflow ancestor still contains the selection', () => {
    const viewportElement = document.createElement('div')
    viewportElement.style.overflow = 'auto'
    const paragraph = document.createElement('p')
    paragraph.textContent = 'selectable agent reply'
    viewportElement.appendChild(paragraph)
    document.body.appendChild(viewportElement)
    Object.defineProperty(viewportElement, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(0, 0, 200, 80)
    })
    const range = document.createRange()
    range.selectNodeContents(paragraph.firstChild!)
    Object.defineProperty(range, 'getClientRects', {
      configurable: true,
      value: () => [rect(10, 20, 120, 40)]
    })
    Object.defineProperty(range, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(10, 20, 120, 40)
    })

    expect(isRangeTriggerVisible(range, false, viewport)).toBe(true)
  })

  it('keeps the trigger when an overflow ancestor reports a zero-size rectangle', () => {
    const viewportElement = document.createElement('div')
    viewportElement.style.overflow = 'hidden'
    const paragraph = document.createElement('p')
    paragraph.textContent = 'selectable agent reply'
    viewportElement.appendChild(paragraph)
    document.body.appendChild(viewportElement)
    Object.defineProperty(viewportElement, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(0, 0, 0, 0)
    })
    const range = document.createRange()
    range.selectNodeContents(paragraph.firstChild!)
    Object.defineProperty(range, 'getClientRects', {
      configurable: true,
      value: () => [rect(10, 20, 180, 40)]
    })
    Object.defineProperty(range, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(10, 20, 180, 40)
    })

    expect(isRangeTriggerVisible(range, false, viewport)).toBe(true)
  })

  it('keeps the trigger when the window viewport has no usable size', () => {
    const range = selectWithRects([rect(10, 20, 180, 40)], rect(10, 20, 180, 40))

    expect(isRangeTriggerVisible(range, false, { width: 0, height: 0 })).toBe(true)
  })
})
