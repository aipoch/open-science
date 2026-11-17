import { describe, expect, it } from 'vitest'
import { strFromU8 } from 'fflate'
import { applyOperations, readOutline, pptxOperationsSchema, diffPptxOutlines } from './index'
import { createDeckFixture, unzipEntries } from './pptx-fixture.test-support'

describe('PowerPoint text format persistence', () => {
  it('round-trips all six formats and removes hyperlinks explicitly', () => {
    const original = createDeckFixture()
    const formatted = applyOperations(original, [
      {
        op: 'setText',
        slideId: 256,
        shapeId: 2,
        paragraphs: [
          {
            runs: [
              {
                text: 'Hello',
                sizePt: 24,
                bold: true,
                italic: true,
                underline: true,
                color: '12ab34',
                hyperlink: 'https://example.org/?x=1&y=2'
              }
            ]
          }
        ]
      }
    ]).bytes
    const outline = readOutline(formatted)
    expect(outline.slides[0].shapes[0].paragraphs?.[0].runs[0]).toMatchObject({
      text: 'Hello',
      sizePt: 24,
      bold: true,
      italic: true,
      underline: true,
      color: '12AB34',
      hyperlink: 'https://example.org/?x=1&y=2'
    })
    expect(strFromU8(unzipEntries(formatted)['ppt/slides/_rels/slide1.xml.rels'])).toContain(
      'TargetMode="External"'
    )
    expect(diffPptxOutlines(readOutline(original), outline).slides[0]).toMatchObject({
      changes: ['text']
    })
    const cleared = applyOperations(formatted, [
      {
        op: 'setText',
        slideId: 256,
        shapeId: 2,
        paragraphs: [
          { runs: [{ text: 'Hello', bold: false, italic: false, underline: false, hyperlink: '' }] }
        ]
      }
    ]).bytes
    expect(readOutline(cleared).slides[0].shapes[0].paragraphs?.[0].runs[0]).toMatchObject({
      bold: false,
      italic: false,
      underline: false
    })
    expect(strFromU8(unzipEntries(cleared)['ppt/slides/slide1.xml'])).not.toContain('hlinkClick')
  })
  it('rejects unsafe links at the operation boundary', () => {
    for (const hyperlink of ['javascript:alert(1)', 'file:///tmp/private', 'https://']) {
      expect(
        pptxOperationsSchema.safeParse([
          {
            op: 'setText',
            slideId: 256,
            shapeId: 2,
            paragraphs: [{ runs: [{ text: 'x', hyperlink }] }]
          }
        ]).success
      ).toBe(false)
    }
  })
})

it('saves fitted text and its frame in one replayable operation', () => {
  const original = createDeckFixture()
  const result = applyOperations(original, [
    {
      op: 'setText',
      slideId: 256,
      shapeId: 2,
      paragraphs: [{ runs: [{ text: 'Large text', sizePt: 72, fontFamily: 'Arial' }] }],
      frame: { x: 100, y: 200, w: 3740022, h: 1188601, rotationDeg: 15 }
    }
  ])
  const shape = readOutline(result.bytes).slides[0].shapes[0]
  expect(shape.frame).toEqual({ x: 100, y: 200, w: 3740022, h: 1188601, rotationDeg: 15 })
  expect(shape.paragraphs?.[0].runs[0]).toMatchObject({
    text: 'Large text',
    sizePt: 72,
    fontFamily: 'Arial'
  })
})
