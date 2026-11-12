/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captureAnonymousHeader } from './single-parent-math-header.mjs'
import { nativeWhitespaceGaps } from '../../resources/literature-pdf-symbol-text.mjs'

// Original anonymous PDF text, followed by the same unsupported proportional
// model subdivision seen at final table publication. No paper text is stored.
export async function anonymousPartialWholeSources({ rows = 1, wideGap = false } = {}) {
  const stream = Array.from(
      { length: rows },
      (_, n) =>
        `BT /F 10 Tf 50 ${300 - n * 20} Td ` +
        (wideGap ? '[(Amber) -450 (Indigo)] TJ' : '(Amber Indigo) Tj') +
        ' ET'
    ).join('\n'),
    f = await captureAnonymousHeader(stream, [50, 130, 200, 250]),
    fonts = f.items.filter((i) => i.text === 'Amber Indigo'),
    runs = nativeWhitespaceGaps(f.context.sourceContent, f.context.operators, f.context.viewport),
    cells = fonts.flatMap((font, row) => {
      const cut = font.rect[0] + ((font.rect[2] - font.rect[0]) * 5) / 11
      return ['Amber', 'Indigo'].map((text, column) => {
        const rect = [
            column ? cut : font.rect[0],
            font.rect[1],
            column ? font.rect[2] : cut,
            font.rect[3]
          ],
          token = { ...font, text, rect, sourceToken: font }
        return {
          row,
          column,
          rowSpan: 1,
          colSpan: 1,
          text,
          rect: [...rect],
          sourceItems: [font.sourceItem],
          sourceRects: [[...rect]],
          sourceTokens: [token]
        }
      })
    }),
    table = {
      grid: fonts.map(() => ['Amber', 'Indigo']),
      cells,
      cropRect: [50, 130, 250, 300],
      issues: ['existing-review'],
      unassigned: ['existing remainder'],
      reviewCandidate: true
    }
  return { ...f, fonts, runs, table }
}
