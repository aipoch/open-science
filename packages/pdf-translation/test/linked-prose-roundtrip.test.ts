import { resolve } from './paths.js'
import { expect, it, onTestFinished } from 'vitest'
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { TestCallerRegistry } from './support/callers.js'
import { PdfTranslationWriter } from '../src/writer.js'
import { extractPdfTranslationSource } from '../src/reader/extraction.js'
import { pdfTranslationLayoutFragments } from '../src/reader/fragments.js'
import type { PdfTranslationPdfRequest } from '../src/contracts.js'
import { readPdfTranslationCases } from './fixtures/read-cases.js'
import { verifyPdfUnits } from './support/pdf-translation-native-verification.js'
import { verifyPdfPreservation } from './support/pdf-translation-preservation.js'

it.each(
  readPdfTranslationCases<{
    name: string
    source: string
    translation: string
    label: string
    nativeLeading: string
    nativeTranslationPrefix: string
    nativeFitted: boolean
  }>('spacing-grave-linked-identity.jsonl')
)(
  'backfills encoded grave citations only with complete link identity: $name',
  async ({
    source: expectedSource,
    translation,
    label,
    nativeLeading,
    nativeTranslationPrefix,
    nativeFitted
  }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      page = pdf.addPage([600, 800]),
      [prefix, suffix] = expectedSource.split('`'),
      accentX = 40 + font.widthOfTextAtSize(prefix, 10)
    page.drawText(nativeLeading, { x: 40, y: 713.2, size: 10, font })
    page.drawText(prefix, { x: 40, y: 700, size: 10, font })
    page.drawText('`', { x: accentX + 0.55, y: 700.05, size: 10, font })
    page.drawText(suffix, { x: accentX, y: 700, size: 10, font })
    page.drawText('Independent neighboring paragraph.', { x: 40, y: 660, size: 10, font })
    page.node.set(
      PDFName.of('Annots'),
      pdf.context.obj(
        [label, '2037'].map((text) => {
          const x =
            40 +
            font.widthOfTextAtSize(
              expectedSource.slice(0, expectedSource.indexOf(text)).replace('`', ''),
              10
            )
          return pdf.context.register(
            pdf.context.obj({
              Type: 'Annot',
              Subtype: 'Link',
              Rect: [x, 698, x + font.widthOfTextAtSize(text.replace('`', ''), 10), 708],
              Border: [0, 0, 0],
              A: { S: 'URI', URI: PDFString.of('https://example.invalid/reference') }
            })
          )
        })
      )
    )
    const bytes = new Uint8Array(await pdf.save()),
      loading = getDocument({ data: bytes.slice(), useSystemFonts: true }),
      registry = new TestCallerRegistry()
    onTestFinished(() => loading.destroy())
    onTestFinished(() => registry.dispose())
    const original = await loading.promise,
      caller = registry.acquire({ leaseId: 'linked-grave', surface: 'electron' }),
      { source } = await extractPdfTranslationSource({
        document: original,
        resourceRequestKey: 'linked-grave',
        signal: caller.lease.signal
      })
    expect(source.units).toHaveLength(2)
    expect(source.units[0].source).toBe(nativeLeading + ' ' + expectedSource)
    const unit = {
        ...source.units[0],
        fragments: pdfTranslationLayoutFragments(source.units[0], source),
        translation: nativeTranslationPrefix + translation
      },
      result = await new PdfTranslationWriter(() =>
        resolve('resources/worker.mjs')
      ).generateDetailed(
        {
          id: 'linked-grave',
          data: bytes,
          pages: source.pages,
          preserveUnsupported: true,
          units: [unit]
        },
        caller.lease
      )
    expect(result).not.toBeNull()
    expect(result!.layoutFailures).toEqual(
      nativeFitted
        ? []
        : [
            {
              unitIndex: 0,
              code: 'annotations',
              phase: 'planning',
              pageNumbers: [1],
              fragmentCount: 1
            }
          ]
    )
    const output = getDocument({ data: result!.data.slice(), useSystemFonts: true })
    onTestFinished(() => output.destroy())
    const target = await output.promise,
      placements = await verifyPdfUnits(
        target,
        [{ ...unit, sourceIndex: 0 }],
        result!.layoutFailures,
        original
      ),
      preservation = await verifyPdfPreservation(
        original,
        target,
        [unit],
        result!.layoutFailures,
        [1]
      )
    expect(placements[0].translationFound).toBe(nativeFitted)
    expect(preservation.pages.flatMap((entry) => entry.failures)).toEqual([])
    expect(preservation.pages[0].pixels!.changedPixels).toBe(0)
    expect((await (await target.getPage(1)).getAnnotations()).map((link) => link.url)).toEqual([
      'https://example.invalid/reference',
      'https://example.invalid/reference'
    ])
  }
)

