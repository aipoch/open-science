import { readPdfTranslationCases } from '../../../../test/fixtures/pdf-translation/read-cases'
import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { PDFDocument, PDFName, PDFString, StandardFonts, type PDFDict } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  pdfLinkLabelKey,
  translatedPdfLinkLabel,
  translatedPdfLinkFragment,
  translatedPdfBracketedReference
} from '../../../../resources/pdf-translation/link-labels.mjs'
import { PdfTranslationWriter } from './writer'
import { ApplicationCallerLeaseRegistry } from '../../caller-lifecycle'

it.each(
  readPdfTranslationCases<{
    name: string
    source: string
    translation: string
    label: string
    offset: number
    method: string
    expectedStart: number | null
    targetLabel: string | null
  }>('opening-citation-raised-footnote.jsonl').concat(
    readPdfTranslationCases('citation-stop-footnote.jsonl')
  )
)(
  'keeps closed citation and raised footnote identity: $name',
  ({ source, translation, label, offset, method, expectedStart, targetLabel }) => {
    const translate = method === 'label' ? translatedPdfLinkLabel : translatedPdfLinkFragment
    for (const prefix of ['', '😀 '])
      expect(
        translate(prefix + source, prefix + translation, label, offset + prefix.length)
      ).toEqual(
        expectedStart === null ? null : { start: prefix.length + expectedStart, text: targetLabel }
      )
  }
)

it.each(
  readPdfTranslationCases<{
    name: string
    source: string
    translation: string
    label: string
    offset: number
    expectedStart: number | null
    targetLabel: string | null
  }>('terminal-numbered-link.jsonl')
)(
  'binds a linked terminal number and stop to its complete figure/table: $name',
  ({ source, translation, label, offset, expectedStart, targetLabel }) => {
    for (const prefix of ['', '😀 ']) {
      expect(
        translatedPdfLinkFragment(
          prefix + source,
          prefix + translation,
          label,
          offset + prefix.length
        )
      ).toEqual(
        expectedStart === null ? null : { start: expectedStart + prefix.length, text: targetLabel }
      )
    }
  }
)

it.each(
  readPdfTranslationCases<{
    name: string
    source: string
    translation: string
    label: string
    targetLabel: string
    accepted: boolean
  }>('spacing-grave-linked-identity.jsonl')
)(
  'preserves complete spacing-accent author identity: $name',
  ({ source, translation, label, targetLabel, accepted }) => {
    for (const prefix of ['', '😀 ']) {
      const input = prefix + source,
        target = prefix + translation,
        offset = input.indexOf(label),
        localized = translatedPdfLinkLabel(input, target, label, offset)
      expect(localized).toEqual(
        accepted ? { start: target.indexOf(targetLabel), text: targetLabel } : null
      )
      expect(translatedPdfLinkLabel(input, target, label, offset + 1)).toBeNull()
    }
    expect(pdfLinkLabelKey(label)).toBe('authors:Covàna:et-al')
    if (accepted) expect(pdfLinkLabelKey(targetLabel)).toBe(pdfLinkLabelKey(label))
  }
)

it.each([
  ['(Wang et al., 2020b)', 'Wang等人（2020b），还有Wang等人'],
  ['Wang et al. (2020b)', '（Wang等人，2020b），还有Wang等人'],
  ['Wang et al. (2020b)', 'Wang等人（2020b），还有Wang等人'],
  ['Wang et al. (2020b) and Wang et al.', '（Wang等人，2020b）'],
  ['(Wang et al., 2020b) and Wang et al.', 'Wang等人（2020b）']
])(
  'keeps full occurrence counts when a narrative dated author is involved: %s → %s',
  (source, translation) => {
    expect(
      translatedPdfLinkLabel(source, translation, 'Wang et al.', source.indexOf('Wang et al.'))
    ).toBeNull()
  }
)

it('preserves established parenthetical-year disambiguation of unlinked author prose', () => {
  const source = '(Wang et al., 2020b)',
    translation = 'Wang等人的方法（Wang等人，2020b）。'
  expect(translatedPdfLinkLabel(source, translation, 'Wang et al.', 1)).toEqual({
    start: translation.lastIndexOf('Wang等人'),
    text: 'Wang等人'
  })
})

it.each(['𝑥', 'α', '2', '\u0302', '_', "'", '′'])(
  'rejects a narrative citation embedded in an identifier: %s',
  (prefix) => {
    const source = '(Wang et al., 2020b)',
      target = `${prefix}Wang等人（2020b）`
    expect(translatedPdfLinkLabel(source, target, 'Wang et al.', 1)).toBeNull()
    expect(translatedPdfLinkFragment(source, target, '2020b', source.indexOf('2020b'))).toBeNull()
    const reverse = `${prefix}Wang et al. (2020b)`
    expect(
      translatedPdfLinkLabel(reverse, '（Wang等人，2020b）', 'Wang et al.', prefix.length)
    ).toBeNull()
    expect(
      translatedPdfLinkFragment(reverse, '（Wang等人，2020b）', '2020b', reverse.indexOf('2020b'))
    ).toBeNull()
  }
)

it.each([
  ['(Wang et al., 2020b)', 'Wang等人（2020b）', true],
  ['Wang et al. (2020b)', '（Wang等人，2020b）', true],
  ['(Wang et al., 2020b)', 'Wang等人（2021b）', false],
  ['(Wang et al., 2020b)', 'Wang等人（2020a）', false],
  ['(Wang et al., 2020b)', 'Other等人（2020b）', false],
  ['(Wang et al., 2020b)', 'Wang等人（2020b', false],
  ['(Wang et al., 2020b)', 'Wang等人（2020b、2021b）', false],
  ['(Wang et al., 2020b)', 'Wang等人（2020b）和Wang等人（2020b）', false],
  ['Wang et al. (2020b)', '（Wang等人，2021b）', false],
  ['Wang et al. (2020b)', '（Other等人，2020b）', false],
  ['Wang et al. (2020b)', '（Wang等人，2020b', false]
] as const)(
  'binds author and suffix-year links across closed citation styles: %s → %s',
  (citation, target, accepted) => {
    const source = `😀 Read ${citation}.`,
      translation = `😀参见${target}。`
    for (const label of ['Wang et al.', '2020b']) {
      const offset = source.indexOf(label),
        expected = label === '2020b' ? label : 'Wang等人'
      const result =
        label === '2020b'
          ? translatedPdfLinkFragment(source, translation, label, offset)
          : translatedPdfLinkLabel(source, translation, label, offset)
      expect(result).toEqual(
        accepted ? { start: translation.indexOf(expected), text: expected } : null
      )
      expect(translatedPdfLinkFragment(source, translation, label, offset + 1)).toBeNull()
    }
  }
)

it('preserves closed citation style occurrence identities and exact UTF-16 offsets', () => {
  const source = '😀 (Wang et al., 2020b), then Wang et al. (2020b).',
    target = '😀Wang等人（2020b），再见（Wang等人，2020b）。'
  for (const label of ['Wang et al.', '2020b'])
    for (const last of [false, true]) {
      const expected = label === '2020b' ? label : 'Wang等人',
        offset = last ? source.lastIndexOf(label) : source.indexOf(label),
        start = last ? target.lastIndexOf(expected) : target.indexOf(expected)
      expect(
        label === '2020b'
          ? translatedPdfLinkFragment(source, target, label, offset)
          : translatedPdfLinkLabel(source, target, label, offset)
      ).toEqual({ start, text: expected })
    }
})

it.each([
  { name: 'literal shorthand list', replace: undefined, accepted: true },
  { name: 'changed year', replace: ['2013b,a', '2014b,a'], accepted: false },
  { name: 'changed suffix', replace: ['2013b,a', '2013b,c'], accepted: false },
  { name: 'changed second author', replace: ['Pennington', 'Other'], accepted: false },
  { name: 'missing closing bracket', replace: [']', ''], accepted: false },
  { name: 'wrong list separator', replace: ['; ', ', '], accepted: false },
  { name: 'extra complete occurrence', duplicate: true, accepted: false }
])('binds split year suffix links to an exact closed citation list: $name', (sample) => {
  const citation = '[Mikolov et al., 2013b,a; Pennington et al., 2014]',
    source = `A model and a vector use ${citation}.`,
    target = `模型和向量使用${sample.replace ? citation.replace(sample.replace[0], sample.replace[1]) : citation}。${sample.duplicate ? citation : ''}`,
    offset = source.indexOf('2013b,a') + '2013b,'.length
  expect(translatedPdfLinkLabel(source, target, 'a', offset)).toEqual(
    sample.accepted ? { start: target.indexOf('2013b,a') + '2013b,'.length, text: 'a' } : null
  )
  expect(translatedPdfLinkLabel('A model and a vector.', '模型使用a。', 'a', 12)).toBeNull()
})

