/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'

// Recover separate numeric entries from one PDF.js item using the original TJ
// advances, not equal-width guesses. Bounded count/fraction, header and statistic
// patterns are eligible; incompatible font streams or geometry remain untouched.
export function splitPdfNumericRuns(content, operators) {
  const pattern = /^\d+(?:\.\d+)?\s*\(\d+\/\d+\)(?:\s+\d+(?:\.\d+)?\s*\(\d+\/\d+\))+$/
  const joinedHeader = /^(\d+\))\s+([A-Za-z][A-Za-z -]+\s*\(n)$/
  const joinedRange = /^(.+\((?:range|IQR)\))\s+(\d+(?:\.\d+)?\s*\(\d+(?:\.\d+)?)$/i
  const spacedStatistics =
    /^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?(?:\s*\([−–+-]?\d+(?:\.\d+)?[−–-][−–+-]?\d+(?:\.\d+)?\))?|\*{1,3})$/
  const pairedSummary = /^(\d+\.\d+\s*\(\d+\.\d+\))\s+(\d+\.\d+\s*\(\d+\.\d+\))$/
  const eligible = (text) =>
    pattern.test(text.trim()) ||
    joinedHeader.test(text.trim()) ||
    joinedRange.test(text.trim()) ||
    spacedStatistics.test(text.trim()) ||
    pairedSummary.test(text.trim())
  if (!content.items.some((i) => 'str' in i && eligible(i.str))) return content
  const streams = new Map(),
    stack = []
  let font,
    size = 0,
    charSpace = 0,
    wordSpace = 0
  for (let run = 0; run < operators.fnArray.length; run++) {
    const op = operators.fnArray[run],
      args = operators.argsArray[run]
    if (op === OPS.save) stack.push({ font, size, charSpace, wordSpace })
    else if (op === OPS.restore)
      ({ font, size, charSpace, wordSpace } = stack.pop() ?? {
        size: 0,
        charSpace: 0,
        wordSpace: 0
      })
    else if (op === OPS.setFont) [font, size] = args
    else if (op === OPS.setCharSpacing) charSpace = args[0]
    else if (op === OPS.setWordSpacing) wordSpace = args[0]
    else if (op === OPS.showText && font) {
      if (!streams.has(font)) streams.set(font, [])
      const stream = streams.get(font)
      let x = 0
      for (const glyph of args[0]) {
        if (typeof glyph === 'number') {
          x -= (glyph * size) / 1000
          continue
        }
        if (!glyph || typeof glyph.unicode !== 'string') continue
        const start = x
        x += (glyph.width * size) / 1000 + charSpace + (glyph.isSpace ? wordSpace : 0)
        for (const char of glyph.unicode
          .replace(/[ﬀ-ﬆ]/gu, (c) => c.normalize('NFKC'))
          .replace(/\s/gu, ''))
          stream.push({ char, start, end: x, run, size })
      }
    }
  }
  const source = new Map()
  for (const i of content.items)
    if ('str' in i)
      source.set(i.fontName, (source.get(i.fontName) ?? '') + i.str.replace(/\s/gu, ''))
  for (const [name, stream] of streams)
    if (stream.map((g) => g.char).join('') !== source.get(name)) streams.delete(name)
  const offsets = new Map()
  return {
    ...content,
    items: content.items.flatMap((item) => {
      if (!('str' in item) || !streams.has(item.fontName)) return [item]
      const offset = offsets.get(item.fontName) ?? 0,
        length = item.str.replace(/\s/gu, '').length
      offsets.set(item.fontName, offset + length)
      if (
        !eligible(item.str) ||
        !item.transform ||
        item.dir !== 'ltr' ||
        Math.abs(item.transform[0] * item.transform[2] + item.transform[1] * item.transform[3]) >
          0.001 ||
        item.transform[0] * item.transform[3] - item.transform[1] * item.transform[2] <= 0
      )
        return [item]
      let glyphs = streams.get(item.fontName).slice(offset, offset + length)
      const first = glyphs[0]
      if (!first || first.size <= 0) return [item]
      const axis = Math.hypot(item.transform[0], item.transform[1])
      const scale = axis / first.size
      const statistics =
        item.str.trim().match(spacedStatistics) ?? item.str.trim().match(pairedSummary)
      let separateRuns = false
      if (glyphs.some((g) => g.run !== first.run)) {
        if (!statistics) return [item]
        const split = statistics[1].replace(/\s/g, '').length,
          second = glyphs[split]
        if (
          second.run === first.run ||
          glyphs.some(
            (g, n) => g.size !== first.size || g.run !== (n < split ? first.run : second.run)
          )
        )
          return [item]
        // PDF.js may combine two independent showText runs on one baseline.
        // Their measured glyph widths and the combined item extent determine
        // the sole intervening gap; no equal-width character estimate is used.
        const secondStart = first.start + item.width / scale - (glyphs.at(-1).end - second.start)
        const gap = (secondStart - glyphs[split - 1].end) * scale
        if (gap < 0 || gap > item.height * 2) return [item]
        glyphs = glyphs.map((g, n) =>
          n < split
            ? g
            : {
                ...g,
                start: g.start + secondStart - second.start,
                end: g.end + secondStart - second.start
              }
        )
        separateRuns = true
      }
      if (scale <= 0 || Math.abs((glyphs.at(-1).end - first.start) * scale - item.width) > 0.02)
        return [item]
      let cursor = 0
      const joined =
        item.str.trim().match(joinedHeader) ?? item.str.trim().match(joinedRange) ?? statistics
      if (statistics && !separateRuns) {
        const split = statistics[1].replace(/\s/g, '').length
        // A normal space or thousands separator is not a column boundary.
        if (
          (glyphs[split].start - glyphs[split - 1].end) * scale <
          item.height * (pairedSummary.test(item.str.trim()) ? 0.5 : 0.75)
        )
          return [item]
      }
      const fragments = joined
        ? joined.slice(1)
        : [...item.str.matchAll(/\d+(?:\.\d+)?\s*\(\d+\/\d+\)/g)].map((m) => m[0])
      const parts = fragments.map((text) => {
        const count = text.replace(/\s/gu, '').length,
          a = glyphs[cursor],
          b = glyphs[cursor + count - 1]
        cursor += count
        return {
          ...item,
          str: text,
          width: (b.end - a.start) * scale,
          transform: [
            ...item.transform.slice(0, 4),
            item.transform[4] + ((a.start - first.start) * scale * item.transform[0]) / axis,
            item.transform[5] + ((a.start - first.start) * scale * item.transform[1]) / axis
          ],
          hasEOL: cursor === length && item.hasEOL
        }
      })
      return parts.every(
        (p, i) =>
          p.width > 0 &&
          (!i ||
            ((p.transform[4] - parts[i - 1].transform[4]) * item.transform[0] +
              (p.transform[5] - parts[i - 1].transform[5]) * item.transform[1]) /
              axis >=
              parts[i - 1].width - 0.001)
      )
        ? parts
        : [item]
    })
  }
}