it.each(
  readPdfTranslationCases<{
    name: string
    pages: Array<{
      runs: Array<{ text: string; x: number; y: number; size: number }>
      fragment: PdfTranslationPdfRequest['units'][number]['fragments'][number]
    }>
    links: Array<{ page: number; uri: string; rect: number[] }>
    source: string
    translation: string
    neighbor: string
    expectedCode: string | null
  }>('dense-linked-cross-page-prose.jsonl')
)(
  'preserves full dense cross-page paragraphs, link actions and neighbors: $name',
  async ({ pages, links, source, translation, neighbor, expectedCode }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman)
    for (const [index, entry] of pages.entries()) {
      const page = pdf.addPage([612, 792])
      for (const run of entry.runs)
        page.drawText(run.text, { x: run.x, y: run.y, size: run.size, font })
      page.drawText(neighbor, { x: 108, y: index === 0 ? 80 : 390, size: 10, font })
      page.node.set(
        PDFName.of('Annots'),
        pdf.context.obj(
          links
            .filter((link) => link.page === index + 1)
            .map((link) =>
              pdf.context.register(
                pdf.context.obj({
                  Type: 'Annot',
                  Subtype: 'Link',
                  Rect: link.rect,
                  Border: [0, 0, 0],
                  A: { S: 'URI', URI: PDFString.of(link.uri) }
                })
              )
            )
        )
      )
    }
    expect(pages.flatMap((page) => page.runs.map((run) => run.text)).join(' ')).toBe(source)
    const bytes = new Uint8Array(await pdf.save()),
      loading = getDocument({ data: bytes.slice(), useSystemFonts: true }),
      registry = new TestCallerRegistry()
    onTestFinished(() => loading.destroy())
    onTestFinished(() => registry.dispose())
    const original = await loading.promise,
      caller = registry.acquire({ leaseId: 'dense-linked-prose', surface: 'electron' }),
      unit = { source, translation, fragments: pages.map((page) => page.fragment) },
      input = {
        id: 'dense-linked-prose',
        data: bytes,
        pages: pages.map(() => ({ width: 612, height: 792 })),
        preserveUnsupported: true,
        units: [unit]
      },
      writer = new PdfTranslationWriter(() => resolve('resources/worker.mjs')),
      result = await writer.generateDetailed(input, caller.lease)
    expect(result).not.toBeNull()
    expect(result!.layoutFailures).toEqual(
      expectedCode
        ? [
            {
              unitIndex: 0,
              code: expectedCode,
              phase: 'planning',
              pageNumbers: [1, 2],
              fragmentCount: 2
            }
          ]
        : []
    )
    const output = getDocument({ data: result!.data.slice(), useSystemFonts: true })
    onTestFinished(() => output.destroy())
    const target = await output.promise,
      placements = await verifyPdfUnits(
        target,
        [{ ...unit, sourceIndex: 0 }],
        result!.layoutFailures,
        original
      ),
      preservation = await verifyPdfPreservation(
        original,
        target,
        [unit],
        result!.layoutFailures,
        [1, 2]
      )
    expect(placements[0].translationFound).toBe(!expectedCode)
    expect(preservation.pages.flatMap((entry) => entry.failures)).toEqual([])
    expect(preservation.pages.map((entry) => entry.pixels!.changedPixels)).toEqual([0, 0])
    for (const pageNumber of [1, 2]) {
      const sourceLinks = await (await original.getPage(pageNumber)).getAnnotations(),
        targetLinks = await (await target.getPage(pageNumber)).getAnnotations()
      expect(targetLinks.map((link) => link.url).sort()).toEqual(
        sourceLinks.map((link) => link.url).sort()
      )
      if (!expectedCode) {
        const content = await (await target.getPage(pageNumber)).getTextContent(),
          prose = content.items.filter((item) => 'str' in item && /\p{Script=Han}/u.test(item.str))
        expect(prose.length).toBeGreaterThan(0)
        for (const item of prose) {
          if ('str' in item)
            expect(Math.hypot(item.transform[0], item.transform[1])).toBeGreaterThanOrEqual(8)
        }
      }
    }
    await expect(
      writer.generateDetailed(
        {
          ...input,
          units: [
            { ...unit, source: source.replace('independent observation', 'invented observation') }
          ]
        },
        caller.lease
      )
    ).rejects.toThrow('[pdf-generation:source-mismatch:2]')
  }
)

