import { expect, test } from 'vitest'
import {
  groupPdfTranslationPages,
  type PdfLayoutPage,
  type PdfLayoutTextItem
} from '../../src/reader/layout.js'

const native = (
  str: string,
  x: number,
  y: number,
  width: number,
  height = 7.5,
  fontName = 'Header'
): PdfLayoutTextItem => ({
  str,
  width,
  height,
  fontName,
  dir: 'ltr',
  fontAscent: 0.8,
  fontDescent: -0.2,
  fontVertical: false,
  hasEOL: true,
  transform: [height, 0, 0, height, x, 800 - y]
})

test.each([
  'complete',
  'small capitals',
  'two pages',
  'font drift',
  'position drift',
  'literal drift',
  'body type',
  'adjacent body',
  'deep body',
  'earlier prose',
  'missing metrics',
  'unmeasured gutter',
  'duplicate native run'
])('requires complete repeated native margin type and an independent body: %s', (fault) => {
  const pages: PdfLayoutPage[] = [1, 2, 3].slice(0, fault === 'two pages' ? 2 : 3).map((page) => {
    const y =
      fault === 'deep body'
        ? 250
        : fault === 'adjacent body'
          ? 95
          : fault === 'small capitals'
            ? 40
            : 75
    const header =
      fault === 'small capitals'
        ? [
            native('R', 200, y, 6, 10, 'Body'),
            native('EPEATED NATIVE RUNNING PAPER TITLE', 206, y, 194, 8, 'Body')
          ]
        : [native('Repeated scholarly running document title', 200, y, 200)]
    if (page === 3 && fault === 'font drift') header[0].fontName = 'Foreign'
    if (page === 3 && fault === 'position drift') header[0].transform[4] += 3
    if (page === 3 && fault === 'literal drift')
      header[0].str = 'A different scholarly running paper title'
    if (fault === 'body type') {
      header[0].height = 10
      header[0].transform[0] = header[0].transform[3] = 10
    }
    if (fault === 'missing metrics') delete header[0].fontAscent
    if (fault === 'duplicate native run') header.push({ ...header[0] })
    const body = Array.from({ length: 3 }, (_, n) =>
      native(
        'The independent native body paragraph explains the ordinary measurements and all relevant experimental observations.',
        50,
        (fault === 'adjacent body'
          ? 100
          : fault === 'deep body'
            ? 300
            : fault === 'small capitals'
              ? 90
              : 110) +
          n * 15,
        500,
        10,
        'Body'
      )
    )
    if (fault === 'unmeasured gutter') {
      const unknown = native('x', 100, 110, 5, 10)
      delete unknown.fontAscent
      body.push(unknown)
    }
    return {
      page,
      width: 600,
      height: 800,
      rotation: 0,
      items: [
        ...(fault === 'earlier prose'
          ? [
              native(
                'An earlier independent native paragraph prevents an empty upper margin proof.',
                50,
                25,
                450,
                10,
                'Body'
              )
            ]
          : []),
        ...header,
        ...body
      ]
    }
  })
  const before = structuredClone(pages),
    result = groupPdfTranslationPages({ pages }),
    headerKeys = new Set(
      pages.flatMap((p) =>
        p.items.flatMap((i, n) =>
          i.str.includes('running') || /^(?:R|EPEATED)/u.test(i.str) ? [`${p.page}:${n}`] : []
        )
      )
    ),
    owners = result.units.filter((u) => u.items.some((k) => headerKeys.has(k)))
  expect(owners.length).toBeGreaterThan(0)
  expect(owners.every((u) => !!u.sourceOnly)).toBe(['complete', 'small capitals'].includes(fault))
  expect(result.units.flatMap((u) => u.items).sort()).toEqual(
    pages.flatMap((p) => p.items.map((_, n) => `${p.page}:${n}`)).sort()
  )
  expect(pages).toEqual(before)
})

test('protects whole title owners without moving the native page counter or changing IDs', () => {
  const pages: PdfLayoutPage[] = [1, 2, 3].map((page) => ({
    page,
    width: 600,
    height: 800,
    rotation: 0,
    items: [
      native(String(page), 60, 75, 5),
      native('Repeated scholarly running document title', 200, 75, 200),
      ...Array.from({ length: 3 }, (_, n) =>
        native(
          'The independent native body paragraph explains the ordinary measurements and all relevant experimental observations.',
          50,
          110 + n * 15,
          500,
          10,
          'Body'
        )
      )
    ]
  }))
  const unproved = groupPdfTranslationPages({ pages: pages.slice(0, 2) }),
    proved = groupPdfTranslationPages({ pages }),
    payload = (unit: (typeof proved.units)[number]): Omit<typeof unit, 'sourceOnly'> => {
      const { sourceOnly, ...original } = unit
      void sourceOnly
      return original
    }
  expect(proved.units.slice(0, unproved.units.length).map(payload)).toEqual(
    unproved.units.map(payload)
  )
  expect(
    proved.units
      .filter((u) => u.source === 'Repeated scholarly running document title')
      .every((u) => u.sourceOnly)
  ).toBe(true)
})

