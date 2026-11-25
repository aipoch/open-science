import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

const item = (
  str: string,
  x: number,
  y: number,
  width: number,
  size: number,
  fontName: string,
  hasEOL = true
): PdfLayoutTextItem => ({
  str,
  dir: 'ltr',
  width,
  height: size,
  transform: [size, 0, 0, size, x, y],
  fontName,
  fontFamily: 'serif',
  fontAscent: 0.85,
  fontDescent: -0.25,
  fontVertical: false,
  hasEOL
})

it.each(['attested word', 'unattested word'] as const)(
  'repairs a native keyword wrap with independent spelling evidence (%s)',
  (evidence) => {
    const attested = evidence === 'attested word'
    const lead = 'KEYWORDS: graph theory, finite trees, orbit enu-'
    const body = attested
      ? 'Complete enumerations identify every orbit.'
      : 'Complete estimates identify every orbit.'
    const items = [
      item('A Note on Finite Trees', 77, 698, 176, 13, 'Title'),
      item('A. Example', 128, 675, 67, 10, 'Body'),
      item('Institute of Mathematical Studies', 77, 656, 182, 9, 'Address'),
      item(lead, 53, 615, 237, 8.5, 'Keywords'),
      item('meration', 109, 604, 24, 8.5, 'Keywords', false),
      item(body, 58, 585, 232, 10, 'Body')
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }],
      pageCount: 1
    })
    const head = units.find((unit) => unit.items.includes('1:3'))
    const tail = units.find((unit) => unit.items.includes('1:4'))
    expect(head?.source).toBe(attested ? lead.slice(0, -1) + 'meration' : lead)
    expect(tail === head).toBe(attested)
    expect(units.find((unit) => unit.items.includes('1:5'))?.source).toBe(body)
    expect(units.flatMap((unit) => unit.items).toSorted()).toEqual(
      items.map((_, index) => `1:${index}`)
    )
  }
)

it.each(['hanging item', 'closed list', 'different rail', 'unclear boundary'] as const)(
  'joins the last keyword taxonomy item after an open native separator (%s)',
  (kind) => {
    const lead =
        'graph theory, discrete structures: overview — simulation methods: individual (group C)' +
        (kind === 'closed list' ? '' : ' —'),
      tail = 'experiments: general',
      contact =
        kind === 'unclear boundary'
          ? 'Supplementary note: A. Example'
          : 'Corresponding author: A. Example',
      items = [
        item('Notes on Discrete Structures', 77, 698, 208, 13, 'Title'),
        item('Keywords:', 87, 576, 45, 10, 'Label', false),
        item(' ', 132, 576, 4, 0, 'Label', false),
        item(lead, 136, 576, 390, 10, 'Keywords'),
        item(tail, kind === 'different rail' ? 145 : 135.8, 563.6, 69, 10, 'Keywords', false),
        item(contact, 51, 93, 140, 8, 'Contact', false)
      ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }],
      pageCount: 1
    })
    const head = units.find((unit) => unit.items.includes('1:3')),
      ending = units.find((unit) => unit.items.includes('1:4')),
      joined = kind === 'hanging item'
    expect(head?.source).toBe(`Keywords: ${lead}${joined ? ' ' + tail : ''}`)
    expect(ending === head).toBe(joined)
    expect(units.find((unit) => unit.items.includes('1:5'))?.source).toBe(contact)
    expect(units.flatMap((unit) => unit.items).toSorted()).toEqual([
      '1:0',
      '1:1',
      '1:3',
      '1:4',
      '1:5'
    ])
  }
)

it.each(['same rail', 'different rail'] as const)(
  'joins complete indexed keyword terms across a native line break (%s)',
  (geometry) => {
    const lead = 'Field trials (54) — Test protocols (327) — Recorded samples (1392)'
    const tail = '— Laboratory methods (216) — Control groups (835)'
    const body =
      'Records from the first session indicate that each group delivered sufficient samples.'
    const joined = geometry === 'same rail'
    const items = [
      item('Notes on Trial Records', 172, 688, 193, 14, 'Title'),
      item('Keywords:', 90, 536, 52, 12, 'Label', false),
      item(' ', 142, 536, 4, 0, 'Label', false),
      item(lead, 146, 536, 376, 12, 'Body'),
      item(tail, joined ? 146.6 : 158, 520, 231, 12, 'Body'),
      item(body, 99, 470, 423, 12, 'Body')
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }],
      pageCount: 1
    })
    const head = units.find((unit) => unit.items.includes('1:3'))
    expect(head?.source).toBe(`Keywords: ${lead}${joined ? ' ' + tail : ''}`)
    expect(units.find((unit) => unit.items.includes('1:4')) === head).toBe(joined)
    expect(units.find((unit) => unit.items.includes('1:5'))?.source).toBe(body)
    expect(units.flatMap((unit) => unit.items).toSorted()).toEqual([
      '1:0',
      '1:1',
      '1:3',
      '1:4',
      '1:5'
    ])
  }
)