it('keeps repeated literal citation-list suffixes tied to their complete occurrence', () => {
  const citation = '[Mikolov et al., 2013b,a; Pennington et al., 2014]',
    source = `A ${citation}, then ${citation}.`,
    target = `采用${citation}，再采用${citation}。`
  for (const at of [source.indexOf(citation), source.lastIndexOf(citation)]) {
    const offset = at + citation.indexOf('2013b,a') + '2013b,'.length,
      targetAt =
        at === source.indexOf(citation) ? target.indexOf(citation) : target.lastIndexOf(citation)
    expect(translatedPdfLinkLabel(source, target, 'a', offset)).toEqual({
      start: targetAt + citation.indexOf('2013b,a') + '2013b,'.length,
      text: 'a'
    })
  }
  expect(
    translatedPdfLinkLabel(source, `采用${citation}。`, 'a', source.indexOf('2013b,a') + 6)
  ).toBeNull()
})

it.each([
  '[Mikolov et al., 2013b,a; Pennington et al., 2014',
  'Mikolov et al., 2013b,a; Pennington et al., 2014]',
  '[Mikolov et al., 2013b,a, Pennington et al., 2014]'
])('requires a closed grammatical source citation before mapping its suffix: %s', (citation) => {
  const source = `A model and a vector use ${citation}.`,
    target = `模型和向量使用${citation}。`
  expect(translatedPdfLinkLabel(source, target, 'a', source.indexOf('2013b,a') + 6)).toBeNull()
})

it.each([
  { target: '参见 Mern et al. (2020a)，另见 Quinn et al. (2020a)。', accepted: true },
  { target: '参见 Mern 等人（2020a），另见 Quinn 等人（2020a）。', accepted: true },
  { target: '参见 Quinn et al. (2020a)，另见 Mern et al. (2020a)。', accepted: false },
  { target: '参见 Mern et al. (2020b)，另见 Quinn et al. (2020a)。', accepted: false },
  { target: '参见 Other et al. (2020a)，另见 Quinn et al. (2020a)。', accepted: false },
  { target: '参见 Mern et al. (2020a)。', accepted: false },
  { target: '参见 Mern et al. (2020a)，另见 Quinn et al. (2020a)，2020a。', accepted: false },
  { target: '参见 Mern et al. (2020a，另见 Quinn et al. (2020a)。', accepted: false },
  { target: '2020a 与 2020a。', accepted: false }
])(
  'binds repeated native year fragments to closed author citations: $target',
  ({ target, accepted }) => {
    const source = 'See Mern et al. (2020a), then Quinn et al. (2020a).',
      offsets = [source.indexOf('2020a'), source.lastIndexOf('2020a')]
    for (const [index, offset] of offsets.entries()) {
      const result = translatedPdfLinkFragment(source, target, '2020a', offset)
      expect(result).toEqual(
        accepted
          ? { start: index ? target.lastIndexOf('2020a') : target.indexOf('2020a'), text: '2020a' }
          : null
      )
    }
    expect(translatedPdfLinkFragment('2020a and 2020a', target, '2020a', 0)).toBeNull()
  }
)

it.each([
  { name: 'unchanged panel', target: '图 2(a)', accepted: true },
  { name: 'localized parentheses', target: '图 2（a）', accepted: true },
  { name: 'changed panel letter', target: '图 2(b)', accepted: false },
  { name: 'missing panel suffix', target: '图 2', accepted: false },
  { name: 'changed panel number', target: '图 3(a)', accepted: false },
  { name: 'extra same panel occurrence', target: '图 2(a) 和图 2(a)', accepted: false }
])('maps only the complete numbered panel: $name', ({ target, accepted }) => {
  const result = translatedPdfLinkFragment('See Figure 2(a).', `参见${target}。`, '2', 11)
  expect(result).toEqual(accepted ? { start: 4, text: '2' } : null)
})

it.each(
  readPdfTranslationCases<{
    name: string
    label: string
    target: string
    accepted: boolean
    source?: string
    translation?: string
    offset?: number
    expectedStart?: number
  }>('localized-cross-reference-identities.jsonl')
)(
  'maps only proven link identities: $name',
  ({ label, target, accepted, source, translation, offset, expectedStart }) => {
    const result =
      translatedPdfLinkLabel(
        source ?? `See ${label}.`,
        translation ?? `参见${target}。`,
        label,
        offset ?? 4
      ) ??
      translatedPdfLinkFragment(
        source ?? `See ${label}.`,
        translation ?? `参见${target}。`,
        label,
        offset ?? 4
      )
    if (accepted) expect(result).toEqual({ start: expectedStart ?? 2, text: target })
    else expect(result).toBeNull()
  }
)

it.each(['uri', 'internal'] as const)(
  'writes a complete translated prose link with its original %s action and hit area',
  async (action) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([612, 792]),
      destination = pdf.addPage([612, 792]),
      source = 'Read the revised paper',
      translation = '阅读修订后的论文',
      width = font.widthOfTextAtSize(source, 12),
      rect = [39, 696, 41 + width, 711],
      annotation = (box: number[]): PDFDict =>
        pdf.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: box,
          Border: [0, 0, 0],
          ...(action === 'uri'
            ? { A: { S: 'URI', URI: PDFString.of('https://example.org/revised') } }
            : { Dest: [destination.ref, PDFName.of('XYZ'), 0, 700, null] })
        })
    page.drawText(source, { x: 40, y: 700, size: 12, font })
    page.node.set(PDFName.of('Annots'), pdf.context.obj([pdf.context.register(annotation(rect))]))
    const registry = new ApplicationCallerLeaseRegistry(),
      caller = registry.acquire({ leaseId: 'whole-link-reader', surface: 'electron' }),
      writer = new PdfTranslationWriter(() => resolve('resources/pdf-translation/worker.mjs')),
      input = {
        id: 'whole-prose-link',
        data: await pdf.save(),
        pages: [
          { width: 612, height: 792 },
          { width: 612, height: 792 }
        ],
        preserveUnsupported: false,
        units: [
          {
            source,
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 40 / 612, y: 72 / 792, width: 250 / 612, height: 35 / 792 }
              }
            ]
          }
        ]
      }
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const output = await writer.generate(input, caller.lease)
      task = getDocument({ data: output!, useSystemFonts: true })
      const doc = await task.promise,
        target = await doc.getPage(1),
        links = await target.getAnnotations(),
        items = (await target.getTextContent()).items.filter((item) => 'str' in item)
      expect(
        items
          .map((item) => item.str)
          .join('')
          .replace(/\s/gu, '')
      ).toBe(translation)
      expect(links).toHaveLength(1)
      const link = links[0]
      expect(link.rect[2] - link.rect[0]).toBeCloseTo(rect[2] - rect[0], 3)
      expect(link.rect[3] - link.rect[1]).toBeCloseTo(rect[3] - rect[1], 3)
      if (action === 'uri') expect(link.url).toBe('https://example.org/revised')
      else {
        expect(link.dest.slice(1)).toEqual([{ name: 'XYZ' }, 0, 700, null])
        expect(await doc.getPageIndex(link.dest[0])).toBe(1)
      }
      const start = 40 + font.widthOfTextAtSize('Read the ', 12)
      page.node.set(
        PDFName.of('Annots'),
        pdf.context.obj([pdf.context.register(annotation([start - 1, 696, 41 + width, 711]))])
      )
      await expect(
        writer.generate({ ...input, data: await pdf.save() }, caller.lease)
      ).rejects.toMatchObject({ failure: { code: 'annotations' } })
    } finally {
      await task?.destroy()
      caller.release()
      registry.dispose()
    }
  }
)