it('preserves a thin native link border through PDFium float32 serialization', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    page = pdf.addPage([600, 800])
  page.drawText('See Figure7.', { font, x: 60, y: 700, size: 10 })
  page.node.set(
    PDFName.of('Annots'),
    pdf.context.obj([
      pdf.context.register(
        pdf.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [
            60 + font.widthOfTextAtSize('See Figure', 10) - 1,
            699,
            60 + font.widthOfTextAtSize('See Figure7', 10) + 1,
            711
          ],
          Border: [0, 0, 0.1],
          A: { S: 'URI', URI: PDFString.of('https://example.invalid/reference') }
        })
      )
    ])
  )
  const bytes = await pdf.save(),
    input = getDocument({ data: bytes.slice(), useSystemFonts: true }),
    original = await input.promise,
    caller = new TestCallerRegistry().acquire({ leaseId: 'native-border' })
  onTestFinished(() => {
    caller.release()
    return input.destroy()
  })
  const result = await new PdfTranslationWriter().generateDetailed(
    {
      id: 'native-border',
      data: bytes,
      pages: [{ width: 600, height: 800 }],
      units: [
        {
          source: 'See Figure7.',
          translation: 'Consult Figure7.',
          fragments: [{ pageNumber: 1, rect: { x: 0.09, y: 0.1, width: 0.2, height: 0.05 } }]
        }
      ]
    },
    caller.lease
  )
  expect(result?.data).toBeInstanceOf(Uint8Array)
  const output = getDocument({ data: result!.data.slice(), useSystemFonts: true })
  onTestFinished(() => output.destroy())
  const translated = await output.promise,
    before = (await (await original.getPage(1)).getAnnotations())[0],
    after = (await (await translated.getPage(1)).getAnnotations())[0]
  expect(before.borderStyle.width).toBe(0.1)
  expect(after.borderStyle.width).not.toBe(before.borderStyle.width)
  expect(Math.fround(after.borderStyle.width)).toBe(Math.fround(before.borderStyle.width))
  expect(after.borderStyle).toEqual({
    ...before.borderStyle,
    width: after.borderStyle.width,
    rawWidth: after.borderStyle.rawWidth
  })
  expect(after.url).toBe(before.url)
})