it.each(['native wrap', 'closed entry', 'different rail', 'short measure'] as const)(
  'groups a final two-word keyword when the native row continues the taxonomy (%s)',
  (shape) => {
    const lead =
      'samples: raw – mixtures: prepared – plants: cultivated – materials: ' +
      (shape === 'closed entry' ? 'temperature' : 'thermally')
    const tail = 'stable'
    const items = [
      item(
        'The initial description defines the materials and their physical properties.',
        42,
        495,
        shape === 'short measure' ? 475 : 505,
        10,
        'Body'
      ),
      item('Key words:', 42, 465, 48, 10, 'Label', false),
      item(lead, 95, 465, 452, 10, 'Body'),
      item(tail, shape === 'different rail' ? 58 : 42, 452.5, 29, 10, 'Body'),
      item('1 INTRODUCTION', 42, 404, 80, 10, 'Label', false)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 595, height: 782, rotation: 0, items }],
      pageCount: 1
    })
    const head = units.find((unit) => unit.items.includes('1:1'))
    const joined = shape === 'native wrap'
    expect(head?.source).toBe(`Key words: ${lead}${joined ? ' ' + tail : ''}`)
    expect(head?.items).toEqual(joined ? ['1:1', '1:2', '1:3'] : ['1:1', '1:2'])
    expect(units.find((unit) => unit.items.includes('1:4'))?.source).toBe('1 INTRODUCTION')
    expect(units.flatMap((unit) => unit.items).toSorted()).toEqual(
      items.map((_, index) => `1:${index}`)
    )
  }
)

it.each(['attested designation', 'shifted continuation', 'unattested designation'] as const)(
  'joins a named individual at the end of a wrapped keyword list (%s)',
  (shape) => {
    const lead = 'Transient stars (117) — Stellar spectra (305) — Field surveys (624) — Stars:'
    const tail = 'individual (Nova Amber 2042)'
    const joined = shape === 'attested designation'
    const title =
      shape === 'unattested designation'
        ? 'Observations of Nova Silver 2042 (field A)'
        : 'Observations of Nova Amber 2042 (field A)'
    const items = [
      item(title, 141, 697, 330, 10, 'Title'),
      item('Keywords:', 84, 407, 45, 10, 'Label', false),
      item(' ', 129, 407, 6, 0, 'Label', false),
      item(lead, 135, 407, 390, 10, 'Body'),
      item(tail, shape === 'shifted continuation' ? 143 : 133, 394.5, 117, 10, 'Body', false),
      item('1.', 259, 370, 7, 9, 'Heading', false),
      item(' ', 266, 370, 6, 0, 'Heading', false),
      item('INTRODUCTION', 272, 370, 81, 10, 'Body'),
      item(
        'We observed the transient repeatedly under stable conditions.',
        60,
        352,
        501,
        10,
        'Body'
      )
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }],
      pageCount: 1
    })
    const head = units.find((unit) => unit.items.includes('1:3'))
    expect(head?.source).toBe(`Keywords: ${lead}${joined ? ' ' + tail : ''}`)
    expect(units.find((unit) => unit.items.includes('1:4')) === head).toBe(joined)
    expect(units.find((unit) => unit.items.includes('1:7'))?.source).toBe('1. INTRODUCTION')
  }
)

it.each([0, 4])('keeps a hyphenated indexed keyword on the hanging rail (%s)', (shift) => {
  const lead = 'Field trials (78) — Sample records (120) — Local surveys (441) — Labora-'
  const tail = 'tory methods (318) — Control groups (692)'
  const items = [
    item('Notes on analytic observations', 168, 696, 260, 14, 'Title'),
    item('Keywords:', 83, 380, 51, 12, 'Label', false),
    item(' ', 134, 380, 3, 0, 'Label', false),
    item(lead, 137, 380, 390, 12, 'Body'),
    item(tail, 137 + shift, 365, 250, 12, 'Body', false),
    item('1.', 116, 338, 8, 11, 'Body', false),
    item(' ', 124, 338, 5, 0, 'Body', false),
    item('INTRODUCTION', 129, 338, 94, 12, 'Body'),
    item(
      'Laboratory observations compare independent groups under ordinary conditions.',
      59,
      318,
      233,
      12,
      'Body'
    )
  ]
  const { units } = groupPdfTranslationPages({
    pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }],
    pageCount: 1
  })
  const head = units.find((unit) => unit.items.includes('1:3'))
  expect(head?.source).toBe('Keywords: ' + (shift ? lead : lead.slice(0, -1) + tail))
  expect(head?.items.includes('1:4')).toBe(!shift)
})