it.each([
  { label: 'Table 2', target: '表2', action: 'uri', merged: false, repeated: false },
  {
    label: 'Supplementary Table 2',
    target: '补充表 2',
    action: 'uri',
    merged: true,
    repeated: false
  },
  ...(['uri', 'internal'] as const).map((action) => ({
    label: 'S2 Fig.',
    target: 'S2 图',
    action,
    merged: true,
    repeated: false
  })),
  ...(['uri', 'internal'] as const).map((action) => ({
    label: '2003)',
    target: '2003）',
    action,
    merged: false,
    repeated: false,
    sourcePrefix: 'Standard Net (Kern et al., ',
    sourceSuffix: '',
    translationOverride: '标准网络（Kern et al., 2003）'
  })),
  ...(['uri', 'internal'] as const).map((action) => ({
    label: 'and De Meulder',
    target: '和 De Meulder',
    action,
    merged: false,
    repeated: false,
    sourcePrefix: 'See (Tjong Kim Sang ',
    sourceSuffix: ', 2003).',
    translationOverride: '参见（Tjong Kim Sang 和 De Meulder，2003）。'
  })),
  {
    label: 'online supplemental file 5',
    target: '在线补充文件 5',
    action: 'uri',
    merged: true,
    repeated: false
  },
  {
    label: 'Vale and Lang (2015',
    target: 'Vale和Lang（2015',
    action: 'uri',
    merged: true,
    repeated: false
  },
  {
    label: 'Arden et al., 2014',
    target: 'Arden等人，2014',
    action: 'internal',
    merged: true,
    repeated: false
  },
  {
    label: 'Suppl. Appendix',
    target: '补充附录',
    action: 'internal',
    merged: false,
    repeated: false
  },
  { label: 'Appendix B', target: '附录B', action: 'internal', merged: true, repeated: false },
  { label: 'Appendix B', target: '附錄B', action: 'uri', merged: true, repeated: true },
  { label: 'Sec. 6.1', target: '第6.1节', action: 'internal', merged: true, repeated: false },
  { label: 'Section 6.1.2', target: '第6.1.2節', action: 'uri', merged: true, repeated: true },
  ...readPdfTranslationCases<{
    name: string
    label: string
    target: string
    action: 'uri' | 'internal'
    merged: boolean
    repeated?: boolean
    sourcePrefix?: string
    sourceSuffix?: string
    translationOverride?: string
    leadingLines?: string[]
    retainedPrefix?: string
  }>('partial-prose-object-link-labels.jsonl')
] as const)(
  'writes a Chinese $label link without consuming touching surrounding prose',
  async ({ label, target, action, merged, repeated, ...details }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([612, 792]),
      destination = pdf.addPage([612, 792]),
      prefix =
        ('sourcePrefix' in details ? details.sourcePrefix : undefined) ??
        (repeated ? `${label} discussed (` : 'See ('),
      suffix = ('sourceSuffix' in details ? details.sourceSuffix : undefined) ?? ') for details.',
      leadingLines = ('leadingLines' in details ? details.leadingLines : undefined) ?? [],
      baseline = 700 - leadingLines.length * 13.2,
      x = 40 + font.widthOfTextAtSize(prefix, 12),
      width = font.widthOfTextAtSize(label, 12),
      rect = [x - 1.5, baseline - 4, x + width + 1.5, baseline + 11],
      url = 'https://example.org/paper/reference'
    for (const [index, text] of leadingLines.entries())
      page.drawText(text, { font, x: 40, y: 700 - index * 13.2, size: 12 })
    if ('retainedPrefix' in details && details.retainedPrefix) {
      if (prefix) page.drawText(prefix, { font, x: 40, y: baseline, size: 12 })
      page.drawText(details.retainedPrefix, { font, x, y: baseline, size: 12 })
      page.drawText(label.slice(details.retainedPrefix.length).trimStart() + suffix, {
        font,
        x: x + font.widthOfTextAtSize(details.retainedPrefix + ' ', 12),
        y: baseline,
        size: 12
      })
    } else if (merged)
      page.drawText(prefix + label + suffix, { font, x: 40, y: baseline, size: 12 })
    else {
      page.drawText(prefix, { font, x: 40, y: baseline, size: 12 })
      page.drawText(label, { font, x, y: baseline, size: 12 })
      page.drawText(suffix, { font, x: x + width, y: baseline, size: 12 })
    }
    const annotation = pdf.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: rect,
      Border: [0, 0, 0],
      ...(action === 'uri'
        ? { A: { S: 'URI', URI: PDFString.of(url) } }
        : { Dest: [destination.ref, PDFName.of('XYZ'), 0, 700, null] })
    })
    page.node.set(PDFName.of('Annots'), pdf.context.obj([pdf.context.register(annotation)]))
    const registry = new ApplicationCallerLeaseRegistry(),
      caller = registry.acquire({ leaseId: 'link-reader', surface: 'electron' }),
      translation =
        ('translationOverride' in details ? details.translationOverride : undefined) ??
        (repeated ? `${target}提到了（${target}）获取详情。` : `参见（${target}）获取详情。`),
      input = {
        id: 'localized-link',
        data: await pdf.save(),
        pages: [
          { width: 612, height: 792 },
          { width: 612, height: 792 }
        ],
        preserveUnsupported: true,
        units: [
          {
            source: [...leadingLines, `${prefix}${label}${suffix}`].join(' '),
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 40 / 612, y: 72 / 792, width: 480 / 612, height: 50 / 792 }
              }
            ]
          }
        ]
      }
    const writer = new PdfTranslationWriter(() => resolve('resources/pdf-translation/worker.mjs'))
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const output = await writer.generate(input, caller.lease)
      task = getDocument({ data: output!, useSystemFonts: true })
      const doc = await task.promise,
        targetPage = await doc.getPage(1),
        annotations = await targetPage.getAnnotations(),
        items = (await targetPage.getTextContent()).items.filter((item) => 'str' in item)
      expect(
        items
          .map((item) => item.str)
          .join('')
          .replace(/\s/gu, '')
      ).toBe(translation.replace(/\s/gu, ''))
      expect(annotations).toHaveLength(1)
      const link = annotations[0]
      expect(link.rect[2] - link.rect[0]).toBeCloseTo(rect[2] - rect[0], 3)
      expect(link.rect[3] - link.rect[1]).toBeCloseTo(rect[3] - rect[1], 3)
      const labelItems =
        'retainedPrefix' in details
          ? items.filter(
              (item) =>
                item.str.trim() &&
                item.transform[4] >= link.rect[0] - 1 &&
                item.transform[4] + item.width <= link.rect[2] + 1 &&
                item.transform[5] >= link.rect[1] &&
                item.transform[5] <= link.rect[3]
            )
          : items.filter((item) => item.str === target)
      expect(labelItems).not.toHaveLength(0)
      expect(
        labelItems
          .map((item) => item.str)
          .join('')
          .replace(/\s/gu, '')
      ).toBe(target.replace(/\s/gu, ''))
      for (const item of labelItems) {
        expect(item.transform[4]).toBeGreaterThanOrEqual(link.rect[0] - 1)
        expect(item.transform[4] + item.width).toBeLessThanOrEqual(link.rect[2] + 1)
      }
      if (action === 'uri') expect(link.url).toBe(url)
      else {
        expect(link.dest.slice(1)).toEqual([{ name: 'XYZ' }, 0, 700, null])
        expect(await doc.getPageIndex(link.dest[0])).toBe(1)
      }
      const invalid = action === 'uri' ? '参见（表3）获取详情。' : '参见正文获取详情。'
      await expect(
        writer.generate(
          {
            ...input,
            preserveUnsupported: false,
            units: [{ ...input.units[0], translation: invalid }]
          },
          caller.lease
        )
      ).rejects.toMatchObject({ failure: { code: 'annotations' } })
      const retained = await writer.generate(
        { ...input, units: [{ ...input.units[0], translation: invalid }] },
        caller.lease
      )
      expect(retained).toEqual(input.data)
    } finally {
      await task?.destroy()
      caller.release()
      registry.dispose()
    }
  }
)

// Synthetic JSONL fixtures preserve the layout failure without copying paper data.
const sharedCitationCases = [
  'shared-citation-object-distinct-links.jsonl',
  'shared-citation-object-invalid-target.jsonl'
].flatMap((file) =>
  readFileSync(resolve('test/fixtures/pdf-translation', file), 'utf8')
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as {
          name: string
          label: string
          translation: string
          expected: 'translated' | 'original'
        }
    )
)

it.each(sharedCitationCases)('$name', async ({ label, translation, expected }) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    page = pdf.addPage([612, 792]),
    prefix = 'See [',
    suffix = '].',
    x = 42 + font.widthOfTextAtSize(prefix, 12),
    numbers = label.split(', '),
    rects = numbers.map((number, index) => {
      const left = x + (index ? font.widthOfTextAtSize(numbers[0] + ', ', 12) : 0)
      return [left - 0.5, 696, left + font.widthOfTextAtSize(number, 12) + 0.5, 711]
    }),
    urls = numbers.map((number) => `https://example.org/reference/${number}`)
  page.drawText(prefix, { font, x: 40, y: 700, size: 12 })
  // Deliberately one text object, but each number has its own link/action.
  page.drawText(label, { font, x, y: 700, size: 12 })
  page.drawText(suffix, { font, x: x + font.widthOfTextAtSize(label, 12) + 2, y: 700, size: 12 })
  page.node.set(
    PDFName.of('Annots'),
    pdf.context.obj(
      rects.map((rect, index) =>
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: rect,
            Border: [0, 0, 0],
            A: { S: 'URI', URI: PDFString.of(urls[index]) }
          })
        )
      )
    )
  )
  const registry = new ApplicationCallerLeaseRegistry(),
    caller = registry.acquire({ leaseId: 'shared-citation', surface: 'electron' }),
    source = prefix + label + suffix,
    input = {
      id: 'shared-citation',
      data: await pdf.save(),
      pages: [{ width: 612, height: 792 }],
      preserveUnsupported: true,
      units: [
        {
          source,
          translation,
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 40 / 612, y: 72 / 792, width: 500 / 612, height: 70 / 792 }
            }
          ]
        }
      ]
    },
    writer = new PdfTranslationWriter(() => resolve('resources/pdf-translation/worker.mjs'))
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const output = await writer.generate(input, caller.lease)
    if (expected === 'original') expect(output).toEqual(input.data)
    task = getDocument({ data: output! })
    const target = await (await task.promise).getPage(1),
      links = await target.getAnnotations(),
      items = (await target.getTextContent()).items.filter((item) => 'str' in item)
    expect(
      items
        .map((item) => item.str)
        .join('')
        .replace(/\s/gu, '')
    ).toBe((expected === 'translated' ? translation : source).replace(/\s/gu, ''))
    expect(links.map((link) => link.url)).toEqual(urls)
    const movement = links.map((link, index) => {
      const before = rects[index]
      expect(link.rect[2] - link.rect[0]).toBeCloseTo(before[2] - before[0], 3)
      expect(link.rect[3] - link.rect[1]).toBeCloseTo(before[3] - before[1], 3)
      return [link.rect[0] - before[0], link.rect[1] - before[1]]
    })
    expect(movement[0][0]).toBeCloseTo(movement[1][0], 3)
    expect(movement[0][1]).toBeCloseTo(movement[1][1], 3)
    if (expected === 'translated') {
      expect(Math.abs(movement[0][0])).toBeGreaterThan(1)
      const item = items.find((item) => item.str === label)!
      expect(item).toBeDefined()
      for (const [index, number] of numbers.entries()) {
        const center =
          item.transform[4] +
          (index ? font.widthOfTextAtSize(numbers[0] + ', ', 12) : 0) +
          font.widthOfTextAtSize(number, 12) / 2
        expect(center).toBeGreaterThan(links[index].rect[0])
        expect(center).toBeLessThan(links[index].rect[2])
      }
    }
  } finally {
    await task?.destroy()
    caller.release()
    registry.dispose()
  }
})

