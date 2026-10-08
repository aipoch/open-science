import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PdfTranslationWriter } from './writer'
import { ApplicationCallerLeaseRegistry } from '../../caller-lifecycle'

it.each([
  'separate-row',
  'small-type',
  'partial-url',
  'empty-anchor',
  'changed-url',
  'changed-source',
  'too-long'
])('reflows only a whole native full-size URI row: %s', async (kind) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    page = pdf.addPage([300, 200]),
    uri = 'https://example.org/data/17',
    label = kind === 'partial-url' ? 'example.org/data/17' : uri,
    size = kind === 'small-type' ? 6 : 8,
    width = font.widthOfTextAtSize(label, size),
    registry = new ApplicationCallerLeaseRegistry(),
    caller = registry.acquire({ leaseId: 'native-url-row', surface: 'electron' })
  page.drawText('Estimates in the overall study population.', { font, x: 40, y: 150, size: 8 })
  page.drawText(label, { font, x: 40, y: 132, size })
  page.drawText('Neighbor 17', { font, x: 40, y: 112, size: 8 })
  page.node.set(
    PDFName.of('Annots'),
    pdf.context.obj([
      pdf.context.register(
        pdf.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: kind === 'empty-anchor' ? [240, 130, 250, 140] : [40, 130, 40 + width, 132 + size],
          Border: [0, 0, 0],
          A: { S: 'URI', URI: PDFString.of(uri) }
        })
      )
    ])
  )
  const source =
      (kind === 'changed-source' ? 'Changed' : 'Estimates') +
      ' in the overall study population. ' +
      label,
    translation =
      (kind === 'too-long'
        ? '总体研究人群中的评估结果。'.repeat(6)
        : '总体研究人群中的无病生存期变化及主要结果估计。') +
      (kind === 'changed-url' ? uri.replace('/17', '/18') : label),
    writer = new PdfTranslationWriter(() => resolve('resources/pdf-translation/worker.mjs'))
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const output = writer.generate(
      {
        id: 'native-url-row',
        data: await pdf.save(),
        pages: [{ width: 300, height: 200 }],
        units: [
          {
            source,
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 39 / 300, y: 44 / 200, width: 212 / 300, height: 26 / 200 }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    if (kind !== 'separate-row') {
      await expect(output).rejects.toMatchObject({
        failure: {
          code: ['changed-url', 'empty-anchor'].includes(kind)
            ? 'annotations'
            : kind === 'changed-source'
              ? 'source-mismatch'
              : 'overflow'
        }
      })
      return
    }
    task = getDocument({ data: (await output)!, useSystemFonts: true })
    const movedPage = await (await task.promise).getPage(1),
      items = (await movedPage.getTextContent()).items.filter((item) => 'str' in item),
      links = await movedPage.getAnnotations(),
      caption = items.filter((item) => item.transform[5] > 125)
    expect(
      caption
        .map((item) => item.str)
        .join('')
        .replace(/\s/gu, '')
    ).toBe(translation)
    expect(items.find((item) => item.str === 'Neighbor 17')?.transform.slice(4)).toEqual([40, 112])
    expect(links).toHaveLength(1)
    expect(links[0].url).toBe(uri)
    expect(links[0].rect[2] - links[0].rect[0]).toBeCloseTo(width, 3)
    expect(links[0].rect[3] - links[0].rect[1]).toBeCloseTo(10, 3)
    const url = caption.find((item) => item.str === uri)!
    expect(url).toBeDefined()
    expect(url.height).toBe(8)
    expect(url.transform[5]).toBeGreaterThanOrEqual(130)
    expect(links[0].rect[1]).toBeGreaterThanOrEqual(130)
    expect(links[0].rect[3]).toBeLessThanOrEqual(156)
  } finally {
    await task?.destroy()
    caller.release()
    registry.dispose()
  }
})

