import { expect, it } from 'vitest'
import {
  groupPdfTranslationPages,
  type PdfLayoutPage,
  type PdfLayoutTextItem
} from '../../src/reader/layout.js'

const part = (
  str: string,
  x: number,
  y: number,
  width: number,
  fontName = 'Body',
  size = 10,
  hasEOL = true
): PdfLayoutTextItem => ({
  str,
  width,
  height: size,
  dir: 'ltr',
  transform: [size, 0, 0, size, x, y],
  fontName,
  fontAscent: 0.8,
  fontDescent: -0.2,
  fontVertical: false,
  hasEOL
})
const page = (items: PdfLayoutTextItem[]): PdfLayoutPage => ({
  page: 1,
  width: 600,
  height: 800,
  rotation: 0,
  items
})
const source = (input: PdfLayoutPage): ReturnType<typeof groupPdfTranslationPages> => {
  const result = groupPdfTranslationPages({ pages: [input] })
  const actual = result.units.flatMap((u) => u.items.map((key, at) => [key, u.originalStrings[at]]))
  expect(actual.toSorted()).toEqual(
    input.items.flatMap((item, at) => (item.str.trim() ? [[`1:${at}`, item.str]] : [])).toSorted()
  )
  expect(new Set(actual.map(([key]) => key)).size).toBe(actual.length)
  return result
}
const owner = (
  result: ReturnType<typeof source>,
  index: number
): ReturnType<typeof source>['units'][number] =>
  result.units.find((u) => u.items.includes(`1:${index}`))!

function acronym(): PdfLayoutPage {
  return page([
    part('We describe the signal representation using the regional', 50, 700, 250),
    part('Trait (Q', 50, 688, 37, 'Body', 10, false),
    part('3', 87, 692, 4, 'Script', 6.7, false),
    part('R) across several bands. We also retain the original', 91.5, 688, 208.5),
    part('native identifiers while improving the measured response.', 50, 676, 250)
  ])
}

it('keeps a complete native acronym row with its numeric superscript in prose', () => {
  const result = source(acronym()),
    lead = owner(result, 1)
  expect(lead.sourceOnly).toBeUndefined()
  expect(lead.items).toContain('1:2')
  expect(lead.items).toContain('1:3')
  expect(lead.source).toContain('Trait (Q3R)')
})

it.each([false, true])(
  'bounds rotated foreign ink in its own axes, overlapping=%s',
  (overlapping) => {
    const input = acronym(),
      margin = part('vertical margin', overlapping ? 60 : 20, 640, 100)
    margin.transform = [0, 10, -10, 0, overlapping ? 60 : 20, 640]
    input.items.push(margin)
    const result = source(input)
    if (overlapping) expect(owner(result, 1)).not.toBe(owner(result, 3))
    else expect(owner(result, 1)).toBe(owner(result, 3))
  }
)

it.each(['missing context', 'foreign script', 'foreign glyph', 'wrong column', 'open parenthesis'])(
  'requires closed native acronym context: %s',
  (fault) => {
    const input = acronym()
    if (fault === 'missing context') input.items[0].str = 'Independent heading.'
    if (fault === 'foreign script') input.items[2].transform[5] += 10
    if (fault === 'foreign glyph') input.items.push(part('z', 120, 688, 5, 'Math'))
    if (fault === 'wrong column') input.items[0].transform[4] += 300
    if (fault === 'open parenthesis') input.items[3].str = input.items[3].str.replace('R)', 'R')
    const result = source(input)
    expect(owner(result, 1)).not.toBe(owner(result, 3))
  }
)