it.each(
  readPdfTranslationCases<{
    name: string
    first: string
    second: string
    sourceReference: string
    targetReference: string
    accepted: boolean
  }>('hyphenated-author-link-fragments.jsonl')
)('$name', async ({ first, second, sourceReference, targetReference, accepted }) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    page = pdf.addPage([612, 792]),
    prefix = 'See ',
    left = 40 + font.widthOfTextAtSize(prefix, 12),
    rects = [
      [left - 1, 696, left + font.widthOfTextAtSize(first, 12) + 1, 711],
      [39, 678, 40 + font.widthOfTextAtSize(second, 12) + 1, 693]
    ],
    url = 'https://example.org/reference'
  page.drawText(prefix + first, { font, x: 40, y: 700, size: 12 })
  page.drawText(second + ' for details.', { font, x: 40, y: 682, size: 12 })
  page.node.set(
    PDFName.of('Annots'),
    pdf.context.obj(
      rects.map((Rect) =>
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect,
            Border: [0, 0, 0],
            A: { S: 'URI', URI: PDFString.of(url) }
          })
        )
      )
    )
  )
  const registry = new ApplicationCallerLeaseRegistry(),
    caller = registry.acquire({ leaseId: 'hyphenated-author', surface: 'electron' }),
    data = await pdf.save(),
    translation = `参见${targetReference}获取详情。`,
    writer = new PdfTranslationWriter(() => resolve('resources/pdf-translation/worker.mjs'))
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const output = await writer.generate(
      {
        id: 'hyphenated-author',
        data,
        pages: [{ width: 612, height: 792 }],
        preserveUnsupported: true,
        units: [
          {
            source: `See ${sourceReference} for details.`,
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 40 / 612, y: 72 / 792, width: 400 / 612, height: 70 / 792 }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    if (!accepted) {
      expect(output).toEqual(data)
      return
    }
    task = getDocument({ data: output!, useSystemFonts: true })
    const target = await (await task.promise).getPage(1),
      text = await target.getTextContent(),
      links = await target.getAnnotations()
    expect(
      text.items
        .flatMap((item) => ('str' in item ? [item.str] : []))
        .join('')
        .replace(/\s/gu, '')
    ).toBe(translation.replace(/\s/gu, ''))
    expect(links).toHaveLength(2)
    for (const [index, link] of links.entries()) {
      expect(link.url).toBe(url)
      expect(link.rect[2] - link.rect[0]).toBeCloseTo(rects[index][2] - rects[index][0], 3)
      expect(link.rect[3] - link.rect[1]).toBeCloseTo(rects[index][3] - rects[index][1], 3)
    }
  } finally {
    await task?.destroy()
    caller.release()
    registry.dispose()
  }
})