test.each([true, false])(
  'protects a dated proceedings line repeated on each margin lane: %s',
  (proof) => {
    const event = "NVS '25, April 4, 2025, Elm City"
    const pages: PdfLayoutPage[] = [1, 2, 3, 4, 5, 6].map((page) => ({
      page,
      width: 600,
      height: 800,
      rotation: 0,
      items: [
        native(event, page % 2 ? 50 : 410, 69, 140),
        native('Field Team', page % 2 ? 490 : 50, 69, 55),
        ...Array.from({ length: 3 }, (_, n) =>
          native(
            'The ordinary observations support analysis across conditions after independent calibration.',
            50,
            (proof ? 100 : 78) + n * 15,
            480,
            10,
            'Body'
          )
        )
      ]
    }))
    const units = groupPdfTranslationPages({ pages }).units
    const headers = units.filter((unit) => unit.source === event)
    expect(headers).toHaveLength(6)
    expect(headers.every((unit) => unit.sourceOnly)).toBe(proof)
    expect(units.some((unit) => unit.source.startsWith('The ordinary') && !unit.sourceOnly)).toBe(
      true
    )
  }
)

test.each(['complete', 'two pairs', 'changing shortened title', 'crowded margin'])(
  'preserves complete alternating proceedings rows with a three-pair native witness: %s',
  (shape) => {
    const imprint = "FN '26, April 3–5, 2026, Elm City"
    const title = 'A native title about layout ...'
    const author = 'L. Huang, et al.'
    const pages: PdfLayoutPage[] = Array.from(
      { length: shape === 'two pairs' ? 4 : 6 },
      (_, index) => ({
        page: index + 1,
        width: 600,
        height: 800,
        rotation: 0,
        items: [
          ...(index % 2
            ? [
                native(
                  shape === 'changing shortened title' && index === 5 ? title + '.' : title,
                  54,
                  69,
                  162
                ),
                native(imprint, 410, 69, 142)
              ]
            : [native(imprint, 54, 69, 142), native(author, 510, 69, 42)]),
          ...Array.from({ length: 3 }, (_, row) =>
            native(
              'Measurements use native text.',
              54,
              (shape === 'crowded margin' ? 87 : 105) + row * 14,
              225,
              9.5,
              'Body'
            )
          )
        ]
      })
    )
    const result = groupPdfTranslationPages({ pages })
    const margin = result.units.filter((u) => u.items.some((key) => /:[01]$/u.test(key)))
    expect(margin).toHaveLength(pages.length * 2)
    expect(margin.every((unit) => unit.sourceOnly)).toBe(shape === 'complete')
    expect(
      result.units.some((unit) => unit.source.startsWith('Measurements') && !unit.sourceOnly)
    ).toBe(true)
    expect(result.units.flatMap((unit) => unit.items).sort()).toEqual(
      pages.flatMap((page) => page.items.map((_, index) => `${page.page}:${index}`)).sort()
    )
  }
)

test.each(['complete', 'cover mismatch', 'two pairs', 'crowded margin'])(
  'preserves compact proceedings headers facing the full cover title: %s',
  (shape) => {
    const imprint = 'FN, April 3–5, 2026, Elm City'
    const first = 'A Practical Guide to Measuring the Stability of'
    const second = 'Sensors Under Independently Controlled Conditions'
    const title = `${first} ${second}`
    const page = (number: number, items: PdfLayoutTextItem[]): PdfLayoutPage => ({
      page: number,
      width: 600,
      height: 800,
      rotation: 0,
      items
    })
    const cover = page(1, [
      native(
        shape === 'cover mismatch' ? 'A Guide to Replacing the Stability of' : first,
        88,
        90,
        420,
        17,
        'Title'
      ),
      native(second, 65, 114, 465, 17, 'Title')
    ])
    const bodyRows = (firstY: number): PdfLayoutTextItem[] =>
      Array.from({ length: 3 }, (_, row) =>
        native(
          'These measurements are repeated with the same native instrument parameters.',
          54,
          firstY + row * 15,
          245,
          10,
          'Body'
        )
      )
    cover.items.push(...bodyRows(170))
    const facing = Array.from({ length: shape === 'two pairs' ? 4 : 6 }, (_, n) =>
      page(n + 2, [
        ...(n % 2
          ? [native(title, 54, 69, 330), native(imprint, 456, 69, 90)]
          : [native(imprint, 54, 69, 90), native('Avery Stone et al.', 508, 69, 38)]),
        ...bodyRows(shape === 'crowded margin' ? 87 : 105)
      ])
    )
    const { units } = groupPdfTranslationPages({ pages: [cover, ...facing] })
    const headers = units.filter((unit) => unit.items.some((key) => /^[2-7]:[01]$/u.test(key)))
    expect(headers).toHaveLength(facing.length * 2)
    expect(headers.filter((header) => header.sourceOnly)).toHaveLength(
      shape === 'complete' ? 12 : 0
    )
    expect(units.find((unit) => unit.items.includes('1:0'))?.sourceOnly).toBeUndefined()
  }
)

test.each([false, true])(
  'separates paired conference margin text only with a repeated dated companion (%s)',
  (changedCompanion) => {
    const workshop = 'Annual Workshop on Optical Systems'
    const pages: PdfLayoutPage[] = [2, 3, 4].map((page, index) => {
      const imprint =
        changedCompanion && index === 2
          ? 'Imaging Forum 2025: July 5-7, Kyoto, Japan'
          : 'Imaging Forum 2025: July 4-6, Kyoto, Japan'
      const items = [
        native(imprint, 515 + index * 4, 31 - index * 0.5, 243, 9),
        native('Optical measurements were compared against a reference', 32, 47, 224, 10, 'Body'),
        native('and recorded at each stage of the experiments.', 32, 59, 219, 10, 'Body'),
        native('The final set of readings confirmed the original result.', 32, 71, 220, 10, 'Body'),
        native('Annual Workshop', 30, 31, 110, 9),
        native('on Optical Systems', 142, 31, 152, 9)
      ]
      for (const item of items) item.transform[5] -= 188
      items[4].hasEOL = false
      return { page, width: 792, height: 612, rotation: 0, items }
    })
    const { units } = groupPdfTranslationPages({ pages })
    const workshops = units.filter((unit) => unit.source === workshop && unit.sourceOnly)
    expect(workshops.length).toBe(changedCompanion ? 0 : 3)
    if (!changedCompanion) {
      expect(units.filter((unit) => unit.sourceOnly).length).toBe(6)
      expect(units.filter((unit) => unit.source.startsWith('Optical measurements')).length).toBe(3)
    }
  }
)

