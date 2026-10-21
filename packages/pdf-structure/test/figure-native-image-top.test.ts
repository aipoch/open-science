import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { nativeProseInkTopLimit } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-crop-geometry.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> => ({
  figure: {
    rect: [20, 100, 220, 240],
    excludedProseLines: [{ x: 20, y: 89, width: 200, height: 10 }]
  },
  tokens: [
    {
      text: 'Anonymous preceding prose.',
      horizontal: true,
      rect: [20, 89, 220, 99],
      baseline: 99,
      height: 10,
      fontDescent: -0.3
    },
    { text: '(a)', horizontal: true, rect: [30, 110, 42, 120] }
  ],
  page: {
    width: 256,
    height: 768,
    graphicsBounds: [
      {
        kind: 'image',
        operationIndex: 1,
        normalizedRect: [20 / 256, 100 / 768, 220 / 256, 240 / 768]
      }
    ]
  },
  context: {
    viewport: { transform: [1, 0, 0, 1, 0, 0] },
    operators: {
      fnArray: [OPS.transform, OPS.paintImageXObject],
      argsArray: [[200, 0, 0, 138, 20, 102], ['image']]
    }
  }
})
it('removes only the quantized strip before a native image when excluded body ink crosses it', () => {
  const x = fixture(),
    before = JSON.stringify(x)
  expect(nativeProseInkTopLimit(x.figure, x.tokens, x.page, x.context)).toBe(102)
  expect(JSON.stringify(x)).toBe(before)
})
it.each([
  'label in strip',
  'other paint in strip',
  'missing image operation',
  'larger than quantization'
])('keeps the established crop without independent complete paint evidence: %s', (variant) => {
  const x = fixture()
  if (variant === 'label in strip') x.tokens[1].rect = [30, 100, 42, 110]
  if (variant === 'other paint in strip')
    x.page.graphicsBounds.push({
      kind: 'path',
      normalizedRect: [20 / 256, 100 / 768, 40 / 256, 110 / 768]
    })
  if (variant === 'missing image operation')
    x.context.operators.fnArray[1] = OPS.paintImageMaskXObject
  if (variant === 'larger than quantization') x.context.operators.argsArray[0][5] = 104
  expect(nativeProseInkTopLimit(x.figure, x.tokens, x.page, x.context)).toBe(0)
})

it.each([OPS.beginAnnotation, OPS.endAnnotation, OPS.beginGroup, OPS.endGroup])(
  'keeps the crop for an untracked transform scope %s',
  (operation) => {
    const x = fixture()
    x.context.operators.fnArray.splice(1, 0, operation)
    x.context.operators.argsArray.splice(1, 0, [])
    x.page.graphicsBounds[0].operationIndex = 2
    expect(nativeProseInkTopLimit(x.figure, x.tokens, x.page, x.context)).toBe(0)
  }
)