it.each([true, false])(
  'keeps a hyphenated modifier with its indexed keyword on the same text rail (%s)',
  (aligned) => {
    const lead = 'Survey sites (37) — Field records (152) — Sampling methods (96) — Low-pressure'
    const tail = 'test chambers (2410) — Pressure sensors (365) — Calibration tools (831)'
    const items = [
      item('Keywords:', 85, 425, 45, 10, 'Label', false),
      item(lead, 133, 425, 393, 10, 'Body'),
      item(tail, aligned ? 133.3 : 151, 412.5, 333, 10, 'Body'),
      item('1. INTRODUCTION', 260, 376, 92, 10, 'Body')
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    const head = units.find((unit) => unit.items.includes('1:1'))
    expect(head?.source).toBe('Keywords: ' + lead + (aligned ? ' ' + tail : ''))
    expect(head?.items).toEqual(aligned ? ['1:0', '1:1', '1:2'] : ['1:0', '1:1'])
    expect(units.find((unit) => unit.items.includes('1:3'))?.source).toBe('1. INTRODUCTION')
  }
)

it.each([true, false])(
  'keeps the final keyword with its article before the next section (%s)',
  (aligned) => {
    const lead = 'methods: fitting – sensors: calibration – sampling: controls – structure of the'
    const tail = 'Dataset'
    const items = [
      item('Key words.', 60, 449, 45, 8.55, 'Label', false),
      item(' ', 105, 449, 7, 0, 'Label', false),
      item(lead, 112, 449, 424, 9, 'Keywords'),
      item(tail, aligned ? 60 : 64, 439, 30, 9, 'Keywords', false),
      item('', 37, 405, 0, 0, 'Label'),
      item('1. Introduction', 37, 405, 72, 10.4, 'Label', false)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 595, height: 842, rotation: 0, items }]
    })
    const owner = units.find((unit) => unit.items.includes('1:2'))
    expect(owner?.source).toBe('Key words. ' + lead + (aligned ? ' ' + tail : ''))
    expect(owner?.items.includes('1:3')).toBe(aligned)
    expect(units.find((unit) => unit.items.includes('1:5'))?.source).toBe('1. Introduction')
  }
)

