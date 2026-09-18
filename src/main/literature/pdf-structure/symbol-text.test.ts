import { expect, it, vi } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readPdfFixture } from './read-fixture'

const { repairPdfSymbolText, splitPdfNumericRuns, removeBackgroundNumericPadding } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-symbol-text.mjs')).href
)

it.each([
  'native',
  'shifted-slots',
  'wrong-font',
  'wrong-width',
  'missing-name',
  'conflicting-name'
])('decodes native comparison glyphs with %s evidence', async (variant) => {
  const f = readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/comparison-symbol-subset.jsonl')
  )
  if (variant === 'wrong-font') f.font.name = 'Times-Roman'
  for (const glyph of f.glyphs) {
    if (variant === 'wrong-width') glyph.width = 769
    if (variant === 'missing-name') delete f.font.differences[glyph.originalCharCode]
    if (variant === 'conflicting-name')
      f.font.differences[glyph.originalCharCode] = glyph.unicode === '\u0015' ? 'C20' : 'C21'
    if (variant === 'shifted-slots') {
      const name = f.font.differences[glyph.originalCharCode]
      delete f.font.differences[glyph.originalCharCode]
      glyph.originalCharCode += 200
      f.font.differences[glyph.originalCharCode] = name
    }
  }
  const content = { items: [{ str: '\u0015 40.3; \u0014 60', fontName: 'native' }] }
  const operators = {
    fnArray: [OPS.setFont, OPS.showText],
    argsArray: [['native', 10], [f.glyphs]]
  }
  const original = structuredClone({ f, content, operators })
  const result = await repairPdfSymbolText(
    { commonObjs: { get: () => f.font } },
    content,
    operators
  )
  expect(result.items[0].str).toBe(
    ['native', 'shifted-slots'].includes(variant) ? '≥ 40.3; ≤ 60' : content.items[0].str
  )
  expect({ f, content, operators }).toEqual(original)
})

it.each([
  ['AdvTir_symb', 66, 'B', '≤', 750],
  ['AdvTir_symb', 67, 'C', '≥', 750],
  ['AdvOT463cc31e', 53, '5', '=', 822],
  ['AdvPS586B', 54, '6', '±', 833],
  ['AdvPS586B', 53, '5', '=', 833],
  ['AdvMT_SY', 188, '¼', '=', 770],
  ['MinionMathSymbols', 136, '�', '=', 583],
  ['TeX_CM_Bold_Maths_Symbols', 136, '¼', '=', 885],
  ['AdvP7CA8', 85, 'U', '=', 833],
  ['AdvPS3FDD77', 91, '[', '=', 1000],
  ['AdvPSMP4', 91, '[', '>', 1000],
  ['AdvPS44A44B', 68, 'D', '+', 1000],
  ['AdvPS44A44B', 67, 'C', '+', 1000],
  ['AdvTT454a7a89', 98, 'b', '<', 562],
  ['TeX_CM_Maths_Symbols', 0, '\u0000', '−', 250],
  ['AdvPS3F4C13', 117, 'u', 'ω', 718],
  ['AdvP0DE0', 177, '±', '–', 552],
  ['AdvP0DE0', 174, 'Æ', 'fi', 614],
  ['AdvP4C4E74', 20, '\u0014', '≤', 770],
  ['AdvP4C4E74', 21, '\u0015', '≥', 770],
  ['AdvP4C4E74', 135, 'á', '+', 770]
])(
  'recovers verified legacy %s glyph %s without rewriting other fonts or slots',
  async (name, code, unicode, expected, width) => {
    const content = { items: [{ str: unicode, fontName: 'source' }] }
    for (const [fontName, glyphCode, advance, result] of [
      [`ABCDEF+${name}`, code, width, expected],
      ['Times-Roman', code, width, unicode],
      [name, code, Number(width) + 1, unicode],
      [name, 999, width, unicode]
    ]) {
      const page = { commonObjs: { get: () => ({ name: fontName }) } }
      const ops = {
        fnArray: [OPS.setFont, OPS.showText],
        argsArray: [['source', 12], [[{ originalCharCode: glyphCode, unicode, width: advance }]]]
      }
      expect((await repairPdfSymbolText(page, content, ops)).items[0].str).toBe(result)
    }
  }
)

it.each([
  ['AdvP0005', 89, 'Y', '–', 500],
  ['AdvP0004', 57, '9', '>', 562]
])(
  'repairs age-label glyphs in %s without changing prose or digits',
  async (name, code, unicode, expected, width) => {
    for (const source of [unicode, `${unicode}65`]) {
      const content = { items: [{ str: source, fontName: 'source' }] }
      for (const [fontName, glyphCode, advance, replacement] of [
        [`ABCDEF+${name}`, code, width, expected],
        ['Times-Roman', code, width, unicode],
        [name, code, Number(width) + 1, unicode],
        [name, 999, width, unicode]
      ]) {
        const page = { commonObjs: { get: () => ({ name: fontName }) } }
        const ops = {
          fnArray: [OPS.setFont, OPS.showText],
          argsArray: [['source', 12], [[{ originalCharCode: glyphCode, unicode, width: advance }]]]
        }
        expect((await repairPdfSymbolText(page, content, ops)).items[0].str).toBe(
          source.replace(String(unicode), String(replacement))
        )
      }
    }
  }
)

it('keeps a broken Unicode value if the same font also uses it for an unverified glyph', async () => {
  const content = { items: [{ str: '24±75 ±', fontName: 'source' }] }
  const page = { commonObjs: { get: () => ({ name: 'AdvP0DE0' }) } }
  const ops = {
    fnArray: [OPS.setFont, OPS.showText],
    argsArray: [
      ['source', 12],
      [
        [
          { originalCharCode: 177, unicode: '±', width: 552 },
          { originalCharCode: 200, unicode: '±', width: 770 }
        ]
      ]
    ]
  }
  expect((await repairPdfSymbolText(page, content, ops)).items).toEqual(content.items)
})

it.each([
  [176, '∞', '<'],
  [185, 'π', '+'],
  [186, '∫', '±'],
  [189, 'Ω', '=']
])(
  'repairs WTimesGreekSF-One slot %s without changing mathematical Unicode elsewhere',
  async (code, unicode, expected) => {
    const content = { items: [{ str: unicode, fontName: 'math' }] }
    for (const [name, width, value] of [
      ['HNMABL+WTimesGreekSF-One', 833, expected],
      ['Times-Roman', 833, unicode],
      ['WTimesGreekSF-One', 500, unicode]
    ]) {
      const page = { commonObjs: { get: () => ({ name }) } }
      const ops = {
        fnArray: [OPS.setFont, OPS.showText],
        argsArray: [['math', 12], [[{ originalCharCode: code, unicode, width }]]]
      }
      expect((await repairPdfSymbolText(page, content, ops)).items[0].str).toBe(value)
    }
  }
)

it('repairs a PDF.js-normalized ohm glyph only in its verified publisher font', async () => {
  const content = { items: [{ str: 'nΩ24', fontName: 'math' }] }
  const ops = {
    fnArray: [OPS.setFont, OPS.showText],
    argsArray: [['math', 12], [[{ originalCharCode: 189, unicode: 'Ω', width: 833 }]]]
  }
  const page = { commonObjs: { get: () => ({ name: 'WTimesGreekSF-One' }) } }
  expect((await repairPdfSymbolText(page, content, ops)).items[0].str).toBe('n=24')
})

