import { describe, expect, it } from 'vitest'

import { applyOperations, diffPptxOutlines, readOutline, type PptxOperation } from '.'
import { PNG_BASE64, createDeckFixture } from './pptx-fixture.test-support'

const deck = createDeckFixture()
const base = readOutline(deck)
const diffAfter = (operations: PptxOperation[]): ReturnType<typeof diffPptxOutlines> =>
  diffPptxOutlines(base, readOutline(applyOperations(deck, operations).bytes))

describe('diffPptxOutlines', () => {
  it('reports nothing for identical decks', () => {
    expect(diffPptxOutlines(base, readOutline(deck))).toEqual({
      slideSizeChanged: false,
      slides: []
    })
  })

  it('lists content changes per slide', () => {
    const { slides } = diffAfter([
      { op: 'setText', slideId: 256, shapeId: 4, paragraphs: [{ runs: [{ text: 'New' }] }] },
      { op: 'setNotes', slideId: 256, text: 'Remember' },
      { op: 'setTableCellText', slideId: 256, shapeId: 5, row: 0, col: 0, paragraphs: [] },
      { op: 'replaceImage', slideId: 257, shapeId: 2, mime: 'image/png', dataBase64: PNG_BASE64 },
      { op: 'setFrame', slideId: 257, shapeId: 2, x: 0, y: 0, w: 3000, h: 2000 }
    ])
    expect(slides).toEqual([
      {
        kind: 'changed',
        slideId: 256,
        fromIndex: 0,
        toIndex: 0,
        moved: false,
        changes: ['text', 'table', 'notes']
      },
      {
        kind: 'changed',
        slideId: 257,
        fromIndex: 1,
        toIndex: 1,
        moved: false,
        changes: ['image', 'geometry']
      }
    ])
  })

  it('marks only the slide that moved, not the ones it shifted', () => {
    const { slides } = diffAfter([{ op: 'moveSlide', slideId: 258, toIndex: 0 }])
    expect(slides).toEqual([
      { kind: 'changed', slideId: 258, fromIndex: 2, toIndex: 0, moved: true, changes: [] }
    ])
  })

  it('lists added slides in place and removed slides last', () => {
    const { slides } = diffAfter([
      { op: 'deleteSlide', slideId: 256 },
      { op: 'duplicateSlide', slideId: 257 }
    ])
    expect(slides.map(({ kind, slideId }) => [kind, slideId])).toEqual([
      ['added', expect.any(Number)],
      ['removed', 256]
    ])
    expect(slides[0]).toMatchObject({ toIndex: 1 })
  })

  it('notices added shapes', () => {
    const { slides } = diffAfter([
      {
        op: 'addTextbox',
        slideId: 258,
        x: 0,
        y: 0,
        w: 10,
        h: 10,
        paragraphs: [{ runs: [{ text: 'Hi' }] }]
      }
    ])
    expect(slides).toEqual([expect.objectContaining({ slideId: 258, changes: ['shapes'] })])
  })
})