it.each(['(AD)', '(XY)'])(
  'requires matching initials to join an acronym enclosed in one native run: %s',
  (label) => {
    const result = source(
      page([
        part('Although conversion in the scaled range', 50, 700, 146, 'Body', 10, false),
        part('(0.1', 200, 700, 16, 'Body', 10, false),
        part('–', 216, 700, 4.7, 'Symbol', 10, false),
        part('10 kPa)', 221, 700, 35, 'Body', 10, false),
        part('near', 260, 700, 8, 'Body', 10, false),
        part('ambient', 273, 700, 22),
        part('density', 50, 688, 51, 'Body', 10, false),
        part(label, 103, 688, 18, 'Body', 10, false),
        part('is stable', 123, 688, 42, 'Body', 10, false),
        part('using reference probes', 167, 688, 89, 'Body', 10, false),
        part('(controls)', 258, 688, 37),
        part('or several sensors available under controlled conditions.', 50, 676, 245)
      ])
    )
    const expansion = owner(result, 6)
    if (label === '(AD)') {
      expect(expansion).toBe(owner(result, 0))
      expect(expansion).toBe(owner(result, 8))
      expect(expansion.source).toContain('ambient density (AD) is stable')
      expect(expansion.sourceOnly).toBeUndefined()
    } else {
      expect(expansion.source).toBe('density (XY)')
      expect(expansion.preserve).toBe('formula')
    }
  }
)

it('retains a complete inline numbered citation row in its continuing paragraph', () => {
  const input = page([
    part('We evaluated the proposed method using three public datasets,', 50, 700, 250),
    part('including (1) SystemOne [7], (2) SystemTwo [8], and', 50, 688, 250),
    part('(3) SystemThree [9]. We present the resulting comparisons', 50, 676, 250),
    part('under the same conditions for every method.', 50, 664, 210)
  ])
  const result = source(input)
  expect(owner(result, 1).sourceOnly).toBeUndefined()
  expect(owner(result, 1)).toBe(owner(result, 0))
  expect(owner(result, 1)).toBe(owner(result, 2))
})

it('keeps a natively split ordinary field name whole inside continuing prose', () => {
  const input = page([
    part(
      'We include the static information to improve the final response. Additional',
      50,
      700,
      280
    ),
    part('attributes', 50, 688, 40, 'Body', 10, false),
    part('(A', 93, 688, 9, 'Body', 10, false),
    part('ccount ID', 102, 688, 40, 'Body', 10, false),
    part(')', 142, 688, 4, 'Body', 10, false),
    part('are incorporated using a shared representation', 149, 688, 181),
    part('for every available sequence in the comparison.', 50, 676, 240)
  ])
  const result = source(input),
    field = owner(result, 1)
  expect(field.sourceOnly).toBeUndefined()
  expect(field).toBe(owner(result, 3))
  expect(field.source).toContain('attributes (Account ID)')
})

function caption(): PdfLayoutPage {
  return page([
    part('Fig. 2. We compare several transformations and Codec', 50, 700, 250),
    part('Encoding (', 50, 688, 45, 'Body', 10, false),
    part('rate', 95, 688, 20, 'Parameter', 10, false),
    part('= 80, 40, 20', 117, 688, 57, 'Math', 10, false),
    part(') (from left to right).', 174, 688, 90)
  ])
}

it('keeps the descriptive caption head before a closed native numeric parameter', () => {
  const result = source(caption())
  expect(owner(result, 1).sourceOnly).toBeUndefined()
  expect(owner(result, 1)).toBe(owner(result, 2))
  expect(owner(result, 1)).toBe(owner(result, 4))
  expect(owner(result, 1).source).toContain('Encoding (rate = 80, 40, 20)')
})

it.each(['Softmax (x)', 'UnknownOperator (x)', 'a = b + c', 'A = F(x)'])(
  'does not grant prose ownership to a standalone mathematical expression: %s',
  (text) => {
    const result = source(page([part(text, 50, 700, 160)]))
    expect(owner(result, 0).sourceOnly).toBe(true)
  }
)

it('does not admit the numeric parameter without an established caption', () => {
  const input = caption()
  input.items[0].str = 'An independent completed sentence.'
  const result = source(input)
  expect(owner(result, 1)).not.toBe(owner(result, 2))
})

