/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  PDFDocument,
  StandardFonts,
  moveTo,
  lineTo,
  stroke,
  setLineWidth,
  setStrokingRgbColor,
  setFillingRgbColor,
  beginText,
  endText,
  setFontAndSize,
  setTextMatrix,
  showText,
  pushGraphicsState,
  popGraphicsState,
  setGraphicsState,
  rectangle,
  clip,
  endPath,
  fill
} from 'pdf-lib'

export async function colonlessNativeRoutine(fault = '') {
  const document = await PDFDocument.create(),
    font = await document.embedFont(StandardFonts.Helvetica),
    page = document.addPage([600, 800]),
    fontKey = page.node.newFontDictionary('Native', font.ref),
    alphaKey = page.node.newExtGState(
      'Alpha',
      document.context.register(document.context.obj({ ca: 0.5 }))
    ),
    text = (value, x, baseline, size = 10) => {
      const body = baseline >= 145 && baseline <= 218
      page.pushOperators(pushGraphicsState())
      if (fault === 'white-body' && body) page.pushOperators(setFillingRgbColor(1, 1, 1))
      if (fault === 'translucent-body' && body) page.pushOperators(setGraphicsState(alphaKey))
      if (fault === 'clipped-body' && body)
        page.pushOperators(rectangle(50, 580, 120, 90), clip(), endPath())
      for (const word of value.split(/\s+/u)) {
        page.pushOperators(
          beginText(),
          setFontAndSize(fontKey, size),
          setTextMatrix(1, 0, 0, 1, x, 800 - baseline),
          showText(font.encodeText(word)),
          endText()
        )
        x += font.widthOfTextAtSize(word, size) + font.widthOfTextAtSize(' ', size)
      }
      page.pushOperators(popGraphicsState())
    }
  text(fault === 'title' ? 'Listing S1 Select a result.' : 'Algorithm S1 Select a result.', 50, 100)
  text('The complete caption continues on this line.', 50, 112)
  text(fault === 'signature' ? 'An ordinary introduction.' : 'SELECT(values, limit)', 50, 145)
  const rows = [
    [fault === 'assignment' ? 'Inspect values' : 'total = initialize(values)', 65],
    [fault === 'condition' ? 'Inspect total' : 'if total < limit', 65],
    ['return total', fault === 'indent' ? 65 : 85],
    [fault === 'return' ? 'Inspect the fallback' : 'return fallback(values)', 65]
  ]
  rows.forEach(([value, x], index) => {
    if (fault !== 'missing-number' || index !== 2)
      text(
        String(fault === 'duplicate-number' && index === 2 ? 2 : index + 1),
        55,
        164 + index * 18,
        8
      )
    text(value, x, 164 + index * 18)
  })
  if (fault === 'foreign-line') text('An unrelated paragraph enters the frame.', 65, 196)
  if (fault === 'foreign-paint') page.pushOperators(rectangle(250, 610, 8, 8), fill())
  page.pushOperators(setLineWidth(0.5))
  if (fault === 'white-frame') page.pushOperators(setStrokingRgbColor(1, 1, 1))
  for (const baseline of [90, 128, 235]) {
    if (fault === 'divider' && baseline === 128) continue
    if (fault === 'closing-rule' && baseline === 235) continue
    page.pushOperators(moveTo(50, 800 - baseline), lineTo(285, 800 - baseline), stroke())
  }
  text('Independent neighboring text.', 320, 165)
  return document.save({ useObjectStreams: false })
}