it.each([
  ['AdvPS7DA6', 36, '$', '≥', 833],
  ['NewGalliard-Roman', 74, '»', '≥', 860],
  ['NewGalliard-Roman', 71, '«', '≤', 860],
  ['NewGalliard-Roman', 81, '«', '≤', 860],
  ['NewGalliard-Roman', 82, '»', '≥', 860]
])(
  'repairs verified comparison glyphs in %s slot %s',
  async (name, code, unicode, expected, width) => {
    const content = { items: [{ str: unicode, fontName: 'math' }] }
    const ops = {
      fnArray: [OPS.setFont, OPS.showText],
      argsArray: [['math', 12], [[{ originalCharCode: code, unicode, width }]]]
    }
    const differences =
      Number(code) >= 81
        ? { 75: 'less', 81: 'guillemotleft', 82: 'guillemotright', 83: 'equal' }
        : { 71: 'guillemotleft', 72: 'greater', 73: 'less', 74: 'guillemotright' }
    const page = { commonObjs: { get: () => ({ name, differences }) } }
    expect((await repairPdfSymbolText(page, content, ops)).items[0].str).toBe(expected)
    const ordinary = { commonObjs: { get: () => ({ name: 'Times-Roman', differences }) } }
    expect((await repairPdfSymbolText(ordinary, content, ops)).items).toEqual(content.items)
    const other = { commonObjs: { get: () => ({ name, differences: {} }) } }
    if (name === 'NewGalliard-Roman')
      expect((await repairPdfSymbolText(other, content, ops)).items).toEqual(content.items)
  }
)

it.each([
  [3, '\u0003', '±', 770],
  [121, 'y', '†', 437],
  [122, 'z', '‡', 437]
])(
  'repairs the C6 mathematical subset slot %s while preserving other subsets',
  async (code, unicode, expected, width) => {
    const content = { items: [{ str: unicode, fontName: 'math' }] }
    const ops = {
      fnArray: [OPS.setFont, OPS.showText],
      argsArray: [['math', 12], [[{ originalCharCode: code, unicode, width }]]]
    }
    for (const [slot, value] of [
      ['C6', expected],
      ['C21', unicode]
    ]) {
      const page = {
        commonObjs: {
          get: () => ({ name: 'AdvP4C4E74', differences: { 1: 'C0', 3: slot, 121: 'y', 122: 'z' } })
        }
      }
      expect((await repairPdfSymbolText(page, content, ops)).items[0].str).toBe(value)
    }
  }
)

it('repairs the single-comparison subset without changing another encoding of slot one', async () => {
  const content = { items: [{ str: '\u001510', fontName: 'math' }] }
  const ops = {
    fnArray: [OPS.setFont, OPS.showText],
    argsArray: [['math', 12], [[{ originalCharCode: 1, unicode: '\u0015', width: 770 }]]]
  }
  for (const [glyphName, expected] of [
    ['C21', '≥10'],
    ['C1', '\u001510']
  ]) {
    const page = {
      commonObjs: { get: () => ({ name: 'MGDKAN+AdvP4C4E74', differences: ['', glyphName] }) }
    }
    expect((await repairPdfSymbolText(page, content, ops)).items[0].str).toBe(expected)
  }
})

it('repairs plus signs in the verified comparison subset but preserves prose thorn letters', async () => {
  const page = {
    commonObjs: { get: () => ({ name: 'AdvP4C4E74', differences: { 1: 'C21', 254: 'thorn' } }) }
  }
  const content = {
    items: [
      { str: 'þþþ', fontName: 'math' },
      { str: 'þ', fontName: 'prose' }
    ]
  }
  const ops = {
    fnArray: [OPS.setFont, OPS.showText],
    argsArray: [['math', 12], [[{ originalCharCode: 254, unicode: 'þ', width: 770 }]]]
  }
  expect(
    (await repairPdfSymbolText(page, content, ops)).items.map((i: { str: string }) => i.str)
  ).toEqual(['+++', 'þ'])
  const other = {
    commonObjs: { get: () => ({ name: 'AdvP4C4E74', differences: { 1: 'C1', 254: 'thorn' } }) }
  }
  expect((await repairPdfSymbolText(other, content, ops)).items).toEqual(content.items)
})

it.each([
  ['AdvPS3FDD77', 90, 'Z', '=', 1000],
  ['AdvP4C4E74', 188, '¼', '=', 770],
  ['AdvP4C4E74', 2, '\u0002', '±', 770],
  ['AdvP4C4E74', 4, '\u0004', '±', 770],
  ['AdvP4C4E74', 1, '\u0001', '−', 770],
  ['AdvP7DA6', 109, 'm', 'µ', 666],
  ['MathematicalPi-One', 1, '\u0001', 'µ', 667],
  ['AdvP4C4E3A', 188, '¼', '=', 885],
  ['AdvP4C9543', 167, '§', '±', 781],
  ['Universal-GreekwithMathPi', 1, '\u0001', '=', 833],
  ['Universal-GreekwithMathPi', 3, '\u0003', '<', 833],
  ['MathematicalPi-Four', 2, '\u0002', '±', 833]
])(
  'repairs the verified %s glyph %s without changing prose or a different glyph width',
  async (name, code, unicode, expected, width) => {
    const page = { commonObjs: { get: () => ({ name: `ABCDEF+${name}` }) } }
    const content = {
      items: [
        { str: unicode, fontName: 'math' },
        { str: unicode, fontName: 'prose' }
      ]
    }
    const ops = {
      fnArray: [OPS.setFont, OPS.showText],
      argsArray: [['math', 12], [[{ originalCharCode: code, unicode, width }]]]
    }
    expect(
      (await repairPdfSymbolText(page, content, ops)).items.map((i: { str: string }) => i.str)
    ).toEqual([expected, unicode])
    const mismatch = {
      ...ops,
      argsArray: [['math', 12], [[{ originalCharCode: code, unicode, width: Number(width) + 1 }]]]
    }
    expect((await repairPdfSymbolText(page, content, mismatch)).items).toEqual(content.items)
  }
)

it.each([
  [2, '\u0002', '–'],
  [3, '\u0015', '≥'],
  [4, '\u0014', '≤']
])(
  'repairs the range/comparison subset slot %s without treating it as plus/minus',
  async (code, unicode, expected) => {
    const page = {
      commonObjs: {
        get: () => ({ name: 'AdvP4C4E74', differences: ['', 'C1', 'C0', 'C21', 'C20'] })
      }
    }
    const content = { items: [{ str: unicode, fontName: 'math' }] }
    const ops = {
      fnArray: [OPS.setFont, OPS.showText],
      argsArray: [['math', 12], [[{ originalCharCode: code, unicode, width: 770 }]]]
    }
    expect((await repairPdfSymbolText(page, content, ops)).items[0].str).toBe(expected)
  }
)

it('distinguishes a less-than glyph from plus/minus in a differently encoded Universal subset', async () => {
  const page = {
    commonObjs: {
      get: () => ({
        name: 'ABCDEF+Universal-GreekwithMathPi',
        differences: ['', 'H11005', 'H11021']
      })
    }
  }
  const content = { items: [{ str: '\u0002', fontName: 'math' }] }
  const ops = {
    fnArray: [OPS.setFont, OPS.showText],
    argsArray: [['math', 12], [[{ originalCharCode: 2, unicode: '\u0002', width: 833 }]]]
  }
  expect((await repairPdfSymbolText(page, content, ops)).items[0].str).toBe('<')
  const other = { commonObjs: { get: () => ({ name: 'ABCDEF+Universal-GreekwithMathPi' }) } }
  expect((await repairPdfSymbolText(other, content, ops)).items[0].str).toBe('±')
})

it('preserves the plus glyph in a Universal subset that uses slot two for less-than', async () => {
  const page = {
    commonObjs: {
      get: () => ({
        name: 'Universal-GreekwithMathPi',
        differences: { 1: 'H11005', 2: 'H11021', 3: 'H11001' }
      })
    }
  }
  const content = { items: [{ str: '\u0003', fontName: 'math' }] }
  const ops = {
    fnArray: [OPS.setFont, OPS.showText],
    argsArray: [['math', 12], [[{ originalCharCode: 3, unicode: '\u0003', width: 833 }]]]
  }
  expect((await repairPdfSymbolText(page, content, ops)).items[0].str).toBe('+')
  const other = { commonObjs: { get: () => ({ name: 'Universal-GreekwithMathPi' }) } }
  expect((await repairPdfSymbolText(other, content, ops)).items[0].str).toBe('<')
})