it.each([true, false])(
  'requires a closed numbered field before detaching an indented body paragraph (closed=%s)',
  (closed) => {
    const result = source(
      page([
        part('5.', 54, 688.19, 6.86, 'Bold', 8.97, false),
        part('Material Choice', 66.66, 688.19, 67.03, 'Bold', 8.97, false),
        part(': We select contrasting colors and', 133.69, 688.19, 160.35, 'Body', 8.97),
        part(
          'other surface treatments to represent differences in the measured',
          54,
          678.22,
          241.16,
          'Body',
          8.97
        ),
        part(
          'data. Each of these materials can be combined with other components',
          54,
          668.26,
          240.05,
          'Body',
          8.97
        ),
        part(
          'to make physical representations easier to understand throughout',
          54,
          658.3,
          240.05,
          'Body',
          8.97
        ),
        part(
          closed ? 'the course of the study.' : 'the course of the study',
          54,
          648.34,
          95.87,
          'Body',
          8.97
        ),
        part(
          'The next prototype was built with components from several',
          63.96,
          637.99,
          231.2,
          'Body',
          8.97
        ),
        part(
          'local manufacturers to evaluate the behavior of the materials',
          54,
          628.03,
          240.04,
          'Body',
          8.97
        ),
        part(
          'when handled by groups of students during a design workshop.',
          54,
          618.07,
          241.53,
          'Body',
          8.97
        )
      ])
    )
    const field = owner(result, 0)
    expect(field.sourceOnly).toBeUndefined()
    if (closed) {
      expect(field.items).toEqual(['1:0', '1:1', '1:2', '1:3', '1:4', '1:5', '1:6'])
      expect(owner(result, 7).items).toEqual(['1:7', '1:8', '1:9'])
      expect(owner(result, 7).sourceOnly).toBeUndefined()
    } else {
      expect(field).toBe(owner(result, 7))
    }
  }
)

it.each([true, false])(
  'keeps native narrative citation years inside their wrapping prose (%s)',
  (aligned) => {
    const input = page([
      part(
        'We compared the new measurements against the observations summarized by',
        50,
        700,
        436.7,
        'Body',
        10,
        false
      ),
      part('Rowan et al.', 490, 700, 60),
      part('(', 50, 687.5, 4, 'Body', 10, false),
      part('2012', 54, 687.5, 20, 'Body', 10, false),
      part(').', 74, 687.5, 7, 'Body', 10, false),
      part(
        'The visible and infrared data were analyzed with the calibration described in',
        89.3,
        687.5,
        399.4,
        'Body',
        10,
        false
      ),
      part('Vale et al.', 492, 687.5, 58),
      part('(', aligned ? 50 : 67, 675, 4, 'Body', 10, false),
      part('2018', aligned ? 54 : 71, 675, 20, 'Body', 10, false),
      part(
        '). The resulting spectra were independently measured using the',
        aligned ? 74 : 91,
        675,
        aligned ? 360 : 343,
        'Body',
        10,
        false
      ),
      part('FieldKit', 438, 675, 40, 'Emphasis', 10, false),
      part(' software suite.', 481, 675, 69)
    ])
    const result = source(input)
    expect(owner(result, 0).source).toContain('Rowan et al. (2012).')
    if (aligned) expect(owner(result, 0).source).toContain('Vale et al. (2018).')
    else expect(owner(result, 0)).not.toBe(owner(result, 8))
  }
)

it.each([0, 18])('keeps a wrapped prose label and its acronym citation together (%s)', (shift) => {
  const input = page([
    part(
      'We compare observations from independent instruments across the same range, with',
      60,
      700,
      480
    ),
    part(
      'the first experiment providing the comparison baseline; the Vector field reconstruction',
      50,
      687.5,
      490
    ),
    part('process (', 50 + shift, 675, 39, 'Body', 10, false),
    part('VFR', 89 + shift, 675, 20, 'Emphasis', 10, false),
    part(
      '; Vale & Owens 2019) uses local observations from independent reference systems.',
      109 + shift,
      675,
      431 - shift
    ),
    part(
      'These methods account for the effects of measurement noise and varying exposure.',
      50,
      662.5,
      490
    )
  ])
  const result = source(input)
  const lead = owner(result, 2)
  if (shift === 0) {
    expect(lead).toBe(owner(result, 1))
    expect(lead.source).toContain(
      'Vector field reconstruction process (VFR; Vale & Owens 2019) uses'
    )
    expect(lead.sourceOnly).toBeUndefined()
  } else {
    expect(lead.source).toBe('process (')
    expect(lead.sourceOnly).toBe(true)
  }
})

