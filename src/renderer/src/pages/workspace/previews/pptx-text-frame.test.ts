// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { measureTextFrame } from './pptx-text-frame'

afterEach(() => vi.restoreAllMocks())
it('measures mixed font runs at document scale and includes PPTX insets', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    expect(this.isConnected).toBe(true)
    expect(this.style.maxWidth).toBe('76.8px')
    const runs = this.querySelectorAll('span')
    expect(runs[0].style.fontSize).toBe('18pt')
    expect(runs[1].style.fontSize).toBe('72pt')
    expect(runs[1].style.fontWeight).toBe('bold')
    return { width: 70, height: 120 } as DOMRect
  })
  const before = document.body.childElementCount
  expect(
    measureTextFrame(
      [
        {
          runs: [
            { text: 'Small', sizePt: 18 },
            { text: 'Large', sizePt: 72, bold: true }
          ]
        }
      ],
      914400
    )
  ).toEqual({ w: 849630, h: 1234440 })
  expect(document.body.childElementCount).toBe(before)
})
it('cleans up the measuring element even if layout fails', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => {
    throw new Error('layout')
  })
  const before = document.body.childElementCount
  expect(() => measureTextFrame([], 914400)).toThrow('layout')
  expect(document.body.childElementCount).toBe(before)
})
