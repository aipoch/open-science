/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { expect, it } from 'vitest'
import { nativeFigureLabelBounds } from '../resources/literature-pdf-figure-crop-geometry.mjs'
import { nativeFormSourceCrop } from '../resources/literature-pdf-figure-native-form-crop.mjs'
import { captureAnonymousVerticalFigure } from './fixtures/vertical-native-subcaptions.mjs'

const text = (label: string, x: number, y: number, rotated = false) =>
  `BT /R 10 Tf ${rotated ? '0 1 -1 0' : '1 0 0 1'} ${x} ${700 - y} Tm (${label}) Tj ET`
const stream = (dictionary: string, body: string) =>
  `<< ${dictionary} /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`

async function inspect(kind: 'plot' | 'diagrams', foreign = false) {
  const plot = kind === 'plot',
    formHeader =
      '/Type /XObject /Subtype /Form /FormType 1 /BBox [60 390 380 550] /Resources << /Font << /R 4 0 R >> >>',
    panel = (x: number, label: string) =>
      `${x} 450 85 40 re S ${x + 25} 500 35 15 re S ${x + 42} 490 m ${x + 42} 500 l S ${text(label, x + 3, 230)}`,
    caption = text('Figure 2: Grouped sample diagrams', 100, plot ? 324 : 180),
    body = plot
      ? `/P0 Do ${caption}`
      : `${caption} /P0 Do /P1 Do ${text('Ordinary prose follows below.', 95, 266)} ${foreign ? text('Independent text in the gap.', 185, 218) : ''}`,
    forms = plot
      ? [
          `105 440 220 75 re S 115 452 24 50 re f 155 455 24 20 re f ${text('Response level', 92, 255, true)} ${text('Sample measurements', 160, 281)}`
        ]
      : [panel(105, 'First sample'), panel(235, 'Second sample')],
    original = plot ? [101, 180, 329, 265] : [95, 172, 330, 270],
    fixture = await captureAnonymousVerticalFigure(
      [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Resources << /Font << /R 4 0 R >> /XObject << /P0 6 0 R ${plot ? '' : '/P1 7 0 R'} >> >> /Contents 5 0 R >>`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        stream('', body),
        ...forms.map((form) => stream(formHeader, form))
      ],
      original
    )
  try {
    expect(fixture.context).toBeTruthy()
    expect(fixture.figure.caption).toBeTruthy()
    return await nativeFormSourceCrop(
      fixture.page,
      { ...fixture.figure, ...(plot ? { reason: 'native-raster-vector-strip' } : {}) },
      fixture.figure.caption,
      original,
      fixture.tokens.map((token) => {
        const item = fixture.context.content.items[token.sourceItem.index]
        return {
          ...token,
          nativeLabelRect: nativeFigureLabelBounds(
            item,
            fixture.context.content.styles[item.fontName],
            fixture.context.viewport
          )
        }
      }),
      fixture.context,
      [],
      fixture.nativePage
    )
  } finally {
    await fixture.cleanup()
  }
}

it('recovers rotated and bottom axis labels painted by one original form', async () => {
  const crop = await inspect('plot')
  expect(crop).toBeDefined()
  expect(crop.rect[0]).toBeLessThan(92)
  expect(crop.rect[3]).toBeGreaterThan(280)
})

it('keeps side-by-side diagrams inside their external caption and prose', async () => {
  const crop = await inspect('diagrams')
  expect(crop).toBeDefined()
  expect(crop.rect[1]).toBeGreaterThan(181)
  expect(crop.rect[3]).toBeLessThan(255)
  expect(crop.rect[0]).toBeLessThan(105)
  expect(crop.rect[2]).toBeGreaterThan(320)
})

it('keeps the existing crop when unrelated text paints between the diagrams', async () => {
  expect(await inspect('diagrams', true)).toBeUndefined()
})

async function inspectIndependentPlots(fault?: 'outside-label') {
  const plot = (x: number, label: string) =>
      `${x} 440 165 105 re S ${x + 18} 447 32 50 re f ${x + 65} 447 21 81 re f ${text(label, x + 24, 245)}`,
    body = [
      '/P0 Do',
      text('Figure 1: First measurement.', 74, 284),
      '/P1 Do',
      ...(fault === 'outside-label' ? [text('External overlay', 370, 177)] : []),
      text('Figure 2: Second measurement.', 330, 284)
    ].join(' '),
    formHeader =
      '/Type /XObject /Subtype /Form /FormType 1 /BBox [65 425 535 565] /Resources << /Font << /R 4 0 R >> >>',
    candidate = [96, 150, 513, 265],
    peerRect = [69, 151, 350, 265],
    fixture = await captureAnonymousVerticalFigure(
      [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Resources << /Font << /R 4 0 R >> /XObject << /P0 6 0 R /P1 7 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        stream('', body),
        stream(formHeader, plot(75, 'Recorded first label')),
        stream(formHeader, plot(330, 'Recorded second label'))
      ],
      candidate
    )
  try {
    const [first, second] = fixture.captions.toSorted(
      (a: { rect: number[] }, b: { rect: number[] }) => a.rect[0] - b.rect[0]
    )
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    const tokens = fixture.tokens.map((token) => {
      const item = fixture.context.content.items[token.sourceItem.index]
      return {
        ...token,
        nativeLabelRect: nativeFigureLabelBounds(
          item,
          fixture.context.content.styles[item.fontName],
          fixture.context.viewport
        )
      }
    })
    return await nativeFormSourceCrop(
      fixture.page,
      { rect: candidate, caption: second },
      second,
      candidate,
      tokens,
      fixture.context,
      [first.rect, peerRect],
      fixture.nativePage,
      [{ rect: peerRect, caption: first }]
    )
  } finally {
    await fixture.cleanup()
  }
}

it('uses the independently captioned vector form when the peer crop catches its left neighbor', async () => {
  const crop = await inspectIndependentPlots()
  expect(crop).toBeDefined()
  expect(crop.rect[0]).toBeGreaterThan(300)
  expect(crop.rect[0]).toBeLessThan(330)
  expect(crop.rect[2]).toBeGreaterThan(495)
  expect(crop.rect[3]).toBeGreaterThan(260)
})

it('keeps a separately captioned vector crop when an unrelated glyph is painted inside the form', async () => {
  expect(await inspectIndependentPlots('outside-label')).toBeUndefined()
})

async function inspectVectorGridWithLeadingProse(foreignInChart = false) {
  const marks = Array.from({ length: 12 }, (_, n) => `${91 + n * 12} 427 1 20 re S`).join(' '),
    form = `75 389 200 100 re S ${marks} ${text('Native chart legend', 92, 236)}`,
    body = [
      text('The complete preceding sentence descends in', 75, 170),
      text('the same row context before this chart.', 75, 183),
      '/P0 Do',
      ...(foreignInChart ? [text('Outside form caption overlay', 98, 257)] : []),
      text('Figure 1: Native chart.', 75, 332)
    ].join(' '),
    old = [70, 169, 280, 316],
    fixture = await captureAnonymousVerticalFigure(
      [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Resources << /Font << /R 4 0 R >> /XObject << /P0 6 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        stream('', body),
        stream(
          '/Type /XObject /Subtype /Form /FormType 1 /BBox [65 380 285 500] /Resources << /Font << /R 4 0 R >> >>',
          form
        )
      ],
      old
    )
  try {
    expect(fixture.figure.caption).toBeDefined()
    const tokens = fixture.tokens.map((token) => {
      const item = fixture.context.content.items[token.sourceItem.index]
      return {
        ...token,
        nativeLabelRect: nativeFigureLabelBounds(
          item,
          fixture.context.content.styles[item.fontName],
          fixture.context.viewport
        )
      }
    })
    return await nativeFormSourceCrop(
      fixture.page,
      { ...fixture.figure, reason: 'native-vector-table-grid' },
      fixture.figure.caption,
      old,
      tokens,
      fixture.context,
      [],
      fixture.nativePage
    )
  } finally {
    await fixture.cleanup()
  }
}

it('separates column prose above a complete native vector grid without moving its other edges', async () => {
  const crop = await inspectVectorGridWithLeadingProse()
  expect(crop).toBeDefined()
  expect(crop.rect[1]).toBeGreaterThan(195)
  expect(crop.rect[1]).toBeLessThan(212)
  expect([crop.rect[0], ...crop.rect.slice(2)]).toEqual([70, 280, 316])
})

it('retains the vector grid crop when text outside the form is painted inside the chart', async () => {
  expect(await inspectVectorGridWithLeadingProse(true)).toBeUndefined()
})