it.each([
  ['MathematicalPi-One', 5, '\u0005', 'χ', 556, 'H9273'],
  ['MathematicalPi-Six', 1, '\u0001', '*', 500, 'H11569']
])(
  'decodes the verified %s subset glyph without altering other subsets',
  async (name, code, unicode, expected, width, glyphName) => {
    const content = { items: [{ str: unicode, fontName: 'math' }] }
    const ops = {
      fnArray: [OPS.setFont, OPS.showText],
      argsArray: [['math', 12], [[{ originalCharCode: code, unicode, width }]]]
    }
    const page = { commonObjs: { get: () => ({ name, differences: { [code]: glyphName } }) } }
    expect((await repairPdfSymbolText(page, content, ops)).items[0].str).toBe(expected)
    const other = { commonObjs: { get: () => ({ name, differences: { [code]: 'unknown' } }) } }
    expect((await repairPdfSymbolText(other, content, ops)).items[0].str).toBe(unicode)
  }
)

it('discards off-crop form text while keeping visible text and outer captions', async () => {
  const item = (
    str: string,
    x: number,
    y: number
  ): { str: string; fontName: string; width: number; height: number; transform: number[] } => ({
    str,
    fontName: 'f',
    width: 20,
    height: 10,
    transform: [10, 0, 0, 10, x, y]
  })
  const content = {
    items: [item('hidden', 110, 100), item('visible', 110, 220), item('caption', 110, 100)]
  }
  const text = (str: string): { unicode: string }[][] => [[...str].map((unicode) => ({ unicode }))]
  const operators = {
    fnArray: [
      OPS.setFont,
      OPS.paintFormXObjectBegin,
      OPS.showText,
      OPS.showText,
      OPS.paintFormXObjectEnd,
      OPS.showText
    ],
    argsArray: [
      ['f', 10],
      [
        [1, 0, 0, 1, 100, 200],
        [0, 0, 100, 100]
      ],
      text('hidden'),
      text('visible'),
      [],
      text('caption')
    ]
  }
  const result = await repairPdfSymbolText({}, content, operators)
  expect(result.items.map((i: { str: string }) => i.str)).toEqual(['visible', 'caption'])
  expect(content.items).toHaveLength(3)
})

it('recovers legacy math symbols using the font and original glyph code', async () => {
  const glyphs = [
    { originalCharCode: 3, unicode: '�' },
    { originalCharCode: 135, unicode: 'þ' },
    { originalCharCode: 136, unicode: '¼' }
  ]
  const operators = { fnArray: [OPS.setFont, OPS.showText], argsArray: [['math', 12], [glyphs]] }
  const page = { commonObjs: { get: () => ({ name: 'TeX_CM_Maths_Symbols' }) } }
  const content = {
    items: [
      { str: '�', fontName: 'math' },
      { str: 'þ', fontName: 'math' },
      { str: '¼', fontName: 'math' },
      { str: 'þ ¼ �', fontName: 'regular' }
    ]
  }
  const result = await repairPdfSymbolText(page, content, operators)
  expect(result.items.map((item: { str: string }) => item.str)).toEqual(['*', '+', '=', 'þ ¼ �'])
  expect(result.items[0].inlineSymbol).toBe(true)
  expect(content.items[0].str).toBe('�')
  const otherFont = { commonObjs: { get: () => ({ name: 'OtherMathFont' }) } }
  expect(await repairPdfSymbolText(otherFont, content, operators)).toEqual(content)
  const ambiguous = {
    ...operators,
    argsArray: [['math', 12], [[...glyphs, { originalCharCode: 4, unicode: '�' }]]]
  }
  expect((await repairPdfSymbolText(page, content, ambiguous)).items[0].str).toBe('�')
})

it('recovers the publisher punctuation dash without replacing ordinary letters', async () => {
  const content = {
    items: [
      { str: 'e', fontName: 'punctuation' },
      { str: 'e', fontName: 'prose' }
    ]
  }
  const operators = {
    fnArray: [OPS.setFont, OPS.showText],
    argsArray: [['punctuation', 10], [[{ originalCharCode: 101, unicode: 'e', width: 750 }]]]
  }
  const page = { commonObjs: { get: () => ({ name: 'ABCDEF+AdvPS44A44B' }) } }
  expect(
    (await repairPdfSymbolText(page, content, operators)).items.map(
      (item: { str: string }) => item.str
    )
  ).toEqual(['–', 'e'])
  for (const glyph of [
    { originalCharCode: 102, unicode: 'e', width: 750 },
    { originalCharCode: 101, unicode: 'e', width: 500 }
  ]) {
    expect(
      await repairPdfSymbolText(page, content, {
        ...operators,
        argsArray: [['punctuation', 10], [[glyph]]]
      })
    ).toEqual(content)
  }
  expect(
    await repairPdfSymbolText(
      { commonObjs: { get: () => ({ name: 'Regular' }) } },
      content,
      operators
    )
  ).toEqual(content)
})

it('does not fetch operators for unaffected text', async () => {
  const page = { getOperatorList: vi.fn() }
  const content = { items: [{ str: 'Ordinary text' }] }
  expect(await repairPdfSymbolText(page, content)).toBe(content)
  expect(page.getOperatorList).not.toHaveBeenCalled()
})

it('removes invisible numeric padding while retaining visible zeros and standalone OCR text', async () => {
  const glyphs = (text: string): { unicode: string }[] => [...text].map((unicode) => ({ unicode }))
  const operators = {
    fnArray: [
      OPS.setFont,
      OPS.beginText,
      OPS.setTextRenderingMode,
      OPS.showText,
      OPS.setGState,
      OPS.setTextRenderingMode,
      OPS.showText,
      OPS.endText,
      OPS.showText,
      OPS.beginText,
      OPS.setTextRenderingMode,
      OPS.showText,
      OPS.endText
    ],
    argsArray: [
      ['regular', 12],
      [],
      [3],
      [glyphs('0')],
      [],
      [0],
      [glyphs('0 ')],
      [],
      [glyphs('(0) 100 00')],
      [],
      [3],
      [glyphs('200')],
      []
    ]
  }
  const content = {
    items: ['00', '(0)', '100', '00', '200'].map((str) => ({ str, fontName: 'regular' }))
  }
  const page = { getOperatorList: vi.fn().mockResolvedValue(operators) }
  const result = await repairPdfSymbolText(page, content)
  expect(result.items.map((item: { str: string }) => item.str)).toEqual([
    '0',
    '(0)',
    '100',
    '00',
    '200'
  ])
  expect(content.items[0].str).toBe('00')
  // No stream alignment: preserve source text instead of guessing which zero to remove.
  const mismatch = { items: [{ str: '00 (0) 100 00 201', fontName: 'regular' }] }
  expect(await repairPdfSymbolText(page, mismatch, operators)).toBe(mismatch)
  // Moving the cursor breaks the immediate invisible-padding/visible-number pair.
  const moved = {
    ...operators,
    fnArray: operators.fnArray.map((op) => (op === OPS.setGState ? OPS.moveText : op))
  }
  expect(await repairPdfSymbolText(page, content, moved)).toBe(content)
})

