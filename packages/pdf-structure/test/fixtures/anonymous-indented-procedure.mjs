/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  PDFDocument,
  StandardFonts,
  moveTo,
  lineTo,
  stroke,
  beginText,
  endText,
  setFontAndSize,
  setTextMatrix,
  showText
} from 'pdf-lib'

const PAGE_HEIGHT = 800

const emitText = (fontKey, font, size, x, y, text) => {
  const words = text.split(/\s+/u)
  return words.flatMap((word, index) => {
    const operators = [
      beginText(),
      setFontAndSize(fontKey, size),
      setTextMatrix(1, 0, 0, 1, x, PAGE_HEIGHT - y),
      showText(font.encodeText(word)),
      endText()
    ]
    x +=
      font.widthOfTextAtSize(word, size) +
      (index < words.length - 1 ? font.widthOfTextAtSize(' ', size) : 0)
    return operators
  })
}

export async function anonymousIndentedProcedure(fault = '') {
  const doc = await PDFDocument.create()
  const regular = await doc.embedFont(StandardFonts.Helvetica),
    bold = await doc.embedFont(StandardFonts.HelveticaBold),
    italic = await doc.embedFont(StandardFonts.HelveticaOblique),
    page = doc.addPage([600, PAGE_HEIGHT]),
    regularKey = page.node.newFontDictionary('R', regular.ref),
    boldKey = page.node.newFontDictionary('B', bold.ref),
    italicKey = page.node.newFontDictionary('I', italic.ref)

  const rows = [
    ['procedure Update(values, limit)', 70, 148],
    ['Initialize accumulator', 85, 164],
    ['for each value in values do', 85, 180],
    ['if value is valid then', 100, 196],
    ['Record the bounded value', 115, 212],
    ['else', 100, 228],
    ['Skip the invalid value', 115, 244],
    ['Observe the next item', 100, 260],
    ['Update progress', 85, 276],
    ['return accumulator', 85, 292]
  ]

  if (fault === 'missing-loop') rows[2][0] = 'Inspect each value in values'
  if (fault === 'missing-if') rows[3][0] = 'Validate each value'
  if (fault === 'orphan-else') rows[3][0] = 'Validate each value'
  if (fault === 'orphan-else') rows[5][0] = 'else'
  if (fault === 'no-return') rows[9][0] = 'Update progress'
  if (fault === 'empty-caption') rows.splice(1, 1)

  page.pushOperators(
    ...emitText(
      boldKey,
      bold,
      10,
      50,
      78,
      fault === 'missing-caption' ? 'Protocol 12: Bounded update' : 'Procedure 12: Bounded update'
    ),
    ...(fault === 'empty-caption'
      ? []
      : emitText(italicKey, italic, 9, 52, 90, 'The second line is part of the complete caption.')),
    ...emitText(regularKey, regular, 9, 55, 148, '1:'),
    ...emitText(boldKey, bold, 9, rows[0][1], rows[0][2], rows[0][0]),
    ...rows.slice(1).flatMap(([text, x, y], index) => {
      const number = index + 2,
        ordinalX = number < 10 ? 55 : 51.5,
        emittedNumber =
          fault === 'missing-number' && number === 5
            ? 6
            : fault === 'duplicate-number' && number === 5
              ? 4
              : number,
        ordinalFont = fault === 'ordinal-font-mutation' && number === 5 ? boldKey : regularKey
      return [
        ...emitText(
          ordinalFont,
          ordinalFont === boldKey ? bold : regular,
          9,
          ordinalX,
          y,
          `${emittedNumber}:`
        ),
        ...emitText(regularKey, regular, 9, x, y, text)
      ]
    }),
    ...(fault === 'foreign-return'
      ? emitText(regularKey, regular, 9, 200, 212, 'return unauthorized')
      : []),
    ...emitText(
      regularKey,
      regular,
      9,
      50,
      400,
      'An unrelated paragraph outside the closing rule.'
    ),
    ...emitText(regularKey, regular, 9, 50, 760, 'Page footer.')
  )

  const railOps = [
    moveTo(50, PAGE_HEIGHT - 66),
    lineTo(550, PAGE_HEIGHT - 66),
    stroke(),
    moveTo(50, PAGE_HEIGHT - 98),
    lineTo(550, PAGE_HEIGHT - 98),
    stroke(),
    moveTo(50, PAGE_HEIGHT - 340),
    lineTo(550, PAGE_HEIGHT - 340),
    stroke()
  ]
  if (fault === 'missing-divider') railOps.splice(3, 3)
  page.pushOperators(...railOps)

  return doc.save()
}
