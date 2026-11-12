/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captureAnonymousHeader } from './single-parent-math-header.mjs'

export async function anonymousSparseCitedHierarchy({ bands = 2, mode = '' } = {}) {
  if (![2, 4].includes(bands)) throw new Error('Use two or four anonymous parent bands')
  const text = (value, x, y) => `BT /F 10 Tf ${x} ${400 - y} Td (${value}) Tj ET`,
    top = 100,
    divider = 120,
    bandHeight = 60,
    bottom = divider + bands * bandHeight,
    rails = [
      top,
      divider,
      ...Array.from({ length: bands }, (_, n) => divider + (n + 1) * bandHeight)
    ],
    stream = [
      text('Table', 40, 90),
      text('1:', 68, 90),
      text('Anonymous', 80, 90),
      text('records.', 140, 90),
      '0.5 w',
      ...rails
        .filter((_, n) => !(mode === 'missing-fence' && n === 2))
        .map((y) => `40 ${400 - y} m 260 ${400 - y} l S`),
      text('Category', 43, 114),
      text('Subtype', 100, 114),
      text('Detail', 155, 114),
      text('Cite', 235, 114),
      ...Array.from({ length: bands }, (_, b) => {
        const first = divider + b * bandHeight + 15,
          group = [
            text(mode === 'quantitative-parent' ? String(128 + b) : 'Group', 43, first),
            text(['Alpha', 'Beta', 'Gamma', 'Delta'][b], 43, first + 10)
          ]
        for (let leaf = 0; leaf < 2; leaf++) {
          const y = first + leaf * 24,
            fields = [
              text(leaf ? 'LeafB' : 'LeafA', 100, y),
              text(mode === 'claimed-mu' && b === 0 && leaf === 0 ? '\\265' : 'Short', 155, y),
              text(
                'wrapped.',
                155,
                mode === 'cross-fence' && b === 0 && leaf === 1 ? divider + bandHeight + 4 : y + 10
              ),
              text(
                mode === 'citation' && b === 0 && leaf === 1 ? 'Other' : `[${b * 2 + leaf + 1}]`,
                235,
                y
              )
            ]
          group.push(
            ...(mode === 'source-cycle' && b === 0 && leaf === 1
              ? [fields[0], fields[3], fields[1], fields[2]]
              : fields)
          )
        }
        return group
      }).flat(),
      ...(mode === 'foreign-paint'
        ? [`145 ${400 - (divider + 35)} m 250 ${400 - (divider + 35)} l S`]
        : []),
      ...(mode === 'foreign-padding-paint'
        ? [`39.5 ${400 - (divider + 10)} m 39.5 ${400 - (divider + 35)} l S`]
        : []),
      // A real PDF octal WinAnsi micro sign: default PDF.js text is Greek mu,
      // while the original showText glyph retains the micro-sign literal.
      text('Unclaimed', 43, 385),
      text('\\265', 100, 385)
    ].join('\n'),
    f = await captureAnonymousHeader(
      stream,
      [39, top - 2, 261, bottom + 1].map((x) => x * 1.5)
    ),
    crop = f.table.cropRect,
    object = (label, rect) => ({ label, score: 1, rect: rect.map((x, n) => x * 1.5 - crop[n % 2]) })
  f.table.id = 'page-1-table-1'
  f.table.page = 1
  f.table.structure.objects = [
    ...[
      [40, 91],
      [91, 145],
      [145, 225],
      [225, 260]
    ].map(([left, right]) => object('table column', [left, top, right, bottom])),
    object('table row', [40, top, 260, divider]),
    ...Array.from({ length: bands }, (_, b) =>
      object('table row', [40, divider + b * bandHeight, 260, divider + (b + 1) * bandHeight])
    ),
    object('table column header', [40, top, 260, divider])
  ]
  const tableItems = f.items.filter((i) => i.baseline > top * 1.5 && i.baseline < bottom * 1.5),
    foreign = f.items.filter((i) => i.baseline > bottom * 1.5),
    operators = f.context.operators,
    paintedMicro = []
  for (const args of operators.argsArray)
    for (const item of Array.isArray(args?.[0]) ? args[0] : []) {
      if (item && typeof item === 'object' && item.unicode === 'µ') paintedMicro.push(item.unicode)
    }
  return {
    ...f,
    bands,
    frame: { top: top * 1.5, divider: divider * 1.5, bottom: bottom * 1.5 },
    expected: {
      records: bands * 2,
      rows: bands * 2 + 1,
      columns: 4,
      categorySpans: Array.from({ length: bands }, (_, n) => ({
        row: n * 2 + 1,
        column: 0,
        rowSpan: 2,
        colSpan: 1
      })),
      originalSources: tableItems.map((i) => i.sourceItem),
      foreignSources: foreign.map((i) => i.sourceItem)
    },
    normalizationWitness: {
      normalizedForeignMu: foreign.some((i) => i.text === 'μ'),
      paintedMicroSigns: paintedMicro.length
    },
    pdfStream: stream
  }
}