it('recovers case only from a consistent subset encoding and exact glyph stream alignment', async () => {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  const glyphs = [...letters].map((char) => ({
    originalCharCode: char.charCodeAt(0) - 29,
    unicode: 'AJNO'.includes(char) ? char.toLowerCase() : char,
    fontChar: char,
    width: /[A-Z]/.test(char) ? 700 : 500
  }))
  const operators = { fnArray: [OPS.setFont, OPS.showText], argsArray: [['subset', 10], [glyphs]] }
  const source = glyphs.map((g) => g.unicode).join('')
  const content = {
    items: [
      { str: source.slice(0, 26), fontName: 'subset' },
      { str: source.slice(26), fontName: 'subset' }
    ]
  }
  const result = await repairPdfSymbolText({}, content, operators)
  expect(result.items.map((i: { str: string }) => i.str).join('')).toBe(letters)
  expect(content.items[0].str).toBe(source.slice(0, 26))
  // The same font may also contain invisible numeric alignment padding. Both
  // repairs must preserve their common alignment with the original text stream.
  const both = { items: [...content.items, { str: '00 (0)', fontName: 'subset' }] }
  const numeric = (unicode: string): object => ({ unicode })
  const combinedOperators = {
    fnArray: [
      ...operators.fnArray,
      OPS.beginText,
      OPS.setTextRenderingMode,
      OPS.showText,
      OPS.setTextRenderingMode,
      OPS.showText,
      OPS.endText
    ],
    argsArray: [
      ...operators.argsArray,
      [],
      [3],
      [[numeric('0')]],
      [0],
      [[numeric('0'), numeric(' '), numeric('('), numeric('0'), numeric(')')]],
      []
    ]
  }
  const combined = await repairPdfSymbolText({}, both, combinedOperators)
  expect(combined.items[0].str).toBe(letters.slice(0, 26))
  expect(combined.items.at(-1).str).toBe('0 (0)')

  const mismatch = { ...content, items: [...content.items, { str: 'extra', fontName: 'subset' }] }
  expect(await repairPdfSymbolText({}, mismatch, operators)).toBe(mismatch)
  for (const incompatible of [
    glyphs.map((g, i) => (i === 2 ? { ...g, unicode: 'X' } : g)),
    glyphs.map((g) => ({ ...g, width: 500 })),
    glyphs.slice(0, 26),
    glyphs.map((g) => ({ ...g, originalCharCode: g.originalCharCode * 3 }))
  ]) {
    const input = {
      items: [{ str: incompatible.map((g) => g.unicode).join(''), fontName: 'subset' }]
    }
    expect(
      await repairPdfSymbolText({}, input, {
        ...operators,
        argsArray: [['subset', 10], [incompatible]]
      })
    ).toBe(input)
  }
})

it('splits fraction-valued runs using unequal TJ advances and text spacing', () => {
  const parts = ['1 (2/3)', '4 (5/6)', '7 (8/9)']
  const glyphs = (text: string): object[] =>
    [...text].map((unicode) => ({ unicode, width: 500, isSpace: unicode === ' ' }))
  const ops = {
    fnArray: [OPS.setFont, OPS.setCharSpacing, OPS.setWordSpacing, OPS.showText],
    argsArray: [
      ['f', 10],
      [0.2],
      [0.5],
      [[...glyphs(parts[0]), -900, ...glyphs(parts[1]), -1800, ...glyphs(parts[2])]]
    ]
  }
  const item = {
    str: parts.join(' '),
    fontName: 'f',
    dir: 'ltr',
    transform: [10, 0, 0, 10, 100, 500],
    width: 137.7,
    height: 10,
    hasEOL: true
  }
  const result = splitPdfNumericRuns({ items: [item] }, ops).items
  expect(result.map((i: { str: string }) => i.str)).toEqual(parts)
  expect(result.map((i: { hasEOL: boolean }) => i.hasEOL)).toEqual([false, false, true])
  for (const [i, x] of [100, 145.9, 200.8].entries()) {
    expect(result[i].transform[4]).toBeCloseTo(x, 6)
    expect(result[i].width).toBeCloseTo(36.9, 6)
  }
  for (const invalid of [
    { ...item, width: 140 },
    { ...item, str: item.str.replace('7', '8') },
    { ...item, transform: [10, 0, 3, 10, 100, 500] },
    { ...item, str: 'This is prose containing 1 (2/3) and 4 (5/6)' }
  ])
    expect(splitPdfNumericRuns({ items: [invalid] }, ops).items).toEqual([invalid])
  const separateRuns = {
    fnArray: [OPS.setFont, OPS.showText, OPS.showText],
    argsArray: [['f', 10], [[...glyphs(parts[0])]], [[...glyphs(parts.slice(1).join(' '))]]]
  }
  expect(splitPdfNumericRuns({ items: [item] }, separateRuns).items).toEqual([item])
})

it('separates adjacent statistic runs along a rotated source baseline', () => {
  const glyphs = (text: string): object[] => [...text].map((unicode) => ({ unicode, width: 500 }))
  const operators = {
    fnArray: [OPS.setFont, OPS.showText, OPS.showText],
    argsArray: [['f', 1], [glyphs('3.817725')], [glyphs('0.053')]]
  }
  const item = {
    str: '3.817725 0.053',
    fontName: 'f',
    dir: 'ltr',
    transform: [0, 10, -10, 0, 100, 200],
    height: 10,
    width: 67,
    hasEOL: true
  }
  const result = splitPdfNumericRuns({ items: [item] }, operators).items
  expect(result.map((i: { str: string }) => i.str)).toEqual(['3.817725', '0.053'])
  expect(result.map((i: { transform: number[] }) => i.transform.slice(4))).toEqual([
    [100, 200],
    [100, 242]
  ])
  expect(result.map((i: { width: number }) => i.width)).toEqual([40, 25])
  for (const invalid of [
    { ...item, width: 60 },
    { ...item, width: 100 },
    { ...item, str: '3.817726 0.053' }
  ])
    expect(splitPdfNumericRuns({ items: [invalid] }, operators).items).toEqual([invalid])
  const oneRun = {
    fnArray: [OPS.setFont, OPS.showText],
    argsArray: [['f', 1], [[...glyphs('3.817725'), -200, ...glyphs('0.053')]]]
  }
  expect(splitPdfNumericRuns({ items: [item] }, oneRun).items).toEqual([item])
})

it.each([
  [2, '\u0002', 'H11001', '+'],
  [3, '\u0003', 'H11002', '−'],
  [3, '\u0003', 'H11006', '±'],
  [4, '\u0004', 'H11021', '<'],
  [5, '\u0005', 'H11022', '>']
])(
  'uses Universal glyph names instead of unstable subset slot %s',
  async (code, unicode, glyph, expected) => {
    const content = { items: [{ str: unicode, fontName: 'math' }] }
    const page = {
      commonObjs: {
        get: () => ({ name: 'Universal-GreekwithMathPi', differences: { [code]: glyph } })
      }
    }
    const ops = {
      fnArray: [OPS.setFont, OPS.showText],
      argsArray: [['math', 10], [[{ originalCharCode: code, unicode, width: 833 }]]]
    }
    expect((await repairPdfSymbolText(page, content, ops)).items[0].str).toBe(expected)
  }
)

it.each([
  ['AdvMacMthSyN', 188, '¼', 781, '='],
  ['AdvMacMthSyN', 2, '\u0002', 781, '−'],
  ['AdvEls-ent4', 111, 'o', 979, '<'],
  ['AdvEls-ent5', 90, 'Z', 979, '≥'],
  ['AdvPSMP13', 97, 'a', 552, 'α'],
  ['AdvPSMP13', 98, 'b', 552, 'β'],
  ['AdvPSMP13', 118, 'v', 552, 'χ'],
  ['AdvTir_symb', 63, '?', 781, '+'],
  ['AdvPS.MH4', 53, '5', 833, '='],
  ['AdvPSMP4', 92, '\\', 1000, '<'],
  ['AdvPSMP11', 98, 'b', 500, 'β'],
  ['AdvPSMP10', 98, 'b', 552, 'β'],
  ['AdvPi1', 52, '4', 1000, '>'],
  ['AdvP4C4E74', 136, 'à', 770, '=']
])(
  'repairs verified publisher symbol %s/%s without replacing prose',
  async (name, code, unicode, width, expected) => {
    const content = { items: [{ str: unicode, fontName: 'math' }] }
    const ops = {
      fnArray: [OPS.setFont, OPS.showText],
      argsArray: [['math', 10], [[{ originalCharCode: code, unicode, width }]]]
    }
    for (const [font, value] of [
      [name, expected],
      ['Times-Roman', unicode]
    ]) {
      const page = { commonObjs: { get: () => ({ name: font, differences: { 2: 'C0' } }) } }
      expect((await repairPdfSymbolText(page, content, ops)).items[0].str).toBe(value)
    }
  }
)

