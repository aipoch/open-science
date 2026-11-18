import type { PptxOperation } from './operations'
import { PNG_BASE64 } from './pptx-fixture.test-support'

const para = (text: string): { runs: { text: string }[] }[] => [{ runs: [{ text }] }]

// Exercises every operation kind against createDeckFixture().
export const EVERY_OPERATION: PptxOperation[] = [
  { op: 'setText', slideId: 256, shapeId: 2, paragraphs: para('Edited') },
  { op: 'setFrame', slideId: 256, shapeId: 3, x: 10, y: 10, w: 3000, h: 1500 },
  { op: 'addTextbox', slideId: 257, x: 100, y: 100, w: 2000, h: 500, paragraphs: para('Box') },
  { op: 'setTableCellText', slideId: 256, shapeId: 5, row: 0, col: 1, paragraphs: para('T') },
  { op: 'setChartText', slideId: 258, shapeId: 2, target: 'title', text: 'Chart' },
  { op: 'replaceImage', slideId: 257, shapeId: 2, mime: 'image/png', dataBase64: PNG_BASE64 },
  { op: 'setNotes', slideId: 257, text: 'Notes' },
  { op: 'duplicateSlide', slideId: 256 },
  { op: 'addSlide', afterSlideId: 258 },
  { op: 'moveSlide', slideId: 258, toIndex: 0 },
  { op: 'deleteShape', slideId: 257, shapeId: 3 },
  { op: 'deleteSlide', slideId: 257 }
]