it.each([true, false])(
  'keeps a witnessed catalogue number intact across hanging keyword rows (%s)',
  (witnessed) => {
    const lead = 'samples: measured — catalogue: type: XY 21-8731, ZX 47-'
    const continuation = '602184, HG 325, JD 15-2 — samples: related — records: previous'
    const tail = '— records: revised'
    const items = [
      item('Survey of Collected Records', 180, 685, 252, 14, 'Title'),
      item('Keywords:', 85, 571, 45, 10, 'Label', false),
      item(lead, 141, 571, 385, 10, 'Body'),
      item(continuation, 135, 558.5, 391, 10, 'Body'),
      item(tail, 135, 546, 85, 10, 'Body', false),
      item('1. BACKGROUND', 241, 519, 130, 10, 'Heading'),
      item(
        'The catalogue lists sample ' +
          (witnessed ? 'ZX 47-602184' : 'ZX 47-680214') +
          ' in the record.',
        51,
        500,
        360,
        10,
        'Body'
      )
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    const keywords = units.find((unit) => unit.items.includes('1:1'))
    expect(keywords?.source).toBe(
      'Keywords: ' + lead + (witnessed ? continuation + ' ' + tail : '')
    )
    expect(keywords?.items).toEqual(witnessed ? ['1:1', '1:2', '1:3', '1:4'] : ['1:1', '1:2'])
  }
)

it.each([true, false])(
  'joins a hyphenated indexed keyword when its complete spelling recurs (%s)',
  (attested) => {
    const lead = 'Trial design (14) — Data quality (22) — Sample records (35) — Calib-'
    const tail = 'ration (46) — Validation runs (58)'
    const items = [
      item('Notes on Trial Records', 168, 684, 276, 14, 'Title'),
      item('Keywords:', 84, 396, 40, 10, 'Label', false),
      item(' ', 124, 396, 4, 0, 'Label', false),
      item(lead, 128, 396, 396, 10, 'Body'),
      item(tail, 127.5, 382, 172, 10, 'Body', false),
      item('', 265, 355, 0, 0, 'Body'),
      item('1.', 265, 355, 6, 9, 'Body', false),
      item(' ', 271, 355, 5, 0, 'Body', false),
      item('INTRODUCTION', 276, 355, 71, 10, 'Body'),
      item(
        attested
          ? 'The calibration records cover the entire first trial.'
          : 'The precision records cover the entire first trial.',
        58,
        337,
        255,
        10,
        'Body'
      )
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    const head = units.find(({ items }) => items.includes('1:3'))
    const end = units.find(({ items }) => items.includes('1:4'))
    expect(head?.source).toBe('Keywords: ' + (attested ? lead.slice(0, -1) + tail : lead))
    expect(end === head).toBe(attested)
    expect(units.find(({ items }) => items.includes('1:6'))?.source).toBe('1. INTRODUCTION')
  }
)

it.each(['attested', 'unattested', 'misaligned', 'different category', 'hyphen attested'] as const)(
  'joins a split word within hanging repeated keyword categories (%s)',
  (evidence) => {
    const lead = 'samples: group (AB1234) – samples: procedure — samples: early – samples: loca-'
    const category = evidence === 'different category' ? 'records' : 'samples'
    const tail = `tion – ${category}: distribution`
    const witnesses: Partial<Record<typeof evidence, string>> = {
      unattested: 'The placement of calibrated devices matches each record.',
      'hyphen attested': 'Both location and loca-tion occur in the records.'
    }
    const witness = witnesses[evidence] ?? 'The location of calibrated devices matches each record.'
    const items = [
      item(witness, 84, 465, 405, 10, 'Body'),
      item('Keywords:', 84, 403, 44.7, 10, 'Label', false),
      item(' ', 128.7, 403, 3.8, 0, 'Label', false),
      item(lead, 132.5, 403, 393, 10, 'Body'),
      item(tail, evidence === 'misaligned' ? 139 : 132.7, 390.5, 121, 10, 'Body', false),
      item('', 259, 362, 0, 0, 'Heading'),
      item('1.', 259, 362, 7, 9, 'Heading', false),
      item(' ', 266, 362, 6, 0, 'Heading', false),
      item('INTRODUCTION', 272, 362, 81, 10, 'Body')
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    const head = units.find(({ items }) => items.includes('1:3'))
    const end = units.find(({ items }) => items.includes('1:4'))
    expect(head?.source).toBe(
      'Keywords: ' + (evidence === 'attested' ? lead.slice(0, -1) + tail : lead)
    )
    expect(end === head).toBe(evidence === 'attested')
    expect(head?.items).toEqual(evidence === 'attested' ? ['1:1', '1:3', '1:4'] : ['1:1', '1:3'])
    expect(units.find(({ items }) => items.includes('1:6'))?.source).toBe('1. INTRODUCTION')
  }
)

it.each(['hanging rail', 'different rail'] as const)(
  'keeps a wrapped category number with its keyword phrase (%s)',
  (rail) => {
    const lead = 'forest surveys (281); controls (72); seasonal water samples'
    const tail = '(123); river sampling (419); native seed banks (728)'
    const body = 'Long records from the survey show substantial changes in these field sites.'
    const joined = rail === 'hanging rail'
    const items = [
      item('Notes on Seasonal Surveys', 170, 680, 185, 14, 'Title'),
      item('Keywords:', 90, 536, 52, 12, 'Label', false),
      item(' ', 142, 536, 4, 0, 'Label', false),
      item(lead, 146, 536, 376, 12, 'Body'),
      item(tail, joined ? 147 : 151, 520, 340, 12, 'Body'),
      item(body, 99, 470, 423, 12, 'Body')
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }],
      pageCount: 1
    })
    const head = units.find((unit) => unit.items.includes('1:3'))
    expect(head?.source).toBe(`Keywords: ${lead}${joined ? ' ' + tail : ''}`)
    expect(units.find((unit) => unit.items.includes('1:4')) === head).toBe(joined)
    expect(units.find((unit) => unit.items.includes('1:5'))?.source).toBe(body)
    expect(units.flatMap((unit) => unit.items).toSorted()).toEqual([
      '1:0',
      '1:1',
      '1:3',
      '1:4',
      '1:5'
    ])
  }
)