test.each([
  'paired folios',
  'single-word imprint',
  'shifted single-word imprint',
  'missing parity',
  'stale page number',
  'shifted folio'
] as const)('keeps a complete mirrored publication line in its original form with %s', (mode) => {
  const spaced = mode.includes('single-word')
  const complete = mode === 'paired folios' || mode === 'single-word imprint'
  const pages: PdfLayoutPage[] = [1, 2, 3, 4]
    .slice(0, mode === 'missing parity' ? 3 : 4)
    .map((page) => {
      const shift = page % 2 === 1 ? 6 : 0
      const number = mode === 'stale page number' && page === 4 ? page - 1 : page
      const folioShift = mode === 'shifted folio' && page === 4 ? 3 : 0
      const imprintX = 482 + shift + (page % 2 === 1 ? 0.0008 : 0)
      const offset = mode === 'shifted single-word imprint' && page === 4 ? 2 : 0
      const space = (left: number, right: number): PdfLayoutTextItem => ({
        ...native(' ', left, 38, right - left),
        height: 0,
        hasEOL: false
      })
      return {
        page,
        width: 600,
        height: 800,
        rotation: 0,
        items: [
          { ...native('Article', 48 + shift, 38, 22), hasEOL: false },
          ...(spaced
            ? [
                space(70 + shift, imprintX + offset),
                { ...native('Mercury', imprintX + offset, 38, 32), hasEOL: false },
                space(imprintX + offset + 32, 550 + shift)
              ]
            : [{ ...native('Example Review', 482 + shift, 38, 47), hasEOL: false }]),
          native(String(number), 550 + shift + folioShift, 38, 4),
          native(
            'Independent observations follow the initial experiment and support the reported result.',
            48,
            70,
            263,
            10,
            'Body'
          )
        ]
      }
    })
  const result = groupPdfTranslationPages({ pages })
  const folioIndex = spaced ? 4 : 2
  const roleOwners = result.units.filter((unit) =>
    unit.items.some((key) => Number(key.split(':')[1]) <= folioIndex)
  )
  const labelOwners = roleOwners.filter((unit) => unit.source.includes('Article'))
  expect(labelOwners).toHaveLength(pages.length)
  expect(labelOwners.every((unit) => unit.sourceOnly === true)).toBe(complete)
  if (complete) expect(roleOwners.every((unit) => unit.sourceOnly)).toBe(true)
  expect(result.units.flatMap((unit) => unit.items).sort()).toEqual(
    pages
      .flatMap((p) =>
        p.items.flatMap((item, index) => (item.str.trim() ? [`${p.page}:${index}`] : []))
      )
      .sort()
  )
})

test.each(['complete', 'cover mismatch', 'incomplete pair', 'offset cover title', 'offset margin'])(
  'preserves a full-title proceedings header over two complete facing pairs: %s',
  (shape) => {
    const imprint = 'SYM ’24, June 6–8, 2024, Alder City'
    const first = 'A Study of Instrument Calibration Across Independent Laboratories'
    const second = 'with Low-Cost Sensors'
    const title = `${first} ${second}`
    const cover = [
      native(first, 54, 93, 492, 17, 'Cover'),
      native(second, shape === 'offset cover title' ? 222 : 242, 115, 116, 17, 'Cover')
    ]
    const pages: PdfLayoutPage[] = Array.from(
      { length: shape === 'incomplete pair' ? 4 : 5 },
      (_, index) => ({
        page: index + 1,
        width: 600,
        height: 800,
        rotation: 0,
        items: [
          ...(index === 0
            ? cover
            : index % 2
              ? [native(imprint, 54, 67, 168), native('Cedar Lane et al.', 504, 67, 42)]
              : [
                  native(shape === 'cover mismatch' ? first + ' in Practice' : title, 54, 67, 230),
                  native(imprint, shape === 'offset margin' ? 369 : 378, 67, 168)
                ]),
          ...Array.from({ length: 3 }, (_, row) =>
            native(
              'The ordinary observations support comparison.',
              54,
              150 + row * 14,
              231,
              10,
              'Body'
            )
          )
        ]
      })
    )
    const { units } = groupPdfTranslationPages({ pages })
    const headings = units.filter(({ items }) => items.some((id) => /^[2-5]:[01]$/u.test(id)))
    expect(headings).toHaveLength((pages.length - 1) * 2)
    expect(headings.filter(({ sourceOnly }) => sourceOnly)).toHaveLength(
      shape === 'complete' ? 8 : 0
    )
    expect(
      units.filter(({ items }) => items.includes('1:0')).every(({ sourceOnly }) => !sourceOnly)
    ).toBe(true)
    expect(
      units.some(({ source, sourceOnly }) => source.startsWith('The ordinary') && !sourceOnly)
    ).toBe(true)
  }
)

