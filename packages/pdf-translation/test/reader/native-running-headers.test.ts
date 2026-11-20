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

test.each(['paired folios', 'missing parity', 'stale page number', 'shifted folio'] as const)(
  'keeps a complete mirrored publication line in its original form with %s',
  (mode) => {
    const pages: PdfLayoutPage[] = [1, 2, 3, 4]
      .slice(0, mode === 'missing parity' ? 3 : 4)
      .map((page) => {
        const shift = page % 2 === 1 ? 6 : 0
        const number = mode === 'stale page number' && page === 4 ? page - 1 : page
        const folioShift = mode === 'shifted folio' && page === 4 ? 3 : 0
        return {
          page,
          width: 600,
          height: 800,
          rotation: 0,
          items: [
            { ...native('Article', 48 + shift, 38, 22), hasEOL: false },
            { ...native('Example Review', 482 + shift, 38, 47), hasEOL: false },
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
    const roleOwners = result.units.filter((unit) =>
      unit.items.some((key) => /^\d+:[012]$/u.test(key))
    )
    const labelOwners = roleOwners.filter((unit) => unit.source.includes('Article'))
    expect(labelOwners).toHaveLength(pages.length)
    expect(labelOwners.every((unit) => unit.sourceOnly === true)).toBe(mode === 'paired folios')
    if (mode === 'paired folios') expect(roleOwners.every((unit) => unit.sourceOnly)).toBe(true)
    expect(result.units.flatMap((unit) => unit.items).sort()).toEqual(
      pages.flatMap((p) => p.items.map((_, index) => `${p.page}:${index}`)).sort()
    )
  }
)

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