it.each([0, 14])(
  'keeps the percentage base attached to its raised and lowered errors (%s)',
  (offset) => {
    const input = page([
      part('The initial observations provided a consistent set of measured samples.', 50, 712, 490),
      part(
        'The observers find the proportion of available records to be 8',
        50,
        700,
        260,
        'Body',
        10,
        false
      ),
      part('+5', 310, 704.3, 10, 'Script', 7, false),
      part('', 310, 697.4, 0, 'Minus', 7),
      part('−', 310 + offset, 697.4, 6.2, 'Minus', 7, false),
      part('2', 316.2 + offset, 697.4, 3.8, 'Script', 7, false),
      part('% for the first group, and 21', 320.5, 700, 100, 'Body', 10, false),
      part('±', 420.5, 700, 8, 'Symbol', 10, false),
      part('4% for the second group.', 428.5, 700, 111.5),
      part('Subsequent observations were evaluated by the same procedure.', 50, 688, 490)
    ])
    const result = source(input)
    const ownerOfBase = owner(result, 1)
    expect(ownerOfBase.source.includes('8+5−2%')).toBe(offset === 0)
    if (offset === 0) {
      expect(ownerOfBase.items).toEqual(expect.arrayContaining(['1:2', '1:4', '1:5', '1:6']))
    }
  }
)

it.each([0, 16])('keeps a Greek catalogue name with its narrative citation (%s)', (shift) => {
  const result = source(
    page([
      part(
        'The first observations provide a broad view of activity across all surveyed regions.',
        60,
        708,
        480
      ),
      part(
        'Additional examples have been reported in the recent survey by Vale et al. (2018)',
        50,
        696,
        490
      ),
      part('for', 50 + shift, 684, 12, 'Body', 10, false),
      part('ξ', 65 + shift, 684, 5.5, 'Greek', 10, false),
      part('Scl and by Reed et al. (2020) for ZX 5182.', 74 + shift, 684, 224),
      part(
        'The next experiment measured an unrelated set of samples from the same range.',
        60,
        672,
        480
      )
    ])
  )
  const label = owner(result, 2)
  expect(label.source.includes('for ξ Scl')).toBe(shift === 0)
  expect(label === owner(result, 1)).toBe(shift === 0)
  expect(label).not.toBe(owner(result, 5))
})

it('keeps a complete index range before prose in the same native run', () => {
  const result = source(
    page([
      part(
        'We checked every arrangement for a term with the given shape',
        71,
        702,
        431,
        'Body',
        12,
        false
      ),
      part('𝑋', 502, 702, 8, 'Math', 12, false),
      part('𝑖', 510, 699.5, 3, 'Math', 8.5, false),
      part('𝑌', 514, 702, 8, 'Math', 12, false),
      part('𝑗', 522, 699.5, 4, 'Math', 8.5, false),
      part('𝑍', 527, 702, 8, 'Math', 12, false),
      part('𝑘', 535, 699.5, 4, 'Math', 8.5, false),
      part(';', 539, 702, 3, 'Body', 12),
      part('i', 62, 686.75, 3, 'Italic', 12, false),
      part(',', 65, 686.75, 3, 'Body', 12, false),
      part('j', 71, 686.75, 3, 'Italic', 12, false),
      part(',', 74, 686.75, 3, 'Body', 12, false),
      part('k', 80, 686.75, 5, 'Italic', 12, false),
      part('= 1,…', 88, 686.75, 30, 'Body', 12, false),
      part(
        ',8. The result can be checked directly by comparing all of the terms.',
        118,
        686.75,
        424,
        'Body',
        12
      )
    ])
  )
  expect(owner(result, 8)).toBe(owner(result, 14))
  expect(owner(result, 8).source).toContain('i, j, k = 1,…,8. The result')
  expect(owner(result, 8).sourceOnly).toBeUndefined()
})