it('recognizes the alternate C0 publisher subset for a plus glyph', async () => {
  const content = { items: [{ str: 'þ', fontName: 'math' }] }
  const ops = {
    fnArray: [OPS.setFont, OPS.showText],
    argsArray: [['math', 8], [[{ originalCharCode: 254, unicode: 'þ', width: 770 }]]]
  }
  for (const [differences, expected] of [
    [{ 2: 'C0', 188: 'onequarter', 254: 'thorn' }, '+'],
    [{ 2: 'C1', 188: 'onequarter', 254: 'thorn' }, 'þ'],
    [{ 2: 'C0', 254: 'thorn' }, 'þ'],
    [{ 2: 'C21', 3: 'C14', 188: 'onequarter', 254: 'thorn' }, '+'],
    [{ 2: 'C21', 3: 'C0', 188: 'onequarter', 254: 'thorn' }, 'þ'],
    [{ 2: 'C21', 3: 'C14', 254: 'thorn' }, 'þ']
  ] as const) {
    const page = { commonObjs: { get: () => ({ name: 'DKLJHI+AdvP4C4E74', differences }) } }
    expect((await repairPdfSymbolText(page, content, ops)).items[0].str).toBe(expected)
  }
})

it.each([
  ['AdvP4C4E74', 2, '\u0002', 770, 'C0', '−'],
  ['AdvP4C4E74', 4, '\u0004', 770, 'C6', '±'],
  ['AdvP4C4E74', 5, '\u0005', 770, 'C2', '×'],
  ['AdvP4C4E74', 2, '\u0014', 770, 'C20', '≤'],
  ['AdvP4C4E74', 3, '\u0015', 770, 'C21', '≥'],
  ['AdvP0003', 106, 'j', 833, undefined, '−'],
  ['AdvP0003', 81, 'Q', 552, 'Q', '≥'],
  ['MathematicalPi-Four', 2, '\u0002', 833, 'H11549', '='],
  ['AdvP0004', 71, 'G', 562, undefined, '<']
])(
  'distinguishes verified numeric symbols in %s slot %s',
  async (name, code, unicode, width, glyphName, expected) => {
    const content = { items: [{ str: `${unicode}1.76`, fontName: 'source' }] }
    const page = { commonObjs: { get: () => ({ name, differences: { [code]: glyphName } }) } }
    const operators = {
      fnArray: [OPS.setFont, OPS.showText],
      argsArray: [['source', 10], [[{ originalCharCode: code, unicode, width }]]]
    }
    expect((await repairPdfSymbolText(page, content, operators)).items[0].str).toBe(
      `${expected}1.76`
    )
    page.commonObjs.get = () => ({ name: 'Times-Roman', differences: { [code]: glyphName } })
    expect((await repairPdfSymbolText(page, content, operators)).items[0].str).toBe(
      `${unicode}1.76`
    )
  }
)

it.each([0, 90, 180, 270, 30])(
  'removes only hidden zero-alignment parentheses at a %s degree text rotation',
  (degrees) => {
    const angle = (degrees * Math.PI) / 180
    const cosine = Math.cos(angle),
      sine = Math.sin(angle)
    const token = (
      str: string,
      x: number
    ): { str: string; fontName: string; width: number; height: number; transform: number[] } => ({
      str,
      fontName: 'font',
      width: 5,
      height: 10,
      transform: [10 * cosine, 10 * sine, -10 * sine, 10 * cosine, x * cosine, 20 + x * sine]
    })
    const content = { items: [token('0', 0), token(' ', 5), token('(', 7)] }
    for (const [colour, expected] of [
      ['#eeeeef', '0 '],
      ['#000000', '0 (']
    ]) {
      const ops = {
        fnArray: [
          OPS.setFillRGBColor,
          OPS.fill,
          OPS.setFont,
          OPS.setFillRGBColor,
          OPS.showText,
          OPS.setFillRGBColor,
          OPS.showText
        ],
        argsArray: [
          ['#eeeeef'],
          [],
          ['font', 10],
          ['#000000'],
          [[{ unicode: '0' }]],
          [colour],
          [[{ unicode: '(' }]]
        ]
      }
      expect(
        removeBackgroundNumericPadding(content, ops)
          .items.map((i: { str: string }) => i.str)
          .join('')
      ).toBe(expected)
      const separated = { items: [content.items[0], token('(', 30)] }
      expect(removeBackgroundNumericPadding(separated, ops).items).toEqual(separated.items)
      const mismatched = { items: [token('00', 0), content.items[2]] }
      expect(removeBackgroundNumericPadding(mismatched, ops).items).toEqual(mismatched.items)
    }
  }
)

it('repairs chi inside a note only with the verified symbol code and advance width', async () => {
  const page = { commonObjs: { get: () => ({ name: 'ABCDEF+AdvPSMP13' }) } }
  for (const [code, width, expected] of [
    [118, 552, ', χ'],
    [118, 481, ', v'],
    [119, 552, ', v']
  ] as const) {
    const content = { items: [{ str: ', v', fontName: 'symbol' }] }
    const operators = {
      fnArray: [OPS.setFont, OPS.showText],
      argsArray: [['symbol', 8], [[{ originalCharCode: code, unicode: 'v', width }]]]
    }
    expect((await repairPdfSymbolText(page, content, operators)).items[0].str).toBe(expected)
  }
})

it('removes background-coloured decimal padding but retains visible comparisons', () => {
  const item = (
    str: string,
    x: number,
    width: number
  ): { str: string; fontName: string; transform: number[]; height: number; width: number } => ({
    str,
    fontName: 'f',
    transform: [10, 0, 0, 10, x, 100],
    height: 10,
    width
  })
  const items = [item('<', 10, 6), item('0.15', 18, 20), item('0', 38, 5)]
  const glyphs = (text: string): { unicode: string }[] => [...text].map((unicode) => ({ unicode }))
  for (const colour of ['#e3dbd5', '#000000']) {
    const ops = {
      fnArray: [
        OPS.setFont,
        OPS.setFillRGBColor,
        OPS.fill,
        OPS.showText,
        OPS.setFillRGBColor,
        OPS.showText,
        OPS.setFillRGBColor,
        OPS.showText
      ],
      argsArray: [
        ['f', 10],
        [colour],
        [],
        [glyphs('<')],
        ['#000000'],
        [glyphs('0.15')],
        [colour],
        [glyphs('0')]
      ]
    }
    for (const [visible, padding] of [
      ['5.1', '0'],
      ['1', '.0']
    ]) {
      const padded = [item(visible, 10, 20), item(padding, 30, 5)]
      const padOps = {
        fnArray: [
          OPS.setFont,
          OPS.setFillRGBColor,
          OPS.fill,
          OPS.setFillRGBColor,
          OPS.showText,
          OPS.setFillRGBColor,
          OPS.showText
        ],
        argsArray: [
          ['f', 10],
          [colour],
          [],
          ['#000000'],
          [glyphs(visible)],
          [colour],
          [glyphs(padding)]
        ]
      }
      expect(
        removeBackgroundNumericPadding({ items: padded }, padOps).items.map(
          (i: { str: string }) => i.str
        )
      ).toEqual(colour === '#000000' ? [visible, padding] : [visible])
    }
    const result = removeBackgroundNumericPadding({ items }, ops)
    expect(result.items.map((i: { str: string }) => i.str)).toEqual(
      colour === '#000000' ? ['<', '0.15', '0'] : ['0.15']
    )
    const detached = {
      items: items.map((i) => ({
        ...i,
        transform: [10, 0, 0, 10, i.transform[4], i.str === '0.15' ? 120 : 100]
      }))
    }
    expect(removeBackgroundNumericPadding(detached, ops).items).toEqual(detached.items)
  }
})
it.each([
  [2, 'C21', '\u0015', '≥'],
  [4, 'C20', '\u0014', '≤'],
  [254, 'thorn', 'þ', '+']
])(
  'uses named comparison glyph %s rather than an unrelated subset slot',
  async (code, name, unicode, expected) => {
    const content = { items: [{ str: unicode, fontName: 'f' }] }
    const ops = {
      fnArray: [OPS.setFont, OPS.showText],
      argsArray: [['f', 10], [[{ unicode, originalCharCode: code, width: 770 }]]]
    }
    const page = {
      commonObjs: {
        get: () => ({
          name: 'AdvP4C4E74',
          differences: { 2: 'C21', 3: 'C0', 4: 'C20', 254: 'thorn', [code]: name }
        })
      }
    }
    expect((await repairPdfSymbolText(page, content, ops)).items[0].str).toBe(expected)
  }
)