// This embedded TeX font uses a legacy symbol encoding but is sometimes given a
// Latin ToUnicode map. These slots render as star/plus/equals in the font. Require
// both the font and original glyph code; never replace these characters globally.
const texSymbols = new Map([
  [0, ['\u0000', '−', 250]],
  [3, ['�', '*']],
  [135, ['þ', '+']],
  [136, ['¼', '=']]
])
const galliardComparisonSubset = new Map([
  [81, ['«', '≤', 860, 'guillemotleft']],
  [82, ['»', '≥', 860, 'guillemotright']]
])
const comparisonSubset = new Map([
  [2, ['\u0002', '–', 770]],
  [3, ['\u0015', '≥', 770]],
  [4, ['\u0014', '≤', 770]]
])
const footnoteSubset = new Map([
  [3, ['\u0003', '±', 770]],
  [121, ['y', '†', 437]],
  [122, ['z', '‡', 437]]
])
const universalGlyphs = new Map([
  ['H11001', '+'],
  ['H11002', '−'],
  ['H11003', '×'],
  ['H11005', '='],
  ['H11006', '±'],
  ['H11021', '<'],
  ['H11022', '>']
])
const latinPiSymbols = new Map([
  [
    'MathematicalPi-One',
    new Map([
      [1, ['1', '+', 833, 'one']],
      [2, ['b', 'β', 611, 'b']],
      [4, ['m', 'μ', 667, 'm']],
      [5, ['2', '−', 833, 'two']],
      [6, [',', '<', 833, 'comma']],
      [7, ['5', '=', 833, 'five']],
      [9, ['l', 'λ', 556, 'l']],
      [10, ['´', 'ε', 500, 'acute']],
      [11, ['k', 'κ', 556, 'k']],
      [12, ['a', 'α', 611, 'a']],
      [13, ['g', 'γ', 556, 'g']]
    ])
  ],
  ['MathematicalPi-Four', new Map([[1, ['2', '−', 833, 'two']]])]
])
const publisherSymbols = new Map([
  ['AdvOT463cc31e', new Map([[53, ['5', '=', 822]]])],
  [
    'AdvPS586B',
    new Map([
      [54, ['6', '±', 833]],
      [53, ['5', '=', 833]]
    ])
  ],
  ['AdvMT_SY', new Map([[188, ['¼', '=', 770]]])],
  ['MinionMathSymbols', new Map([[136, ['�', '=', 583]]])],
  ['TeX_CM_Bold_Maths_Symbols', new Map([[136, ['¼', '=', 885]]])],
  ['AdvTT454a7a89', new Map([[98, ['b', '<', 562]]])],
  [
    'AdvPS4731B1',
    new Map([
      [33, ['!', '<', 1000]],
      [79, ['O', '>', 1000]]
    ])
  ],
  ['AdvPS3F4C13', new Map([[117, ['u', 'ω', 718]]])],
  [
    'AdvP0003',
    new Map([
      [106, ['j', '−', 833]],
      [81, ['Q', '≥', 552, 'Q']]
    ])
  ],
  [
    'AdvP0004',
    new Map([
      [71, ['G', '<', 562]],
      [57, ['9', '>', 562]]
    ])
  ],
  ['AdvP0005', new Map([[89, ['Y', '–', 500]]])],
  // AdvP0DE0 paints these legacy WinAnsi slots as an en dash and fi ligature.
  // The dedicated math font supplies real plus/minus signs separately.
  [
    'AdvP0DE0',
    new Map([
      [177, ['±', '–', 552]],
      [174, ['Æ', 'fi', 614]]
    ])
  ],
  ['AdvPS.MH4', new Map([[53, ['5', '=', 833]]])],
  [
    'AdvPSMP4',
    new Map([
      [91, ['[', '>', 1000]],
      [92, ['\\', '<', 1000]]
    ])
  ],
  [
    'AdvPSMP11',
    new Map([
      [98, ['b', 'β', 500]],
      [108, ['l', 'μ', 552]]
    ])
  ],
  [
    'AdvPSMP10',
    new Map([
      [98, ['b', 'β', 552]],
      [118, ['v', 'χ', 500]]
    ])
  ],
  ['AdvP697C', new Map([[97, ['a', 'α', 635, 'a']]])],
  [
    'AdvP7DED',
    new Map([
      [97, ['a', 'α', 666]],
      [53, ['5', '=', 833, 'five']]
    ])
  ],
  [
    'AdvPi1',
    new Map([
      [52, ['4', '>', 1000]],
      [43, ['+', '±', 1000]],
      [119, ['w', 'χ', 552]]
    ])
  ],
  [
    'AdvMacMthSyN',
    new Map([
      [188, ['¼', '=', 781]],
      [2, ['\u0002', '−', 781, 'C0']]
    ])
  ],
  ['AdvEls-ent4', new Map([[111, ['o', '<', 979]]])],
  ['AdvEls-ent5', new Map([[90, ['Z', '≥', 979]]])],
  [
    'AdvPSMP13',
    new Map([
      [97, ['a', 'α', 552]],
      [98, ['b', 'β', 552]],
      [118, ['v', 'χ', 552]]
    ])
  ],
  [
    'AdvTir_symb',
    new Map([
      [63, ['?', '+', 781]],
      [66, ['B', '≤', 750]],
      [67, ['C', '≥', 750]]
    ])
  ],
  [
    'WTimesGreekSF-One',
    new Map([
      [176, ['∞', '<', 833]],
      [185, ['π', '+', 833]],
      [186, ['∫', '±', 833]],
      [189, ['Ω', '=', 833]]
    ])
  ],
  [
    'AdvPS3FDD77',
    new Map([
      [90, ['Z', '=', 1000]],
      [91, ['[', '=', 1000]]
    ])
  ],
  ['AdvP7CA8', new Map([[85, ['U', '=', 833]]])],
  ['AdvMathSymb', new Map([[188, ['¼', '=', 781, 'onequarter']]])],
  [
    'AdvP4C4E74',
    new Map([
      [48, ['0', '′', 270, 'zero']],
      [188, ['¼', '=', 770]],
      [136, ['à', '=', 770]],
      [2, ['\u0002', '±', 770]],
      [4, ['\u0004', '±', 770]],
      [20, ['\u0014', '≤', 770]],
      [21, ['\u0015', '≥', 770]],
      [135, ['á', '+', 770]],
      [1, ['\u0001', '−', 770]]
    ])
  ],
  ['AdvP7DA6', new Map([[109, ['m', 'µ', 666]]])],
  [
    'AdvPS7DA6',
    new Map([
      [36, ['$', '≥', 833]],
      [35, ['#', '≤', 833]],
      [53, ['5', '=', 833]],
      [44, [',', '<', 833, 'comma']]
    ])
  ],
  [
    'NewGalliard-Roman',
    new Map([
      [74, ['»', '≥', 860, 'guillemotright']],
      [71, ['«', '≤', 860, 'guillemotleft']]
    ])
  ],
  ['AdvP4C4E3A', new Map([[188, ['¼', '=', 885]]])],
  ['AdvP4C9543', new Map([[167, ['§', '±', 781]]])],
  [
    'Universal-GreekwithMathPi',
    new Map([
      [1, ['\u0001', '=', 833]],
      [2, ['\u0002', '±', 833]],
      [3, ['\u0003', '<', 833]]
    ])
  ],
  [
    'MathematicalPi-Four',
    new Map([
      [1, ['\u0001', '=', 833]],
      [2, ['\u0002', '±', 833]]
    ])
  ],
  [
    'MathematicalPi-One',
    new Map([
      [1, ['\u0001', 'µ', 667]],
      [5, ['\u0005', 'χ', 556, 'H9273']]
    ])
  ],
  [
    'MathematicalPi-Six',
    new Map([
      [1, ['\u0001', '*', 500, 'H11569']],
      [2, ['\u0002', '*', 500, 'H11569']]
    ])
  ]
])