it('keeps a same-size URL raised beside ordinary prose on its original baseline', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    page = pdf.addPage([300, 200]),
    uri = 'https://example.org/data/17',
    width = font.widthOfTextAtSize(uri, 8),
    registry = new ApplicationCallerLeaseRegistry(),
    caller = registry.acquire({ leaseId: 'raised-native-url', surface: 'electron' })
  page.drawText('Results.', { font, x: 40, y: 150, size: 8 })
  page.drawText(uri, { font, x: 80, y: 154, size: 8 })
  page.node.set(
    PDFName.of('Annots'),
    pdf.context.obj([
      pdf.context.register(
        pdf.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [80, 152, 80 + width, 162],
          Border: [0, 0, 0],
          A: { S: 'URI', URI: PDFString.of(uri) }
        })
      )
    ])
  )
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const writer = new PdfTranslationWriter(() => resolve('resources/pdf-translation/worker.mjs')),
      output = await writer.generate(
        {
          id: 'raised-native-url',
          data: await pdf.save(),
          pages: [{ width: 300, height: 200 }],
          units: [
            {
              source: 'Results. ' + uri,
              translation: '结果。' + uri,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 39 / 300, y: 37 / 200, width: 242 / 300, height: 16 / 200 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
    task = getDocument({ data: output!, useSystemFonts: true })
    const movedPage = await (await task.promise).getPage(1),
      items = (await movedPage.getTextContent()).items.filter((item) => 'str' in item),
      links = await movedPage.getAnnotations()
    expect(items.find((item) => item.str === uri)?.transform.slice(4)).toEqual([80, 154])
    expect(items.find((item) => item.str === '结果。')?.transform[5]).toBe(150)
    expect(links[0].rect).toEqual([80, 152, 80 + width, 162])
    expect(links[0].url).toBe(uri)
  } finally {
    await task?.destroy()
    caller.release()
    registry.dispose()
  }
})

it.each(['same-uri', 'changed-uri', 'partial-visible-uri', 'small-suffix', 'raised-suffix'])(
  'keeps only a complete unchanged URI split across proven native rows flowable: %s',
  async (kind) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([300, 200]),
      prefix = 'https://example.invalid/item.',
      suffix = 'data.0000001',
      uri = prefix + suffix,
      visiblePrefix = kind === 'partial-visible-uri' ? prefix.slice(8) : prefix,
      size = kind === 'small-suffix' ? 6 : 8,
      y = kind === 'raised-suffix' ? 154 : 138,
      registry = new ApplicationCallerLeaseRegistry(),
      caller = registry.acquire({ leaseId: 'split-native-uri-row', surface: 'electron' })
    page.drawText('Results: ', { font, x: 40, y: 150, size: 8 })
    page.drawText(visiblePrefix, { font, x: 74, y: 150, size: 8 })
    page.drawText(suffix, { font, x: 40, y, size })
    page.drawText('Neighbor 17', { font, x: 40, y: 115, size: 8 })
    page.node.set(
      PDFName.of('Annots'),
      pdf.context.obj(
        [
          [74, 148, 74 + font.widthOfTextAtSize(visiblePrefix, 8), 158],
          [40, y - 2, 40 + font.widthOfTextAtSize(suffix, size), y + size]
        ].map((rect) =>
          pdf.context.register(
            pdf.context.obj({
              Type: 'Annot',
              Subtype: 'Link',
              Rect: rect,
              Border: [0, 0, 0],
              A: { S: 'URI', URI: PDFString.of(uri) }
            })
          )
        )
      )
    )
    const translation =
        '研究结果：' +
        visiblePrefix +
        (kind === 'changed-uri' ? suffix.replace('0000001', '0000002') : suffix),
      writer = new PdfTranslationWriter(() => resolve('resources/pdf-translation/worker.mjs'))
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const output = writer.generate(
        {
          id: 'split-native-uri-row',
          data: await pdf.save(),
          pages: [{ width: 300, height: 200 }],
          units: [
            {
              source: 'Results: ' + visiblePrefix + ' ' + suffix,
              translation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 39 / 300, y: 40 / 200, width: 157 / 300, height: 26 / 200 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      if (kind !== 'same-uri') {
        await expect(output).rejects.toMatchObject({
          failure: {
            code: ['changed-uri', 'raised-suffix'].includes(kind) ? 'annotations' : 'overflow'
          }
        })
        return
      }
      task = getDocument({ data: (await output)!, useSystemFonts: true })
      const movedPage = await (await task.promise).getPage(1),
        items = (await movedPage.getTextContent()).items.filter((item) => 'str' in item),
        links = await movedPage.getAnnotations()
      expect(
        items
          .filter((item) => item.transform[5] > 130)
          .map((item) => item.str)
          .join('')
          .replace(/\s/gu, '')
      ).toBe(translation)
      expect(links).toHaveLength(2)
      for (const [index, link] of links.entries()) {
        expect(link.url).toBe(uri)
        expect(link.rect[2] - link.rect[0]).toBeCloseTo(
          font.widthOfTextAtSize(index ? suffix : prefix, 8),
          3
        )
        expect(link.rect[1]).toBeGreaterThanOrEqual(134)
        expect(link.rect[3]).toBeLessThanOrEqual(160)
      }
      for (const label of [prefix, suffix]) {
        expect(items.find((item) => item.str === label)?.height).toBe(8)
      }
      expect(items.find((item) => item.str === 'Neighbor 17')?.transform.slice(4)).toEqual([
        40, 115
      ])
    } finally {
      await task?.destroy()
      caller.release()
      registry.dispose()
    }
  }
)

it.each(['padded', 'changed-uri', 'partial-label', 'wide-padding', 'narrow-region'])(
  'fits only a complete standalone URI with original click padding: %s',
  async (kind) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([300, 200]),
      uri = 'https://example.org/data/17',
      label = kind === 'partial-label' ? uri.slice(8) : uri,
      width = font.widthOfTextAtSize(label, 8),
      padding = kind === 'wide-padding' ? 3 : 1,
      registry = new ApplicationCallerLeaseRegistry(),
      caller = registry.acquire({ leaseId: 'padded-native-uri-row', surface: 'electron' })
    page.drawText('Results:', { font, x: 40, y: 150, size: 8 })
    page.drawText(label, { font, x: 40, y: 132, size: 8 })
    page.drawText('Neighbor 17', { font, x: 40, y: 112, size: 8 })
    page.node.set(
      PDFName.of('Annots'),
      pdf.context.obj([
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [40 - padding, 130, 40 + width + padding, 140],
            Border: [0, 0, 0],
            A: { S: 'URI', URI: PDFString.of(uri) }
          })
        )
      ])
    )
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const writer = new PdfTranslationWriter(() =>
          resolve('resources/pdf-translation/worker.mjs')
        ),
        translation = '结果：' + (kind === 'changed-uri' ? uri.replace('/17', '/18') : label),
        output = writer.generate(
          {
            id: 'padded-native-uri-row',
            data: await pdf.save(),
            pages: [{ width: 300, height: 200 }],
            units: [
              {
                source: 'Results: ' + label,
                translation,
                fragments: [
                  {
                    pageNumber: 1,
                    rect: {
                      x: 40 / 300,
                      y: 44 / 200,
                      width: (width + (kind === 'narrow-region' ? -2 : 0.1)) / 300,
                      height: 26 / 200
                    }
                  }
                ]
              }
            ]
          },
          caller.lease
        )
      if (kind !== 'padded') {
        await expect(output).rejects.toBeDefined()
        return
      }
      task = getDocument({ data: (await output)!, useSystemFonts: true })
      const movedPage = await (await task.promise).getPage(1),
        items = (await movedPage.getTextContent()).items.filter((item) => 'str' in item),
        links = await movedPage.getAnnotations()
      expect(
        items
          .filter((item) => item.transform[5] > 125)
          .map((item) => item.str)
          .join('')
          .replace(/\s/gu, '')
      ).toBe(translation)
      const nativeUrl = items.find((item) => item.str === uri)!
      expect(nativeUrl.height).toBe(8)
      expect(nativeUrl.transform[4]).toBe(40)
      expect(links[0].url).toBe(uri)
      expect(links[0].rect[0]).toBe(39)
      expect(links[0].rect[2]).toBeCloseTo(41 + width, 3)
      expect(items.find((item) => item.str === 'Neighbor 17')?.transform.slice(4)).toEqual([
        40, 112
      ])
    } finally {
      await task?.destroy()
      caller.release()
      registry.dispose()
    }
  }
)