it.each(
  readPdfTranslationCases<{ name: string; alias: string; full: string; translated: string }>(
    'mixed-abbreviated-reference-hit-areas.jsonl'
  )
)('$name', async ({ alias, full, translated }) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    page = pdf.addPage([600, 800]),
    source = `See (${alias} 7) and (${full} 7).`,
    translation = `参见${translated}7及${translated}7。`,
    starts = [source.indexOf('7'), source.lastIndexOf('7')]
  let cursor = 0,
    x = 40
  const rects: number[][] = []
  for (const start of starts) {
    const before = source.slice(cursor, start)
    page.drawText(before, { font, size: 12, x, y: 700 })
    x += font.widthOfTextAtSize(before, 12)
    page.drawText('7', { font, size: 12, x, y: 700 })
    const width = font.widthOfTextAtSize('7', 12)
    rects.push([x - 0.5, 698, x + width + 0.5, 711])
    x += width
    cursor = start + 1
  }
  page.drawText(source.slice(cursor), { font, size: 12, x, y: 700 })
  page.node.set(
    PDFName.of('Annots'),
    pdf.context.obj(
      rects.map((rect, index) =>
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: rect,
            A: { S: 'URI', URI: PDFString.of(`https://example.org/reference/${index}`) }
          })
        )
      )
    )
  )
  const caller = new ApplicationCallerLeaseRegistry().acquire({
    leaseId: 'mixed-reference',
    surface: 'electron'
  })
  try {
    const bytes = await new PdfTranslationWriter(() =>
      resolve('resources/pdf-translation/worker.mjs')
    ).generate(
      {
        id: 'mixed-reference',
        data: await pdf.save(),
        pages: [{ width: 600, height: 800 }],
        units: [
          {
            source,
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 40 / 600, y: 75 / 800, width: 450 / 600, height: 40 / 800 }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    const task = getDocument({ data: bytes! })
    try {
      const result = await (await task.promise).getPage(1),
        links = await result.getAnnotations(),
        text = (await result.getTextContent()).items
          .map((item) => ('str' in item ? item.str : ''))
          .join('')
          .replace(/\s/gu, '')
      expect(text).toBe(translation)
      expect(links).toHaveLength(2)
      expect(links[0].rect[2]).toBeLessThan(links[1].rect[0])
      expect(links.map((link) => link.url)).toEqual([
        'https://example.org/reference/0',
        'https://example.org/reference/1'
      ])
    } finally {
      await task.destroy()
    }
  } finally {
    caller.release()
  }
})

it.each([
  ['figure 1', 'figure\u00a01', '图 1'],
  ['table 2', 'table\u00a02', '表 2'],
  ['figure\u00a01', 'figure 1', '图 1'],
  ['figure 1', 'figure\u202f1', '图 1'],
  ['table 2', 'table\u202f2', '表 2'],
  ['figure\u202f1', 'figure 1', '图 1']
])('keeps exact source offsets for native NBSP in %s', (prepared, native, target) => {
  const prefix = '😀 See (',
    source = prefix + prepared + ').',
    translation = '结果（' + target + '）。'
  expect(translatedPdfLinkLabel(source, translation, native, prefix.length)).toEqual({
    start: 3,
    text: target
  })
  expect(translatedPdfLinkLabel(source, translation, native, prefix.length - 1)).toBeNull()
  expect(translatedPdfLinkLabel(source, translation, ' ' + native, prefix.length)).toBeNull()
  expect(
    translatedPdfLinkLabel(source, translation, native.replace(/\s/u, '  '), prefix.length)
  ).toBeNull()
})

it.each(['支持信息', '支持資訊', '支持材料'])(
  'maps a complete supporting-information notice and both wrapped components: %s',
  (target) => {
    const source = 'Data are available in the Supporting information.',
      translation = `数据见${target}。`,
      offset = source.indexOf('Supporting')
    expect(translatedPdfLinkLabel(source, translation, 'Supporting information', offset)).toEqual({
      start: 3,
      text: target
    })
    for (const [label, component, start] of [
      ['Supporting', target.slice(0, 2), 3],
      ['information', target.slice(2), 5]
    ] as const) {
      const from = source.indexOf(label)
      expect(translatedPdfLinkFragment(source, translation, label, from)).toEqual({
        start,
        text: component
      })
      expect(translatedPdfLinkFragment(translation, source, component, start)).toEqual({
        start: from,
        text: label
      })
    }
  }
)

it.each([
  ['See Supporting data and information.', '见支持信息。', 'Supporting', 4],
  ['See Supporting information.', '见支持数据。', 'Supporting', 4],
  ['See Supporting information.', '见信息。', 'information', 15],
  ['See Supporting information.', '见支持信息和支持材料。', 'Supporting', 4],
  ['See Supporting information.', '见支持信息。', 'Supporting', 5],
  ['See Supporting information.', '见支持信息。', 'upporting', 5],
  ['Other information. Supporting information.', '其他信息。支持信息。', 'information', 6]
])('rejects unproven supporting notice components: %s / %s', (source, target, label, offset) => {
  expect(translatedPdfLinkFragment(source, target, label, offset)).toBeNull()
})

it('keeps complete supporting notice occurrences and native whitespace distinct', () => {
  const source = 'Supporting\u00a0information, then Supporting information.',
    target = '支持資訊，然后支持信息。',
    offset = source.lastIndexOf('information')
  expect(translatedPdfLinkFragment(source, target, 'information', offset)).toEqual({
    start: target.lastIndexOf('信息'),
    text: '信息'
  })
  expect(translatedPdfLinkFragment(source, '仅支持信息。', 'information', offset)).toBeNull()
})

it.each(['在线补充文件 5', '在線補充文件 5', '線上補充檔案 5', 'online supplemental file 5'])(
  'maps the complete numbered online supplement to %s',
  (target) => {
    const source = 'See the guide (online supplemental file 5).',
      translation = '参见指南（' + target + '）。'
    expect(translatedPdfLinkLabel(source, translation, 'online supplemental file 5', 15)).toEqual({
      start: 5,
      text: target
    })
    expect(translatedPdfLinkLabel(translation, source, target, 5)).toEqual({
      start: 15,
      text: 'online supplemental file 5'
    })
  }
)

it.each([
  ['在线补充文件 6', 'online supplemental file 5'],
  ['补充文件 5', 'online supplemental file 5'],
  ['在线补充附录 5', 'online supplemental file 5'],
  ['在线补充文件 5及在线补充文件 5', 'online supplemental file 5'],
  ['在线补充文件 5.2', 'online supplemental file 5'],
  ['online supplemental file 5.pdf', 'online supplemental file 5'],
  ['在线补充文件 5', 'supplemental file 5'],
  ['在线补充文件 5', 'file 5'],
  ['在线补充文件 5', '5']
])('rejects ambiguous or partial online supplements: %s / %s', (target, label) => {
  const source = 'See the guide (online supplemental file 5).',
    translation = '参见指南（' + target + '）。',
    offset = source.indexOf(label)
  expect(translatedPdfLinkLabel(source, translation, label, offset)).toBeNull()
  expect(translatedPdfLinkFragment(source, translation, label, offset)).toBeNull()
})

it('keeps repeated complete supplement occurrences distinct and rejects missing occurrences', () => {
  const label = 'online supplemental file 5',
    source = `See ${label}, then ${label}.`,
    translation = '先看在线补充文件 5，再看在线补充文件 5。',
    offset = source.lastIndexOf(label)
  expect(translatedPdfLinkLabel(source, translation, label, offset)).toEqual({
    start: translation.lastIndexOf('在线补充文件 5'),
    text: '在线补充文件 5'
  })
  expect(translatedPdfLinkLabel(source, '参见在线补充文件 5。', label, offset)).toBeNull()
})

const compoundPairSource = 'See (Tjong Kim Sang and De Meulder, 2003).'
const compoundPairTarget = '参见（Tjong Kim Sang 和 De Meulder，2003）。'
it.each(['Tjong Kim Sang', 'and De Meulder', 'De Meulder', '2003'])(
  'proves a complete dated compound pair before mapping its fragment: %s',
  (label) => {
    const offset = compoundPairSource.indexOf(label),
      mapped = translatedPdfLinkLabel(compoundPairSource, compoundPairTarget, label, offset)
    expect(mapped).toEqual({
      start: compoundPairTarget.indexOf(label === 'and De Meulder' ? '和 De Meulder' : label),
      text: label === 'and De Meulder' ? '和 De Meulder' : label
    })
    expect(
      translatedPdfLinkFragment(compoundPairTarget, compoundPairSource, mapped!.text, mapped!.start)
    ).toEqual({ start: offset, text: label })
  }
)
it.each([
  ['changed-first', compoundPairTarget.replace('Tjong Kim Sang', 'Tjong Kim Fang')],
  ['changed-second', compoundPairTarget.replace('De Meulder', 'De Baker')],
  ['lost-first-boundary', compoundPairTarget.replace('Tjong Kim Sang', 'TjongKim Sang')],
  ['lost-second-boundary', compoundPairTarget.replace('De Meulder', 'DeMeulder')],
  ['reordered-author-words', compoundPairTarget.replace('Tjong Kim Sang', 'Tjong Sang Kim')],
  ['reversed-authors', '参见（De Meulder 和 Tjong Kim Sang，2003）。'],
  ['changed-year', compoundPairTarget.replace('2003', '2004')],
  ['changed-year-suffix', compoundPairTarget.replace('2003', '2003a')],
  ['missing-parenthesis', compoundPairTarget.replace('（', '').replace('）', '')],
  ['extra-reference', compoundPairTarget + compoundPairTarget]
])('rejects a changed compound pair identity: %s', (_name, translation) => {
  for (const map of [translatedPdfLinkLabel, translatedPdfLinkFragment])
    expect(
      map(
        compoundPairSource,
        translation,
        'and De Meulder',
        compoundPairSource.indexOf('and De Meulder')
      )
    ).toBeNull()
})
it('rejects missing repeated compound references and maps identical occurrences in order', () => {
  const source = compoundPairSource + ' ' + compoundPairSource,
    target = compoundPairTarget + '然后' + compoundPairTarget,
    offset = source.lastIndexOf('and De Meulder')
  expect(translatedPdfLinkLabel(source, compoundPairTarget, 'and De Meulder', offset)).toBeNull()
  expect(translatedPdfLinkLabel(source, target, 'and De Meulder', offset)).toEqual({
    start: target.lastIndexOf('和 De Meulder'),
    text: '和 De Meulder'
  })
})
it('uses the full dated identity when two compound citations change prose order', () => {
  const source = compoundPairSource + ' ' + compoundPairSource.replace('2003', '2004'),
    target = compoundPairTarget.replace('2003', '2004') + '然后' + compoundPairTarget,
    label = 'and De Meulder',
    mapped = translatedPdfLinkLabel(source, target, label, source.indexOf(label))
  expect(mapped).toEqual({ start: target.lastIndexOf('和 De Meulder'), text: '和 De Meulder' })
  expect(translatedPdfLinkFragment(target, source, mapped!.text, mapped!.start)).toEqual({
    start: source.indexOf(label),
    text: label
  })
})
it('does not infer a standalone compound-author suffix or a truncated name', () => {
  for (const map of [translatedPdfLinkLabel, translatedPdfLinkFragment]) {
    expect(map('See and De Meulder.', '参见和 De Meulder。', 'and De Meulder', 4)).toBeNull()
    expect(
      map(compoundPairSource, compoundPairTarget, 'and De', compoundPairSource.indexOf('and De'))
    ).toBeNull()
  }
})

it('rejects compacted author names in reverse instead of recovering their missing word boundaries', () => {
  const source = '见（TjongKimSang 和 DeMeulder，2003）。',
    label = 'TjongKimSang 和 DeMeulder'
  for (const map of [translatedPdfLinkLabel, translatedPdfLinkFragment])
    expect(map(source, compoundPairSource, label, source.indexOf(label))).toBeNull()
})

it.each([
  { source: 'Read (Kern et al., 2003).', target: '参见（Kern 等人，2003）。', accepted: true },
  { source: 'Read (Kern et al., 2003).', target: '参见（Kern 等人，2004）。', accepted: false },
  { source: 'Read (Kern et al., 2003).', target: '参见（Vale 等人，2003）。', accepted: false },
  { source: 'Read (Kern et al., 2003).', target: '参见（Kern，2003）。', accepted: false },
  { source: 'Read (Kern et al., 2003).', target: '参见（Kern 等人，2003]。', accepted: false },
  { source: 'Read (Kern et al., 2003).', target: '参见（Kern 等人，2003 ）。', accepted: false },
  { source: 'Read (Kern & Vale, 2003).', target: '参见（Kern 和 Vale，2003）。', accepted: true },
  {
    source: 'Read (Arden Stone and Vale Lake, 2003).',
    target: '参见（Arden Stone 和 Vale Lake，2003）。',
    accepted: true
  },
  {
    source: 'Read (Arden Stone and Vale Lake, 2003).',
    target: '参见（ArdenStone 和 ValeLake，2003）。',
    accepted: false
  },
  { source: 'Read (Kern et al., 2003a).', target: '参见（Kern 等人，2003a）。', accepted: true },
  { source: 'Read (Kern et al., 2003a).', target: '参见（Kern 等人，2003b）。', accepted: false },
  { source: 'Read (2003).', target: '参见（2003）。', accepted: false },
  { source: 'Read Kern et al., 2003).', target: '参见 Kern 等人，2003）。', accepted: false },
  {
    source: 'Read (Kern et al., 2003), then (Kern et al., 2004).',
    target: '先参见（Kern 等人，2004），再参见（Kern 等人，2003）。',
    accepted: true
  },
  {
    source: 'Read (Kern et al., 2003) and (Kern et al., 2003).',
    target: '参见（Kern 等人，2003）。',
    accepted: false
  },
  {
    source: 'Read (Kern et al., 2003).',
    target: '参见（Kern 等人，2003）及（Kern 等人，2003）。',
    accepted: false
  }
])(
  'maps closing citation brackets only through full dated identity: $source → $target',
  ({ source, target, accepted }) => {
    const label = source.match(/\d{4}[a-z]?\)/u)![0],
      offset = source.indexOf(label)
    for (const map of [translatedPdfLinkLabel, translatedPdfLinkFragment]) {
      const result = map(source, target, label, offset)
      expect(result).toEqual(
        accepted
          ? { start: target.indexOf(label.replace(')', '）')), text: label.replace(')', '）') }
          : null
      )
      if (result)
        expect(map(target, source, result.text, result.start)).toEqual({
          start: offset,
          text: label
        })
      expect(map(source, target, label, offset + 1)).toBeNull()
    }
  }
)