export async function repairPdfSymbolText(page, content, operators) {
  if (content.items.some((item) => item.transform)) operators ??= await page.getOperatorList()
  content = repairSpacedTextOffsets(content, operators)
  const originalContent = content
  // Myriad's fitted numeral glyphs retain Adobe private-use codes in some
  // PDFs. Check the font and its encoding entry rather than replacing private
  // Unicode globally: other fonts may paint unrelated outlines at these slots.
  if (
    content.items.some(
      (item) => 'str' in item && /[\uf130-\uf139\uf639-\uf641\uf6dc]/u.test(item.str)
    )
  ) {
    operators ??= await page.getOperatorList()
    const fitted = new Map([
      ['\uf639', '0'],
      ['\uf6dc', '1'],
      ['\uf63a', '2'],
      ['\uf63b', '3'],
      ['\uf63c', '4'],
      ['\uf63d', '5'],
      ['\uf63e', '6'],
      ['\uf63f', '7'],
      ['\uf640', '8'],
      ['\uf641', '9']
    ])
    content = {
      ...content,
      items: content.items.map((item) => {
        if (!('str' in item) || !/[\uf130-\uf139\uf639-\uf641\uf6dc]/u.test(item.str)) return item
        const font = page.commonObjs.get(item.fontName)
        const name = font.name?.replace(/^[A-Z]{6}\+/, '')
        const privateDigits = ['AdvOTfc06a83e+f1', 'AdvOT58b04b30.B+f1'].includes(name)
        if (!privateDigits && !/^MyriadPro-(?:Semibold)?SemiCn$/.test(name)) return item
        return {
          ...item,
          str: item.str.replace(
            privateDigits ? /[\uf130-\uf139]/gu : /[\uf639-\uf641\uf6dc]/gu,
            (char) =>
              font.differences?.includes(`uni${char.charCodeAt(0).toString(16).toUpperCase()}`)
                ? privateDigits
                  ? String(char.charCodeAt(0) - 0xf130)
                  : fitted.get(char)
                : char
          )
        }
      })
    }
  }
  const letters = new Map()
  for (const item of content.items) {
    if (!('str' in item)) continue
    if (!letters.has(item.fontName)) letters.set(item.fontName, new Set())
    for (const char of item.str) if (/[A-Za-z]/.test(char)) letters.get(item.fontName).add(char)
  }
  if ([...letters.values()].some((chars) => chars.size >= 35)) {
    operators ??= await page.getOperatorList()
    content = repairShiftedLatinCase(content, operators)
  }
  if (content.items.some((item) => 'str' in item && /\d{2}/u.test(item.str))) {
    operators ??= await page.getOperatorList()
    content = removeInvisibleNumericPadding(content, operators, originalContent)
  }
  if (
    !content.items.some(
      (item) =>
        ('str' in item &&
          ([
            '�',
            'þ',
            '¼',
            '§',
            '±',
            'Æ',
            'á',
            '\u0000',
            '\u0001',
            '\u0002',
            '\u0003',
            '\u0004',
            '\u0005',
            '\u0006',
            '\u0007',
            '?',
            'à',
            '\\',
            '\u0014',
            '\u0015',
            '$',
            '»',
            '«',
            '∞',
            'π',
            '∫',
            'Ω',
            'Ω'
          ].some((char) => item.str.includes(char)) ||
            /^[jGQ9](?:$|[\d.])|(?:^|\d)Y(?:$|\d)/.test(item.str) ||
            ['+', 'w', '!', 'O', '#'].includes(item.str) ||
            item.str === 'e' ||
            item.str === 'm' ||
            item.str === 'u' ||
            item.str === 'Z' ||
            item.str === 'U' ||
            item.str === '[' ||
            item.str === ',' ||
            item.str === 'D' ||
            item.str === 'C' ||
            item.str === 'B' ||
            item.str === 'o' ||
            item.str === 'a' ||
            item.str === 'b' ||
            (item.str.includes('v') && page.commonObjs?.get))) ||
        item.str === '0' ||
        item.str === '4' ||
        ['1', '2', 'l', '´', 'k', 'g'].includes(item.str) ||
        item.str === '5' ||
        item.str === '6' ||
        item.str === 'y' ||
        item.str === 'z'
    )
  )
    return removeBackgroundNumericPadding(
      removeClippedFormText(content, operators, originalContent),
      operators
    )
  operators ??= await page.getOperatorList()
  const mappings = new Map()
  const fontStack = []
  let font
  for (let index = 0; index < operators.fnArray.length; index++) {
    const op = operators.fnArray[index],
      args = operators.argsArray[index]
    if (op === OPS.save) fontStack.push(font)
    else if (op === OPS.restore) font = fontStack.pop()
    else if (op === OPS.setFont) font = args[0]
    else if (op === OPS.showText && font) {
      const fontInfo = page.commonObjs?.get(font) ?? {}
      const name = fontInfo.name?.replace(/^[A-Z]{6}\+/, '')
      // These legacy Pi subsets label mathematical outlines with Latin glyph
      // names. Require the complete observed encoding as well as each glyph's
      // original code, Unicode and width; other subsets remain untouched.
      const latinPi =
        (name === 'MathematicalPi-One' &&
          fontInfo.differences?.length === 15 &&
          [
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
          ].every((value, n) => fontInfo.differences[n + 1] === value)) ||
        (name === 'MathematicalPi-Four' &&
          fontInfo.differences?.length === 2 &&
          fontInfo.differences[1] === 'two')
          ? latinPiSymbols.get(name)
          : undefined
      const alternateGalliard =
        name === 'NewGalliard-Roman' &&
        fontInfo.differences?.[75] === 'less' &&
        fontInfo.differences?.[81] === 'guillemotleft' &&
        fontInfo.differences?.[82] === 'guillemotright' &&
        fontInfo.differences?.[83] === 'equal'
      if (
        name === 'NewGalliard-Roman' &&
        !alternateGalliard &&
        !['guillemotleft', 'greater', 'less', 'guillemotright'].every(
          (value, i) => fontInfo.differences?.[71 + i] === value
        )
      )
        continue
      if (name !== 'TeX_CM_Maths_Symbols' && name !== 'AdvPS44A44B' && !publisherSymbols.has(name))
        continue
      let map = mappings.get(font)
      if (!map) mappings.set(font, (map = new Map()))
      for (const glyph of args[0]) {
        if (typeof glyph !== 'object' || !glyph) continue
        // This publisher's dedicated punctuation font paints its 750-unit
        // dash at WinAnsi e. Require the font, code, Unicode and advance width;
        // an e in a prose font is still a letter.
        // Universal's subset slots are not stable between papers. This
        // encoding names the less-than glyph H11021 in slot 2, not plus/minus.
        const isComparisonSubset =
          name === 'AdvP4C4E74' &&
          ['C1', 'C0', 'C21', 'C20'].every(
            (glyphName, i) => fontInfo.differences?.[i + 1] === glyphName
          )
        const alternateComparison =
          name === 'AdvP4C4E74' &&
          fontInfo.differences?.[2] === 'C21' &&
          fontInfo.differences?.[3] === 'C0' &&
          fontInfo.differences?.[4] === 'C20' &&
          fontInfo.differences?.[254] === 'thorn'
        const treatmentComparison =
          name === 'AdvP4C4E74' &&
          fontInfo.differences?.[1] === 'C3' &&
          fontInfo.differences?.[3] === 'C21' &&
          fontInfo.differences?.[4] === 'C20' &&
          fontInfo.differences?.[121] === 'y' &&
          fontInfo.differences?.[254] === 'thorn'
        const publisher =
          name === 'AdvP4C4E74' &&
          Array.isArray(fontInfo.differences) &&
          fontInfo.differences.length === 0 &&
          glyph.originalCharCode === 254
            ? ['þ', '+', 770]
            : treatmentComparison && [3, 4, 254].includes(glyph.originalCharCode)
              ? new Map([
                  [3, ['\u0015', '≥', 770]],
                  [4, ['\u0014', '≤', 770]],
                  [254, ['þ', '+', 770]]
                ]).get(glyph.originalCharCode)
              : alternateComparison
                ? (new Map([
                    [2, ['\u0015', '≥', 770]],
                    [4, ['\u0014', '≤', 770]],
                    [254, ['þ', '+', 770]]
                  ]).get(glyph.originalCharCode) ??
                  publisherSymbols.get(name)?.get(glyph.originalCharCode))
                : alternateGalliard
                  ? galliardComparisonSubset.get(glyph.originalCharCode)
                  : name === 'AdvP4C4E74' &&
                      fontInfo.differences?.[1] === 'C0' &&
                      fontInfo.differences?.[3] === 'C6' &&
                      fontInfo.differences?.[121] === 'y' &&
                      fontInfo.differences?.[122] === 'z' &&
                      footnoteSubset.has(glyph.originalCharCode)
                    ? footnoteSubset.get(glyph.originalCharCode)
                    : // The range/comparison subset reuses slots that mean ± in other subsets.
                      isComparisonSubset && comparisonSubset.has(glyph.originalCharCode)
                      ? comparisonSubset.get(glyph.originalCharCode)
                      : name === 'Universal-GreekwithMathPi' &&
                          fontInfo.differences?.[3] === 'H11001' &&
                          glyph.originalCharCode === 3
                        ? ['\u0003', '+', 833]
                        : name === 'Universal-GreekwithMathPi' &&
                            fontInfo.differences?.[1] === 'H11005' &&
                            fontInfo.differences?.[2] === 'H11021' &&
                            glyph.originalCharCode === 2
                          ? ['\u0002', '<', 833]
                          : name === 'AdvP4C4E74' &&
                              fontInfo.differences?.[1] === 'C21' &&
                              glyph.originalCharCode === 1
                            ? ['\u0015', '≥', 770]
                            : name === 'AdvP4C4E74' &&
                                (fontInfo.differences?.[1] === 'C21' ||
                                  (fontInfo.differences?.[2] === 'C21' &&
                                    fontInfo.differences?.[3] === 'C14' &&
                                    fontInfo.differences?.[188] === 'onequarter') ||
                                  (fontInfo.differences?.[2] === 'C0' &&
                                    fontInfo.differences?.[188] === 'onequarter')) &&
                                fontInfo.differences?.[254] === 'thorn' &&
                                glyph.originalCharCode === 254
                              ? ['þ', '+', 770]
                              : publisherSymbols.get(name)?.get(glyph.originalCharCode)
        // Subset slots vary; the embedded glyph name is authoritative when present.
        const namedUniversal =
          name === 'Universal-GreekwithMathPi' && glyph.width === 833
            ? universalGlyphs.get(fontInfo.differences?.[glyph.originalCharCode])
            : undefined
        const namedAdv =
          name === 'AdvP4C4E74' && glyph.width === 770 && !isComparisonSubset
            ? new Map([
                ['C0', '−'],
                ['C6', '±'],
                ['C2', '×'],
                [
                  'thorn',
                  glyph.unicode === 'þ' &&
                  glyph.originalCharCode === 254 &&
                  ['C21', 'C3'].includes(fontInfo.differences?.[2]) &&
                  fontInfo.differences?.[3] === undefined &&
                  fontInfo.differences?.[188] === 'onequarter'
                    ? '+'
                    : undefined
                ],
                ['C20', glyph.unicode === '\u0014' ? '≤' : undefined],
                ['C21', glyph.unicode === '\u0015' ? '≥' : undefined]
              ]).get(fontInfo.differences?.[glyph.originalCharCode])
            : undefined
        const namedStar =
          name === 'AdvP4C4E74' &&
          glyph.width === 500 &&
          fontInfo.differences?.[glyph.originalCharCode] === 'C3' &&
          glyph.originalCharCode < 32 &&
          glyph.unicode === String.fromCharCode(glyph.originalCharCode)
            ? '*'
            : undefined
        const tex = texSymbols.get(glyph.originalCharCode)
        const pi =
          (name === 'MathematicalPi-One' &&
          glyph.unicode === String.fromCharCode(glyph.originalCharCode)
            ? new Map([
                ['H11021', [glyph.unicode, '<', 833]],
                ['H11022', [glyph.unicode, '>', 833]],
                ['H11350', [glyph.unicode, '≥', 833]]
              ]).get(fontInfo.differences?.[glyph.originalCharCode])
            : undefined) ??
          latinPi?.get(glyph.originalCharCode) ??
          (name === 'MathematicalPi-Four' &&
          glyph.originalCharCode === 2 &&
          fontInfo.differences?.[2] === 'H11549'
            ? ['\u0002', '=', 833]
            : undefined)
        const correction = namedStar
          ? [glyph.unicode, namedStar]
          : pi && pi[2] === glyph.width
            ? pi
            : namedAdv
              ? [glyph.unicode, namedAdv]
              : namedUniversal
                ? [glyph.unicode, namedUniversal]
                : publisher &&
                    publisher[2] === glyph.width &&
                    (!publisher[3] ||
                      fontInfo.differences?.[glyph.originalCharCode] === publisher[3])
                  ? publisher
                  : name === 'AdvPS44A44B'
                    ? glyph.originalCharCode === 101 && glyph.width === 750
                      ? ['e', '–']
                      : [67, 68].includes(glyph.originalCharCode) && glyph.width === 1000
                        ? [String.fromCharCode(glyph.originalCharCode), '+']
                        : undefined
                    : name === 'TeX_CM_Maths_Symbols'
                      ? tex?.[2] === undefined || tex[2] === glyph.width
                        ? tex
                        : undefined
                      : undefined
        const value = correction?.[0] === glyph.unicode ? correction[1] : glyph.unicode
        // Several original glyphs can share the same broken Unicode value. In
        // that case there is no safe text-item substitution: leave it for review.
        if (map.has(glyph.unicode) && map.get(glyph.unicode) !== value) map.set(glyph.unicode, null)
        else if (!map.has(glyph.unicode)) map.set(glyph.unicode, value)
        // PDF.js normalizes the ohm sign to Greek omega in text content, while
        // the operator glyph retains U+2126. Only alias this verified slot.
        if (name === 'WTimesGreekSF-One' && glyph.originalCharCode === 189 && value === '=')
          map.set('Ω', value)
      }
    }
  }
  return removeBackgroundNumericPadding(
    removeClippedFormText(
      {
        ...content,
        items: content.items.map((item) => {
          const map = mappings.get(item.fontName)
          if (!('str' in item) || !map) return item
          const str = [...item.str].map((char) => map.get(char) ?? char).join('')
          return str === item.str ? item : { ...item, str, inlineSymbol: [...str].length === 1 }
        })
      },
      operators,
      originalContent
    ),
    operators
  )
}

