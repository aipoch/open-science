/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { nativeRecordFixture } from './open-native-table-contradictions.mjs'

export function signedNativeRecords(mode) {
  const f = nativeRecordFixture(6, 7)
  const token = (text, x, y, width, height = 10) => {
    const t = f.token(text, x, y, width)
    t.height = height
    t.rect[1] = y - height
    return t
  }
  token('Case', 10, 48, 35)
  for (let c = 0; c < 7; c++) {
    token(String.fromCharCode(65 + c), 100 + c * 60, 48, 7)
    token(String(c + 1), 107 + c * 60, 50, 4, 6)
  }
  for (let r = 0; r < 6; r++) {
    const y = 70 + r * 20
    token('Entry ' + r, 10, y, 45)
    for (let c = 0; c < 7; c++) {
      if (mode !== 'unsigned' && (r === 0 || c === r - 1)) token('−', 85 + c * 60, y, 15)
      token(mode === 'missing value' && c === 6 ? '—' : '1.23', 100 + c * 60, y, 24)
      if (mode === 'uncertainty lane' && c === 6) token('±', 485, y, 10)
    }
  }
  if (mode === 'unclaimed ink') token('Foreign', 520, 70, 35)
  f.finish()
  const context = f.context.nativeGlyphContext
  f.context.sourcePage.width = 600
  context.viewport.width = 600
  const signs = new Set(f.tokens.filter((t) => t.text === '−').map((t) => t.sourceItem.index))
  context.content.styles.S = { ...context.content.styles.F }
  context.glyphBounds.push({ ...structuredClone(context.glyphBounds[0]), fontName: 'S' })
  for (const index of signs) {
    context.content.items[index].fontName = 'S'
    context.operators.argsArray[2 + index * 5][0] = 'S'
  }
  context.viewport.convertToViewportPoint = (x, y) => [x, 400 - y]
  const items = f.tokens
    .filter((t) => t.text !== 'Foreign')
    .map((t) => ({
      ...t,
      rect: t.rect.map((n) => n * 1.5),
      nativeLabelRect: t.nativeLabelRect.map((n) => n * 1.5),
      height: t.height * 1.5,
      baseline: t.baseline * 1.5
    }))
  const rules = [35, 55, 180].map((y) => [0, y * 1.5, 900, y * 1.5])
  return {
    items,
    rules,
    captions: [{ page: 1, lines: ['Table 1: Scalar records'], rect: [0, 0, 900, 37.5] }],
    paint: new Map(rules.map((r) => [r.join(','), [r[0], r[1] - 0.1, r[2], r[3] + 0.1]])),
    evidence: { page: f.context.sourcePage, tokens: f.tokens, context }
  }
}