it('maps repeated complete dated tails by their same-identity occurrence', () => {
  const source = '(Kern et al., 2003) then (Kern et al., 2003)',
    target = '（Kern 等人，2003）再（Kern 等人，2003）',
    label = '2003)'
  for (const map of [translatedPdfLinkLabel, translatedPdfLinkFragment])
    expect(map(source, target, label, source.lastIndexOf(label))).toEqual({
      start: target.lastIndexOf('2003）'),
      text: '2003）'
    })
})

it.each([
  { source: 'Read the revised paper', target: '阅读修订后的论文', accepted: true },
  { source: '  Read the revised paper  ', target: ' 阅读修订后的论文 ', accepted: true },
  { source: 'Read more', target: '阅读更多', accepted: true },
  { source: 'Read the revised paper', target: 'Read the updated article', accepted: true },
  { source: 'Read the revised paper', target: '', accepted: false },
  { source: 'Read the revised paper', target: '译', accepted: false },
  { source: 'Read the revised paper', target: '阅读\u001f论文', accepted: false },
  { source: 'Read the revised paper 2', target: '阅读修订后的论文 3', accepted: false },
  { source: 'Table 2', target: '表 3', accepted: false },
  { source: 'Kern et al.', target: 'Vale 等人', accepted: false },
  { source: 'and De Meulder', target: '和 De Meulder', accepted: false },
  { source: 'Arden Stone Lake', target: '阿登斯通湖', accepted: false },
  { source: 'Read https://example.org/paper', target: '阅读论文', accepted: false },
  {
    source: 'Read the revised paper',
    target: '阅读论文 https://example.org/paper',
    accepted: false
  }
])(
  'maps only a complete unnumbered prose link: $source → $target',
  ({ source, target, accepted }) => {
    const label = source.trim(),
      offset = source.indexOf(label)
    for (const map of [translatedPdfLinkLabel, translatedPdfLinkFragment]) {
      const result = map(source, target, label, offset)
      expect(result).toEqual(
        accepted ? { start: target.indexOf(target.trim()), text: target.trim() } : null
      )
      if (result)
        expect(map(target, source, result.text, result.start)).toEqual({
          start: offset,
          text: label
        })
      expect(map(source, target, label, offset + 1)).toBeNull()
      expect(map(source, target, label.slice(0, -1), offset)).toBeNull()
      expect(map('See ' + source, target, label, offset + 4)).toBeNull()
    }
  }
)

it.each([
  { target: '2020年10月，见［10，11］。', label: '10', accepted: true },
  { target: '2020年10月，见［10，11］。', label: '11', accepted: true },
  { target: '2020年10月，见[10, 11]。', label: '10', accepted: true },
  { target: '2020年10月，见［11，10］。', label: '10', accepted: false },
  { target: '2020年10月，见［10，12］。', label: '10', accepted: false },
  { target: '2020年10月，见［10］。', label: '10', accepted: false },
  { target: '2020年10月，见［10，11，12］。', label: '10', accepted: false },
  { target: '2020年10月，见［10，11。', label: '10', accepted: false },
  { target: '2020年10月，见［10，11］和［10，11］。', label: '10', accepted: false },
  { target: '2020年10月，见［１０，11］。', label: '10', accepted: false }
])(
  'maps a linked numeral only within the identical closed citation list: $target / $label',
  ({ target, label, accepted }) => {
    const source = 'Reports published in October 2020 cite [10, 11].',
      offset = source.indexOf(label),
      proof = translatedPdfBracketedReference(source, target, label, offset)
    if (!accepted) {
      expect(proof).toBeNull()
      return
    }
    expect(proof?.text).toBe(label)
    expect(target.slice(proof!.start, proof!.end)).toBe(label)
    expect(source.slice(proof!.sourceBlock.start, proof!.sourceBlock.end)).toBe('[10, 11]')
    expect(target.slice(proof!.targetBlock.start, proof!.targetBlock.end)).toBe(
      proof!.targetBlock.text
    )
    expect(proof!.start).toBeGreaterThan(target.indexOf('10月'))
    expect(translatedPdfLinkFragment(source, target, label, offset)).toEqual({
      start: proof!.start,
      text: label
    })
  }
)

it.each([
  { source: 'A month 10 precedes [10, 11].', label: '10', offset: 8 },
  { source: 'The source cites [10, 11] and [10, 11].', label: '10', offset: 18 },
  { source: 'The source cites [210, 11].', label: '10', offset: 19 },
  { source: 'The source cites [10, 11.', label: '10', offset: 18 }
])('rejects an unowned or ambiguous bracketed numeral: $source', ({ source, label, offset }) => {
  expect(translatedPdfBracketedReference(source, '引用［10，11］。', label, offset)).toBe(
    source.includes('and [10, 11]') ? null : undefined
  )
})

it('maps repeated complete numeric lists by block occurrence and numeric ordinal', () => {
  const source = 'Read [31] and [31], then [10, 11] and [10, 11].',
    target = '参见［31］及［31］，再参见［10，11］及［10，11］。'
  for (const label of ['31', '10', '11']) {
    for (const offset of [source.indexOf(label), source.lastIndexOf(label)]) {
      const proof = translatedPdfBracketedReference(source, target, label, offset)!
      expect(proof?.start).toBe(
        offset === source.indexOf(label) ? target.indexOf(label) : target.lastIndexOf(label)
      )
      expect(translatedPdfBracketedReference(target, source, label, proof.start)?.start).toBe(
        offset
      )
    }
  }
  expect(
    translatedPdfBracketedReference(
      source,
      target.replace('及［31］', ''),
      '31',
      source.indexOf('31')
    )
  ).toBeNull()
  expect(
    translatedPdfBracketedReference(source, target + '［10，11］', '10', source.indexOf('10'))
  ).toBeNull()
})

it.each(['S2 图', 'S2 圖', 'S2 Figure'])(
  'preserves the complete supplementary figure identity: %s',
  (target) => {
    const source = 'See S2 Fig. for the distribution.',
      translation = `分布见${target}。`
    expect(translatedPdfLinkLabel(source, translation, 'S2 Fig.', 4)).toEqual({
      start: 3,
      text: target
    })
    expect(translatedPdfLinkLabel(translation, source, target, 3)).toEqual({
      start: 4,
      text: 'S2 Fig.'
    })
  }
)

it.each(['S3 图', '图 2', 'S2 表', 'S2 文件', 'S2 图和 S2 图', 'S2 Figurehead', 'S2 Fig.caption'])(
  'rejects changed or ambiguous supplementary figure identity: %s',
  (target) => {
    expect(
      translatedPdfLinkLabel('See S2 Fig. for the distribution.', `分布见${target}。`, 'S2 Fig.', 4)
    ).toBeNull()
  }
)

it.each([
  ['Supplementary Table 2', '补充表 2', true],
  ['Suppl. Table 2', '補充表 2', true],
  ['S1 Table', 'S1 表', true],
  ['S1 Fig', 'S1 图', true],
  ['Supplementary Table 2', '补充表 3', false],
  ['Supplementary Table 2', '表 2', false],
  ['Supplementary Table 2', '补充图 2', false],
  ['S1 Table', 'S1 图', false],
  ['S1 Fig', 'S1 表', false]
])('keeps the supplementary type and complete number: %s → %s', (label, target, accepted) => {
  const result = translatedPdfLinkLabel(`See ${label}.`, `参见${target}。`, label, 4)
  expect(result).toEqual(accepted ? { start: 2, text: target } : null)
})