// Cropped Form XObjects can contain off-crop text from an entire source page.
// Require exact glyph-stream alignment; keep partially visible or unknown text.
export function removeClippedFormText(content, operators, originalContent = content) {
  if (
    !operators?.fnArray.some((op) => [OPS.paintFormXObjectBegin, OPS.clip, OPS.eoClip].includes(op))
  )
    return content
  const streams = new Map(),
    stack = []
  let font,
    matrix = [1, 0, 0, 1, 0, 0],
    clip
  let pendingClip = false
  const applyClip = (box) => {
    if (!box || box.length !== 4 || !Array.from(box).every(Number.isFinite)) return
    const points = [
      [box[0], box[1]],
      [box[2], box[1]],
      [box[0], box[3]],
      [box[2], box[3]]
    ]
    for (const p of points) Util.applyTransform(p, matrix)
    const next = [
      Math.min(...points.map((p) => p[0])),
      Math.min(...points.map((p) => p[1])),
      Math.max(...points.map((p) => p[0])),
      Math.max(...points.map((p) => p[1]))
    ]
    clip = clip
      ? [
          Math.max(clip[0], next[0]),
          Math.max(clip[1], next[1]),
          Math.min(clip[2], next[2]),
          Math.min(clip[3], next[3])
        ]
      : next
  }
  for (let i = 0; i < operators.fnArray.length; i++) {
    const op = operators.fnArray[i],
      args = operators.argsArray[i]
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) stack.push({ font, matrix, clip })
    if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      const state = stack.pop()
      if (state) ({ font, matrix, clip } = state)
    } else if (op === OPS.transform) matrix = Util.transform(matrix, args)
    else if (op === OPS.paintFormXObjectBegin) {
      if (args[0]) matrix = Util.transform(matrix, Array.from(args[0]))
      applyClip(args[1])
    } else if (op === OPS.clip || op === OPS.eoClip) pendingClip = true
    else if (op === OPS.constructPath && pendingClip) {
      // PDF.js defers clipping until this combined path-ending operation.
      // Its bounding box is conservative even for a nonrectangular path.
      applyClip(args[2])
      pendingClip = false
    } else if (op === OPS.setFont) font = args[0]
    else if (op === OPS.showText && font) {
      if (!streams.has(font)) streams.set(font, [])
      streams.get(font).push(
        ...args[0]
          .filter((g) => g && typeof g === 'object')
          .flatMap((g) =>
            // Match PDF.js Latin ligature normalization, including its
            // long-s exception; never normalize the visible item itself.
            [...g.unicode.replace(/[ﬀ-ﬆ]/gu, (c) => (c === 'ﬅ' ? 'ſt' : c.normalize('NFKC')))]
              .filter((c) => !/\s/u.test(c))
              .map((char) => ({ char, clip }))
          )
      )
    }
  }
  const original = new Map()
  for (const item of originalContent.items)
    if ('str' in item)
      original.set(
        item.fontName,
        (original.get(item.fontName) ?? '') + item.str.replace(/\s/gu, '')
      )
  for (const [font, chars] of streams) {
    const text = chars.map((c) => c.char).join('')
    const source = original.get(font)
    // PDF.js can omit an off-page suffix. A single clip for the entire font
    // stream makes its item-to-clip assignment unambiguous even in that case.
    const uniformClip = chars[0]?.clip
    if (
      text !== source &&
      !(
        source &&
        text.startsWith(source) &&
        uniformClip &&
        chars.every((c) => c.clip === uniformClip)
      )
    )
      streams.delete(font)
  }
  const positions = new Map()
  return {
    ...content,
    items: content.items.filter((item, index) => {
      const source = originalContent.items[index],
        chars = streams.get(item.fontName)
      if (!('str' in item) || !chars) return true
      const start = positions.get(item.fontName) ?? 0,
        length = source.str.replace(/\s/gu, '').length
      positions.set(item.fontName, start + length)
      if (!length || !item.transform) return true
      const [a, b, c, d, x, y] = item.transform,
        horizontal = Math.hypot(a, b),
        vertical = Math.hypot(c, d)
      if (!horizontal || !vertical) return true
      // Use the same oriented advance box as page geometry. Form text can
      // be rotated independently of the page, including outside its crop.
      const points = [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1]
      ].map(([u, v]) => [
        x + (u * item.width * a) / horizontal + (v * item.height * c) / vertical,
        y + (u * item.width * b) / horizontal + (v * item.height * d) / vertical
      ])
      const bounds = [
        Math.min(...points.map((p) => p[0])),
        Math.min(...points.map((p) => p[1])),
        Math.max(...points.map((p) => p[0])),
        Math.max(...points.map((p) => p[1]))
      ]
      return !chars
        .slice(start, start + length)
        .every(
          ({ clip: c }) =>
            c &&
            (bounds[2] < c[0] - 0.5 ||
              bounds[0] > c[2] + 0.5 ||
              bounds[3] < c[1] - 0.5 ||
              bounds[1] > c[3] + 0.5)
        )
    })
  }
}