it.each(['single', 'multiple', 'tight', 'above-neighbor', 'below-neighbor'])(
  'reserves original citation hit area when positioning the first translated row: %s',
  async (kind) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([300, 200]),
      registry = new ApplicationCallerLeaseRegistry(),
      caller = registry.acquire({ leaseId: 'first-row-citation-box', surface: 'electron' })
    page.drawText('Background.', { font, x: 40, y: 150, size: 8 })
    page.drawText('Smith', { font, x: 40, y: 138, size: 8 })
    page.drawText(' results.', { font, x: 60.448, y: 138, size: 8 })
    if (kind === 'multiple') page.drawText('More.', { font, x: 40, y: 116, size: 8 })
    if (kind === 'above-neighbor') page.drawText('Neighbor above', { font, x: 40, y: 160, size: 8 })
    page.drawText('Neighbor 17', { font, x: 40, y: 100, size: 8 })
    const originalRect = [
      39,
      kind === 'below-neighbor' ? 98 : 136,
      61.448,
      kind === 'above-neighbor' ? 168 : kind === 'tight' ? 146.5 : 148
    ]
    page.node.set(
      PDFName.of('Annots'),
      pdf.context.obj([
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: originalRect,
            Border: [0, 0, 0],
            A: { S: 'URI', URI: PDFString.of('https://example.org/reference') }
          })
        )
      ])
    )
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const writer = new PdfTranslationWriter(() =>
          resolve('resources/pdf-translation/worker.mjs')
        ),
        translation =
          (kind === 'tight' ? 'Smith结果。' : '背景Smith结果。') +
          (kind === 'multiple' ? '更多。' : ''),
        output = writer.generate(
          {
            id: 'first-row-citation-box',
            preserveUnsupported: kind === 'above-neighbor' || kind === 'below-neighbor',
            data: await pdf.save(),
            pages: [{ width: 300, height: 200 }],
            units: [
              {
                source:
                  (kind === 'tight' ? 'Smith results.' : 'Background. Smith results.') +
                  (kind === 'multiple' ? ' More.' : ''),
                translation,
                fragments: [
                  {
                    pageNumber: 1,
                    rect: {
                      x: 40 / 300,
                      y: (kind === 'tight' ? 55 : 46) / 200,
                      width: 120 / 300,
                      height: (kind === 'tight' ? 9 : 20) / 200
                    }
                  },
                  ...(kind === 'multiple'
                    ? [
                        {
                          pageNumber: 1,
                          rect: { x: 40 / 300, y: 77 / 200, width: 120 / 300, height: 12 / 200 }
                        }
                      ]
                    : [])
                ]
              }
            ]
          },
          caller.lease
        )
      task = getDocument({ data: (await output)!, useSystemFonts: true })
      const movedPage = await (await task.promise).getPage(1),
        items = (await movedPage.getTextContent()).items.filter((item) => 'str' in item),
        links = await movedPage.getAnnotations()
      if (kind === 'above-neighbor' || kind === 'below-neighbor') {
        expect(
          items
            .filter((item) => item.transform[5] > 133 && item.transform[5] < 155)
            .map((item) => item.str)
            .join('')
            .replace(/\s/gu, '')
        ).toBe('Background.Smithresults.')
        expect(links).toHaveLength(1)
        expect(links[0].url).toBe('https://example.org/reference')
        for (const [index, value] of originalRect.entries())
          expect(links[0].rect[index]).toBeCloseTo(value, 3)
        expect(items.find((item) => item.str === 'Neighbor 17')?.transform.slice(4)).toEqual([
          40, 100
        ])
        if (kind === 'above-neighbor')
          expect(items.find((item) => item.str === 'Neighbor above')?.transform.slice(4)).toEqual([
            40, 160
          ])
        return
      }
      expect(
        items
          .filter(
            (item) => item.transform[5] > 110 && (kind !== 'tight' || item.str !== 'Background.')
          )
          .map((item) => item.str)
          .join('')
          .replace(/\s/gu, '')
      ).toBe(translation)
      expect(links).toHaveLength(1)
      expect(links[0].url).toBe('https://example.org/reference')
      expect(links[0].rect[3] - links[0].rect[1]).toBeCloseTo(kind === 'tight' ? 10.5 : 12, 3)
      expect(links[0].rect[1]).toBeGreaterThanOrEqual(134)
      expect(links[0].rect[3]).toBeLessThanOrEqual(kind === 'tight' ? 147 : 154)
      if (kind === 'tight') {
        expect(items.find((item) => item.str === 'Background.')?.transform.slice(4)).toEqual([
          40, 150
        ])
        // Glyphs fit the nine-point row while the original click padding uses
        // the existing two-point tolerance. Do not shift a successful fit.
        expect(items.find((item) => item.str === 'Smith')?.transform[5]).toBeGreaterThan(136.5)
      }
      expect(items.find((item) => item.str === 'Smith')?.height).toBe(8)
      expect(items.find((item) => item.str === 'Neighbor 17')?.transform.slice(4)).toEqual([
        40, 100
      ])
    } finally {
      await task?.destroy()
      caller.release()
      registry.dispose()
    }
  }
)