it('fits linked prose with native rows closer than the initial target font size', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman),
    page = pdf.addPage([600, 800]),
    size = 6.4,
    top = 700,
    next = top - 7.7,
    x = 40,
    first = 'The collected measurements are ready for review.',
    prefix = 'See ',
    label = 'Atlas',
    suffix = ' for the final report.',
    uri = 'https://example.invalid/help',
    linkX = x + font.widthOfTextAtSize(prefix, size),
    linkRight = linkX + font.widthOfTextAtSize(label, size)
  page.drawText(first, { x, y: top, font, size })
  page.drawText(prefix, { x, y: next, font, size })
  page.drawText(label, { x: linkX, y: next, font, size })
  page.drawText(suffix, { x: linkRight, y: next, font, size })
  page.node.set(
    PDFName.of('Annots'),
    pdf.context.obj([
      pdf.context.register(
        pdf.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [linkX - 0.02, next - 1, linkRight + 0.02, next + 5.5],
          Border: [0, 0, 0],
          A: { S: 'URI', URI: PDFString.of(uri) }
        })
      )
    ])
  )
  const data = new Uint8Array(await pdf.save()),
    original = getDocument({ data: data.slice(), useSystemFonts: true }),
    registry = new TestCallerRegistry(),
    caller = registry.acquire({ leaseId: 'compact-linked-prose', surface: 'electron' }),
    unit = {
      source: `${first} ${prefix}${label}${suffix}`,
      translation: '测量数据已整理，参见 Atlas 的最终报告。',
      fragments: [
        { pageNumber: 1, rect: { x: 39 / 600, y: 90 / 800, width: 280 / 600, height: 22 / 800 } }
      ]
    }
  onTestFinished(() => original.destroy())
  onTestFinished(() => registry.dispose())
  const result = await new PdfTranslationWriter(() =>
    resolve('resources/worker.mjs')
  ).generateDetailed(
    {
      id: 'compact-linked-prose',
      data,
      pages: [{ width: 600, height: 800 }],
      units: [unit],
      preserveUnsupported: true,
      preserveUnmatched: true
    },
    caller.lease
  )
  expect(result?.layoutFailures).toEqual([])
  const output = getDocument({ data: result!.data.slice(), useSystemFonts: true })
  onTestFinished(() => output.destroy())
  const [before, target] = await Promise.all([original.promise, output.promise]),
    placement = await verifyPdfUnits(target, [{ ...unit, sourceIndex: 0 }], [], before),
    preservation = await verifyPdfPreservation(before, target, [unit], [], [1])
  expect(placement[0].translationFound).toBe(true)
  expect(preservation.pages.flatMap((entry) => entry.failures)).toEqual([])
  expect(preservation.pages[0].pixels!.changedPixels).toBe(0)
  expect((await (await target.getPage(1)).getAnnotations()).map((link) => link.url)).toEqual([uri])
})