// Some publishers advance the cursor with an invisible digit before painting a
// number. PDF.js combines both into one text item (e.g. hidden 0 + visible 0).
// Only discard padding immediately followed by visible digits in the same text
// object. Keep invisible OCR layers and require exact per-font stream alignment.
export function removeInvisibleNumericPadding(content, operators, originalContent = content) {
  const streams = new Map()
  const stack = []
  let font,
    mode = 0,
    pending
  for (let index = 0; index < operators.fnArray.length; index++) {
    const op = operators.fnArray[index],
      args = operators.argsArray[index]
    if (op === OPS.save) stack.push({ font, mode })
    else if (op === OPS.restore) ({ font, mode } = stack.pop() ?? { mode: 0 })
    else if (op === OPS.setFont) font = args[0]
    else if (op === OPS.setTextRenderingMode) mode = args[0]
    else if (op === OPS.showText && font) {
      const text = args[0]
        .filter((glyph) => glyph && typeof glyph === 'object')
        .map((glyph) => glyph.unicode)
        .join('')
      let stream = streams.get(font)
      if (!stream) streams.set(font, (stream = []))
      if (pending?.font === font && mode === 0 && /^\d/.test(text.trim())) {
        for (const char of pending.chars) char.padding = true
      }
      const chars = [...text].filter((char) => !/\s/u.test(char)).map((char) => ({ char }))
      stream.push(...chars)
      pending = mode === 3 && /^\d+$/.test(text.trim()) ? { font, chars } : undefined
      continue
    }
    if (op !== OPS.setTextRenderingMode && op !== OPS.setGState) pending = undefined
  }
  const itemStreams = new Map()
  for (const item of originalContent.items) {
    if (!('str' in item)) continue
    itemStreams.set(
      item.fontName,
      (itemStreams.get(item.fontName) ?? '') + item.str.replace(/\s/gu, '')
    )
  }
  for (const [font, stream] of streams) {
    if (
      !stream.some((char) => char.padding) ||
      stream.map(({ char }) => char).join('') !== itemStreams.get(font)
    )
      streams.delete(font)
  }
  if (!streams.size) return content
  const offsets = new Map()
  return {
    ...content,
    items: content.items.map((item) => {
      const stream = streams.get(item.fontName)
      if (!('str' in item) || !stream) return item
      let offset = offsets.get(item.fontName) ?? 0
      const str = [...item.str]
        .filter((char) => /\s/u.test(char) || !stream[offset++].padding)
        .join('')
      offsets.set(item.fontName, offset)
      return str === item.str ? item : { ...item, str }
    })
  }
}