test.each(['complete', 'folio mismatch', 'one page', 'asymmetric frame'])(
  'protects an independent journal type label beside repeated printed folios: %s',
  (variant) => {
    const label = 'Technical Note'
    const pages: PdfLayoutPage[] = Array.from(
      { length: variant === 'one page' ? 1 : 4 },
      (_, index) => ({
        page: index + 1,
        width: 600,
        height: 800,
        rotation: 0,
        items: [
          native(label, 119, 65, 51),
          native(
            String(variant === 'folio mismatch' && index === 3 ? 9 : index + 1),
            variant === 'asymmetric frame' ? 498 : 477,
            65,
            4
          ),
          native(
            'These independent measurements were repeated across multiple instruments.',
            113,
            117,
            350,
            10,
            'Body'
          )
        ]
      })
    )
    const { units } = groupPdfTranslationPages({ pages })
    expect(units.filter(({ source, sourceOnly }) => source === label && sourceOnly)).toHaveLength(
      variant === 'complete' ? 4 : 0
    )
    expect(
      units
        .filter(({ source }) => source.startsWith('These independent'))
        .every(({ sourceOnly }) => !sourceOnly)
    ).toBe(true)
  }
)

test.each(['complete', 'two mirrors', 'body touches imprint'])(
  'keeps a separately repeated outer-margin preprint imprint source-only: %s',
  (fault) => {
    const pages: PdfLayoutPage[] = [2, 3, 4]
      .slice(0, fault === 'two mirrors' ? 2 : 3)
      .map((page) => {
        const header = [
          native('A', 380, 40, 7, 10, 'Body'),
          native('PREPRINT', 390, 40, 40, 8, 'Body'),
          native('- M', 433, 40, 13, 10, 'Body'),
          native('ARCH', 447, 40, 42, 8, 'Body'),
          native('12, 2040', 492, 40, 37, 10, 'Body')
        ]
        for (const run of header.slice(0, -1)) run.hasEOL = false
        const bodyY = fault === 'body touches imprint' ? 55 : page === 4 ? 230 : 90
        return {
          page,
          width: 600,
          height: 800,
          rotation: 0,
          items: [
            ...header,
            ...Array.from({ length: 3 }, (_, line) =>
              native(
                'The independent paragraph records each measurement and explains the observed result.',
                50,
                bodyY + line * 15,
                500,
                10,
                'Body'
              )
            )
          ]
        }
      })
    const result = groupPdfTranslationPages({ pages })
    for (const { page } of pages) {
      const containing = (index: number): (typeof result.units)[number] | undefined =>
        result.units.find((unit) => unit.items.includes(`${page}:${index}`))
      for (let index = 0; index < 5; index++)
        expect(Boolean(containing(index)?.sourceOnly)).toBe(fault === 'complete')
      expect(containing(5)?.sourceOnly).toBeFalsy()
    }
    expect(result.units.flatMap((unit) => unit.items).sort()).toEqual(
      pages.flatMap((page) => page.items.map((_, index) => `${page.page}:${index}`)).sort()
    )
  }
)

test.each(['complete', 'different cover', 'short run', 'occupied gutter'])(
  'preserves three facing margin rows backed by the cover title and byline: %s',
  (shape) => {
    const title = 'CALIBRATION OF SEVERAL INDEPENDENT INSTRUMENTS'
    const byline = 'CEDAR LANE AND RIVER NORTH'
    const body = (y: number): PdfLayoutTextItem =>
      native(
        'The independent measurement includes a comparison against the previous reference.',
        70,
        y,
        442,
        10,
        'Body'
      )
    const page = (n: number, items: PdfLayoutTextItem[]): PdfLayoutPage => ({
      page: n,
      width: 600,
      height: 800,
      rotation: 0,
      items
    })
    const pages = [
      page(1, [
        native(
          shape === 'different cover' ? 'ANOTHER COVER TITLE' : title,
          120,
          112,
          360,
          10,
          'Title'
        ),
        native(byline, 210, 141, 180, 8, 'Byline'),
        body(190)
      ]),
      ...[2, 3, 4].slice(0, shape === 'short run' ? 2 : 3).map((n) => {
        const even = n % 2 === 0
        const header = even ? native(byline, 222, 54, 156, 7) : native(title, 179, 54, 242, 7)
        const folio = native(String(n), even ? 70 : 526, 54, 4, 7)
        return page(n, [
          ...(even ? [folio, header] : [header, folio]),
          body(shape === 'occupied gutter' && n === 3 ? 65 : 82)
        ])
      })
    ]
    const { units } = groupPdfTranslationPages({ pages })
    for (const p of pages) {
      const header = units.find(({ items }) => items.includes(p.page + ':' + (p.page % 2 ? 0 : 1)))
      expect(Boolean(header?.sourceOnly)).toBe(shape === 'complete' && p.page > 1)
      expect(units.find(({ items }) => items.includes(p.page + ':2'))?.sourceOnly).toBeUndefined()
    }
  }
)

