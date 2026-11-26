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

test.each(['matching footers', 'shifted imprint', 'folio mismatch', 'nearby prose'])(
  'requires an isolated, mirrored four-page rail for a placeholder imprint (%s)',
  (variant) => {
    const imprint = 'VOLUME, NUMBER'
    const pages: PdfLayoutPage[] = [1, 2, 3, 4].map((page) => ({
      page,
      width: 600,
      height: 800,
      rotation: 0,
      items: [
        native('This separate paragraph belongs to the report body.', 84, 470, 275, 10, 'Body'),
        ...(variant === 'nearby prose' && page === 4
          ? [native('This final sentence sits close to the footer.', 84, 718, 230, 10, 'Body')]
          : []),
        native(
          String(variant === 'folio mismatch' && page === 3 ? 8 : page),
          page % 2 === 0 ? 84 : 511,
          734,
          5,
          10,
          'Body'
        ),
        ...(page % 2 === 0
          ? [
              native(
                imprint,
                variant === 'shifted imprint' && page === 4 ? 426 : 423,
                734,
                93,
                10,
                'Body'
              )
            ]
          : [])
      ]
    }))
    const { units } = groupPdfTranslationPages({ pages, pageCount: pages.length })
    const footers = units.filter((unit) => unit.source === imprint)
    expect(footers).toHaveLength(2)
    expect(footers.map((unit) => Boolean(unit.sourceOnly))).toEqual(
      Array(2).fill(variant === 'matching footers')
    )
    expect(
      units.filter((unit) => unit.source.startsWith('This separate') && !unit.sourceOnly)
    ).toHaveLength(4)
    expect(units.flatMap((unit) => unit.items).sort()).toEqual(
      pages.flatMap(({ page, items }) => items.map((_, index) => `${page}:${index}`)).sort()
    )
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

test.each([true, false])(
  'retains a repeated submission prompt below its aligned folio (%s)',
  (matching) => {
    const prompt =
      '> REPLACE THIS LINE WITH YOUR MANUSCRIPT ID NUMBER (DOUBLE-CLICK HERE TO EDIT) <'
    const pages: PdfLayoutPage[] = [1, 2, 3].map((page) => ({
      page,
      width: 600,
      height: 800,
      rotation: 0,
      items: [
        { ...native(String(page), 552, 30, 5, 10), hasEOL: false },
        { ...native('', 49, 42, 0, 0), transform: [10, 0, 0, 10, 49, 758] },
        { ...native(prompt, !matching && page === 3 ? 51 : 49, 42, 430, 10), hasEOL: false },
        native('The independent observations appear in the first chart.', 49, 78, 308, 10, 'Body')
      ]
    }))
    const { units } = groupPdfTranslationPages({ pages, pageCount: pages.length })
    const prompts = units.filter((unit) => unit.source === prompt)
    expect(prompts).toHaveLength(3)
    expect(prompts.map(({ sourceOnly }) => Boolean(sourceOnly))).toEqual(pages.map(() => matching))
    expect(
      units
        .filter((unit) => unit.source.startsWith('The independent'))
        .every((unit) => !unit.sourceOnly)
    ).toBe(true)
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

test.each(['matching', 'mismatched title', 'wrong folio'] as const)(
  'joins the cover variable suffix only with a matching title and byline rail (%s)',
  (variant) => {
    const title = 'SHORT SURVEY OF FINITE GRID MODELS'
    const tail = '-PATTERNS'
    const headerAuthors = 'A. WELLS, E. TURNER, AND A. DAS'
    const row = (
      str: string,
      x: number,
      y: number,
      width: number,
      size: number,
      font: string,
      hasEOL = false
    ): PdfLayoutTextItem => ({ ...native(str, x, 800 - y, width, size, font), hasEOL })
    const page = (page: number, items: PdfLayoutTextItem[]): PdfLayoutPage => ({
      page,
      width: 600,
      height: 842,
      rotation: 0,
      items
    })
    const pages = [
      page(1, [
        row('', 144, 683, 0, 10, 'Title', true),
        row(title, 144, 683, 312, 10, 'Title'),
        row('', 268, 669, 0, 10, 'Variable', true),
        row('q', 268, 669, 7, 10, 'Variable'),
        row(tail, 275, 669, 57, 10, 'Title'),
        row('', 151, 639, 0, 8, 'Name', true),
        row('ANTONIA WELLS, ERIC TURNER, AND ARUN DAS', 151, 639, 298, 8, 'Name'),
        row('', 153, 612, 0, 8, 'Abstract', true),
        row('Abstract.', 153, 612, 41, 8, 'Abstract'),
        row('We compare several families of representable grids.', 199, 612, 208, 8, 'Name', true)
      ]),
      ...[2, 3, 4, 5].map((folio) =>
        page(folio, [
          ...(folio % 2 === 0
            ? [
                row(String(folio), 120, 739, 4, 7, 'Running'),
                row(headerAuthors, 222, 739, 156, 7, 'Running')
              ]
            : [
                row(title, 175, 739, 205, 7, 'Running'),
                row('q', 384, 739, 5, 7, 'RunningVariable'),
                row(
                  variant === 'mismatched title' && folio === 5 ? '-GROUPS' : tail,
                  389,
                  739,
                  36,
                  7,
                  'Running'
                ),
                row(
                  String(variant === 'wrong folio' && folio === 5 ? 8 : folio),
                  476,
                  739,
                  4,
                  7,
                  'Running'
                )
              ]),
          row('', 120, 715, 0, 10, 'Body', true),
          row(
            'The following text belongs to this page and remains editable.',
            120,
            715,
            360,
            10,
            'Body',
            true
          )
        ])
      )
    ]
    const { units } = groupPdfTranslationPages({ pages })
    const matching = variant === 'matching'
    expect(units[0].source).toBe(matching ? `${title} q${tail}` : title)
    expect(units[0].items).toEqual(matching ? ['1:1', '1:3', '1:4'] : ['1:1'])
    expect(units[0].sourceOnly).toBeUndefined()
    expect(units.flatMap((unit) => unit.items).toSorted()).toEqual(
      pages
        .flatMap(({ page, items }) =>
          items.flatMap(({ str }, index) => (str ? [`${page}:${index}`] : []))
        )
        .toSorted()
    )
    for (const key of ['2:1', '3:0', '4:1', '5:0'])
      expect(units.find((unit) => unit.items.includes(key))?.sourceOnly).toBe(
        matching ? true : undefined
      )
    for (const key of ['2:3', '3:5', '4:3', '5:5'])
      expect(units.find((unit) => unit.items.includes(key))?.sourceOnly).toBeUndefined()
  }
)

test.each(['matching', 'unrelated byline', 'different lead'] as const)(
  'joins centered title lines when paired running headers repeat the lead and initials (%s)',
  (variant) => {
    const title = 'A SHORT INVESTIGATION OF TWO BOUNDED SEQUENCES'
    const tail = 'INVOLVING SUMS OF DISTINCT TERMS'
    const centered = (
      str: string,
      y: number,
      width: number,
      height: number,
      face: string
    ): PdfLayoutTextItem => native(str, (600 - width) / 2, y, width, height, face)
    const author = 'ELENA WELLS AND MARIE-LYNN HALE'
    const initials =
      variant === 'unrelated byline' ? 'R. PIERCE AND B.-T. LIU' : 'E. WELLS AND M.-L. HALE'
    const pages: PdfLayoutPage[] = [1, 2, 3, 4, 5].map((page) => ({
      page,
      width: 600,
      height: 800,
      rotation: 0,
      items:
        page === 1
          ? [
              centered(title, 155, 340, 10, 'Title'),
              centered(tail, 169, 320, 10, 'Title'),
              native('', 0, 199, 0, 8, 'Author'),
              centered(author, 199, 120, 8, 'Author'),
              native('', 0, 225, 0, 8, 'Abstract'),
              { ...native('Abstract.', 150, 225, 42, 8, 'Abstract'), hasEOL: false },
              native(
                'This note compares bounds for independent sequences.',
                197,
                225,
                245,
                8,
                'Author'
              )
            ]
          : [
              ...(page % 2 === 0
                ? [native(String(page), 120, 103, 4, 7), centered(initials, 103, 92, 7, 'Header')]
                : [
                    centered(
                      variant === 'different lead'
                        ? 'DIFFERENT WORDS PRINTED ON BOTH ODD PAGES'
                        : title,
                      103,
                      228,
                      7,
                      'Header'
                    ),
                    native(String(page), 476, 103, 4, 7)
                  ]),
              native(
                'The ordinary article text explains how the bounds follow.',
                120,
                128,
                355,
                10,
                'Body'
              )
            ]
    }))
    const { units } = groupPdfTranslationPages({ pages })
    const match = variant === 'matching'
    expect(units[0].source).toBe(match ? `${title} ${tail}` : title)
    expect(units[0].items).toEqual(match ? ['1:0', '1:1'] : ['1:0'])
    expect(units[0].fragments).toHaveLength(match ? 2 : 1)
    expect(units[0].sourceOnly).toBeUndefined()
    expect(units.flatMap((unit) => unit.items).sort()).toEqual(
      pages
        .flatMap(({ page, items }) =>
          items.flatMap(({ str }, index) => (str ? [`${page}:${index}`] : []))
        )
        .sort()
    )
  }
)

test.each([0, 4])(
  'separates a two-page proof from the running bibliography label (folio shift %s)',
  (shift) => {
    const proof = 'The bound follows by comparing the two positive quantities.'
    const formula = 'x ≥ y + z'
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      face = 'Body'
    ): PdfLayoutTextItem => native(str, x, y, width, 10, face)
    const content = [
      [
        native('A Bound for Finite Regions', 72, 85, 190, 14, 'Section'),
        item('The first comparison establishes the preliminary bound.', 72, 120, 350),
        item('1', 297.5, 758, 5)
      ],
      [
        { ...item('REFERENCES', 72, 47, 66, 'Running'), hasEOL: false },
        item('2', 523 + shift, 47, 5),
        { ...item('Proof.', 72, 82, 26, 'Emphasis'), hasEOL: false },
        item(proof, 103, 82, 380),
        item(formula, 267, 118, 55, 'Formula'),
        item('This gives the desired bound for every finite region.', 72, 152, 355),
        native('References', 72, 401, 75, 14, 'Section'),
        ...['A. Example', 'B. Sample', 'C. Reader'].map((author, index) =>
          item(
            `[${index + 1}] ${author}, A bound in finite geometry (2008).`,
            77,
            423 + index * 20,
            350
          )
        )
      ]
    ]
    const { units } = groupPdfTranslationPages({
      pages: content.map((items, index) => ({
        page: index + 1,
        width: 600,
        height: 800,
        rotation: 0,
        items
      })),
      pageCount: 2
    })
    const owner = (key: string): (typeof units)[number] | undefined =>
      units.find((unit) => unit.items.includes(key))
    expect(owner('2:0')?.sourceOnly).toBe(true)
    expect(owner('2:1')?.sourceOnly).toBe(true)
    expect(owner('2:3')?.source).toContain(proof)
    expect(owner('2:3')?.sourceOnly).toBe(shift ? true : undefined)
    expect(owner('2:4')?.preserve).toBe(shift ? 'reference' : 'formula')
    expect(['2:6', '2:7', '2:8', '2:9'].map((key) => owner(key)?.preserve)).toEqual(
      Array(4).fill('reference')
    )
  }
)

test.each(['full', 'short', 'unrelated'] as const)(
  'checks alternating margin labels against a centered two-line cover (%s)',
  (shape) => {
    const title = 'METHODS FOR REPEATED FIELD SAMPLES'
    const ending = 'WITH PARALLEL MEASUREMENTS'
    const author = shape === 'full' ? 'ALEX SAMPLE AND SARA EXAMPLE' : 'ALEX SAMPLE'
    const authorWidth = shape === 'full' ? 112 : 64
    const authorX = 300 - authorWidth / 2
    const odd =
      shape === 'full'
        ? title + ' ' + ending
        : shape === 'short'
          ? 'METHODS FOR PARALLEL MEASUREMENTS'
          : 'METHODS FOR ALTERNATE MEASUREMENTS'
    const pages: PdfLayoutPage[] = [1, 2, 3, 4].map((page) => ({
      page,
      width: 600,
      height: 800,
      rotation: 0,
      items:
        page === 1
          ? [
              native(title, 182, 160, 236, 10, 'Title'),
              { ...native(ending, 214, 174, 172, 10, 'Title'), hasEOL: false },
              native(author, authorX, 204, authorWidth, 8, 'Author'),
              { ...native('Abstract.', 160, 232, 38, 8, 'Abstract'), hasEOL: false },
              native('We discuss a reproducible method for sampling.', 202, 232, 230, 8, 'Author')
            ]
          : [
              ...(page === 3
                ? [native(odd, 207, 100, 186, 7), native('3', 476, 100, 4, 7)]
                : [
                    native(String(page), 120, 100, 4, 7),
                    native(author, authorX, 100, authorWidth, 7)
                  ]),
              ...(page === 4
                ? [
                    native('References', 276, 126, 48, 10, 'Body'),
                    ...['[Lab18]', '[Fit19]', '[Ref20]'].map((label, at) =>
                      native(label, 120, 145 + 12 * at, 33, 8, 'Body')
                    )
                  ]
                : [
                    native(
                      'The remaining results follow from the previous independent computations.',
                      120,
                      126,
                      330,
                      10,
                      'Body'
                    )
                  ])
            ]
    }))
    const { units } = groupPdfTranslationPages({ pages, pageCount: 4 })
    for (const key of ['2:1', '3:0', '4:1'])
      expect(units.find((unit) => unit.items.includes(key))?.sourceOnly === true).toBe(
        shape !== 'unrelated'
      )
    expect(units.find((unit) => unit.items.includes('1:2'))?.sourceOnly).toBeUndefined()
    expect(units.find((unit) => unit.items.includes('2:2'))?.sourceOnly).toBeUndefined()
  }
)

test.each(['matched', 'different title'])(
  'protects three-page alternating labels when the title splits at an accent (%s)',
  (variant) => {
    const lead = 'A NOTE ON THE KO ˝'
    const tail = 'R VARIATION PRINCIPLE'
    const authors = 'MIRA SAMPLE, LEE EXAMPLE, AND JUN READER'
    const body = 'Let the regions be separated by independent boundaries.'
    const cover = [
      native(lead, 110, 145, 150, 11, 'Title'),
      native(tail, 253, 145, 253, 11, 'Title'),
      native(authors, 170, 172, 276, 9, 'Authors'),
      native('Abstract.', 104, 218, 42, 9, 'Body')
    ]
    const proof = [
      native('2', 72, 90, 4, 8),
      native(authors, 182, 90, 252, 8),
      native('Proof of Theorem 1.', 72, 110, 96, 11, 'Proof'),
      native(body, 72, 132, 350, 11, 'Body')
    ]
    const references = [
      native(lead, 171, 90, 100, 8),
      native(variant === 'matched' ? tail : 'R GEOMETRIC PRINCIPLE', 266, 90, 179, 8),
      native('3', 540, 90, 4, 8),
      native('References', 275, 110, 66, 11, 'Body'),
      ...[1, 2, 3].map((n) =>
        native(`[${n}] A. Reader, Variations of Regions, 2008.`, 72, 112 + n * 18, 270, 9, 'Body')
      )
    ]
    const { units } = groupPdfTranslationPages({
      pages: [cover, proof, references].map((items, i) => ({
        items,
        page: i + 1,
        width: 600,
        height: 800,
        rotation: 0
      })),
      pageCount: 3
    })
    const retained = (key: string): boolean =>
      units.some((unit) => unit.items.includes(key) && unit.sourceOnly)
    expect(retained('1:2')).toBe(false)
    expect(retained('2:3')).toBe(false)
    expect(['2:1', '3:0', '3:1'].map(retained)).toEqual(Array(3).fill(variant === 'matched'))
  }
)

test.each([true, false])(
  'preserves an alternating running title split across native fonts (%s)',
  (matched) => {
    const authors = 'NINA SAMPLE AND LEON READER'
    const title = (cover: boolean, y: number, label = ', m'): PdfLayoutTextItem[] => {
      const h = cover ? 10 : 7,
        font = cover ? 'Title' : 'Header'
      return [
        native('A BOUND ON SYMBOLIC REGIONS', cover ? 176 : 210, y, cover ? 205 : 141, h, font),
        native('SR', cover ? 386 : 355, y, cover ? 12 : 9, h, 'Variable'),
        native('(3', cover ? 398 : 364, y, 8, h, font),
        native(label, cover ? 406 : 372, y, cover ? 12 : 13, h, 'Variable'),
        native(')', cover ? 418 : 385, y, cover ? 6 : 5, h, font)
      ].map((item) => ({ ...item, hasEOL: false }))
    }
    const pages: PdfLayoutPage[] = Array.from({ length: 5 }, (_, n) => ({
      page: n + 1,
      width: 600,
      height: 800,
      rotation: 0,
      items:
        n === 0
          ? [
              ...title(true, 158),
              native(authors, 218, 188, 164, 8, 'Authors'),
              native('Abstract.', 160, 215, 42, 8, 'Section'),
              native(
                'The paper proves the bound using a partition of each region.',
                160,
                228,
                280,
                8,
                'Body'
              )
            ]
          : [
              ...(n % 2
                ? [native(String(n + 1), 120, 100, 4, 7), native(authors, 223, 100, 154, 7)]
                : [
                    ...title(false, 100, !matched && n === 4 ? ', n' : ', m'),
                    native(String(n + 1), 476, 100, 4, 7)
                  ]
              ).map((item) => ({ ...item, hasEOL: false })),
              native(
                'The rest of the proof follows from the estimates on each region.',
                120,
                125,
                354,
                10,
                'Body'
              )
            ]
    }))
    const { units } = groupPdfTranslationPages({ pages, pageCount: pages.length })
    const retained = (key: string): boolean =>
      units.some((unit) => unit.items.includes(key) && unit.sourceOnly)
    expect(retained('1:0')).toBe(false)
    expect(retained('2:2')).toBe(false)
    expect(['2:1', '3:0', '4:1'].map(retained)).toEqual(Array(3).fill(matched))
  }
)

test.each([true, false])(
  'joins centered title rows when the facing margins corroborate the title and author (%s)',
  (matched) => {
    const content = [
      [
        native('A BOUND ON FINITE REGIONS IMPLIES', 130, 168, 340, 12, 'Title'),
        native('STABILITY OF REGIONS', 220, 182, 160, 12, 'Title'),
        native('', 242, 212, 0, 10, 'Author'),
        native('NORA SAMPLE', 242, 212, 116, 10, 'Author'),
        native('This is an epigraph ...', 399, 253, 99, 12, 'Body')
      ],
      [
        native('2', 124, 104, 4, 9),
        native('Nora Sample', 252, 104, 96, 9),
        native('The argument continues for every region on this page.', 124, 129, 320, 12, 'Body')
      ],
      [
        native(matched ? 'Stability of regions' : 'Distribution of regions', 232, 104, 136, 9),
        native('3', 472, 104, 4, 9),
        native('REFERENCES', 250, 194, 100, 12, 'Title'),
        native('[1] S. Writer, An estimate for regions, 2008.', 124, 225, 280, 12, 'Body')
      ]
    ]
    const pages = content.map((items, index) => ({
      page: index + 1,
      width: 600,
      height: 800,
      rotation: 0,
      items
    }))
    const { units } = groupPdfTranslationPages({ pages, pageCount: pages.length })
    const owner = (key: string): (typeof units)[number] | undefined =>
      units.find((unit) => unit.items.includes(key))
    expect(owner('1:0')?.items.includes('1:1')).toBe(matched)
    expect(owner('1:3')?.sourceOnly).toBeUndefined()
    expect(owner('1:4')?.sourceOnly).toBeUndefined()
    expect(['2:1', '3:0'].map((key) => owner(key)?.sourceOnly === true)).toEqual(
      Array(2).fill(matched)
    )
  }
)

test.each([true, false])(
  'retains a journal imprint and alternating labels corroborated by the cover (%s)',
  (matched) => {
    const imprint = (y: number, suffix: string): PdfLayoutTextItem[] => [
      { ...native('F', 240, y, 6, 10), hasEOL: false },
      { ...native('IELD NOTES', 246, y, 57, 8), hasEOL: false },
      native(suffix, 303, y, 57, 10)
    ]
    const cover = [
      ...imprint(123, ', 2020:8, 5 pp.'),
      native('www.example.test', 257, 136, 86, 10, 'Website'),
      native('A New Estimate for Sample Regions', 100, 211, 400, 24),
      native('Nora Sample', 248, 246, 104, 14),
      native('Received 11 March 2020; Published 22 April 2020', 170, 270, 260, 10),
      native('We show the estimates from independent observations.', 80, 328, 330, 11, 'Body')
    ]
    const pages = [
      cover,
      ...[2, 3, 4, 5].map((page) => [
        native(page % 2 ? 'A NEW ESTIMATE FOR SAMPLE REGIONS' : 'NORA SAMPLE', 192, 98, 216, 10),
        native('The independent paragraphs record the measurements.', 80, 128, 360, 11, 'Body'),
        ...imprint(728, !matched && page === 5 ? ', 2020:7, 5pp.' : ', 2020:8, 5pp.'),
        native(String(page), 516, 728, 5, 10)
      ])
    ].map((items, index) => ({
      page: index + 1,
      width: 600,
      height: 800,
      rotation: 0,
      items
    }))
    const { units } = groupPdfTranslationPages({ pages, pageCount: pages.length })
    const preserved = (key: string): boolean =>
      units.some((unit) => unit.items.includes(key) && unit.sourceOnly === true)
    expect(['1:0', '2:0', '2:2', '3:0', '4:0', '5:0'].map(preserved)).toEqual(
      Array(6).fill(matched)
    )
    expect(preserved('1:4')).toBe(false)
    expect(preserved('2:1')).toBe(false)
  }
)

test.each([true, false])(
  'keeps a short author margin corroborated by the bibliography (%s)',
  (matched) => {
    const content = [
      [
        native('A NOTE ON MEASURED PLANAR REGIONS', 146, 101, 308, 11, 'Title'),
        native('MAYA SAMPLE', 250, 131, 100, 9, 'Author'),
        native('Abstract.', 85, 159, 44, 9, 'Abstract'),
        native(
          'The proof begins by measuring each region along the boundary.',
          85,
          176,
          360,
          11,
          'Body'
        )
      ],
      [
        native('2', 55, 44, 4, 8),
        native(matched ? 'MAYA SAMPLE' : 'IRIS READER', 253, 44, 94, 8),
        native('The argument continues by separating each region.', 55, 68, 315, 11, 'Body')
      ],
      [
        native('REFERENCES', 269, 44, 62, 8),
        native('3', 541, 44, 4, 8),
        native('References', 267, 415, 66, 11, 'Title'),
        ...[1, 2, 3].flatMap((number) => [
          native(`[${number}]`, 55, 418 + number * 17, 12, 11, 'Body'),
          native('S. Reader, Measured regions, 2005.', 72, 418 + number * 17, 280, 11, 'Body')
        ])
      ]
    ]
    const pages = content.map((items, index) => ({
      page: index + 1,
      width: 600,
      height: 800,
      rotation: 0,
      items
    }))
    const { units } = groupPdfTranslationPages({ pages, pageCount: 3 })
    expect(units.find((u) => u.items.includes('2:1'))?.sourceOnly === true).toBe(matched)
    expect(units.find((u) => u.items.includes('1:1'))?.sourceOnly).toBeUndefined()
    expect(units.find((u) => u.items.includes('2:2'))?.sourceOnly).toBeUndefined()
  }
)

test.each(['matched', 'unrelated footer'])(
  'retains a short proceedings margin pair corroborated on the cover (%s)',
  (mode) => {
    const event = 'Field Talks ’23, May 29 - June 02, 2023, Elm City'
    const front = [
      native('Signals Observed Along Two Independent Measurement Lines', 54, 100, 492, 17, 'Title'),
      native('Taylor Reed', 135, 126, 80, 12, 'Body'),
      native('Field Lab', 151, 139, 48, 10, 'Body'),
      native('Elm City', 151, 152, 48, 10, 'Body'),
      native('taylor@example.org', 120, 165, 110, 10, 'Body'),
      native('Morgan Lane', 385, 126, 80, 12, 'Body'),
      native('Field Lab', 401, 139, 48, 10, 'Body'),
      native('Ord City', 401, 152, 48, 10, 'Body'),
      native('morgan@example.org', 370, 165, 110, 10, 'Body'),
      native(mode === 'matched' ? event : event.replace('Elm City', 'Ord City'), 54, 680, 170, 7)
    ]
    const body = [
      native(event, 54, 68, 180, 7),
      { ...native(' ', 234, 68, 202, 7), height: 0 },
      native('Taylor Reed and Morgan Lane', 436, 68, 110, 7),
      native('The ordinary continuation begins on a different baseline.', 54, 108, 231, 10, 'Body')
    ]
    const pages = [front, body].map((items, index) => ({
      page: index + 1,
      width: 600,
      height: 800,
      rotation: 0,
      items
    }))
    const { units } = groupPdfTranslationPages({ pages, pageCount: 2 })
    for (const key of ['2:0', '2:2'])
      expect(Boolean(units.find(({ items }) => items.includes(key))?.sourceOnly)).toBe(
        mode === 'matched'
      )
    expect(units.find(({ items }) => items.includes('2:3'))?.sourceOnly).toBeUndefined()
  }
)

test.each([
  ['spaced', true],
  ['spaced', false],
  ['inset', true],
  ['inset', false]
] as const)(
  'joins title rows for the %s running folio (correct page number=%s)',
  (shape, matched) => {
    const inset = shape === 'inset',
      leadWidth = inset ? 312 : 404,
      headerTop = inset ? 100 : 40,
      bylineTop = inset ? 136.2 : 139,
      folio = (inset ? '' : ' ') + (matched ? '3' : '4'),
      head = 'A SHORT PROOF FOR FINITE PARTITIONS OF',
      tail = 'REGIONS IN PLANAR GRAPHS',
      authors = inset ? 'A.B. SAMPLE AND ELLA READER' : 'ALEX SAMPLE AND ELLA READER'
    const content = [
      [
        native(head, (600 - leadWidth) / 2, 95, leadWidth, 10, 'Title'),
        native(tail, 198, 109, 204, 10, 'Title'),
        native('', 220, bylineTop, 0, 8, 'Author'),
        native(authors, 220, bylineTop, 160, 8, 'Author'),
        native('', 121, 168, 0, 8, 'Abstract'),
        native('Abstract.', 121, 168, 41, 8, 'Abstract'),
        native(
          'We prove a bound for the partitions considered in this paper.',
          169,
          168,
          304,
          8,
          'Body'
        )
      ],
      [
        native('2', 85, headerTop, 4, 7),
        native(authors, 226, headerTop, 148, 7),
        native(
          'The next argument considers the remaining independent regions.',
          95,
          headerTop + 24,
          400,
          10,
          'Body'
        )
      ],
      [
        native(head + ' ' + tail + folio, 90, headerTop, 425, 7),
        native(
          'The proof continues by choosing a representative region.',
          85,
          headerTop + 24,
          401,
          10,
          'Body'
        )
      ]
    ]
    const pages = content.map((items, index) => ({
      page: index + 1,
      width: 600,
      height: 800,
      rotation: 0,
      items
    }))
    const { units } = groupPdfTranslationPages({ pages, pageCount: 3 })
    const owner = (key: string): (typeof units)[number] | undefined =>
      units.find((unit) => unit.items.includes(key))
    expect(owner('1:0')?.items.includes('1:1')).toBe(matched)
    expect(owner('2:1')?.sourceOnly === true).toBe(matched)
    expect(owner('3:0')?.sourceOnly === true).toBe(matched)
    expect(owner('1:3')?.sourceOnly).toBeUndefined()
  }
)

test.each([
  ['split title', false],
  ['split title', true],
  ['author columns', false],
  ['author columns', true]
] as const)('checks the native cover before keeping alternate margins (%s, %s)', (shape, wrong) => {
  const split = shape === 'split title'
  const title = split
    ? [
        native('Methods for', 70, 96, 92, 17, 'Title'),
        native('Longitudinal', 166, 96, 111, 17, 'Emphasis'),
        native('Measurement Studies', 281, 96, 249, 17, 'Title')
      ]
    : [
        native('Methods for Longitudinal', 70, 96, 460, 17, 'Title'),
        native('Measurement Studies', 182, 116, 236, 17, 'Title')
      ]
  const names = split ? ['Sam Abel'] : ['Sam Abel', 'Devin Oak', 'Robin Lark']
  const byline = split ? names[0] : 'Sam Abel, Devin Oak, and Robin Lark'
  const margin = split
    ? 'RSD ’32, April 20, 2032, Delta City'
    : 'RSD Forum ’32, April 20–22, 2032, Delta City'
  const authors = names.flatMap((name, n) => {
    const center = split ? 300 : 120 + n * 180
    const y = split ? 120 : 140
    return [
      native(name, center - 35, y, 70, 12, 'Author'),
      native('Field Research Institute', center - 51, y + 12, 102, 10, 'Author'),
      native('Delta City', center - 24, y + 24, 48, 10, 'Author'),
      native(`research${n}@example.test`, center - 45, y + 36, 90, 10, 'Author')
    ]
  })
  const unit = (page: number, items: PdfLayoutTextItem[]): PdfLayoutPage => ({
    page,
    width: 600,
    height: 800,
    rotation: 0,
    items
  })
  const row = (page: number): PdfLayoutTextItem[] => {
    const event = (x: number): PdfLayoutTextItem => native(margin, x, 68, 160, 7)
    const peerName = wrong && page === 4 ? 'Morgan Bluff' : byline
    const peer = native(peerName, split ? 505 : 250, 68, split ? 43 : 298, 7)
    const rests = split
      ? [
          native('Methods for', 52, 68, 46, 7),
          native('Longitudinal', 100, 68, 52, 7, 'Italic'),
          native('Measurement Studies', 154, 68, 93, 7)
        ]
      : [native(title.map((item) => item.str).join(' '), 52, 68, 238, 7)]
    const ink = page % 2 === 0 ? [event(52), peer] : [...rests, event(388)]
    return ink.flatMap((item, index) => {
      const next = ink[index + 1]
      const end = item.transform[4] + item.width
      return next ? [item, native(' ', end, 68, next.transform[4] - end, 0, item.fontName)] : [item]
    })
  }
  const body = native('The native body begins below the margin.', 52, 104, 237, 10, 'Body')
  const cover = unit(1, [
    ...title,
    ...authors,
    native('ABSTRACT', 52, 225, 65, 10, 'Body'),
    { ...body, transform: [10, 0, 0, 10, 52, 552] },
    native(margin, 52, 685, 155, 7, 'Imprint')
  ])
  const tailPages = Array.from({ length: split ? 3 : 4 }, (_, n) =>
    unit(n + 2, [...row(n + 2), body])
  )
  const pages = [cover, ...tailPages]
  const { units } = groupPdfTranslationPages({ pages, pageCount: pages.length })
  for (const page of tailPages) {
    const target = units.find((owner) => owner.items.includes(`${page.page}:0`))
    expect(target?.sourceOnly).toBe(wrong ? undefined : true)
    expect(
      units.find((owner) => owner.items.includes(`${page.page}:${page.items.length - 1}`))
        ?.sourceOnly
    ).toBeUndefined()
  }
})

test.each([true, false])(
  'retains repeated facing headers only when the detached title accent also repeats (%s)',
  (matched) => {
    const lead = 'A NOTE ON KU '
    const tail = 'LNER-TYPE BOUNDS FOR FINITE REGIONS'
    const author = 'MIRA READER'
    const body = native('The proof considers each region in turn.', 60, 65, 250, 11, 'Body')
    const cover = [
      native(lead + '˝', 90, 92, 60, 11, 'Title'),
      native(tail, 142, 92, 368, 11, 'Title'),
      native(author, 240, 126, 120, 9, 'Author'),
      native('Abstract.', 60, 179, 49, 9, 'Section'),
      native('We give a bound for ordered collections.', 60, 191, 250, 9, 'Body')
    ]
    const margins = [2, 3, 4, 5].map((page) =>
      page % 2 === 0
        ? [native(String(page), 60, 38, 4, 8), native(author, 240, 38, 120, 8), body]
        : [
            native(lead, 155, 38, 36, 8),
            native('˝', !matched && page === 5 ? 193 : 191, 36, 4, 8),
            native(tail, 190, 38, 255, 8),
            native(String(page), 536, 38, 4, 8),
            body
          ]
    )
    const pages: PdfLayoutPage[] = [cover, ...margins].map((items, i) => ({
      page: i + 1,
      width: 600,
      height: 800,
      rotation: 0,
      items: items.map((item, at) => ({ ...item, hasEOL: at === items.length - 1 }))
    }))
    const { units } = groupPdfTranslationPages({ pages, pageCount: pages.length })
    const retained = (key: string): boolean =>
      units.some((unit) => unit.sourceOnly && unit.items.includes(key))
    const labels = ['2:1', '3:0', '3:1', '3:2', '4:1', '5:0', '5:1', '5:2']
    expect(labels.map(retained)).toEqual(Array(labels.length).fill(matched))
    expect(['1:0', '1:1', '2:2', '3:4', '4:2', '5:4'].some(retained)).toBe(false)
  }
)

test.each([
  { pageCount: 4, shift: 0, expected: true },
  { pageCount: 4, shift: 4, expected: undefined },
  { pageCount: 5, shift: 0, expected: true },
  { pageCount: 5, shift: 4, expected: true }
])(
  'protects offset running labels over $pageCount pages at cover shift $shift',
  ({ pageCount, shift, expected }) => {
    const title = 'INDEPENDENT COUNTS FOR FINITE PARTITIONS'
    const byline = 'MIRA READER AND ORIN SAMPLE'
    const cover = [
      native(title, 160 + shift, 151, 294, 10, 'Title'),
      native(byline, 225 + shift, 181, 164, 8, 'Byline'),
      native('Abstract.', 112, 207, 40, 8, 'Abstract'),
      native('The same comparison applies across all partitions.', 112, 219, 278, 8, 'Body')
    ]
    const inner = [2, 3, 4, 5].slice(0, pageCount - 1).map((page) => {
      const even = page % 2 === 0
      const label = even ? native(byline, 229, 103, 156, 7) : native(title, 202, 103, 210, 7)
      const folio = native(String(page), even ? 75 : 535, 103, 4, 7)
      return [
        ...(even ? [folio, label] : [label, folio]),
        native(
          'These independent measurements agree with all previously reported results.',
          75,
          130,
          445,
          10,
          'Body'
        )
      ]
    })
    const pages = [cover, ...inner].map((items, n) => ({
      page: n + 1,
      width: 600,
      height: 800,
      rotation: 0,
      items
    }))
    const { units } = groupPdfTranslationPages({ pages, pageCount: pages.length })
    expect(units.find((unit) => unit.items.includes('1:0'))?.sourceOnly).toBeUndefined()
    for (let page = 2; page <= pageCount; page++) {
      const key = `${page}:${page % 2 === 0 ? 1 : 0}`
      expect(units.find((unit) => unit.items.includes(key))?.sourceOnly).toBe(expected)
    }
  }
)

test.each([true, false])(
  'preserves alternating running titles with a matching Greek glyph (%s)',
  (matches) => {
    const title = 'AN INDEPENDENT RESULT IS NOT'
    const cover = [
      native(title + ' GAMMA-STABLE', 133, 137, 346, 11, 'Title'),
      native('MIRA REED', 256, 166, 100, 9, 'Author'),
      native('Abstract.', 140, 198, 45, 9, 'Label')
    ]
    const inner = [2, 3, 4, 5].map((page) => {
      const isEven = page % 2 === 0
      const folio = native(String(page), isEven ? 72 : 536, 80, 4, 8)
      const label = isEven
        ? [native('M. REED', 276, 80, 60, 8)]
        : [
            native(title, 192, 80, 160, 8),
            native(matches || page === 3 ? 'γ' : 'β', 356, 80, 4, 8, 'Greek'),
            native('-STABLE', 361, 80, 59, 8)
          ]
      return [
        ...(isEven ? [folio, ...label] : [...label, folio]),
        native(
          'An independent calculation verifies the primary result in each case.',
          72,
          105,
          468,
          11,
          'Body'
        )
      ]
    })
    const pages = [cover, ...inner].map((items, i) => ({
      page: i + 1,
      width: 612,
      height: 800,
      rotation: 0,
      items
    }))
    const { units } = groupPdfTranslationPages({ pages, pageCount: pages.length })
    for (const key of ['2:1', '3:0', '4:1', '5:0']) {
      expect(units.find((unit) => unit.items.includes(key))?.sourceOnly === true).toBe(matches)
    }
    expect(units.find((unit) => unit.items.includes('1:0'))?.sourceOnly).toBeUndefined()
  }
)

test.each(['complete', 'different cover imprint', 'different peer', 'crowded margin'] as const)(
  'keeps repeated facing submission labels only with a native cover and empty gutter (%s)',
  (shape) => {
    const label = 'Submitted to QX FORUM ’28'
    const city = 'Elm City'
    const imprint = `${label}, April 3–5, 2028, ${city}`
    const page = (number: number, items: PdfLayoutTextItem[]): PdfLayoutPage => ({
      page: number,
      width: 600,
      height: 800,
      rotation: 0,
      items
    })
    const cover = page(1, [
      native('A Guide to Measuring Native', 95, 94, 410, 17, 'Title'),
      native('Signals Under Independent Conditions', 78, 114, 444, 17, 'Title'),
      native('Avery Reed', 92, 139, 79, 12, 'Author'),
      native('Robin Lane', 264, 139, 72, 12, 'Author'),
      native('Morgan Holt', 420, 139, 78, 12, 'Author'),
      native('Abstract', 50, 224, 50, 11, 'Body'),
      native(
        `${label}, ${shape === 'different cover imprint' ? 'Bay City' : city}`,
        50,
        690,
        125,
        7
      )
    ])
    const interior = Array.from({ length: 6 }, (_, index) => {
      const even = index % 2 === 0
      const left = native(even ? imprint : 'Native Signals', 50, 68, even ? 190 : 60, 7)
      const right = native(
        even
          ? shape === 'different peer' && index === 4
            ? 'Reed, Shaw, Holt'
            : 'Reed, Lane, Holt'
          : imprint,
        even ? 465 : 360,
        68,
        even ? 85 : 190,
        7
      )
      const gap = native(' ', left.transform[4] + left.width, 68, 30, 0)
      const body = native(
        'The native body begins on an independent baseline below the margin.',
        50,
        shape === 'crowded margin' && index === 3 ? 85 : 105,
        230,
        10,
        'Body'
      )
      return page(index + 2, [left, gap, right, body])
    })
    const pages = [cover, ...interior]
    const { units } = groupPdfTranslationPages({ pages, pageCount: pages.length })
    const owner = (key: string): (typeof units)[number] | undefined =>
      units.find((unit) => unit.items.includes(key))
    for (const { page: number } of interior) {
      expect(Boolean(owner(`${number}:0`)?.sourceOnly)).toBe(shape === 'complete')
      expect(Boolean(owner(`${number}:2`)?.sourceOnly)).toBe(shape === 'complete')
      expect(owner(`${number}:3`)?.sourceOnly).toBeUndefined()
    }
    expect(owner('1:0')?.sourceOnly).toBeUndefined()
  }
)