// Some subset fonts give uppercase glyphs lowercase ToUnicode values. Recover
// only an otherwise consistent shifted ASCII encoding, with both cases well
// represented and distinct lowercase glyphs. Never capitalize by word context.
export function repairShiftedLatinCase(content, operators) {
  const streams = new Map(),
    stack = []
  let font
  for (let i = 0; i < operators.fnArray.length; i++) {
    const op = operators.fnArray[i],
      args = operators.argsArray[i]
    if (op === OPS.save) stack.push(font)
    else if (op === OPS.restore) font = stack.pop()
    else if (op === OPS.setFont) font = args[0]
    else if (op === OPS.showText && font) {
      if (!streams.has(font)) streams.set(font, [])
      streams.get(font).push(...args[0].filter((g) => g && typeof g === 'object'))
    }
  }
  const replacements = new Map()
  for (const [font, stream] of streams) {
    const glyphs = [
      ...new Map(
        stream.filter((g) => /^[A-Za-z]$/.test(g.unicode)).map((g) => [g.originalCharCode, g])
      ).values()
    ]
    const offsets = new Map()
    for (const g of glyphs) {
      const offset = g.originalCharCode - g.unicode.charCodeAt(0)
      offsets.set(offset, (offsets.get(offset) ?? 0) + 1)
    }
    const [offset, count] = [...offsets].sort((a, b) => b[1] - a[1])[0] ?? []
    if (!offset || glyphs.length < 35 || count < glyphs.length * 0.85) continue
    const matched = glyphs.filter((g) => g.originalCharCode - g.unicode.charCodeAt(0) === offset)
    if (
      matched.filter((g) => /^[A-Z]$/.test(g.unicode)).length < 8 ||
      matched.filter((g) => /^[a-z]$/.test(g.unicode)).length < 15
    )
      continue
    const changed = new Map()
    for (const g of glyphs.filter((g) => !matched.includes(g))) {
      const expected = String.fromCharCode(g.originalCharCode - offset)
      const lower = matched.find((other) => other.unicode === g.unicode)
      if (
        !/^[A-Z]$/.test(expected) ||
        expected.toLowerCase() !== g.unicode ||
        !lower ||
        lower.fontChar === g.fontChar ||
        lower.width === g.width
      ) {
        changed.clear()
        break
      }
      changed.set(g.originalCharCode, expected)
    }
    if (changed.size < 2) continue
    const chars = stream.flatMap((g) =>
      [...g.unicode]
        .filter((c) => !/\s/u.test(c))
        .map((char) => ({ char, corrected: changed.get(g.originalCharCode) ?? char }))
    )
    const source = content.items
      .filter((i) => i.fontName === font && 'str' in i)
      .map((i) => i.str.replace(/\s/gu, ''))
      .join('')
    if (source === chars.map((c) => c.char).join('')) replacements.set(font, chars)
  }
  const positions = new Map()
  return replacements.size
    ? {
        ...content,
        items: content.items.map((item) => {
          const chars = replacements.get(item.fontName)
          if (!chars || !('str' in item)) return item
          let position = positions.get(item.fontName) ?? 0
          const str = [...item.str]
            .map((char) => (/\s/u.test(char) ? char : chars[position++].corrected))
            .join('')
          positions.set(item.fontName, position)
          return str === item.str ? item : { ...item, str }
        })
      }
    : content
}