test.each(['matching cover', 'different title', 'different byline'])(
  'preserves inset facing margins only when both labels match the cover: %s',
  (shape) => {
    const page = (n: number, items: PdfLayoutTextItem[]): PdfLayoutPage => ({
      page: n,
      width: 600,
      height: 800,
      rotation: 0,
      items
    })
    const cover = page(1, [
      native('Experiments on the transfer of', 132, 150, 304, 14, 'Cover'),
      native('Heat: A short report', 132, 168, 175, 14, 'Cover'),
      native('Amelia M. Green', 132, 202, 75, 10, 'Author')
    ])
    const pages = [
      cover,
      ...[2, 3, 4].map((n) => {
        const even = n % 2 === 0
        const folio = native(String(n), even ? 132 : 463, 90, 5, 9)
        const title = native(
          shape === 'different title'
            ? 'Experiments on the transfer of light'
            : 'Experiments on the transfer of heat',
          236,
          90,
          200,
          9
        )
        const author = native(
          shape === 'different byline' ? 'A. M. Gray et al.' : 'A. M. Green et al.',
          164,
          90,
          78,
          9
        )
        const body = native(
          'The experiment records temperature over several measurement periods.',
          132,
          115,
          330,
          10,
          'Body'
        )
        return page(n, even ? [folio, author, body] : [title, folio, body])
      })
    ]
    const { units } = groupPdfTranslationPages({ pages })
    for (const p of pages.slice(1)) {
      const headers = units.filter((unit) =>
        unit.items.some((key) => key === `${p.page}:0` || key === `${p.page}:1`)
      )
      expect(
        headers.some(
          (unit) => unit.items.includes(`${p.page}:${p.page % 2 ? 0 : 1}`) && unit.sourceOnly
        )
      ).toBe(shape === 'matching cover')
      expect(units.find(({ items }) => items.includes(`${p.page}:2`))?.sourceOnly).toBeUndefined()
    }
    expect(units.find(({ items }) => items.includes('1:0'))?.sourceOnly).toBeUndefined()
  }
)

test.each([0, 3])(
  'does not start bibliography at a last-page running label (folio shift %s)',
  (shift) => {
    const page = (number: number, items: PdfLayoutTextItem[]): PdfLayoutPage => ({
      page: number,
      width: 600,
      height: 800,
      rotation: 0,
      items
    })
    const text = (
      str: string,
      x: number,
      y: number,
      width: number,
      face = 'Body'
    ): PdfLayoutTextItem => native(str, x, y, width, 11, face)
    const open = (item: PdfLayoutTextItem): PdfLayoutTextItem => ({ ...item, hasEOL: false })
    const units = groupPdfTranslationPages({
      pages: [
        page(1, [
          native('AN ESTIMATE FOR FINITE REGIONS', 150, 90, 300, 14, 'Title'),
          text('MARA STONE', 262, 115, 76),
          text('We prove a bound for the distance between two nearby regions.', 57, 152, 470)
        ]),
        page(2, [
          open(native('2', 57, 43, 4)),
          native('MARA STONE', 262, 43, 76),
          text('The estimate follows from a comparison of the two adjacent sides.', 57, 67, 430)
        ]),
        page(3, [
          open(native('REFERENCES', 271, 43, 58)),
          native('3', 539 + shift, 43, 4),
          text('R', 315, 168, 8, 'Symbol'),
          text('Figure 2. Boundaries for the two adjacent finite regions.', 150, 259, 300),
          text('3. Additional distance estimates', 188, 286, 224, 'Section'),
          text(
            'We next prove a uniform distance bound for the finite regions in this construction.',
            68,
            310,
            480
          ),
          text(
            'The estimate applies whenever both boundary curves can be closely approximated.',
            57,
            324,
            460
          ),
          text('References', 268, 515, 64, 'Section'),
          ...['A. Grey.', 'J. Green.', 'D. Brown.'].flatMap((author, index) => [
            open(text(`[${index + 1}]`, 57, 535 + 14 * index, 11)),
            text(
              `${author} Notes on finite regions. Journal of Geometry (2008).`,
              78,
              535 + 14 * index,
              450
            )
          ])
        ])
      ]
    }).units
    for (const prefix of ['Figure 2.', '3. Additional distance', 'We next prove']) {
      const owner = units.find(({ source }) => source.startsWith(prefix))
      expect(owner).toBeDefined()
      expect(owner?.sourceOnly).toBe(shift ? true : undefined)
      expect(owner?.preserve).toBe(shift ? 'reference' : undefined)
    }
    for (const source of ['REFERENCES', 'R', 'References'])
      expect(units.find((owner) => owner.source === source)?.sourceOnly).toBe(true)
  }
)

test.each(['matched', 'wrong total', 'unrelated shortened title'])(
  'retains a two-page proceedings folio with its cover imprint (%s)',
  (mode) => {
    const space = (x: number, y: number): PdfLayoutTextItem => ({
      ...native(' ', x, y, 12, 8),
      height: 0
    })
    const cover = [
      native('Example Symposium (2022)', 49, 66, 100, 8),
      space(149, 66),
      native('Poster', 530, 66, 23, 8, 'Italic'),
      space(49, 76),
      native('J. Reader and R. Editor (Editors)', 49, 76, 120, 8),
      native('An Overview of Practical Signal Processing for', 130, 130, 340, 17, 'Title'),
      native('Independent Measurements on Several Instruments', 85, 150, 430, 17, 'Title'),
      native('Sam Reed', 105, 194, 61, 9, 'Body')
    ]
    const second = [
      native(mode === 'wrong total' ? '2 of 3' : '2 of 2', 49, 71, 20, 8),
      space(69, 71),
      native(
        mode === 'unrelated shortened title'
          ? 'Reed / Observations of Variable Current'
          : 'Reed / Practical Signal Processing for Field Tests',
        201,
        71,
        198,
        8,
        'Italic'
      ),
      native(
        'Independent readings were validated against the reference equipment.',
        49,
        92,
        235,
        9,
        'Body'
      )
    ]
    const pages = [cover, second].map((items, index) => ({
      page: index + 1,
      width: 600,
      height: 800,
      rotation: 0,
      items
    }))
    const { units } = groupPdfTranslationPages({ pages, pageCount: 2 })
    const owner = (key: string): (typeof units)[number] | undefined =>
      units.find(({ items }) => items.includes(key))
    for (const key of ['1:0', '1:2', '1:4', '2:0', '2:2'])
      expect(Boolean(owner(key)?.sourceOnly)).toBe(mode === 'matched')
    expect(owner('1:5')?.sourceOnly).toBeUndefined()
    expect(owner('2:3')?.sourceOnly).toBeUndefined()
  }
)