it.each([
  { target: '结果（Merivan 等，2004；Uve 等，2006；Talenovrin 等，2006）。', accepted: true },
  { target: '结果（Merivan 等，2004；Uve 等，2006；Talenovrin 等，2007）。', accepted: false },
  { target: '结果（Merivan 等，2004；Uve 等，2006；Other 等，2006）。', accepted: false },
  { target: '结果（Merivan 等，2004；Talenovrin 等，2006；Uve 等，2006）。', accepted: false },
  { target: '结果（Merivan 等，2004；Uve 等，2006）；Talenovrin 等，2006）。', accepted: false },
  { target: '结果（Merivan 等，2004；Uve 等，2006；Talenovrin 等，2006）', accepted: false },
  { target: '结果（Talenovrin 等，2006）。', accepted: false },
  { target: '2006）。', accepted: false },
  {
    target:
      '结果（Merivan 等，2004；Uve 等，2006；Talenovrin 等，2006）。再次（Merivan 等，2004；Uve 等，2006；Talenovrin 等，2006）。',
    accepted: false
  }
])(
  'maps a citation-list terminal year and punctuation by complete identity: $target',
  ({ target, accepted }) => {
    const source = 'Results (Merivan et al., 2004; Uve et al., 2006; Talenovrin et al., 2006).',
      offset = source.lastIndexOf('2006'),
      result = translatedPdfLinkFragment(source, target, '2006).', offset)
    expect(result).toEqual(
      accepted ? { start: target.lastIndexOf('2006'), text: '2006）。' } : null
    )
    if (result)
      expect(translatedPdfLinkFragment(target, source, result.text, result.start)).toEqual({
        start: offset,
        text: '2006).'
      })
  }
)

it.each([false, true])(
  'handles an entire fragment owned by a terminal citation link (changed year: %s)',
  async (changedYear) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([612, 792]),
      prefix = 'Results (Merivan et al., 2004; Uve et al., 2006; Talenovrin et al.,',
      tail = '2006).',
      source = `${prefix} ${tail}`,
      translation = `结果（Merivan 等，2004；Uve 等，2006；Talenovrin 等，${changedYear ? '2007' : '2006'}）。`,
      neighbor = 'This separate paragraph remains readable.',
      neighborTranslation = '这个独立段落仍然可以阅读。',
      // The publisher links the year/bracket; the native object also owns its full stop.
      rect = [39, 678, 40 + font.widthOfTextAtSize('2006)', 12), 693],
      url = 'https://example.invalid/talenovrin-2006'
    page.drawText(prefix, { x: 40, y: 700, size: 12, font })
    page.drawText(tail, { x: 40, y: 682, size: 12, font })
    page.drawText(neighbor, { x: 40, y: 620, size: 12, font })
    page.node.set(
      PDFName.of('Annots'),
      pdf.context.obj([
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: rect,
            Border: [0, 0, 0],
            A: { S: 'URI', URI: PDFString.of(url) }
          })
        )
      ])
    )
    const registry = new ApplicationCallerLeaseRegistry(),
      caller = registry.acquire({ leaseId: 'terminal-citation-fragment', surface: 'electron' }),
      writer = new PdfTranslationWriter(() => resolve('resources/pdf-translation/worker.mjs'))
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const output = await writer.generateDetailed(
        {
          id: 'terminal-citation-fragment',
          data: await pdf.save(),
          pages: [{ width: 612, height: 792 }],
          preserveUnsupported: true,
          units: [
            {
              source,
              translation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 40 / 612, y: 80 / 792, width: 530 / 612, height: 16 / 792 }
                },
                {
                  pageNumber: 1,
                  rect: { x: 40 / 612, y: 98 / 792, width: 50 / 612, height: 16 / 792 }
                }
              ]
            },
            {
              source: neighbor,
              translation: neighborTranslation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 40 / 612, y: 160 / 792, width: 400 / 612, height: 30 / 792 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      expect(output?.layoutFailures).toEqual(
        changedYear ? [expect.objectContaining({ unitIndex: 0, code: 'annotations' })] : []
      )
      task = getDocument({ data: output!.data, useSystemFonts: true })
      const target = await (await task.promise).getPage(1),
        text = (await target.getTextContent()).items
          .flatMap((item) => ('str' in item ? [item.str] : []))
          .join('')
          .replace(/\s/gu, ''),
        links = await target.getAnnotations()
      expect(text).toContain((changedYear ? source : translation).replace(/\s/gu, ''))
      expect(text).toContain(neighborTranslation)
      expect(text).not.toContain(changedYear ? '2007' : 'Results')
      if (!changedYear) {
        const items = (await target.getTextContent()).items.filter((item) => 'str' in item),
          year = items.find((item) => item.str.includes('2006）。'))!,
          body = items.find((item) => item.str.startsWith('结果'))!
        // The last source line has no non-link prose. It is still a full-size
        // citation row, not a scientific subscript relative to the prior line.
        expect(Math.abs(year.transform[5] - body.transform[5])).toBeLessThan(3)
      }
      expect(links).toHaveLength(1)
      expect(links[0].url).toBe(url)
      expect(links[0].rect[2] - links[0].rect[0]).toBeCloseTo(rect[2] - rect[0], 3)
      expect(links[0].rect[3] - links[0].rect[1]).toBeCloseTo(rect[3] - rect[1], 3)
    } finally {
      await task?.destroy()
      caller.release()
      registry.dispose()
    }
  }
)

it.each([
  ['第6.1节', true],
  ['第6.1節', true],
  ['Section 6.1', true],
  ['§ 6.1', true],
  ['第6.10节', false],
  ['第6.1.2节', false],
  ['第6.01节', false],
  ['6.1', false],
  ['Sec. 6.1 – 6.3', false],
  ['Sec. 6.1–Sec. 6.3', false],
  ['第6.0节至第6.1节', false],
  ['Sec. 6.1𝑎', false],
  ['Sec. 6.1a', false],
  ['Sec. 6.1–6.3', false],
  ['Sec. 6.1,6.2', false],
  ['Sections 6.1', false],
  ['Subsection 6.1', false],
  ['第6.1节至第6.3节', false],
  ['第6.1节和第6.1节', false],
  ['Sec. 6.1.2 and Section 6.1', true]
] as const)('matches only complete section link identities: %s', (target, accepted) => {
  const source = 'See Sec. 6.1.',
    translation = '参见' + target + '。'
  expect(translatedPdfLinkLabel(source, translation, 'Sec. 6.1', 4)).toEqual(
    accepted
      ? {
          start: translation.indexOf(
            target === 'Sec. 6.1.2 and Section 6.1' ? 'Section 6.1' : target
          ),
          text: target === 'Sec. 6.1.2 and Section 6.1' ? 'Section 6.1' : target
        }
      : null
  )
})

it('keeps section occurrences tied to exact native offsets', () => {
  const source = 'See Sec. 6.1 and Section 6.1.',
    target = '参见第6.1节和第6.1節。'
  expect(translatedPdfLinkLabel(source, target, 'Section 6.1', source.indexOf('Section'))).toEqual({
    start: target.indexOf('第6.1節'),
    text: '第6.1節'
  })
  expect(translatedPdfLinkLabel(source, target, 'Sec. 6.1', 5)).toBeNull()
  expect(translatedPdfLinkLabel(source, '参见第6.1节。', 'Sec. 6.1', 4)).toBeNull()
  for (const source of ['See Sec. 6.1.2.', 'See Sec. 6.1–6.3.', 'See Sec. 6.1,6.2.'])
    expect(translatedPdfLinkLabel(source, '参见第6.1节。', 'Sec. 6.1', 4)).toBeNull()
})

it.each([
  ['第E.2节', true],
  ['第E.2節', true],
  ['Section E.2', true],
  ['§ E.2', true],
  ['第e.2节', false],
  ['第F.2节', false],
  ['第6.2节', false],
  ['第E.20节', false],
  ['第E.2.1节', false],
  ['第E节', false],
  ['第II.2节', false],
  ['E.2', false],
  ['Sec. E.2 – F.1', false],
  ['Sec. D.1–Sec. E.2', false],
  ['第D.1节至第E.2节', false],
  ['第E.2节至第F.1节', false],
  ['Sec. E.2, Section F.1', false],
  ['Sec. E.2.A', false],
  ['Sec. E.2.a', false],
  ['Sec. E.2.A.3', false],
  ['Sec. E.2 / E.3', false],
  ['Sec. E.2𝑎', false],
  ['𝑎Sec. E.2', false],
  ['第E.2节和第E.2节', false]
] as const)('matches complete case-sensitive lettered sections: %s', (target, accepted) => {
  const source = 'See Sec. E.2.',
    translation = `参见${target}。`
  expect(translatedPdfLinkLabel(source, translation, 'Sec. E.2', 4)).toEqual(
    accepted ? { start: 2, text: target } : null
  )
})

