import { strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { applyOperations, PptxEditError, readOutline, type PptxOperation } from './index'
import { PNG_BASE64, createDeckFixture, unzipEntries } from './pptx-fixture.test-support'

const apply = (
  ops: PptxOperation[],
  bytes = createDeckFixture()
): ReturnType<typeof applyOperations> => applyOperations(bytes, ops)
const text = (bytes: Uint8Array, name: string): string => strFromU8(unzipEntries(bytes)[name]!)
const run = (t: string): { runs: { text: string }[] } => ({ runs: [{ text: t }] })

describe('readOutline', () => {
  it('describes slides, shapes, tables, charts, pictures and notes', () => {
    const outline = readOutline(createDeckFixture())
    expect(outline.slides.map((s) => s.slideId)).toEqual([256, 257, 258])
    expect(outline.slideSize).toEqual({ cx: 9144000, cy: 5143500 })
    expect(outline.layouts).toEqual([
      { part: 'ppt/slideLayouts/slideLayout1.xml', name: 'Title and Content' }
    ])
    const [one, two, three] = outline.slides
    expect(one!.notes).toBe('First notes')
    expect(one!.shapes[0]).toMatchObject({ shapeId: 2, kind: 'text', text: 'Hello' })
    expect(one!.shapes[1]).toMatchObject({
      kind: 'group',
      children: [{ shapeId: 4, text: 'Grouped text' }]
    })
    expect(one!.shapes[2]!.table).toEqual([
      ['A1', 'B1'],
      ['A2', 'B2']
    ])
    expect(two!.shapes[0]).toMatchObject({ kind: 'picture', mediaPart: 'ppt/media/image1.png' })
    expect(two!.shapes[1]!.frame).toBeUndefined()
    expect(two!.notes).toBe('')
    expect(three!.shapes[0]!.chart).toEqual({
      title: 'Revenue',
      categoryAxisTitle: undefined,
      valueAxisTitle: undefined,
      series: [{ name: '2025', categories: ['Q1', 'Q2'] }]
    })
  })
})

describe('setText and setFrame', () => {
  it('replaces text but keeps paragraph and run properties and untouched parts', () => {
    const before = unzipEntries(createDeckFixture())
    const { bytes } = apply([{ op: 'setText', slideId: 256, shapeId: 2, paragraphs: [run('Bye')] }])
    const xml = text(bytes, 'ppt/slides/slide1.xml')
    expect(xml).toContain('<a:t>Bye</a:t>')
    expect(xml).toContain('algn="ctr"')
    expect(xml).toContain('sz="3200"')
    expect(xml).toContain('222222')
    const after = unzipEntries(bytes)
    for (const name of Object.keys(before)) {
      if (name === 'ppt/slides/slide1.xml') continue
      expect(after[name], name).toEqual(before[name])
    }
  })

  it('applies run formatting overrides', () => {
    const { bytes } = apply([
      {
        op: 'setText',
        slideId: 256,
        shapeId: 2,
        paragraphs: [{ runs: [{ text: 'A', bold: true, sizePt: 20, color: 'ff0000' }] }]
      }
    ])
    const xml = text(bytes, 'ppt/slides/slide1.xml')
    expect(xml).toMatch(/<a:rPr[^>]*b="1"/)
    expect(xml).toContain('sz="2000"')
    expect(xml).toContain('FF0000')
    expect(xml.match(/222222/g)).toHaveLength(1) // only the untouched grouped child keeps it
  })

  it('inserts a frame for shapes that inherit their position', () => {
    const { bytes } = apply([
      { op: 'setFrame', slideId: 257, shapeId: 3, x: 10, y: 20, w: 300, h: 400, rotationDeg: 90 }
    ])
    const shape = readOutline(bytes).slides[1]!.shapes[1]!
    expect(shape.frame).toEqual({ x: 10, y: 20, w: 300, h: 400, rotationDeg: 90 })
  })

  it('moves a group and a table frame', () => {
    const { bytes } = apply([
      { op: 'setFrame', slideId: 256, shapeId: 3, x: 5, y: 6, w: 4000, h: 2000 },
      { op: 'setFrame', slideId: 256, shapeId: 5, x: 1, y: 2, w: 3, h: 4 }
    ])
    const [, group, table] = readOutline(bytes).slides[0]!.shapes
    expect(group!.frame).toMatchObject({ x: 5, y: 6, w: 4000, h: 2000 })
    expect(table!.frame).toMatchObject({ x: 1, y: 2, w: 3, h: 4 })
  })
})

describe('shape operations', () => {
  it('adds a text box with a fresh id and deletes shapes', () => {
    const added = apply([
      { op: 'addTextbox', slideId: 257, x: 1, y: 2, w: 3, h: 4, paragraphs: [run('New')] }
    ])
    const shapes = readOutline(added.bytes).slides[1]!.shapes
    expect(shapes[2]).toMatchObject({ shapeId: 4, kind: 'text', text: 'New' })
    const removed = apply([{ op: 'deleteShape', slideId: 257, shapeId: 4 }], added.bytes)
    expect(readOutline(removed.bytes).slides[1]!.shapes).toHaveLength(2)
  })

  it('edits table cells and rejects cells outside the table', () => {
    const { bytes } = apply([
      { op: 'setTableCellText', slideId: 256, shapeId: 5, row: 1, col: 0, paragraphs: [run('Z')] }
    ])
    expect(readOutline(bytes).slides[0]!.shapes[2]!.table).toEqual([
      ['A1', 'B1'],
      ['Z', 'B2']
    ])
    expect(() =>
      apply([{ op: 'setTableCellText', slideId: 256, shapeId: 5, row: 9, col: 0, paragraphs: [] }])
    ).toThrow(expect.objectContaining({ code: 'SHAPE_NOT_FOUND' }))
  })

  it('edits chart text', () => {
    const { bytes } = apply([
      { op: 'setChartText', slideId: 258, shapeId: 2, target: 'title', text: 'Sales' },
      {
        op: 'setChartText',
        slideId: 258,
        shapeId: 2,
        target: 'seriesName',
        index: 0,
        text: '2026'
      },
      { op: 'setChartText', slideId: 258, shapeId: 2, target: 'category', index: 1, text: 'H2' },
      { op: 'setChartText', slideId: 258, shapeId: 2, target: 'valueAxisTitle', text: 'USD' }
    ])
    expect(readOutline(bytes).slides[2]!.shapes[0]!.chart).toEqual({
      title: 'Sales',
      categoryAxisTitle: undefined,
      valueAxisTitle: 'USD',
      series: [{ name: '2026', categories: ['Q1', 'H2'] }]
    })
    expect(text(bytes, 'ppt/charts/chart1.xml')).toContain('Sheet1!$B$1')
  })

  it('replaces a picture with a new media part and keeps the old one', () => {
    const { bytes } = apply([
      { op: 'replaceImage', slideId: 257, shapeId: 2, mime: 'image/png', dataBase64: PNG_BASE64 }
    ])
    expect(readOutline(bytes).slides[1]!.shapes[0]!.mediaPart).toBe('ppt/media/image2.png')
    expect(Object.keys(unzipEntries(bytes))).toContain('ppt/media/image1.png')
  })

  it('rejects image bytes that do not match the declared type', () => {
    expect(() =>
      apply([
        { op: 'replaceImage', slideId: 257, shapeId: 2, mime: 'image/jpeg', dataBase64: PNG_BASE64 }
      ])
    ).toThrow(expect.objectContaining({ code: 'INVALID_OPERATION' }))
  })
})

describe('notes', () => {
  it('updates existing notes and creates notes for slides without them', () => {
    const { bytes } = apply([
      { op: 'setNotes', slideId: 256, text: 'Updated' },
      { op: 'setNotes', slideId: 257, text: 'Line 1\nLine 2' }
    ])
    const slides = readOutline(bytes).slides
    expect(slides[0]!.notes).toBe('Updated')
    expect(slides[1]!.notes).toBe('Line 1\nLine 2')
    expect(text(bytes, '[Content_Types].xml')).toContain('/ppt/notesSlides/notesSlide2.xml')
  })
})

describe('slide operations', () => {
  const ids = (bytes: Uint8Array): number[] => readOutline(bytes).slides.map((s) => s.slideId)

  it('adds a slide from the layout with placeholders and syncs the slide count', () => {
    const { bytes, slideCount } = apply([{ op: 'addSlide', afterSlideId: 256 }])
    expect(slideCount).toBe(4)
    expect(ids(bytes)).toEqual([256, 259, 257, 258])
    const added = readOutline(bytes).slides[1]!
    expect(added.layoutPart).toBe('ppt/slideLayouts/slideLayout1.xml')
    expect(added.shapes.map((s) => s.kind)).toEqual(['text', 'text'])
    expect(text(bytes, 'docProps/app.xml')).toContain('<Slides>4</Slides>')
    expect(text(bytes, '[Content_Types].xml')).toContain('/ppt/slides/slide4.xml')
  })

  it('duplicates a slide together with its notes', () => {
    const { bytes } = apply([{ op: 'duplicateSlide', slideId: 256 }])
    expect(ids(bytes)).toEqual([256, 259, 257, 258])
    const copy = readOutline(bytes).slides[1]!
    expect(copy.notes).toBe('First notes')
    expect(copy.part).not.toBe('ppt/slides/slide1.xml')
    const notesRels = text(bytes, 'ppt/notesSlides/_rels/notesSlide2.xml.rels')
    expect(notesRels).toContain(`../slides/${copy.part.split('/').pop()}`)
  })

  it('moves slides by id and clamps the target index', () => {
    expect(ids(apply([{ op: 'moveSlide', slideId: 258, toIndex: 0 }]).bytes)).toEqual([
      258, 256, 257
    ])
    expect(ids(apply([{ op: 'moveSlide', slideId: 256, toIndex: 99 }]).bytes)).toEqual([
      257, 258, 256
    ])
  })

  it('deletes a slide with its notes and relationships, but never the last slide', () => {
    const { bytes } = apply([{ op: 'deleteSlide', slideId: 256 }])
    expect(ids(bytes)).toEqual([257, 258])
    const names = Object.keys(unzipEntries(bytes))
    expect(names).not.toContain('ppt/slides/slide1.xml')
    expect(names).not.toContain('ppt/notesSlides/notesSlide1.xml')
    expect(text(bytes, '[Content_Types].xml')).not.toContain('slide1.xml')
    expect(() =>
      apply([
        { op: 'deleteSlide', slideId: 256 },
        { op: 'deleteSlide', slideId: 257 },
        { op: 'deleteSlide', slideId: 258 }
      ])
    ).toThrow(expect.objectContaining({ code: 'INVALID_OPERATION' }))
  })
})

describe('error handling', () => {
  it('reports unknown slides and shapes with stable codes', () => {
    expect(() => apply([{ op: 'deleteShape', slideId: 999, shapeId: 1 }])).toThrow(
      expect.objectContaining({ code: 'SLIDE_NOT_FOUND' })
    )
    expect(() => apply([{ op: 'deleteShape', slideId: 256, shapeId: 999 }])).toThrow(
      expect.objectContaining({ code: 'SHAPE_NOT_FOUND' })
    )
  })

  it('rejects malformed operations, non-zip input and DOCTYPE parts', () => {
    expect(() => applyOperations(createDeckFixture(), [{ op: 'nope' }])).toThrow(PptxEditError)
    expect(() =>
      applyOperations(new Uint8Array([1, 2, 3]), [{ op: 'deleteSlide', slideId: 1 }])
    ).toThrow(expect.objectContaining({ code: 'INVALID_PACKAGE' }))
  })
})