it('does not create a fraction from a raised order over a lowered index', () => {
  const result = source(
    page([
      part('The construction produces a graph of type', 62, 701, 257, 'Body', 12, false),
      part('𝐺', 324, 701, 8, 'Math', 12, false),
      part('21', 331.5, 697.5, 10, 'Math', 8.5, false),
      part('(', 333.25, 707.5, 3.5, 'Math', 8.5, false),
      part('4', 336.75, 707.5, 5, 'Math', 8.5, false),
      part(')', 341.75, 707.5, 3.5, 'Math', 8.5, false),
      part('with each selected vertex counted only once.', 348, 701, 230, 'Body', 12)
    ])
  )
  expect(owner(result, 1).source).toContain('𝐺21(4)')
})

it('keeps native checklist marks separate from wrapped option translations', () => {
  const input = page([
    part('Maintenance options (Check all that apply):', 50, 725, 210, 'Heading'),
    part('⊠', 50, 700, 7.8, 'Marks', 10, false),
    part('(Option A) Inspect the assembled parts for signs of', 60, 700, 293),
    part('damage before transporting the case', 50, 687.5, 182),
    part('□', 50, 675, 7.8, 'Marks', 10, false),
    part('(Option B) Confirm that each record is available to', 60, 675, 291),
    part('the operator during the procedure', 50, 662.5, 179),
    part('□', 50, 650, 7.8, 'Marks', 10, false),
    part('(Option C) Check the requested dimensions against', 60, 650, 292),
    part('the list of approved parts.', 50, 637.5, 147),
    part('A separate inspection follows these checks.', 50, 612.5, 220)
  ])
  const result = source(input)
  for (const marker of [1, 4, 7]) {
    expect(owner(result, marker).sourceOnly).toBe(true)
    expect(owner(result, marker).items).toEqual([`1:${marker}`])
    const option = owner(result, marker + 1)
    expect(option.sourceOnly).toBeUndefined()
    expect(option.items).toEqual([`1:${marker + 1}`, `1:${marker + 2}`])
    expect(option.source).toBe(input.items[marker + 1].str + ' ' + input.items[marker + 2].str)
  }
  expect(owner(result, 10).source).toBe(input.items[10].str)
})

it.each([true, false])(
  'keeps both native closing parentheses in a continuing prose row, closed=%s',
  (closed) => {
    const description = (closed ? '))' : ')') + ' describes the final regional total.'
    const result = source(
      page([
        part(
          'The calculation uses a prior adjustment to establish the regional model',
          50,
          685,
          328
        ),
        part('Φ(', 50, 673, 10, 'Body', 10, false),
        part('M', 60, 673, 9, 'Math', 10, false),
        part('i', 69, 671.5, 4, 'Subscript', 7, false),
        part('(', 73.4, 673, 3.8, 'Body', 10, false),
        part('T', 77.2, 673, 7, 'Variable', 10, false),
        part(description, 84.2, 673, 159, 'Body')
      ])
    )
    if (closed) {
      expect(owner(result, 1)).toEqual(owner(result, 6))
      expect(owner(result, 6).source).toContain('Φ(Mi(T)) describes')
      expect(owner(result, 6).sourceOnly).toBeUndefined()
    } else {
      expect(owner(result, 1)).not.toEqual(owner(result, 6))
    }
  }
)