it('fits a cross-page continuation on its three native citation rows', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman),
    width = 612,
    height = 792,
    size = 10,
    left = 51,
    headY = 144,
    tailY = 717,
    leading = 12.45,
    head = pdf.addPage([width, height]),
    tail = pdf.addPage([width, height]),
    headText = 'The instrument recorded every measurement and reported a repeatable result.',
    citations = [
      ['An independent check (', 'Sample Study Team', '2041', ') establishes the starting point.'],
      ['A separate record in ', 'Another Research Group', '2042', ' adds the baseline comparison.'],
      [
        'The established method (',
        'The Reference Collective',
        '2043',
        ') specifies the conditions.'
      ]
    ],
    destination = [head.ref, PDFName.of('XYZ'), left, headY, null]
  head.drawText(headText, { x: left, y: headY, size, font })
  for (const [index, [prefix, author, year, suffix]] of citations.entries()) {
    const y = tailY - index * leading
    let x = left
    for (const [text, linked] of [
      [prefix, false],
      [author, true],
      [' ', false],
      [year, true],
      [suffix, false]
    ] as const) {
      const advance = font.widthOfTextAtSize(text, size)
      if (text.trim()) tail.drawText(text.trimEnd(), { x, y, size, font })
      if (linked)
        tail.node.addAnnot(
          pdf.context.register(
            pdf.context.obj({
              Type: 'Annot',
              Subtype: 'Link',
              Rect: [x - 0.1, y - 3.45, x + advance + 0.1, y + 8.43],
              Border: [0, 0, 0],
              Dest: destination
            })
          )
        )
      x += advance
    }
  }

  const prose = '这里记录每次操作的结果并观察不同设置如何改变读数',
    translation = `${prose.repeat(2).slice(0, 45)}。${citations
      .map(([, author, year]) => `${author}（${year}）`)
      .join(`${prose.repeat(3).slice(0, 50)}。`)}。`,
    unit = {
      source: [
        headText,
        ...citations.map(([prefix, author, year, suffix]) => `${prefix}${author} ${year}${suffix}`)
      ].join(' '),
      translation,
      fragments: [headY, tailY].map((y, index) => ({
        pageNumber: index + 1,
        rect: {
          x: left / width,
          y: (height - y - 9.54) / height,
          width: 530 / width,
          height: (2 * leading + 12.03) / height
        }
      }))
    },
    data = await pdf.save(),
    registry = new TestCallerRegistry(),
    caller = registry.acquire({ leaseId: 'native-citation-rows', surface: 'electron' })
  onTestFinished(() => registry.dispose())
  const result = await new PdfTranslationWriter(() =>
    resolve('resources/worker.mjs')
  ).generateDetailed(
    {
      id: 'native-citation-rows',
      data,
      pages: [head, tail].map(() => ({ width, height })),
      units: [unit],
      preserveUnsupported: true
    },
    caller.lease
  )
  expect(result?.layoutFailures).toEqual([])
  const originalLoad = getDocument({ data: data.slice(), useSystemFonts: true }),
    translatedLoad = getDocument({ data: result!.data.slice(), useSystemFonts: true })
  onTestFinished(() => originalLoad.destroy())
  onTestFinished(() => translatedLoad.destroy())
  const [original, translated] = await Promise.all([originalLoad.promise, translatedLoad.promise]),
    placements = await verifyPdfUnits(translated, [{ ...unit, sourceIndex: 0 }], [], original),
    sourceLinks = await (await original.getPage(2)).getAnnotations(),
    targetLinks = await (await translated.getPage(2)).getAnnotations()
  expect(placements[0].translationFound).toBe(true)
  expect(targetLinks).toHaveLength(6)
  for (const [index, target] of targetLinks.entries()) {
    const source = sourceLinks[index]
    expect(await translated.getPageIndex(target.dest[0])).toBe(0)
    expect(target.dest.slice(1)).toEqual(source.dest.slice(1))
    expect(target.rect[1]).toBeCloseTo(source.rect[1], 3)
    expect(target.rect[3]).toBeCloseTo(source.rect[3], 3)
  }
})

it('keeps a compact figure panel on one line while moving only its linked digit', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman),
    width = 600,
    height = 800,
    left = 40,
    top = 700,
    leading = 12,
    size = 10,
    page = pdf.addPage([width, height]),
    rows = [
      'Here we report the collected measurements.',
      'Fig. 2b shows the first set of results.',
      'The second set repeats the same checks.',
      'The recordings are available for review.'
    ],
    digitX = left + font.widthOfTextAtSize('Fig. ', size),
    digitY = top - leading
  rows.forEach((text, index) =>
    page.drawText(text, { x: left, y: top - index * leading, size, font })
  )
  page.node.addAnnot(
    pdf.context.register(
      pdf.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [
          digitX - 0.02,
          digitY - 2.8,
          digitX + font.widthOfTextAtSize('2', size) + 0.55,
          digitY + 8.1
        ],
        Border: [0, 0, 0],
        Dest: [page.ref, PDFName.of('XYZ'), left, top, null]
      })
    )
  )
  const data = new Uint8Array(await pdf.save()),
    original = getDocument({ data: data.slice(), useSystemFonts: true }),
    registry = new TestCallerRegistry()
  onTestFinished(() => original.destroy())
  onTestFinished(() => registry.dispose())
  const caller = registry.acquire({ leaseId: 'linked-figure-panel', surface: 'electron' }),
    answer = await new PdfTranslationWriter(() => resolve('resources/worker.mjs')).generateDetailed(
      {
        id: 'linked-figure-panel',
        data,
        pages: [{ width, height }],
        units: [
          {
            source: rows.join(' '),
            translation:
              '实验记录整理后得到的第一组实验结果见图 2b，并再次采用相同的办法核对其余数据。完整记录可供阅览。',
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 39 / width, y: 90 / height, width: 206 / width, height: 52 / height }
              }
            ]
          }
        ],
        preserveUnsupported: true,
        preserveUnmatched: true
      },
      caller.lease
    )
  expect(answer?.layoutFailures).toEqual([])
  const output = getDocument({ data: answer!.data.slice(), useSystemFonts: true })
  onTestFinished(() => output.destroy())
  const before = await (await original.promise).getPage(1),
    after = await (await output.promise).getPage(1),
    items = (await after.getTextContent()).items,
    digit = items.find((item) => 'str' in item && item.str === '2'),
    prefix = items.find((item) => 'str' in item && item.str.trimEnd().endsWith('图')),
    suffix = items.find((item) => 'str' in item && item.str.startsWith('b，'))
  if (!digit || !prefix || !suffix || !('str' in digit && 'str' in prefix && 'str' in suffix))
    throw new Error('Missing figure panel text')
  const [oldLink] = await before.getAnnotations(),
    [newLink] = await after.getAnnotations()
  expect(Math.abs(digit.transform[5] - prefix.transform[5])).toBeLessThan(size * 0.2)
  expect(Math.abs(digit.transform[5] - suffix.transform[5])).toBeLessThan(size * 0.2)
  expect(newLink.dest).toEqual(oldLink.dest)
  expect(newLink.rect).not.toEqual(oldLink.rect)
  expect(newLink.rect[2] - newLink.rect[0]).toBeCloseTo(oldLink.rect[2] - oldLink.rect[0], 3)
  expect(newLink.rect[0]).toBeLessThanOrEqual(digit.transform[4])
  expect(newLink.rect[2]).toBeGreaterThanOrEqual(digit.transform[4] + digit.width)
  expect(newLink.rect[2]).toBeLessThan(suffix.transform[4])
})