it.each([
  ['AdvMathSymb', 188, '¼', '=', 781, 'onequarter'],
  ['AdvPS7DA6', 44, ',', '<', 833, 'comma']
])(
  'uses verified named glyphs in %s only with matching font encoding',
  async (name, code, unicode, expected, width, glyphName) => {
    for (const matched of [true, false]) {
      const page = {
        commonObjs: {
          get: () => ({ name, differences: { [code]: matched ? glyphName : 'other' } })
        }
      }
      const content = { items: [{ str: unicode, fontName: 'source' }] }
      const ops = {
        fnArray: [OPS.setFont, OPS.showText],
        argsArray: [['source', 12], [[{ originalCharCode: code, unicode, width }]]]
      }
      expect((await repairPdfSymbolText(page, content, ops)).items[0].str).toBe(
        matched ? expected : unicode
      )
    }
  }
)
it.each([
  [3, '\u0015', '≥'],
  [4, '\u0014', '≤'],
  [254, 'þ', '+']
])(
  'uses comparison glyph names while requiring the treatment subset for slot %s',
  async (code, unicode, expected) => {
    for (const matched of [true, false]) {
      const page = {
        commonObjs: {
          get: () => ({
            name: 'AdvP4C4E74',
            differences: { 1: matched ? 'C3' : 'other', 3: 'C21', 4: 'C20', 121: 'y', 254: 'thorn' }
          })
        }
      }
      const content = { items: [{ str: unicode, fontName: 'source' }] }
      const ops = {
        fnArray: [OPS.setFont, OPS.showText],
        argsArray: [['source', 12], [[{ originalCharCode: code, unicode, width: 770 }]]]
      }
      expect((await repairPdfSymbolText(page, content, ops)).items[0].str).toBe(
        matched || code !== 254 ? expected : unicode
      )
    }
  }
)

it.each([
  ['1515) ED arm (n', ['1515)', 'ED arm (n']],
  ['Median age, years (range) 50 (23', ['Median age, years (range)', '50 (23']]
])('splits a joined table run by verified glyph advances: %s', (str, expected) => {
  const glyphs = [...str].map((unicode) => ({ unicode, width: 500, isSpace: unicode === ' ' }))
  const item = {
    str,
    fontName: 'f',
    dir: 'ltr',
    width: str.length * 5,
    height: 10,
    transform: [10, 0, 0, 10, 100, 500],
    hasEOL: true
  }
  // PDF.js expands a ligature elsewhere in the same font stream. Its width must
  // remain one glyph while stream validation uses the corresponding plain text.
  const other = { ...item, str: 'file', width: 15 }
  const ops = {
    fnArray: [OPS.setFont, OPS.showText, OPS.showText],
    argsArray: [
      ['f', 10],
      [glyphs],
      [
        [
          { unicode: 'ﬁ', width: 500 },
          { unicode: 'l', width: 500 },
          { unicode: 'e', width: 500 }
        ]
      ]
    ]
  }
  const result = splitPdfNumericRuns({ items: [item, other] }, ops).items
  expect(result.slice(0, 2).map((i: { str: string }) => i.str)).toEqual(expected)
  expect(result[1].transform[4]).toBe(100 + (expected[0].length + 1) * 5)
  expect(result.at(-1)).toEqual(other)
  const invalid = { ...item, width: item.width + 2 }
  expect(splitPdfNumericRuns({ items: [invalid, other] }, ops).items).toEqual([invalid, other])
})

it.each([
  [1, '1', '+', 833],
  [2, 'b', 'β', 611],
  [4, 'm', 'μ', 667],
  [5, '2', '−', 833],
  [6, ',', '<', 833],
  [7, '5', '=', 833],
  [9, 'l', 'λ', 556],
  [10, '´', 'ε', 500],
  [11, 'k', 'κ', 556],
  [12, 'a', 'α', 611],
  [13, 'g', 'γ', 556]
])(
  'decodes verified MathematicalPi glyph %s only in its matching subset',
  async (code, unicode, expected, width) => {
    const differences = [
      undefined,
      'one',
      'b',
      'eight',
      'm',
      'two',
      'comma',
      'five',
      'three',
      'l',
      'acute',
      'k',
      'a',
      'g',
      'numbersign'
    ]
    const content = { items: [{ str: unicode, fontName: 'f' }] }
    for (const condition of [
      'matching',
      'different-font',
      'different-subset',
      'different-width',
      'different-code'
    ]) {
      const names = [...differences]
      if (condition === 'different-subset') names[3] = 'seven'
      const page = {
        commonObjs: {
          get: () => ({
            name: condition === 'different-font' ? 'Times-Roman' : 'ABCDEF+MathematicalPi-One',
            differences: names
          })
        }
      }
      const ops = {
        fnArray: [OPS.setFont, OPS.showText],
        argsArray: [
          ['f', 10],
          [
            [
              {
                originalCharCode: condition === 'different-code' ? 99 : code,
                unicode,
                width: condition === 'different-width' ? Number(width) + 1 : width
              }
            ]
          ]
        ]
      }
      expect((await repairPdfSymbolText(page, content, ops)).items[0].str).toBe(
        condition === 'matching' ? expected : unicode
      )
    }
  }
)

it('retains an ambiguous Unicode slot and verifies the bold Pi minus separately', async () => {
  const content = { items: [{ str: '2', fontName: 'f' }] }
  const page = {
    commonObjs: {
      get: () => ({ name: 'ABCDEF+MathematicalPi-Four', differences: [undefined, 'two'] })
    }
  }
  const glyphs = [{ originalCharCode: 1, unicode: '2', width: 833 }]
  const ops = {
    fnArray: [OPS.setFont, OPS.showText],
    argsArray: [['f', 10], [glyphs]]
  }
  expect((await repairPdfSymbolText(page, content, ops)).items[0].str).toBe('−')
  glyphs.push({ originalCharCode: 2, unicode: '2', width: 500 })
  expect((await repairPdfSymbolText(page, content, ops)).items[0].str).toBe('2')
})

it('decodes fitted Myriad numerals only with matching private glyph names', async () => {
  const digits = '\uf639\uf6dc\uf63a\uf63b\uf63c\uf63d\uf63e\uf63f\uf640\uf641'
  const differences = Array.from(
    digits,
    (char) => 'uni' + char.charCodeAt(0).toString(16).toUpperCase()
  )
  for (const name of ['ABCDEF+MyriadPro-SemiCn', 'MyriadPro-SemiboldSemiCn', 'Times-Roman']) {
    const page = { commonObjs: { get: () => ({ name, differences }) } }
    const content = { items: [{ str: digits, fontName: 'source' }] }
    expect(
      (await repairPdfSymbolText(page, content, { fnArray: [], argsArray: [] })).items[0].str
    ).toBe(name === 'Times-Roman' ? digits : '0123456789')
  }
  const page = { commonObjs: { get: () => ({ name: 'MyriadPro-SemiCn', differences: [] }) } }
  expect(
    (
      await repairPdfSymbolText(
        page,
        { items: [{ str: digits, fontName: 'source' }] },
        { fnArray: [], argsArray: [] }
      )
    ).items[0].str
  ).toBe(digits)
})