it.each([true, false])('preserves a diagonal operator with its stacked operand (%s)', (paired) => {
  const rows = source(
    page([
      part('We compare the two resulting matrices.', 50, 700, 221),
      part('Q :=', 120, 670, 21, 'Body', 10, false),
      part('a + b', 144, 677, 22, 'Math', 10, false),
      part('a − b', 144, 663, 22, 'Math', 10, false),
      part('=', 169, 670, 8, 'Body', 10, false),
      part('V', 181, 670, 7, 'Math', 10, false),
      part('diag', 191, 670, 19, 'Body', 10, false),
      part('\u0012', 210.2, 684, 7, 'Delimiter', 10, false),
      part('x + y', 224, 677, 21, 'Math', 10, false),
      part('x − y', 224, 663, 21, 'Math', 10, false),
      part(',', 249, 670, 3, 'Body', 10, false),
      part('u + v', 256, 677, 22, 'Math', 10, false),
      part('u − v', 256, 663, 22, 'Math', 10, false),
      part(paired ? '\u0013' : '\u0015', 283, 684, 7, 'Delimiter', 10, false),
      part('V', 292, 670, 7, 'Math', 10, false),
      part('T', 300, 673.5, 5, 'Script', 7, false),
      part('≥ 0.', 307, 670, 19)
    ])
  )
  expect(owner(rows, 6).source).toBe('diag')
  expect(owner(rows, 6).preserve).toBe(paired ? 'formula' : undefined)
})

it.each([true, false])('keeps paired delimiters on a repeated inline formula (%s)', (repeated) => {
  const result = source(
    page([
      part('We first compare the restricted operations and use', 50, 700, 235, 'Body', 10, false),
      part('N', 289, 700, 8, 'Math', 10, false),
      part('[', 297, 700, 3, 'Body', 10, false),
      part('P', 300, 700, 7, 'Math', 10, false),
      part('(', 308, 700, 4, 'Body', 10, false),
      part(repeated ? 'k' : 'l', 312, 700, 5, 'Math', 10, false),
      part(')]', 317, 700, 7, 'Body', 10, false),
      part('\u0001', 324, 708, 5, 'Delimiter', 10, false),
      part(', where', 329, 700, 34, 'Body', 10, false),
      part('', 50, 687.6, 0, 'Math', 0, true),
      part('N', 50, 687.6, 8, 'Math', 10, false),
      part('[', 58, 687.6, 3, 'Body', 10, false),
      part('P', 61, 687.6, 7, 'Math', 10, false),
      part('(', 69, 687.6, 4, 'Body', 10, false),
      part('k', 73, 687.6, 5, 'Math', 10, false),
      part(')] denotes the restriction used in the calculation.', 78, 687.6, 258)
    ])
  )
  const formula = owner(result, 10)
  expect(formula.items.includes('1:15')).toBe(repeated)
  if (repeated) {
    expect(formula.sourceOnly).toBeUndefined()
    expect(formula.source).toMatch(/^N\[P\s?\(k\)\] denotes/u)
  }
})

it.each([true, false])(
  'assigns a wrapped predicate before a native stacked fraction (%s)',
  (matching) => {
    const units = source(
      page([
        part(
          'The two prescribed measurements give equal values for the whole sample.',
          85,
          672,
          441
        ),
        part('Using the two regular terms, we can now obtain the average degree', 85, 657, 441),
        part('of', 85, 642, 9, 'Body', 10.9, false),
        part('M', 97.4, 642, 7, 'Math', 10.9, false),
        part('is', 109.5, 642, 7.3, 'Body', 10.9, false),
        part('r', 120.5, 642, 5.7, 'Math', 10.9, false),
        part('(', 126.2, 642, 4.2, 'Body', 10.9, false),
        part(matching ? 'M' : 'H', 130.4, 642, 7, 'Math', 10.9, false),
        part(') =', 138.9, 642, 15.7, 'Body', 10.9, false),
        part('2', 158.9, 647.4, 4.2, 'Small', 8, false),
        part('r', 163.1, 647.4, 4.3, 'SmallMath', 8, false),
        part('(', 167.4, 647.4, 3.3, 'Small', 8, false),
        part('k', 170.7, 647.4, 4.1, 'SmallMath', 8, false),
        part(')+', 175.1, 647.4, 9.9, 'Small', 8, false),
        part('n', 185, 647.4, 7.5, 'SmallMath', 8),
        part('r', 162.6, 638.1, 4.4, 'SmallMath', 8, false),
        part('(', 167, 638.1, 3.3, 'Small', 8, false),
        part('k', 170.3, 638.1, 4.1, 'SmallMath', 8, false),
        part(')+1', 174.7, 638.1, 14.1, 'Small', 8, false),
        part(
          '. Since the measured quantity varies with the sampling rate, we',
          193.7,
          642,
          332.3,
          'Body',
          10.9
        ),
        part(
          'retain the same scale for the remainder of the analysis.',
          85,
          625.3,
          293,
          'Body',
          10.9
        )
      ])
    )
    const equation = owner(units, 9)
    const predicate = owner(units, 2)
    expect(equation.preserve).toBe('formula')
    expect(predicate === equation).toBe(!matching)
    if (matching) {
      expect(predicate.source.endsWith('the average degree of M is')).toBe(true)
      expect(equation.items.slice(0, 4)).toEqual(['1:5', '1:6', '1:7', '1:8'])
    }
  }
)

