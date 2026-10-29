/* eslint-disable @typescript-eslint/explicit-function-return-type -- retain inferred native fixture types */
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'

export function dividedNativeReferences() {
  const item = (
    str: string,
    x: number,
    y: number,
    width: number,
    fontName = 'Body',
    height = 8,
    hasEOL = true
  ) => ({
    str,
    dir: 'ltr',
    width,
    height,
    transform: [height, 0, 0, height, x, 800 - y],
    fontName,
    hasEOL
  })
  const ordinary =
    'The independent discussion describes ordinary measurements, explains the controls, and records the resulting observations.'
  const items = [
    item('1', 550, 30, 6, 'Body', 12),
    item('The independent discussion ends with an ambiguous-', 60, 180, 430, 'Body', 12),
    item('continuation and keeps its original source and warning.', 60, 194, 430, 'Body', 12)
  ]
  for (let n = 1; n <= 8; n++) {
    const x = n <= 4 ? 60 : 330,
      y = 500 + ((n - 1) % 4) * 20
    if (n === 4) {
      items.push(
        item(`[${n}] A. Writer,`, x, y, 60, 'Body', 8, false),
        item('An independent handbook', x + 62, y, 150, 'Title'),
        item('(Example Press, City, 2020).', x + 20, y + 10, 190)
      )
    } else {
      items.push(item(`[${n}] A. Writer, Measured response, Independent Journal`, x, y, 220))
      if (n === 8) items.push(item('10.1234/example.2020 (2020).', x + 20, y + 10, 180))
      else {
        items.push(
          item(String(n + 10), x + 20, y + 10, 8, 'Volume', 8, false),
          item(', 123 (2020).', x + 30, y + 10, 100)
        )
      }
    }
  }
  const styles = Object.fromEntries(
    ['Body', 'Volume', 'Title'].map((id) => [id, { ascent: 0.8, descent: -0.2, vertical: false }])
  )
  const fonts = Object.fromEntries(
    Object.keys(styles).map((id) => [
      id,
      {
        ...styles[id],
        missingFile: false,
        isType3Font: false,
        isInvalidPDFjsFont: false,
        systemFontInfo: null
      }
    ])
  )
  const operators: { fnArray: number[]; argsArray: unknown[][] } = {
    fnArray: [OPS.constructPath],
    argsArray: [[OPS.stroke, [new Float32Array([0, 180, 400, 1, 420, 400])]]]
  }
  const page = {
    rotate: 0,
    commonObjs: {
      has: (id: string) => !!fonts[id],
      get: (id: string) => fonts[id]
    },
    getViewport: () => ({ width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] }),
    getTextContent: async () => ({ items, styles }),
    getOperatorList: async () => operators
  }
  return {
    ordinary,
    items,
    styles,
    fonts,
    operators,
    page,
    document: {
      numPages: 1,
      fingerprints: ['anonymous-divided-source'],
      getPage: async () => page
    } as unknown as PDFDocumentProxy
  }
}
