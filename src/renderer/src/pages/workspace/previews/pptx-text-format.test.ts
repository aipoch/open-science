import { describe, expect, it } from 'vitest'
import { formatTextRange, paragraphsText, replaceText } from './pptx-text-format'

describe('PowerPoint text formatting', () => {
  it('splits a selection across paragraphs without altering surrounding styles', () => {
    const original = [
      { runs: [{ text: 'Hello', italic: true }] },
      { runs: [{ text: 'world', color: 'FF0000' }] }
    ]
    const result = formatTextRange(original, 2, 8, { bold: true, underline: true })
    expect(result).toEqual([
      {
        runs: [
          { text: 'He', italic: true },
          { text: 'llo', italic: true, bold: true, underline: true }
        ]
      },
      {
        runs: [
          { text: 'wo', color: 'FF0000', bold: true, underline: true },
          { text: 'rld', color: 'FF0000' }
        ]
      }
    ])
    expect(paragraphsText(result)).toBe('Hello\nworld')
    expect(original[0].runs[0].text).toBe('Hello')
  })
  it('keeps unedited runs and inherits the insertion style when pasting lines', () => {
    const original = [
      {
        runs: [
          { text: 'Hello', bold: true },
          { text: ' world', italic: true }
        ]
      }
    ]
    const result = replaceText(original, 'Hello!\nNew world')
    expect(paragraphsText(result)).toBe('Hello!\nNew world')
    expect(result[1].runs).toEqual([
      { text: 'New', bold: true },
      { text: ' world', italic: true }
    ])
    expect(paragraphsText(original)).toBe('Hello world')
  })
})