it('moves a citation whose author period is painted in a separate text run', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman),
    width = 600,
    height = 800,
    page = pdf.addPage([width, height]),
    x = 40,
    y = 700,
    size = 10,
    prefix = 'Measurements followed a published procedure [',
    author = 'Sample et al',
    first = prefix + author,
    stopX = x + font.widthOfTextAtSize(first, size),
    year = '2040] for comparison.',
    citationLeft = x + font.widthOfTextAtSize(prefix, size),
    citationRight = stopX + font.widthOfTextAtSize('.', size) + 0.1,
    destination = [page.ref, PDFName.of('XYZ'), x, y - 40, null]
  page.drawText(first, { x, y, size, font })
  page.drawText('. ', { x: stopX, y, size, font })
  page.drawText(year, { x: stopX + font.widthOfTextAtSize('. ', size), y, size, font })
  page.node.addAnnot(
    pdf.context.register(
      pdf.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [citationLeft - 0.1, y - 2, citationRight, y + 8],
        Border: [0, 0, 0],
        Dest: destination
      })
    )
  )
  const source = first + '. ' + year,
    translation = '按已发表的方法 [Sample et al. 2040] 进行测量与比较。',
    unit = {
      source,
      translation,
      fragments: [
        {
          pageNumber: 1,
          rect: {
            x: x / width,
            y: (height - y - 8) / height,
            width: 510 / width,
            height: 11 / height
          }
        }
      ]
    },
    bytes = await pdf.save(),
    registry = new TestCallerRegistry(),
    caller = registry.acquire({ leaseId: 'split-author-period', surface: 'electron' })
  onTestFinished(() => registry.dispose())
  const result = await new PdfTranslationWriter(() =>
    resolve('resources/worker.mjs')
  ).generateDetailed(
    {
      id: 'split-author-period',
      data: bytes,
      pages: [{ width, height }],
      units: [unit],
      preserveUnsupported: true
    },
    caller.lease
  )
  expect(result?.layoutFailures).toEqual([])
  const output = getDocument({ data: result!.data.slice(), useSystemFonts: true })
  onTestFinished(() => output.destroy())
  const translated = await output.promise,
    [link] = await (await translated.getPage(1)).getAnnotations()
  expect(await translated.getPageIndex(link.dest[0])).toBe(0)
  expect(link.dest.slice(1)).toEqual([{ name: 'XYZ' }, x, y - 40, null])
  expect(link.rect[0]).not.toBeCloseTo(citationLeft, 1)
})