it('separates a numbered heading and complete paragraph before a run-in theorem', () => {
  const result = source(
    page([
      part('3.2', 60, 710, 16, 'Heading', 11, false),
      part('Residual estimates for the model', 87, 710, 180, 'Heading', 11),
      part('The trial sequence', 59.4, 693, 103, 'Body', 10, false),
      part('(', 167, 693, 4, 'Delimiter', 10, false),
      part('u', 171, 693, 6, 'Math', 10, false),
      part('j', 177, 691.5, 4.7, 'Script', 7.3, false),
      part(')', 182, 693, 4, 'Delimiter', 10, false),
      part('stays bounded under a fixed update rule.', 202, 693, 192),
      part('Proposition 3.4.', 60, 676, 68, 'Label', 10, false),
      part('Let', 132, 676, 14, 'Statement', 10, false),
      part('the trial states satisfy the following conditions', 149, 676, 199, 'Statement')
    ])
  )
  expect(result.units.map((unit) => unit.source)).toEqual([
    '3.2 Residual estimates for the model',
    'The trial sequence (uj) stays bounded under a fixed update rule.',
    'Proposition 3.4. Let the trial states satisfy the following conditions'
  ])
})

it.each([true, false])(
  'separates an independent numbered title above an indented paragraph (%s)',
  (aligned) => {
    const lead =
      'The independent test records establish the minimum spacing for the first group of samples.'
    const result = source(
      page([
        part('A separate trial confirmed the earlier result.', 55, 690, 211, 'Body', 10, false),
        part('', 55, 667, 0, 'Heading', 0),
        part('2.', 55, 667, 8, 'Heading', 10.25, false),
        part(' ', 63, 667, 6, 'Heading', 0, false),
        part('Measurement intervals', 69, 667, 126, 'Heading', 10.25, false),
        part('', 65, 652.2, 0),
        part(lead, aligned ? 65 : 67.5, 652.2, aligned ? 470 : 467.5),
        part(
          'different groups require a second set of observations before comparing the mean values',
          55,
          640.7,
          480
        ),
        part('under comparable conditions in the remaining trials.', 55, 629.2, 230)
      ])
    )
    const heading = owner(result, 2)
    const body = owner(result, 6)
    expect(heading === body).toBe(!aligned)
    if (aligned) {
      expect(heading.source).toBe('2. Measurement intervals')
      expect(body.source.startsWith(lead)).toBe(true)
    }
  }
)