test.each([true, false])(
  'keeps mirrored native publisher footers only with sequential folios (%s)',
  (sequential) => {
    const url = 'example.org/proceedings/7'
    const publication = 'Example Proceedings'
    const pages: PdfLayoutPage[] = [1, 2, 3, 4].map((page) => {
      const folio = String(40 + page + (sequential || page !== 3 ? 0 : 2))
      const entries: [string, number, number, number?, string?][] =
        page % 2 === 0
          ? [
              [folio, 60, 11, 10, 'Body'],
              ['⋆', 73, 5, 8, 'Symbol'],
              [publication, 80, 90],
              ['⋆', 172, 5, 8, 'Symbol'],
              ['April 7, 2022', 179, 93],
              ['⋆', 274, 5, 8, 'Symbol'],
              ['vol. 7', 281, 40],
              [url, 400, 140]
            ]
          : [
              [url, 60, 140],
              [publication, 279, 90],
              ['⋆', 371, 5, 8, 'Symbol'],
              ['April 7, 2022', 378, 93],
              ['⋆', 473, 5, 8, 'Symbol'],
              ['vol. 7', 480, 40],
              ['⋆', 522, 5, 8, 'Symbol'],
              [folio, 529, 11, 10, 'Body']
            ]
      return {
        page,
        width: 600,
        height: 800,
        rotation: 0,
        items: [
          native(
            'The sample contains enough ordinary body prose to translate.',
            60,
            120,
            360,
            10,
            'Body'
          ),
          ...entries.map(([str, x, width, height = 8, fontName = 'Imprint'], n) => ({
            ...native(str, x, 770, width, height, fontName),
            hasEOL: n === entries.length - 1
          }))
        ]
      }
    })
    const { units } = groupPdfTranslationPages({ pages, pageCount: pages.length })
    const footers = units.filter((unit) => unit.source.includes(publication) || unit.source === url)
    expect(footers).toHaveLength(8)
    expect(footers.every((unit) => Boolean(unit.sourceOnly) === sequential)).toBe(true)
    expect(
      units.filter((unit) => unit.source.startsWith('The sample') && !unit.sourceOnly)
    ).toHaveLength(4)
  }
)

test.each([false, true])(
  'retains a repeated facing preprint imprint only when the native row agrees (drift=%s)',
  (drift) => {
    const pages: PdfLayoutPage[] = [1, 2, 3].map((page) => ({
      page,
      width: 600,
      height: 800,
      rotation: 0,
      items: [
        { ...native('Conference Overview', 55, 70, 65), hasEOL: false },
        { ...native(' ', 120, 70, 360, 0), hasEOL: false },
        native(
          drift && page === 3 ? 'Preprint, 2021, Archive' : 'Preprint, 2020, Archive',
          480,
          70,
          65
        ),
        ...(page === 3 ? [native('References', 55, 99, 60, 11, 'Body')] : []),
        ...Array.from({ length: 3 }, (_, n) =>
          native(
            'The survey records the measurements obtained along the southern shore.',
            55,
            115 + n * 15,
            220,
            page === 3 ? 7.5 : 10,
            'Body'
          )
        ),
        native('Conference Overview', 55, 185, 100, 12, 'Body')
      ]
    }))
    const { units } = groupPdfTranslationPages({ pages, pageCount: pages.length })
    for (const { page, items } of pages) {
      for (const index of [0, 2]) {
        expect(units.find((unit) => unit.items.includes(`${page}:${index}`))?.sourceOnly).toBe(
          drift ? undefined : true
        )
      }
      if (page < 3)
        expect(
          units.find((unit) => unit.items.includes(`${page}:${items.length - 1}`))?.sourceOnly
        ).toBeUndefined()
    }
  }
)

test.each([true, false])(
  'retains repeated proceedings and licensing rows with a common native imprint (%s)',
  (repeated) => {
    const pages: PdfLayoutPage[] = [1, 2, 3, 4].map((page) => {
      const year = repeated || page < 4 ? 2022 : 2023
      return {
        page,
        width: 600,
        height: 800,
        rotation: 0,
        items: [
          native(
            'The laboratory recorded all readings at the same marked positions.',
            55,
            240,
            330,
            10,
            'Body'
          ),
          native(
            'The next experiment uses an independent set of measurements.',
            55,
            265,
            340,
            10,
            'Body'
          ),
          { ...native('3', 56, 745, 4, 8, 'Footer'), hasEOL: false },
          { ...native('rd', 60, 742.2, 5, 6, 'Footer'), hasEOL: false },
          native(`Conference on Field Measurements (CFM ${year})`, 67, 745, 165, 8, 'Footer'),
          { ...native('©', 55.5, 754.5, 5.5, 8, 'Symbol'), hasEOL: false },
          native(`${year} A. Reader et al., licensed via CC BY 4.0.`, 63, 754.5, 150, 8, 'Footer')
        ]
      }
    })
    const { units } = groupPdfTranslationPages({ pages, pageCount: pages.length })
    const footers = units.filter(
      (unit) =>
        unit.source.includes('Conference on Field Measurements') ||
        unit.source.includes('CC BY 4.0')
    )
    expect(footers.flatMap((unit) => unit.items)).toHaveLength(20)
    expect(footers.every((unit) => Boolean(unit.sourceOnly) === repeated)).toBe(true)
    expect(
      units
        .filter((unit) => unit.source.startsWith('The laboratory'))
        .every((unit) => !unit.sourceOnly)
    ).toBe(true)
  }
)