it.each([
  'complete',
  'too-narrow',
  'tiny',
  'mixed-size',
  'changed-uri',
  'partial-uri',
  'raised-row'
])('reflows a complete smaller native URI across its proven rows: %s', async (kind) => {
  const pdf = await PDFDocument.create(),
    body = await pdf.embedFont(StandardFonts.Helvetica),
    mono = await pdf.embedFont(StandardFonts.Courier),
    page = pdf.addPage([300, 250]),
    uri = 'https://example.invalid/synthetic/code/tree/main/models/sample/encoderx001',
    labels = ['https:', '//example.invalid/synthetic/code/', 'tree/main/models/sample/encoderx001'],
    registry = new ApplicationCallerLeaseRegistry(),
    caller = registry.acquire({ leaseId: 'wrapped-smaller-uri', surface: 'electron' })
  page.drawText('Background results in the population.', {
    font: body,
    x: 40,
    y: 190,
    size: 10
  })
  page.drawText('Data at ', { font: body, x: 40, y: 178, size: 10 })
  const rows = labels.map((label, index) => {
    const size = kind === 'tiny' ? 6 : kind === 'mixed-size' && index === 1 ? 8 : 9,
      x = index ? 40 : 78,
      y = 178 - index * (kind === 'raised-row' ? 3 : 12),
      width = mono.widthOfTextAtSize(label, size)
    page.drawText(label, { font: mono, x, y, size })
    return { label, size, x, y, width }
  })
  page.drawText('.', { font: body, x: rows[2].x + rows[2].width + 1, y: rows[2].y, size: 10 })
  page.drawText('Neighbor 17', { font: body, x: 40, y: 125, size: 10 })
  page.node.set(
    PDFName.of('Annots'),
    pdf.context.obj(
      rows.map((row) =>
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [row.x - 1, row.y - 2, row.x + row.width + 1, row.y + row.size],
            Border: [0, 0, 0],
            A: { S: 'URI', URI: PDFString.of(uri) }
          })
        )
      )
    )
  )
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const writer = new PdfTranslationWriter(() => resolve('resources/pdf-translation/worker.mjs')),
      source = 'Background results in the population. Data at ' + labels.join(' ') + '.',
      translation =
        '总体研究人群中的主要结果与背景说明。数据位于 ' +
        (kind === 'partial-uri'
          ? labels.slice(0, 2)
          : kind === 'changed-uri'
            ? labels.map((label) => label.replace('example.invalid', 'changed.invalid'))
            : labels
        ).join(' ') +
        '。',
      result = writer.generate(
        {
          id: 'wrapped-smaller-uri',
          data: await pdf.save(),
          pages: [{ width: 300, height: 250 }],
          units: [
            {
              source,
              translation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: {
                    x: 39 / 300,
                    y: 49 / 250,
                    width:
                      (mono.widthOfTextAtSize(labels[2], 9) +
                        10 -
                        (kind === 'too-narrow' ? 0.001 : 0)) /
                      300,
                    height: 49 / 250
                  }
                }
              ]
            }
          ]
        },
        caller.lease
      )
    if (kind === 'too-narrow') {
      await expect(result).rejects.toMatchObject({ failure: { code: 'overflow' } })
      return
    }
    if (['partial-uri', 'changed-uri', 'raised-row', 'mixed-size'].includes(kind)) {
      await expect(result).rejects.toBeDefined()
      return
    }
    task = getDocument({ data: (await result)!, useSystemFonts: true })
    const output = await (await task.promise).getPage(1),
      items = (await output.getTextContent()).items.filter((item) => 'str' in item),
      annotations = await output.getAnnotations()
    expect(
      items
        .filter((item) => item.transform[5] > 140)
        .map((item) => item.str)
        .join('')
        .replace(/\s/gu, '')
    ).toBe(translation.replace(/\s/gu, ''))
    expect(annotations).toHaveLength(3)
    for (const [index, annotation] of annotations.entries()) {
      expect(annotation.url).toBe(uri)
      expect(annotation.rect[2] - annotation.rect[0]).toBeCloseTo(rows[index].width + 2, 3)
      const native = items.find((item) => item.str.includes(labels[index]))!
      expect(native.height).toBe(rows[index].size)
      if (kind !== 'complete') expect(native.transform[5]).toBe(rows[index].y)
    }
    expect(items.find((item) => item.str === 'Neighbor 17')?.transform.slice(4)).toEqual([40, 125])
  } finally {
    await task?.destroy()
    caller.release()
    registry.dispose()
  }
})