// Some tables paint an alignment parenthesis in exactly the row background
// colour after a visible zero. Require a previously painted background, exact
// operator/item stream alignment, and adjacent zero on the same baseline.
export function removeBackgroundNumericPadding(content, operators) {
  if (!operators || !content.items.some((i) => ['(', '<', '0', '.0'].includes(i.str)))
    return content
  const streams = new Map(),
    backgrounds = new Set(['#ffffff']),
    stack = []
  let font,
    colour = '#000000'
  for (let n = 0; n < operators.fnArray.length; n++) {
    const op = operators.fnArray[n],
      args = operators.argsArray[n]
    if (op === OPS.save) stack.push({ font, colour })
    else if (op === OPS.restore) ({ font, colour } = stack.pop() ?? { colour: '#000000' })
    else if (op === OPS.setFont) font = args[0]
    else if (op === OPS.setFillRGBColor) colour = args[0]
    else if ([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke].includes(op))
      backgrounds.add(colour)
    else if (
      op === OPS.constructPath &&
      [OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke].includes(args[0])
    )
      backgrounds.add(colour)
    else if (op === OPS.showText && font) {
      if (!streams.has(font)) streams.set(font, [])
      for (const g of args[0])
        if (g && typeof g === 'object')
          for (const char of g.unicode.replace(/\s/gu, ''))
            streams.get(font).push({
              char,
              hidden:
                backgrounds.has(colour) &&
                /^#[0-9a-f]{6}$/i.test(colour) &&
                [1, 3, 5].every((offset) => parseInt(colour.slice(offset, offset + 2), 16) >= 210)
            })
    }
  }
  for (const [font, chars] of streams)
    if (
      chars.map((c) => c.char).join('') !==
      content.items
        .filter((i) => i.fontName === font && 'str' in i)
        .map((i) => i.str.replace(/\s/gu, ''))
        .join('')
    )
      streams.delete(font)
  const offsets = new Map()
  return {
    ...content,
    items: content.items.filter((item, index) => {
      const chars = streams.get(item.fontName)
      if (!chars || !('str' in item)) return true
      const start = offsets.get(item.fontName) ?? 0
      offsets.set(item.fontName, start + item.str.replace(/\s/gu, '').length)
      const before = content.items.slice(0, index).findLast((i) => i.str?.trim())
      const after = content.items.slice(index + 1).find((i) => i.str?.trim())
      // Publishers also pad decimal p-values with a background-coloured less-than
      // sign or trailing zero. Preserve visible comparisons and numeric OCR layers.
      const neighbour = item.str === '<' ? after : before
      if (
        ['<', '0', '.0'].includes(item.str) &&
        chars.slice(start, start + item.str.length).every((c) => c.hidden) &&
        (item.str === '.0' ? /^\d+$/ : /^\d+\.\d+$/).test(neighbour?.str?.trim() ?? '') &&
        item.transform &&
        neighbour?.transform
      ) {
        const [a, b] = item.transform,
          scale = Math.hypot(a, b)
        const dx = neighbour.transform[4] - item.transform[4],
          dy = neighbour.transform[5] - item.transform[5]
        const along = (dx * a + dy * b) / scale
        const gap = item.str === '<' ? along - item.width : -along - neighbour.width
        const neighbourOffset =
          item.str === '<' ? start + 1 : start - neighbour.str.replace(/\s/gu, '').length
        if (
          scale &&
          !chars[neighbourOffset]?.hidden &&
          neighbour.transform[0] === a &&
          neighbour.transform[1] === b &&
          Math.abs((dy * a - dx * b) / scale) < 0.01 &&
          item.height === neighbour.height &&
          gap >= -0.01 &&
          gap < item.height * 0.5
        )
          return false
      }
      if (item.str !== '(' || !item.transform || !before?.transform) return true
      // PDF text can run vertically on landscape pages. Measure adjacency in
      // the text baseline direction rather than assuming page-space x/y axes.
      const [a, b] = before.transform
      const scale = Math.hypot(a, b)
      const dx = item.transform[4] - before.transform[4]
      const dy = item.transform[5] - before.transform[5]
      const gap = (dx * a + dy * b) / scale - before.width
      return !(
        chars[start]?.hidden &&
        !chars[start - 1]?.hidden &&
        before?.str.trim() === '0' &&
        item.transform[0] === a &&
        item.transform[1] === b &&
        Math.abs((dy * a - dx * b) / scale) < 0.01 &&
        item.height === before.height &&
        gap >= -0.01 &&
        gap < item.height * 0.5
      )
    })
  }
}