it.each(
  [0, 1].flatMap((sample) =>
    ['native', 'wrong-font', 'wrong-slot', 'wrong-width', 'wrong-unicode', 'ambiguous-glyph'].map(
      (variant) => [sample, variant] as const
    )
  )
)(
  'preserves native alpha and Latin footnotes for font %s with %s evidence',
  async (sample, variant) => {
    const f = readPdfFixture(
      resolve('src/main/literature/pdf-structure/fixtures/native-alpha-fonts.jsonl')
    ).samples[sample]
    if (variant === 'wrong-font') f.font.name = 'Times-Roman'
    if (variant === 'wrong-slot') f.glyph.originalCharCode = 98
    if (variant === 'wrong-width') f.glyph.width += 1
    if (variant === 'wrong-unicode') f.glyph.unicode = 'b'
    const glyphs = [f.glyph]
    if (variant === 'ambiguous-glyph') glyphs.push({ ...f.glyph, originalCharCode: 99 })
    const content = {
      items: [
        { str: f.glyph.unicode, fontName: 'native' },
        { str: 'a', fontName: 'footnote' },
        { str: 'data', fontName: 'prose' }
      ]
    }
    const operators = {
      fnArray: [OPS.setFont, OPS.showText],
      argsArray: [['native', 10], [glyphs]]
    }
    const before = structuredClone({ f, content, operators })
    const result = await repairPdfSymbolText(
      {
        commonObjs: {
          get: (name: string) => (name === 'native' ? f.font : { name: 'Times-Roman' })
        }
      },
      content,
      operators
    )
    expect(result.items.map((i: { str: string }) => i.str)).toEqual([
      variant === 'native' ? 'α' : f.glyph.unicode,
      'a',
      'data'
    ])
    expect({ f, content, operators }).toEqual(before)
  }
)

it.each(['missing', 'contradictory'])(
  'preserves a Latin glyph with %s native encoding evidence',
  async (variant) => {
    const f = readPdfFixture(
      resolve('src/main/literature/pdf-structure/fixtures/native-alpha-fonts.jsonl')
    ).samples[0]
    if (variant === 'missing') delete f.font.differences[97]
    else f.font.differences[97] = 'b'
    const content = { items: [{ str: 'a', fontName: 'native' }] }
    const result = await repairPdfSymbolText({ commonObjs: { get: () => f.font } }, content, {
      fnArray: [OPS.setFont, OPS.showText],
      argsArray: [['native', 10], [[f.glyph]]]
    })
    expect(result.items[0].str).toBe('a')
  }
)

it.each(['native', 'wrong-font', 'wrong-width', 'wrong-slot', 'wrong-name', 'wrong-unicode'])(
  'decodes a native prime without replacing numeric zeros: %s',
  async (variant) => {
    const f = readPdfFixture(
      resolve('src/main/literature/pdf-structure/fixtures/native-prime-font.jsonl')
    )
    if (variant === 'wrong-font') f.font.name = 'Times-Roman'
    if (variant === 'wrong-width') f.glyph.width = 500
    if (variant === 'wrong-slot') f.glyph.originalCharCode = 49
    if (variant === 'wrong-name') f.font.differences[48] = 'one'
    if (variant === 'wrong-unicode') f.glyph.unicode = '1'
    const content = {
      items: [
        { str: f.glyph.unicode, fontName: 'native' },
        { str: '50', fontName: 'prose' }
      ]
    }
    const result = await repairPdfSymbolText(
      {
        commonObjs: {
          get: (name: string) => (name === 'native' ? f.font : { name: 'Times-Roman' })
        }
      },
      content,
      {
        fnArray: [OPS.setFont, OPS.showText],
        argsArray: [['native', 7], [[f.glyph]]]
      }
    )
    expect(result.items.map((i: { str: string }) => i.str)).toEqual([
      variant === 'native' ? '′' : f.glyph.unicode,
      '50'
    ])
  }
)

it.each([
  ['AdvPSMP10', 118, 'v', 'χ', 500],
  ['AdvPSMP11', 108, 'l', 'μ', 552],
  ['AdvP7DED', 53, '5', '=', 833]
])(
  'repairs the native clinical-font slot %s/%s without guessing prose',
  async (name, code, source, expected, width) => {
    const page = { commonObjs: { get: () => ({ name, differences: { 53: 'five' } }) } }
    const content = {
      items: [
        { str: source, fontName: 'math' },
        { str: source, fontName: 'prose' }
      ]
    }
    const ops = {
      fnArray: [OPS.setFont, OPS.showText],
      argsArray: [['math', 10], [[{ originalCharCode: code, unicode: source, width }]]]
    }
    expect(
      (await repairPdfSymbolText(page, content, ops)).items.map((i: { str: string }) => i.str)
    ).toEqual([expected, source])
  }
)

it('corrects the extra Tc advance from an empty leading TJ string using exact glyph alignment', async () => {
  const { repairSpacedTextOffsets } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-symbol-text.mjs')).href
  )
  const item = (str: string, x: number): unknown => ({
    str,
    fontName: 'f',
    dir: 'ltr',
    transform: [8, 0, 0, 8, x, 340],
    width: 4,
    height: 8
  })
  const content = { items: [item(')', 280), item('n', 430), item('52', 296)] }
  const ops = {
    fnArray: [
      OPS.setFont,
      OPS.setCharSpacing,
      OPS.showText,
      OPS.moveText,
      OPS.setCharSpacing,
      OPS.showText
    ],
    argsArray: [
      ['f', 1],
      [18.47],
      [[-0.1, { unicode: ')' }, { unicode: 'n' }]],
      [20, 0],
      [0],
      [[{ unicode: '52' }]]
    ]
  }
  const repaired = repairSpacedTextOffsets(content, ops)
  expect(repaired.items.map((i: { transform: number[] }) => i.transform[4])).toEqual([
    280 - 18.47 * 8,
    430 - 18.47 * 8,
    296
  ])
  expect(repaired.items.map((i: { str: string }) => i.str)).toEqual([')', 'n', '52'])
  const mismatch = { items: [...content.items, item('extra', 0)] }
  expect(repairSpacedTextOffsets(mismatch, ops)).toEqual(mismatch)
  const noLeadingAdjustment = structuredClone(ops)
  noLeadingAdjustment.argsArray[2][0] = [{ unicode: ')' }, { unicode: 'n' }]
  expect(repairSpacedTextOffsets(content, noLeadingAdjustment)).toEqual(content)
  // Operator glyphs iterate Unicode code points. A supplementary-plane symbol
  // must not consume the following item's offset or move an unshifted item.
  const unicodeOps = structuredClone(ops)
  unicodeOps.argsArray[2][0] = [-0.1, { unicode: '𝛼' }, { unicode: 'n' }]
  const unicodeContent = { items: [item('𝛼', 280), item('n', 430), item('52', 296)] }
  expect(
    repairSpacedTextOffsets(unicodeContent, unicodeOps).items.map(
      (i: { transform: number[] }) => i.transform[4]
    )
  ).toEqual([280 - 18.47 * 8, 430 - 18.47 * 8, 296])
})