it('preserves distinct section and table actions within one native text run', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    page = pdf.addPage([612, 792]),
    destination = pdf.addPage([612, 792]),
    source = 'See Table 2 and Sec. E.2 for results.',
    translation = '结果见表2和第E.2节。',
    labels = ['Table 2', 'Sec. E.2']
  page.drawText(source, { font, size: 12, x: 40, y: 700 })
  page.drawText('Untouched neighbor.', { font, size: 12, x: 40, y: 500 })
  page.node.set(
    PDFName.of('Annots'),
    pdf.context.obj(
      labels.map((label, index) => {
        const x = 40 + font.widthOfTextAtSize(source.slice(0, source.indexOf(label)), 12)
        return pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Border: [0, 0, 0],
            Rect: [x - 1, 697, x + font.widthOfTextAtSize(label, 12) + 1, 711],
            Dest: [destination.ref, PDFName.of('XYZ'), 0, index ? 600 : 700, null]
          })
        )
      })
    )
  )
  const registry = new ApplicationCallerLeaseRegistry(),
    caller = registry.acquire({ leaseId: 'shared-section-run', surface: 'electron' }),
    writer = new PdfTranslationWriter(() => resolve('resources/pdf-translation/worker.mjs')),
    data = await pdf.save(),
    input = {
      id: 'shared-section-run',
      data,
      pages: [
        { width: 612, height: 792 },
        { width: 612, height: 792 }
      ],
      preserveUnsupported: true,
      units: [
        {
          source,
          translation,
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 40 / 612, y: 72 / 792, width: 480 / 612, height: 50 / 792 }
            }
          ]
        }
      ]
    }
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const output = await writer.generate(input, caller.lease)
    task = getDocument({ data: output!, useSystemFonts: true })
    const document = await task.promise,
      targetPage = await document.getPage(1),
      annotations = await targetPage.getAnnotations(),
      items = (await targetPage.getTextContent()).items.filter((item) => 'str' in item)
    expect(
      items
        .map((item) => item.str)
        .join('')
        .replace(/\s/gu, '')
    ).toBe(translation + 'Untouchedneighbor.')
    expect(annotations).toHaveLength(2)
    for (const [index, label] of ['表2', '第E.2节'].entries()) {
      const link = annotations[index],
        text = items.find((item) => item.str === label)
      expect(text).toBeDefined()
      expect(text!.transform[4]).toBeGreaterThanOrEqual(link.rect[0] - 1)
      expect(text!.transform[4] + text!.width).toBeLessThanOrEqual(link.rect[2] + 1)
      expect(link.dest.slice(1)).toEqual([{ name: 'XYZ' }, 0, index ? 600 : 700, null])
      expect(await document.getPageIndex(link.dest[0])).toBe(1)
    }
    for (const bad of ['第e.2节', '第E.20节', '第E.2.1节', '第E.2节和第E.2节']) {
      const retained = await writer.generate(
        {
          ...input,
          units: [{ ...input.units[0], translation: translation.replace('第E.2节', bad) }]
        },
        caller.lease
      )
      expect(retained).toEqual(data)
    }
  } finally {
    await task?.destroy()
    caller.release()
    registry.dispose()
  }
})

it('requires exact complete native occurrence offsets for lettered sections', () => {
  const source = '😀 See Sec. E.2 and Section E.2.',
    target = '😀参见第E.2节和第E.2節。'
  expect(translatedPdfLinkLabel(source, target, 'Section E.2', source.indexOf('Section'))).toEqual({
    start: target.indexOf('第E.2節'),
    text: '第E.2節'
  })
  expect(
    translatedPdfLinkLabel(source, target, 'Section E.2', source.indexOf('Section') - 1)
  ).toBeNull()
  expect(
    translatedPdfLinkLabel(source, '参见第E.2节。', 'Sec. E.2', source.indexOf('Sec.'))
  ).toBeNull()
  for (const source of ['Sec. D.1–Sec. E.2', 'Sec. E.2 – F.1', 'Sec. E.2.1', 'Sec. E.2𝑎'])
    expect(
      translatedPdfLinkLabel(source, '第E.2节', 'Sec. E.2', source.indexOf('Sec. E.2'))
    ).toBeNull()
})

it('rejects unsupported section descendants but keeps sentence-ending periods', () => {
  for (const label of ['Sec. E.2', 'Sec. 6.1']) {
    for (const suffix of ['.a', '.A.3']) {
      expect(
        translatedPdfLinkLabel(label + suffix, '第' + label.slice(5) + '节', label, 0)
      ).toBeNull()
      expect(translatedPdfLinkLabel(label, label + suffix, label, 0)).toBeNull()
    }
    expect(
      translatedPdfLinkLabel(label + '. More results follow.', label + '. See details.', label, 0)
    ).toEqual({ start: 0, text: label })
  }
})

it.each([
  ['附录B', true],
  ['附錄B', true],
  ['APPENDIX B', true],
  ['Appendix b', false],
  ['附录b', false],
  ['附录C', false],
  ['Section B', false],
  ['第B节', false],
  ['B', false],
  ['Appendix BB', false],
  ['Appendix B. 1', false],
  ['Appendix B .1', false],
  ['附录B . 1', false],
  ['Appendix B.1', false],
  ['Appendix B.a', false],
  ['附录B.1', false],
  ['Appendix B-C', false],
  ['Appendix B / C', false],
  ['Appendix A–Appendix B', false],
  ['附录A至附录B', false],
  ['Appendix B, Appendix C', false],
  ['Appendix B𝑎', false],
  ['𝑎Appendix B', false],
  ['Appendix B\u0302', false],
  ['Appendix B′', false],
  ['Appendix B(a)', false],
  ['附录B和附录B', false],
  ['Appendix 𝐁', false],
  ['Appendix Ｂ', false],
  ['Anhang B', false]
] as const)('binds only the complete ASCII appendix identity: %s', (target, accepted) => {
  const source = 'See Appendix B.',
    translation = '参见' + target + '。'
  expect(translatedPdfLinkLabel(source, translation, 'Appendix B', 4)).toEqual(
    accepted ? { start: 2, text: target } : null
  )
})

it('keeps appendix occurrences, source offsets and namespace exact', () => {
  const source = '😀 See Appendix B and Appendix B.',
    target = '😀附录B和附錄B。'
  expect(
    translatedPdfLinkLabel(source, target, 'Appendix B', source.lastIndexOf('Appendix'))
  ).toEqual({ start: target.indexOf('附錄'), text: '附錄B' })
  expect(
    translatedPdfLinkLabel(source, target, 'Appendix B', source.lastIndexOf('Appendix') - 1)
  ).toBeNull()
  expect(
    translatedPdfLinkLabel(source, '附录B', 'Appendix B', source.indexOf('Appendix'))
  ).toBeNull()
  for (const source of [
    'Appendix B.1',
    'Appendix B.a',
    'Appendix B-C',
    'Appendix A–Appendix B',
    '附录A至附录B',
    'Appendix B𝑎'
  ]) {
    const label = source.includes('Appendix B') ? 'Appendix B' : '附录B'
    expect(translatedPdfLinkLabel(source, '附录B', label, source.indexOf(label))).toBeNull()
  }
  expect(
    translatedPdfLinkLabel('See Appendix B. More follows.', '参见附录B。', 'Appendix B', 4)
  ).toEqual({ start: 2, text: '附录B' })
})

it('rejects non-ASCII appendix letters and whitespace-separated descendants', () => {
  for (const source of ['Appendix B. 1', 'Appendix B .1', '附录B . 1']) {
    const label = source.startsWith('附录') ? '附录B' : 'Appendix B'
    expect(translatedPdfLinkLabel(source, '附录B', label, 0)).toBeNull()
  }
  expect(translatedPdfLinkLabel('Appendix K', '附录K', 'Appendix K', 0)).toBeNull()
  expect(
    translatedPdfLinkLabel('Appendix B. The proof follows.', '附录B。', 'Appendix B', 0)
  ).toEqual({ start: 0, text: '附录B' })
})

it.each([
  'Supplementary Appendix B',
  'Suppl. Appendix B',
  '补充附录B',
  '補充附錄B',
  'Appendix B to C',
  'Appendix A to Appendix B'
])(
  'does not conflate a qualified appendix or English range with its plain label: %s',
  (reference) => {
    const label = reference.includes('Appendix B') ? 'Appendix B' : reference.slice(2)
    expect(
      translatedPdfLinkLabel('See ' + reference + '.', '附录B', label, 4 + reference.indexOf(label))
    ).toBeNull()
    expect(translatedPdfLinkLabel('Appendix B', '见' + reference, 'Appendix B', 0)).toBeNull()
  }
)

it.each(
  readPdfTranslationCases<{
    name: string
    source: string
    translation: string
    label: string
    offset: number
    expectedStart: number | null
  }>('compound-year-suffix-link.jsonl')
)(
  'binds a linked year suffix to its complete citation group: $name',
  ({ source, translation, label, offset, expectedStart }) => {
    expect(translatedPdfLinkFragment(source, translation, label, offset)).toEqual(
      expectedStart === null ? null : { start: expectedStart, text: label }
    )
    expect(translatedPdfLinkFragment(source, translation, label, offset + 1)).toBeNull()
  }
)