test.each([true, false])(
  'retains the repeated unfilled publication template row (%s)',
  (repeated) => {
    const pages: PdfLayoutPage[] = [1, 2, 3].map((page) => ({
      page,
      width: 600,
      height: 800,
      rotation: 0,
      items: [
        native('North Publishing', 52, 25, 65, 9, 'Imprint'),
        native('Journal', 128, 25, 32, 10, 'Italic'),
        native('vv', 163, 25, 12, 10, 'Bold'),
        native('(yyyy) zzzzzz', 178, 25, 61, 10, 'Regular'),
        native('Author', page === 3 && !repeated ? 502 : 500, 25, 30, 10, 'Regular'),
        native('et al', 536, 25, 18, 10, 'Italic'),
        native('The recorded readings are shown in the first chart.', 128, 72, 346, 10, 'Body')
      ]
    }))
    const { units } = groupPdfTranslationPages({ pages, pageCount: pages.length })
    const margin = units.filter((unit) => unit.items.some((key) => /:[0-5]$/u.test(key)))
    expect(margin.flatMap((unit) => unit.items)).toHaveLength(18)
    expect(margin.every((unit) => Boolean(unit.sourceOnly) === repeated)).toBe(true)
    const prose = units.filter((unit) => unit.source.startsWith('The recorded readings'))
    expect(prose).toHaveLength(3)
    expect(prose.every((unit) => !unit.sourceOnly)).toBe(true)
  }
)

test.each([0, 9])(
  'accepts neighboring native fragments as one body row below complete facing headers (%s)',
  (gap) => {
    const title = 'INDEPENDENT CALIBRATION RESULTS'
    const byline = 'J. RIVER'
    const page = (n: number, items: PdfLayoutTextItem[]): PdfLayoutPage => ({
      page: n,
      width: 600,
      height: 800,
      rotation: 0,
      items
    })
    const prose =
      'The independent measurements agree with the earlier observations for all samples.'
    const pages = [
      page(1, [native(prose, 112, 190, 376, 10, 'Body')]),
      ...[2, 3, 4, 5].map((n) => {
        const even = n % 2 === 0
        const header = even ? native(byline, 278, 101, 44, 7) : native(title, 222, 101, 156, 7)
        const folio = native(String(n), even ? 112 : 484, 101, 4, 7)
        return page(n, [
          ...(even ? [folio, header] : [header, folio]),
          ...(n === 3
            ? [
                {
                  ...native('The independent measurements ', 112, 126, 133, 10, 'Body'),
                  hasEOL: false
                },
                native('agree with the previous observations.', 247 + gap, 126, 172, 10, 'Italic')
              ]
            : [native(prose, 112, 126, 376, 10, 'Body')])
        ])
      })
    ]
    const { units } = groupPdfTranslationPages({ pages })
    for (const p of pages.slice(1)) {
      const header = units.find(({ items }) => items.includes(`${p.page}:${p.page % 2 ? 0 : 1}`))
      expect(Boolean(header?.sourceOnly)).toBe(gap === 0)
      expect(units.find(({ items }) => items.includes(`${p.page}:2`))?.sourceOnly).toBeUndefined()
    }
  }
)

test.each(['complete', 'different byline', 'different cover imprint'])(
  'retains both short proceedings margins when the cover verifies them (%s)',
  (shape) => {
    const title = 'A Method for Recording Independent Field Measurements'
    const venue = 'FM Demonstrations ’21'
    const place = 'Elm City, North Region'
    const imprint = `${venue}, May 8–10, 2021, ${place}`
    const page = (n: number, items: PdfLayoutTextItem[]): PdfLayoutPage => ({
      page: n,
      width: 600,
      height: 800,
      rotation: 0,
      items
    })
    const body = (y: number): PdfLayoutTextItem[] => [
      native(
        'This paper records measurements under independent conditions.',
        55,
        y,
        240,
        10,
        'Body'
      ),
      native('The complete set was measured on each field visit.', 55, y + 12, 228, 10, 'Body'),
      native('The reference values were collected independently.', 55, y + 24, 232, 10, 'Body')
    ]
    const pages = [
      page(1, [
        native(title, 55, 96, 490, 17.5, 'Title'),
        native('Cedar Lane', 118, 119, 66, 12, 'Body'),
        ...body(205),
        native(
          `${venue}, ${shape === 'different cover imprint' ? 'Other City, North Region' : place}`,
          55,
          684,
          138,
          7.5,
          'Body'
        )
      ]),
      page(2, [
        native(imprint, 55, 72, 163),
        native(shape === 'different byline' ? 'Stone et al.' : 'Lane et al.', 504, 72, 41),
        ...body(103)
      ]),
      page(3, [native(title, 55, 72, 200), native(imprint, 382, 72, 163), ...body(103)])
    ]
    const { units } = groupPdfTranslationPages({ pages, pageCount: pages.length })
    const headers = units.filter((unit) => unit.items.some((key) => /^[23]:[01]$/u.test(key)))
    expect(headers).toHaveLength(4)
    expect(headers.filter((unit) => unit.sourceOnly)).toHaveLength(shape === 'complete' ? 4 : 0)
    expect(units.find((unit) => unit.items.includes('1:0'))?.sourceOnly).toBeUndefined()
    expect(units.some((unit) => unit.items.includes('2:2') && !unit.sourceOnly)).toBe(true)
  }
)