it.each([
  'raised-introducer',
  'changed-uri',
  'changed-marker',
  'ordinary-digit',
  'separated-target',
  'distant-digit',
  'same-prose-row'
] as const)(
  'reflows only a proven raised footnote introducer with its complete URI: %s',
  async (kind) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      mono = await pdf.embedFont(StandardFonts.Courier),
      page = pdf.addPage([300, 200]),
      uri = 'https://example.invalid/model/aaaaaa',
      size = 8,
      width = mono.widthOfTextAtSize(uri, size),
      markerSize = kind === 'ordinary-digit' ? 8 : 6,
      markerX = kind === 'distant-digit' ? 25 : 40,
      uriY = kind === 'same-prose-row' ? 150 : 134,
      registry = new ApplicationCallerLeaseRegistry(),
      caller = registry.acquire({ leaseId: 'native-uri-footnote', surface: 'electron' })
    page.drawText('Equal contribution.', { font, x: 40, y: 150, size })
    page.drawText('1', { font, x: markerX, y: uriY + 3.4, size: markerSize })
    page.drawText(uri, { font: mono, x: 44, y: uriY, size })
    page.drawText('Neighbor', { font, x: 40, y: 112, size })
    page.node.set(
      PDFName.of('Annots'),
      pdf.context.obj([
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [43, uriY - 2, 45 + width, uriY + 9],
            Border: [0, 0, 0],
            A: { S: 'URI', URI: PDFString.of(uri) }
          })
        )
      ])
    )
    const source = 'Equal contribution. 1' + uri,
      translation =
        '所有作者贡献相同。' +
        (kind === 'changed-marker' ? '2' : '1') +
        (kind === 'separated-target' ? '，' : '') +
        (kind === 'changed-uri' ? uri.replace('aaaaaa', 'bbbbbb') : uri),
      writer = new PdfTranslationWriter(() => resolve('resources/pdf-translation/worker.mjs'))
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const output = writer.generate(
        {
          id: 'native-uri-footnote',
          data: await pdf.save(),
          pages: [{ width: 300, height: 200 }],
          units: [
            {
              source,
              translation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: (markerX - 1) / 300, y: 43 / 200, width: 185 / 300, height: 27 / 200 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      if (!['raised-introducer', 'changed-marker', 'ordinary-digit'].includes(kind)) {
        await expect(output).rejects.toMatchObject({ failure: { code: expect.any(String) } })
        return
      }
      task = getDocument({ data: (await output)!, useSystemFonts: true })
      const moved = await (await task.promise).getPage(1),
        items = (await moved.getTextContent()).items.filter((item) => 'str' in item),
        marker = items.find((item) => item.str === '1')!,
        url = items.find((item) => item.str === uri)!,
        links = await moved.getAnnotations()
      expect(
        items
          .filter((item) => item.str !== 'Neighbor')
          .map((item) => item.str)
          .join('')
          .replace(/\s/gu, '')
      ).toBe(translation)
      if (kind === 'changed-marker') {
        expect(marker).toBeUndefined()
        expect(url.transform[5]).toBe(134)
        return
      }
      expect(marker.height).toBe(markerSize)
      if (kind === 'ordinary-digit') {
        expect(url.transform[5]).toBe(134)
        return
      }
      expect(url.height).toBe(8)
      expect(marker.transform[5] - url.transform[5]).toBeCloseTo(3.4, 3)
      expect(links).toHaveLength(1)
      expect(links[0].url).toBe(uri)
      expect(links[0].rect[2] - links[0].rect[0]).toBeCloseTo(width + 2, 3)
      expect(items.find((item) => item.str === 'Neighbor')?.transform.slice(4)).toEqual([40, 112])
    } finally {
      await task?.destroy()
      caller.release()
      registry.dispose()
    }
  }
)

it.each(['complete', 'changed-address', 'changed-action', 'missing-tail', 'duplicate-address'])(
  'reflows a wrapped URI ending in the native sentence stop across paragraph regions: %s',
  async (kind) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      mono = await pdf.embedFont(StandardFonts.Courier),
      page = pdf.addPage([300, 250]),
      uri = 'https://example.invalid/team/Mock-Encoder01',
      labels = ['https://example.', 'invalid/team/Mock-Encoder01.'],
      rows = [
        { x: 120, y: 168, label: labels[0] },
        { x: 40, y: 156, label: labels[1] }
      ],
      registry = new ApplicationCallerLeaseRegistry(),
      caller = registry.acquire({ leaseId: 'wrapped-uri-stop', surface: 'electron' })
    page.drawText('Our method supports visual recognition.', { font, x: 40, y: 192, size: 10 })
    page.drawText('The code is at ', { font, x: 40, y: 180, size: 10 })
    for (const row of rows) page.drawText(row.label, { font: mono, x: row.x, y: row.y, size: 10 })
    page.drawText('Neighbor', { font, x: 40, y: 120, size: 10 })
    page.node.set(
      PDFName.of('Annots'),
      pdf.context.obj(
        rows.map((row) =>
          pdf.context.register(
            pdf.context.obj({
              Type: 'Annot',
              Subtype: 'Link',
              Rect: [
                row.x - 1,
                row.y - 2,
                row.x + mono.widthOfTextAtSize(row.label, 10) + 1,
                row.y + 10
              ],
              Border: [0, 0, 0],
              A: {
                S: 'URI',
                URI: PDFString.of(
                  kind === 'changed-action'
                    ? uri.replace('example.invalid', 'changed.invalid')
                    : uri
                )
              }
            })
          )
        )
      )
    )
    const source = 'Our method supports visual recognition. The code is at ' + labels.join(' '),
      targetUri =
        kind === 'changed-address'
          ? uri.replace('example.invalid', 'changed.invalid')
          : kind === 'missing-tail'
            ? labels[0]
            : uri,
      translation =
        '方法可用于视觉识别。代码见 ' +
        targetUri +
        '。' +
        (kind === 'duplicate-address' ? uri : ''),
      writer = new PdfTranslationWriter(() => resolve('resources/pdf-translation/worker.mjs'))
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const output = await writer.generate(
        {
          id: 'wrapped-uri-stop',
          data: await pdf.save(),
          pages: [{ width: 300, height: 250 }],
          preserveUnsupported: true,
          units: [
            {
              source,
              translation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 39 / 300, y: 47 / 250, width: 200 / 300, height: 38 / 250 }
                },
                {
                  pageNumber: 1,
                  rect: { x: 39 / 300, y: 83 / 250, width: 200 / 300, height: 16 / 250 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      task = getDocument({ data: output!, useSystemFonts: true })
      const written = await (await task.promise).getPage(1),
        text = (await written.getTextContent()).items.filter((item) => 'str' in item),
        annotations = await written.getAnnotations()
      expect(
        text
          .map((item) => item.str)
          .join('')
          .replace(/\s/gu, '')
      ).toBe((kind === 'complete' ? translation : source).replace(/\s/gu, '') + 'Neighbor')
      if (kind === 'complete') {
        const tail = text.find((item) => item.str.includes('invalid/team/Mock-Encoder01'))!,
          stop = text.find((item) => item.str === '。')!
        expect(tail).toBeDefined()
        expect(stop).toBeDefined()
        expect(stop.transform[4] - tail.transform[4] - tail.width).toBeGreaterThanOrEqual(0)
        expect(stop.transform[4] - tail.transform[4] - tail.width).toBeLessThan(4)
      }
      expect(annotations).toHaveLength(2)
      expect(annotations.map((annotation) => annotation.url)).toEqual(
        rows.map(() =>
          kind === 'changed-action' ? uri.replace('example.invalid', 'changed.invalid') : uri
        )
      )
      expect(text.find((item) => item.str === 'Neighbor')?.transform.slice(4)).toEqual([40, 120])
    } finally {
      await task?.destroy()
      caller.release()
      registry.dispose()
    }
  }
)
