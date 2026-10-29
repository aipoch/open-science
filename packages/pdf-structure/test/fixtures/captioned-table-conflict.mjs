/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'

export function captionedTableConflict() {
  const page = { pageNumber: 1, width: 200, height: 200, rotation: 0, invalidGraphicsBounds: 0 },
    viewport = {
      width: 200,
      height: 200,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, 200],
      convertToViewportPoint(x, y) {
        return [x, 200 - y]
      }
    },
    specs = [
      ['Table 1: Inputs', 40, 20],
      ['A', 40, 50],
      ['B', 100, 50],
      ['C', 40, 70],
      ['D', 100, 70]
    ],
    items = specs.map(([str, x, y], index) => ({
      str,
      dir: 'ltr',
      width: str.length * 5,
      height: 10,
      transform: [10, 0, 0, 10, x, 200 - y - 10],
      fontName: 'fixture-font',
      hasEOL: true,
      sourceItem: { pageNumber: 1, index, text: str }
    })),
    styles = {
      'fixture-font': { ascent: 0.7, descent: -0.2, vertical: false, fontFamily: 'serif' }
    },
    tokens = items.map((r) => tableTextToken(r, viewport, 0, styles[r.fontName])),
    table = {
      id: 'page-1-table-1',
      page: 1,
      caption: { page: 1, text: specs[0][0], lines: [specs[0][0]], rect: [...tokens[0].rect] },
      region: [35 / 200, 45 / 200, 145 / 200, 85 / 200],
      sourceViewport: { width: 300, height: 300, scale: 1.5 },
      cropRect: [52.5, 67.5, 217.5, 127.5],
      grid: [
        ['A', 'B'],
        ['C', 'D']
      ],
      cells: items.slice(1).map((r, i) => ({
        row: Math.floor(i / 2),
        column: i % 2,
        rowSpan: 1,
        colSpan: 1,
        text: r.str,
        sourceItems: [r.sourceItem],
        sourceRects: [tokens[i + 1].rect.map((n) => n * 1.5)]
      })),
      selectedTextItems: 4,
      unassigned: [],
      clipped: [],
      issues: [],
      reviewCandidate: true,
      thumbnail: 'thumbnails/page-1-table-1.png'
    },
    figure = {
      id: 'p1-figure-1',
      page: 1,
      caption: {
        page: 1,
        text: 'Figure 1: Results.',
        lines: ['Figure 1: Results.'],
        rect: [30, 130, 150, 140]
      },
      region: [30 / 200, 45 / 200, 150 / 200, 120 / 200],
      thumbnail: 'thumbnails/p1-figure-1.png',
      graphicsCount: 12
    },
    fnArray = [],
    argsArray = []
  for (const r of items) {
    fnArray.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText)
    argsArray.push(
      [],
      ['fixture-font', 10],
      r.transform,
      [
        [...r.str].map((unicode) => ({
          unicode,
          fontChar: unicode,
          width: 500,
          isInFont: true,
          isSpace: unicode === ' '
        }))
      ],
      []
    )
  }
  return {
    page,
    figure,
    tables: [table],
    tokens,
    context: {
      pageNumber: 1,
      sourceSha256: 'a'.repeat(64),
      viewport,
      content: { items, styles },
      operators: { fnArray, argsArray },
      glyphBounds: [
        {
          fontName: 'fixture-font',
          glyphs: [...new Set(items.flatMap((r) => [...r.str]))].map((fontChar) => ({
            fontChar,
            bounds: [0, -0.2, 0.5, 0.7]
          }))
        }
      ]
    }
  }
}