test.each(['verified cover', 'different author', 'different title'] as const)(
  'retains alternating proceedings margins backed by two cover bylines (%s)',
  (kind) => {
    const lead = 'Practical Patterns for Planning and Observation'
    const tail = 'in the Field'
    const venue = 'FO 2022, May 8–10, 2022, Elm City, North Region'
    const row = (n: number, items: PdfLayoutTextItem[]): PdfLayoutPage => ({
      page: n,
      width: 600,
      height: 800,
      rotation: 0,
      items
    })
    const author = (name: string, email: string, x: number): PdfLayoutTextItem[] => [
      native(name, x, 139, 68, 12, 'Author'),
      native('Sample Institute', x - 2, 151, 72, 10, 'Author'),
      native('Elm City, North Region', x - 12, 163, 92, 10, 'Author'),
      native(email, x - 8, 175, 84, 10, 'Author')
    ]
    const cover = row(1, [
      native(lead, 54, 99, 492, 17.5, 'Title'),
      native(tail, 254, 119, 92, 17.5, 'Title'),
      ...author('Ellis Reader', 'ellis@example.org', 150),
      ...author('Morgan Writer', 'morgan@example.org', 390),
      native('This paper records a sequence of independent observations.', 54, 220, 234, 10, 'Body')
    ])
    const pages = [
      cover,
      ...[2, 3, 4].map((page) => {
        const odd = page === 3
        const byline = kind === 'different author' ? 'Reader and James' : 'Reader and Writer'
        const title = kind === 'different title' ? lead + ' Outdoors' : lead + ' ' + tail
        const left = native(odd ? title : venue, 54, 69, odd ? 221 : 164)
        const right = native(odd ? venue : byline, odd ? 382 : 493, 69, odd ? 164 : 53)
        const gapStart = left.transform[4] + left.width
        return row(page, [
          left,
          native(' ', gapStart, 69, right.transform[4] - gapStart, 0),
          right,
          native(
            'This paper records a sequence of independent observations.',
            54,
            102,
            234,
            10,
            'Body'
          )
        ])
      })
    ]
    const { units } = groupPdfTranslationPages({ pages, pageCount: pages.length })
    const headers = units.filter((unit) => unit.items.some((item) => /^[234]:[02]$/u.test(item)))
    expect(headers.filter((unit) => unit.sourceOnly)).toHaveLength(
      kind === 'verified cover' ? 6 : 0
    )
    expect(units.find((unit) => unit.items.includes('1:0'))?.sourceOnly).toBeUndefined()
  }
)

test.each(['matched cover', 'unrelated byline', 'sloped label'] as const)(
  'preserves alternating proceedings labels matched to a shared cover byline (%s)',
  (shape) => {
    const shortTitle = 'Measurements in a stable environment'
    const shortAuthor = 'R. Vale and N. Green'
    const page = (number: number, items: PdfLayoutTextItem[]): PdfLayoutPage => ({
      page: number,
      width: 600,
      height: 800,
      rotation: 0,
      items
    })
    const cover = page(1, [
      native('**Volume Title**', 104, 90, 63, 9),
      native('**Copyright Year** Proceedings Publisher', 104, 120, 180, 9),
      native(`${shortTitle} - an independent study`, 136, 159, 305, 12, 'Title'),
      native('using reference conditions', 136, 172, 120, 12, 'Title'),
      native(
        shape === 'unrelated byline' ? 'Rhea Cole and Nina Green' : 'Rhea Vale and Nina Green',
        136,
        208,
        142,
        11
      )
    ])
    const inner = [2, 3, 4].map((number) => {
      const odd = number === 3
      const label = native(
        odd ? shortTitle : shortAuthor,
        odd ? 239 : 180,
        90,
        odd ? 162 : 126,
        Math.hypot(11, 1.8)
      )
      label.transform = [
        11,
        shape === 'sloped label' && odd ? 1 : 0,
        1.8,
        11,
        label.transform[4],
        710
      ]
      const folio = native(String(number), odd ? 472 : 104, 90, 5, 11)
      return page(number, [
        ...(odd ? [label, folio] : [folio, label]),
        native(
          'The methods and measurements use the same independently verified reference parameters.',
          104,
          138,
          368,
          11,
          'Body'
        ),
        native('The next sentence remains a separate part of the text.', 104, 151, 335, 11, 'Body')
      ])
    })
    const { units } = groupPdfTranslationPages({ pages: [cover, ...inner], pageCount: 4 })
    const headers = units.filter(
      (unit) => unit.source === shortTitle || unit.source === shortAuthor
    )
    expect(headers).toHaveLength(3)
    expect(headers.filter((unit) => unit.sourceOnly)).toHaveLength(
      shape === 'matched cover' ? 3 : 0
    )
    expect(
      units
        .filter((unit) => unit.source.startsWith('The methods'))
        .every((unit) => !unit.sourceOnly)
    ).toBe(true)
  }
)
