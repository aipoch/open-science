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