// The source glyphs render <, > and ≥; slot 5 in another Pi subset is χ.
it.each([
  ['H11021', 5, '<'],
  ['H11022', 6, '>'],
  ['H11350', 7, '≥']
])(
  'recovers named MathematicalPi comparison %s only with matching font evidence',
  async (glyphName, code, expected) => {
    const unicode = String.fromCharCode(Number(code))
    for (const variant of ['native', 'wrong-font', 'wrong-width', 'wrong-name']) {
      const differences: string[] = []
      differences[Number(code)] = variant === 'wrong-name' ? 'unknown' : String(glyphName)
      const result = await repairPdfSymbolText(
        {
          commonObjs: {
            get: () => ({
              name: variant === 'wrong-font' ? 'Times-Roman' : 'ABCDEF+MathematicalPi-One',
              differences
            })
          }
        },
        { items: [{ str: unicode, fontName: 'native' }] },
        {
          fnArray: [OPS.setFont, OPS.showText],
          argsArray: [
            ['native', 10],
            [[{ originalCharCode: code, unicode, width: variant === 'wrong-width' ? 832 : 833 }]]
          ]
        }
      )
      expect(result.items[0].str).toBe(variant === 'native' ? expected : unicode)
    }
  }
)

it.each(['native', 'wrong-font', 'wrong-slot', 'wrong-width', 'ambiguous'])(
  'decodes native statistical and comparison fonts with %s evidence',
  async (variant) => {
    const { samples } = readPdfFixture(
      resolve(
        'src/main/literature/pdf-structure/fixtures/native-statistical-and-comparison-glyphs.jsonl'
      )
    )
    for (const sample of samples) {
      const { font, glyph, expected } = sample
      if (variant === 'wrong-font') font.name = 'Times-Roman'
      if (variant === 'wrong-slot') glyph.originalCharCode = 999
      if (variant === 'wrong-width') glyph.width += 1
      const glyphs =
        variant === 'ambiguous' ? [glyph, { ...glyph, originalCharCode: 998 }] : [glyph]
      const content = { items: [{ str: glyph.unicode, fontName: 'native' }] }
      const result = await repairPdfSymbolText({ commonObjs: { get: () => font } }, content, {
        fnArray: [OPS.setFont, OPS.showText],
        argsArray: [['native', 10], [glyphs]]
      })
      expect(result.items[0].str).toBe(variant === 'native' ? expected : glyph.unicode)
    }
  }
)
it('separates native probability and hazard-interval runs using measured glyph advances', () => {
  const f = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/native-probability-beside-hazard-interval.jsonl'
    )
  )
  const original = structuredClone(f)
  const split = splitPdfNumericRuns(f.content, f.operators).items
  const first = split.find(
    (i: { str: string; transform: number[] }) =>
      i.str === '0.177' &&
      i.transform[4] === f.target.transform[4] &&
      i.transform[5] === f.target.transform[5]
  )
  expect(first).toBeDefined()
  const next = split[split.indexOf(first) + 1]
  expect(next.str).toBe('0.96 (0.69–1.28)')
  expect(next.transform[4]).toBeGreaterThan(first.transform[4] + first.width)
  expect(next.transform[4] + next.width).toBeCloseTo(f.target.transform[4] + f.target.width, 5)
  expect(f).toEqual(original)
  const invalid = structuredClone(f.content)
  invalid.items.find((i: { str: string }) => i.str === f.target.str).width += f.target.height * 3
  expect(splitPdfNumericRuns(invalid, f.operators).items).toContainEqual(
    expect.objectContaining({ str: f.target.str })
  )
})

it.each(['native', 'bold-native', 'wrong-font', 'missing-name'])(
  'decodes private numeral glyphs only with matching %s evidence',
  async (variant) => {
    const chars = Array.from({ length: 10 }, (_, n) => String.fromCharCode(0xf130 + n)).join('')
    const font = {
      name:
        variant === 'wrong-font'
          ? 'Times-Roman'
          : variant === 'bold-native'
            ? 'ABCDEF+AdvOT58b04b30.B+f1'
            : 'ABCDEF+AdvOTfc06a83e+f1',
      differences:
        variant === 'missing-name' ? [] : Array.from({ length: 10 }, (_, n) => `uniF13${n}`)
    }
    const content = { items: [{ str: chars, fontName: 'source' }] }
    const result = await repairPdfSymbolText({ commonObjs: { get: () => font } }, content, {
      fnArray: [],
      argsArray: []
    })
    expect(result.items[0].str).toBe(
      ['native', 'bold-native'].includes(variant) ? '0123456789' : chars
    )
    expect(content.items[0].str).toBe(chars)
  }
)
it.each([
  ['Universal-GreekwithMathPi', 5, 833, 'H11003', '×'],
  ['Universal-GreekwithMathPi', 6, 833, 'H11003', '×'],
  ['MathematicalPi-Six', 2, 500, 'H11569', '*']
])(
  'decodes %s slot %s using its embedded glyph',
  async (name, code, width, glyphName, expected) => {
    const unicode = String.fromCharCode(code)
    for (const variant of ['native', 'wrong-font', 'wrong-name', 'wrong-width']) {
      const font = {
        name: variant === 'wrong-font' ? 'Times-Roman' : `ABCDEF+${name}`,
        differences: { [code]: variant === 'wrong-name' ? 'unknown' : glyphName }
      }
      const result = await repairPdfSymbolText(
        { commonObjs: { get: () => font } },
        { items: [{ str: unicode, fontName: 'source' }] },
        {
          fnArray: [OPS.setFont, OPS.showText],
          argsArray: [
            ['source', 12],
            [
              [
                {
                  originalCharCode: code,
                  unicode,
                  width: variant === 'wrong-width' ? width + 1 : width
                }
              ]
            ]
          ]
        }
      )
      expect(result.items[0].str).toBe(variant === 'native' ? expected : unicode)
    }
  }
)

it.each([0, 90, 180, 270])(
  'respects a path clip for rotated text at %s degrees and retains partial visibility',
  async (angle) => {
    const radians = (angle * Math.PI) / 180,
      a = Math.cos(radians),
      b = Math.sin(radians)
    const item = (
      str: string,
      x: number,
      y: number
    ): { str: string; fontName: string; width: number; height: number; transform: number[] } => ({
      str,
      fontName: 'f',
      width: 20,
      height: 10,
      transform: [10 * a, 10 * b, -10 * b, 10 * a, x, y]
    })
    const content = {
      items: [item('hidden', 200, 200), item('visible', 50, 50), item('edge', 99, 50)]
    }
    const glyphs = (text: string): { unicode: string }[][] => [
      [...text].map((unicode) => ({ unicode }))
    ]
    const operators = {
      fnArray: [
        OPS.save,
        OPS.clip,
        OPS.constructPath,
        OPS.setFont,
        OPS.showText,
        OPS.showText,
        OPS.showText,
        OPS.restore
      ],
      argsArray: [
        [],
        [],
        [OPS.endPath, [], [0, 0, 100, 100]],
        ['f', 10],
        glyphs('hidden'),
        glyphs('visible'),
        glyphs('edge'),
        []
      ]
    }
    const result = await repairPdfSymbolText({}, content, operators)
    expect(result.items.map((i: { str: string }) => i.str)).toEqual(['visible', 'edge'])
    expect(content.items).toHaveLength(3)
  }
)
it.each([250, 500, 900])(
  'splits paired mean/deviation runs only across a verified column gap of %s',
  (gap) => {
    const a = '55.8 (10.9)',
      b = '57.1 (11.6)',
      str = a + ' ' + b
    const glyphs = [...str].map((unicode, n) => ({
      unicode,
      width: n === a.length ? gap : 500,
      isSpace: unicode === ' '
    }))
    const item = {
      str,
      fontName: 'f',
      dir: 'ltr',
      width: (str.length - 1) * 5 + gap / 100,
      height: 10,
      transform: [10, 0, 0, 10, 100, 500],
      hasEOL: true
    }
    const operators = { fnArray: [OPS.setFont, OPS.showText], argsArray: [['f', 10], [glyphs]] }
    const result = splitPdfNumericRuns({ items: [item] }, operators).items
    if (gap < 500) expect(result).toEqual([item])
    else {
      expect(result.map((i: { str: string }) => i.str)).toEqual([a, b])
      expect(result[1].transform[4]).toBe(100 + a.length * 5 + gap / 100)
      expect(result[0].width + gap / 100 + result[1].width).toBe(item.width)
    }
  }
)