// PDF.js text extraction adds Tc to an empty TJ string before a leading
// numeric adjustment; Canvas rendering applies only that numeric adjustment.
// Match the complete native glyph stream before removing the extra advance.
// A text-line/matrix reset also resets the accumulated extraction offset.
export function repairSpacedTextOffsets(content, operators) {
  if (!operators?.fnArray.includes(OPS.setCharSpacing)) return content
  const streams = new Map(),
    stack = []
  let font,
    size = 0,
    charSpace = 0,
    error = 0
  for (let n = 0; n < operators.fnArray.length; n++) {
    const op = operators.fnArray[n],
      args = operators.argsArray[n]
    if (op === OPS.save) stack.push({ font, size, charSpace, error })
    else if (op === OPS.restore)
      ({ font, size, charSpace, error } = stack.pop() ?? { size: 0, charSpace: 0, error: 0 })
    else if (op === OPS.setFont) [font, size] = args
    else if (op === OPS.setCharSpacing) charSpace = args[0]
    else if (
      [
        OPS.beginText,
        OPS.setTextMatrix,
        OPS.moveText,
        OPS.setLeadingMoveText,
        OPS.nextLine
      ].includes(op)
    )
      error = 0
    else if (op === OPS.showText && font) {
      if (!streams.has(font)) streams.set(font, [])
      let empty = true
      for (const g of args[0]) {
        if (typeof g === 'number') {
          if (g !== 0 && empty) error += charSpace
          empty = true
          continue
        }
        if (!g || typeof g.unicode !== 'string') continue
        empty = false
        for (const char of g.unicode
          .replace(/[ﬀ-ﬆ]/gu, (c) => (c === 'ﬅ' ? 'ſt' : c.normalize('NFKC')))
          .replace(/\s/gu, ''))
          streams.get(font).push({ char, error, size })
      }
    }
  }
  const text = new Map()
  for (const i of content.items)
    if ('str' in i) text.set(i.fontName, (text.get(i.fontName) ?? '') + i.str.replace(/\s/gu, ''))
  for (const [font, g] of streams)
    if (g.map((i) => i.char).join('') !== text.get(font)) streams.delete(font)
  const positions = new Map()
  return {
    ...content,
    items: content.items.map((i) => {
      const g = streams.get(i.fontName)
      if (!g || !('str' in i)) return i
      const at = positions.get(i.fontName) ?? 0,
        length = [...i.str.replace(/\s/gu, '')].length
      positions.set(i.fontName, at + length)
      const part = g.slice(at, at + length),
        first = part[0]
      if (
        !first?.error ||
        !(first.size > 0) ||
        !i.transform ||
        i.dir !== 'ltr' ||
        part.some((x) => x.error !== first.error || x.size !== first.size)
      )
        return i
      return {
        ...i,
        transform: [
          ...i.transform.slice(0, 4),
          i.transform[4] - (first.error * i.transform[0]) / first.size,
          i.transform[5] - (first.error * i.transform[1]) / first.size
        ]
      }
    })
  }
}