it.each([true, false])(
  'reattaches a wrapped example reference above its independently printed caption (%s)',
  (sameFigure) => {
    const result = source(
      page([
        part('This completes the proof.', 72, 611, 121, 'Body', 11, false),
        part('', 72, 591, 0, 'Heading', 0),
        part('Example 2.3.', 72, 591, 72, 'Heading', 11, false),
        part(' ', 144, 591, 5, 'Heading', 0, false),
        part('We explain the counting argument for the case', 149, 591, 238, 'Body', 11, false),
        part(' ', 387, 591, 4, 'Body', 0, false),
        part('d', 391, 591, 7, 'Math', 11, false),
        part(' ', 398, 591, 3, 'Math', 0, false),
        part('= 4', 401, 591, 17, 'Body', 11, false),
        part('.', 418, 591, 3, 'Math', 11, false),
        part(' ', 421, 591, 4, 'Math', 0, false),
        part('Consider the graph Q in', 425, 591, 115, 'Body', 11),
        part('Figure 4.', 72, 578, 43, 'Body', 11, false),
        part('', 214, 555, 0, 'Diagram', 0),
        part('U', 214, 555, 7, 'Diagram', 7, false),
        part('1', 221, 554, 4, 'Script', 5, false),
        part(' ', 225, 554, 160, 'Script', 0, false),
        part('U', 385, 555, 7, 'Diagram', 7, false),
        part('3', 392, 554, 4, 'Script', 5, false),
        part('', 108, 344, 0, 'Caption', 0),
        part(sameFigure ? 'Figure 4.' : 'Figure 5.', 108, 344, 52, 'Caption', 11, false),
        part(' ', 160, 344, 5, 'Caption', 0, false),
        part('Q is a weighted graph showing the first construction.', 165, 344, 329, 'Body', 11)
      ])
    )
    const example = owner(result, 2)
    expect(example === owner(result, 12)).toBe(sameFigure)
    expect(example === owner(result, 20)).toBe(false)
    expect(example.fragments.length).toBe(sameFigure ? 2 : 1)
  }
)

it.each(['mode', 'gain'] as const)(
  'preserves matching lowered labels with their native fraction operands (%s)',
  (lowerLabel) => {
    const result = source(
      page([
        part('= ', 402, 300, 13, 'Body', 10, false),
        part('3Γ', 415, 306.8, 12, 'Body', 10, false),
        part('mode', 427, 305.3, 15, 'Script', 7, false),
        part('', 418, 293.2, 0, 'Greek', 0),
        part('τ', 418, 293.2, 6, 'Greek', 10, false),
        part(lowerLabel, 424, 291.7, 15, 'Script', 7, false),
        part('', 447, 300, 0, 'Relation', 0),
        part('≈', 447, 300, 8, 'Relation', 10, false)
      ])
    )
    const protectedLabel = lowerLabel === 'mode' ? 'formula' : undefined
    expect(owner(result, 2).preserve).toBe(protectedLabel)
    expect(owner(result, 5).preserve).toBe(protectedLabel)
  }
)

it.each([0.15, 3])('continues a caption past a separated micrometer suffix (gap=%s)', (gap) => {
  const input = page([
    part('Fig. 2.', 50, 600, 24, 'Bold', 9, false),
    part('The figure compares the measured values for both cases.', 77, 600, 223, 'Body', 9),
    part('The second panel shows the same measurement for (d)', 50, 589, 249, 'Body', 9),
    part('140', 50, 578, 14, 'Body', 9, false),
    part('μ', 66.5, 578, 5.3, 'Greek', 9, false),
    part('m, (e) 180', 72, 578, 40, 'Body', 9, false),
    part('μ', 114.5, 578, 5.3, 'Greek', 9, false),
    part('m. These measurements', 119.8 + gap, 578, 180, 'Body', 9),
    part('were recorded at a fixed orientation.', 50, 567, 163, 'Body', 9)
  ])
  const result = source(input)
  if (gap < 1) {
    expect(owner(result, 0).source).toContain(
      '(d) 140 μm, (e) 180 μm. These measurements were recorded at a fixed orientation.'
    )
    expect(owner(result, 6)).toBe(owner(result, 0))
    expect(owner(result, 8)).toBe(owner(result, 0))
  } else {
    expect(owner(result, 6).sourceOnly).toBe(true)
    expect(owner(result, 7)).not.toBe(owner(result, 0))
  }
})
