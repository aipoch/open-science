import { expect, it } from 'vitest'
import { resolve } from './paths.js'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pdfTranslationLineEnds } from '../resources/line-breaks.mjs'
import { PdfTranslationWriter } from '../src/writer.js'
import { TestCallerRegistry } from './support/callers.js'

const existingEnds = (text: string): number[] => {
  const ends = [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)]
    .map((segment) => segment.index + segment.segment.length)
    .filter(
      (end) =>
        !/[（(［[｛{《「『【“‘]$/u.test(text.slice(0, end).trimEnd()) &&
        !(/[.,]$/u.test(text.slice(0, end)) && /^\d/u.test(text.slice(end))) &&
        !/^[，。！？；：、,.;:!?）)］\]｝}》」』】”’％%]/u.test(text.slice(end).trimStart())
    )
  if (!ends.includes(text.length)) ends.push(text.length)
  return ends
}
it.each(['第23节', '第23節', '第6.1节', '第E.2节', '第G．4．2節', '第 23 节'])(
  'keeps a complete CJK section marker together with independent UTF-16 offsets: %s',
  (marker) => {
    const text = `😀结果（${marker}），仍可继续观察。`,
      start = text.indexOf(marker),
      stop = start + marker.length,
      ends = pdfTranslationLineEnds(text)
    expect(ends.filter((end) => end > start && end < stop)).toEqual([])
    expect(ends).not.toContain(start) // Do not strand the opening parenthesis.
    expect(ends).toContain(text.indexOf('继续') + 1)
    expect(ends).toContain(text.length)
    for (const end of ends) {
      expect(text.slice(0, end).trimEnd()).not.toMatch(/[（(]$/u)
      expect(text.slice(end).trimStart()).not.toMatch(/^[）)，]/u)
    }
  }
)
it.each(['23节', '第23章', '第23', '第E.节', '第２３节', '第二十三节'])(
  'does not add section protection for an unsupported or incomplete marker: %s',
  (marker) => {
    const text = `结果${marker}仍可观察`,
      ends = pdfTranslationLineEnds(text),
      start = text.indexOf(marker)
    expect(ends.some((end) => end > start && end < start + marker.length)).toBe(true)
    expect(ends).toContain(text.indexOf('观察') + 1)
  }
)
it('allows ordinary prose to wrap directly before and after a complete section marker', () => {
  const text = '参见第23节后文',
    start = text.indexOf('第'),
    stop = text.indexOf('节') + 1,
    ends = pdfTranslationLineEnds(text)
  expect(ends).toContain(start)
  expect(ends).toContain(stop)
  expect(ends.filter((end) => end > start && end < stop)).toEqual([])
  expect(ends).toContain(text.length)
})
it.each([
  ['矩阵 R ∈ {0, 1}N×D 的元素', 'R ∈ {0, 1}N×D'],
  ['变量 X∉{1,2} 的结果', 'X∉{1,2}'],
  ['概率 p ∈ {0, 0.5, 1} 随时间变化', 'p ∈ {0, 0.5, 1}']
])('keeps a finite-set membership expression intact: %s', (text, expression) => {
  const start = text.indexOf(expression),
    stop = start + expression.length
  expect(pdfTranslationLineEnds(text).filter((end) => end > start && end < stop)).toEqual([])
  expect(pdfTranslationLineEnds(text)).toContain(text.length)
})
it.each([
  'Long English dictionary words stay together.',
  'BERTBASE ELMo x_i 1.25 80% 10,000',
  'x = y + 1 − 2; n=2041a (8.50%)',
  '日本語かなカナ abc😀 e\u0301',
  '漢\uFE00字 漢\u{E0100}字'
])('does not invent breaks in non-Han words or compound graphemes: %s', (text) => {
  const before = existingEnds(text),
    after = pdfTranslationLineEnds(text)
  for (const end of after.filter((end) => !before.includes(end))) {
    const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)]
    const index = graphemes.findIndex((g) => g.index === end)
    expect(graphemes[index - 1].segment).toMatch(/^\p{Script=Han}$/u)
    expect(graphemes[index].segment).toMatch(/^\p{Script=Han}$/u)
  }
  if (!/\p{Script=Han}/u.test(text)) expect(after.every((end) => before.includes(end))).toBe(true)
})
it.each([
  '−2.5',
  '-0.31±1.19',
  '45–75',
  '8-12',
  '6.02e+23',
  '1.2×10−3',
  '2.5 × 10^−3',
  '6×10⁻³',
  '4^(-3)',
  '2.5^(+3)',
  '4^−2',
  '6×10^(-3)',
  'n = 48',
  'P < .001',
  'r ≥ −0.31',
  'FACT-B',
  'S-ketamine',
  'S-氯',
  'x + y',
  '1+2',
  'r − z',
  'r - z',
  'α × β',
  'TOI = 癌'
])('does not split a scientific token between its parts: %s', (token) => {
  const text = `结果为${token}，继续观察。`,
    start = text.indexOf(token),
    stop = start + token.length
  expect(pdfTranslationLineEnds(text).filter((end) => end > start && end < stop)).toEqual([])
  expect(pdfTranslationLineEnds(text)).toContain(text.length)
})

it('keeps a complete explicit power on one translated PDF row', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman),
    page = pdf.addPage([300, 300]),
    lines = ['Power 4^(-3).', 'We observe stable', 'measurements.'],
    translation = '结果变化比为4^(-3)，并继续观察后续结果。',
    registry = new TestCallerRegistry(),
    caller = registry.acquire({ leaseId: 'power-wrap', surface: 'electron' }),
    writer = new PdfTranslationWriter(() => resolve('resources/worker.mjs'))
  lines.forEach((line, index) => page.drawText(line, { font, size: 8, x: 40, y: 250 - index * 12 }))
  page.drawText('Neighbor 17', { font, size: 8, x: 180, y: 250 })
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const output = await writer.generate(
      {
        id: 'power-wrap',
        data: await pdf.save(),
        preserveUnsupported: true,
        pages: [{ width: 300, height: 300 }],
        units: [
          {
            source: lines.join(' '),
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 40 / 300, y: 40 / 300, width: 68 / 300, height: 50 / 300 }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    task = getDocument({ data: output!, useSystemFonts: true })
    const doc = await task.promise,
      items = (await (await doc.getPage(1)).getTextContent()).items.filter((item) => 'str' in item),
      moved = items.filter((item) => item.str.trim() && item.transform[4] < 120),
      rows = Map.groupBy(moved, (item) => Math.round(item.transform[5] * 100))
    expect(
      moved
        .map((item) => item.str)
        .join('')
        .replace(/\s/gu, '')
    ).toBe(translation)
    expect(rows.size).toBeGreaterThan(1)
    expect(
      [...rows.values()].some((row) =>
        row
          .map((item) => item.str)
          .join('')
          .includes('4^(-3)')
      )
    ).toBe(true)
    expect(items.find((item) => item.str === 'Neighbor 17')?.transform.slice(4)).toEqual([180, 250])
    for (const item of moved) {
      expect(Math.hypot(item.transform[0], item.transform[1])).toBeGreaterThanOrEqual(7.99)
      expect(item.transform[4]).toBeGreaterThanOrEqual(39.99)
      expect(item.transform[4] + item.width).toBeLessThanOrEqual(108.01)
    }
  } finally {
    await task?.destroy()
    caller.release()
    registry.dispose()
  }
})

it.each(['结果显示改善[8–10]。', '结果显示改善（8–10）。', '结果显示改善[8, 10]。'])(
  'keeps a numeric citation with the clause that introduces it: %s',
  (text) => {
    const citation = text.match(/[[(（].*[\])）]/u)![0],
      start = text.indexOf(citation),
      stop = start + citation.length
    expect(pdfTranslationLineEnds(text).filter((end) => end > start && end < stop)).toEqual([])
    expect(
      pdfTranslationLineEnds(text).some(
        (end) => end === start && /[\p{L}\p{N}）)]$/u.test(text.slice(0, end).trimEnd())
      )
    ).toBe(false)
  }
)
it.each(['x + y', 'S-氯胺酮', '差值为 ± 2', '结果 = 值'])(
  'does not leave an operator detached at the end of a line: %s',
  (text) => {
    for (const end of pdfTranslationLineEnds(text).filter((end) => end < text.length))
      expect(text.slice(0, end).trimEnd()).not.toMatch(/[+−\-±∓×÷=<>≤≥≈≠]$/u)
  }
)

it('keeps signs, statistical relations and identifiers intact in actual wrapped PDF rows', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman),
    page = pdf.addPage([300, 300]),
    lines = [
      'Results:',
      'Change -0.31',
      'and +/- 1.19;',
      'n = 48;',
      'P < .001;',
      'range 45-75;',
      'dose -2.5 mg;',
      'FACT-B = score.'
    ],
    translation =
      '根据试验结果，变化为−0.31±1.19，样本n = 48；P < .001。范围45–75岁，剂量−2.5 mg；FACT-B = 评分。',
    registry = new TestCallerRegistry(),
    caller = registry.acquire({ leaseId: 'scientific-wrap', surface: 'electron' }),
    writer = new PdfTranslationWriter(() => resolve('resources/worker.mjs'))
  lines.forEach((line, index) => page.drawText(line, { font, size: 8, x: 40, y: 250 - index * 12 }))
  page.drawText('Neighbor 17', { font, size: 8, x: 180, y: 250 })
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const output = await writer.generate(
      {
        id: 'scientific-wrap',
        data: await pdf.save(),
        preserveUnsupported: true,
        pages: [{ width: 300, height: 300 }],
        units: [
          {
            source: lines.join(' '),
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 40 / 300, y: 40 / 300, width: 70 / 300, height: 98 / 300 }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    task = getDocument({ data: output!, useSystemFonts: true })
    const doc = await task.promise,
      items = (await (await doc.getPage(1)).getTextContent()).items.filter((item) => 'str' in item),
      moved = items.filter((item) => item.str.trim() && item.transform[4] < 120),
      rows = Map.groupBy(moved, (item) => Math.round(item.transform[5] * 100))
    expect(
      moved
        .map((item) => item.str)
        .join('')
        .replace(/\s/gu, '')
    ).toBe(translation.replace(/\s/gu, ''))
    expect(rows.size).toBeGreaterThan(1)
    const rowText = [...rows.values()].map((row) => row.map((item) => item.str).join(''))
    for (const token of ['−0.31±1.19', 'n = 48', 'P < .001', '45–75', '−2.5', 'FACT-B'])
      expect(
        rowText.some((row) => row.replace(/\s/gu, '').includes(token.replace(/\s/gu, '')))
      ).toBe(true)
    for (const row of rowText) expect(row.trimEnd()).not.toMatch(/[+−\-±∓×÷=<>≤≥≈≠]$/u)
    expect(items.find((item) => item.str === 'Neighbor 17')?.transform.slice(4)).toEqual([180, 250])
    for (const item of moved) {
      expect(Math.hypot(item.transform[0], item.transform[1])).toBeGreaterThanOrEqual(7.99)
      expect(item.transform[4]).toBeGreaterThanOrEqual(39.99)
      expect(item.transform[4] + item.width).toBeLessThanOrEqual(110.01)
    }
  } finally {
    await task?.destroy()
    caller.release()
    registry.dispose()
  }
})
it.each(['主要结果（可信度），仍不明确。', '结果为 1.25，参考[8]；风险 80%。'])(
  'keeps closing punctuation and decimals together: %s',
  (text) => {
    for (const end of pdfTranslationLineEnds(text).filter((end) => end < text.length)) {
      expect(text.slice(0, end).trimEnd()).not.toMatch(/[（(［[｛{《「『【“‘]$/u)
      expect(text.slice(end).trimStart()).not.toMatch(
        /^[，。！？；：、,.;:!?）)］\]｝}》」』】”’％%]/u
      )
      expect(text.slice(0, end)).not.toMatch(/\d[.,]$/u)
    }
  }
)
it('adds legal Han boundaries inside a dictionary word', () => {
  const text = '可信度不明确',
    before = existingEnds(text),
    after = pdfTranslationLineEnds(text)
  expect(after).toEqual([1, 2, 3, 4, 5, 6])
  expect(after.length).toBeGreaterThan(before.length)
})
it.each([
  ['cjk', '主要评价结果的可信度仍然不明确', true],
  ['punctuation', '主要评价结果，可信度不明确。', true],
  ['too-tall', '主要评价结果的可信度仍然不明确主要评价结果的可信度仍然不明确', false],
  ['english', 'supercalifragilistic', false],
  ['number', '1234567890123456789', false],
  ['identifier', 'x1234567890123456789', false],
  ['mixed-identifier', '变量x1234567890123456789', false],
  ['mixed-English', '结果supercalifragilistic', false],
  ['decimal', '1234567890.1234567890', false]
] as const)(
  'fits only safe ink in the unchanged narrow source box: %s',
  async (_kind, translation, accepted) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      page = pdf.addPage([300, 200]),
      registry = new TestCallerRegistry(),
      caller = registry.acquire({ leaseId: 'cjk-wrap', surface: 'electron' }),
      lines = ['unclear result', 'in one or more', 'main domains'],
      point = 6.3759,
      rect = { x: 40 / 300, y: 45 / 200, width: 42.7 / 300, height: 24.2 / 200 }
    lines.forEach((line, index) =>
      page.drawText(line, { font, size: point, x: 40, y: 150 - index * 8.56 })
    )
    page.drawText('Neighbor 17', { font, size: point, x: 100, y: 150 })
    const data = await pdf.save(),
      writer = new PdfTranslationWriter(() => resolve('resources/worker.mjs'))
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const output = await writer.generate(
        {
          id: 'cjk-wrap',
          data,
          preserveUnsupported: true,
          pages: [{ width: 300, height: 200 }],
          units: [{ source: lines.join(' '), translation, fragments: [{ pageNumber: 1, rect }] }]
        },
        caller.lease
      )
      if (!accepted) {
        expect(output).toEqual(data)
        return
      }
      task = getDocument({ data: output!, useSystemFonts: true })
      const doc = await task.promise,
        items = (await (await doc.getPage(1)).getTextContent()).items.filter((i) => 'str' in i),
        moved = items.filter((i) => i.str.trim() && i.transform[4] < 90)
      expect(
        moved
          .map((i) => i.str)
          .join('')
          .replace(/\s/gu, '')
      ).toBe(translation)
      expect(items.find((i) => i.str === 'Neighbor 17')?.transform.slice(4)).toEqual([100, 150])
      for (const item of moved) {
        expect(item.str.trimStart()).not.toMatch(/^[，。！？；：、,.;:!?）)］\]｝}》」』】”’％%]/u)
        expect(item.str.trimEnd()).not.toMatch(/[（(［[｛{《「『【“‘]$/u)
        expect(Math.hypot(item.transform[0], item.transform[1])).toBeGreaterThanOrEqual(
          point - 0.01
        )
        expect(item.transform[4]).toBeGreaterThanOrEqual(39.99)
        expect(item.transform[4] + item.width).toBeLessThanOrEqual(82.71)
        expect(item.transform[5]).toBeGreaterThanOrEqual(130.79)
        expect(item.transform[5]).toBeLessThanOrEqual(155.01)
      }
    } finally {
      await task?.destroy()
      caller.release()
      registry.dispose()
    }
  }
)

it.each([
  ['narrow scientific ranges', '有氧运动 – 150分钟（60–80 % HRM） RET – 每组8–12次，共3组', true],
  [
    'insufficient cell height',
    '有氧运动 – 150分钟（60–80 % HRM） RET – 每组8–12次，共3组'.repeat(2),
    false
  ],
  ['tall native glyph rows', '汉Ǘgj '.repeat(12).trimEnd(), false],
  ['ASCII keeps normal leading', 'REST 8–12 '.repeat(7).trimEnd(), false]
] as const)(
  'retries only safe compact CJK ink after normal leading fails: %s',
  async (_name, translation, accepted) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      page = pdf.addPage([300, 300]),
      point = 6.3759,
      lines = ['Aerobic -', '150 min (60-', '80 % HRM)', 'RET - 8-12', '3 sets'],
      rect = { x: 40 / 300, y: (300 - 255.42) / 300, width: 40.179 / 300, height: 41.313 / 300 },
      registry = new TestCallerRegistry(),
      caller = registry.acquire({ leaseId: 'compact-cjk-leading', surface: 'electron' })
    lines.forEach((line, index) =>
      page.drawText(line, { font, size: point, x: 40, y: 250 - index * 8.56 })
    )
    page.drawText('Neighbor 17', { font, size: point, x: 95, y: 250 })
    page.drawText('Lower neighbor', { font, size: point, x: 40, y: 204 })
    const data = await pdf.save()
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const output = await new PdfTranslationWriter(() => resolve('resources/worker.mjs')).generate(
        {
          id: 'compact-cjk-leading',
          data,
          preserveUnsupported: true,
          pages: [{ width: 300, height: 300 }],
          units: [{ source: lines.join(' '), translation, fragments: [{ pageNumber: 1, rect }] }]
        },
        caller.lease
      )
      if (!accepted) {
        expect(output).toEqual(data)
        return
      }
      task = getDocument({ data: output!, useSystemFonts: true })
      const document = await task.promise,
        items = (await (await document.getPage(1)).getTextContent()).items.filter(
          (item) => 'str' in item
        ),
        moved = items.filter(
          (item) => item.str.trim() && item.transform[4] < 90 && item.transform[5] > 210
        ),
        rows = Map.groupBy(moved, (item) => Math.round(item.transform[5] * 100))
      expect(
        moved
          .map((item) => item.str)
          .join('')
          .replace(/\s/gu, '')
      ).toBe(translation.replace(/\s/gu, ''))
      expect(rows.size).toBe(6)
      const rowText = [...rows.values()].map((row) => row.map((item) => item.str).join(''))
      for (const token of ['60–80 %', '8–12'])
        expect(
          rowText.some((row) => row.replace(/\s/gu, '').includes(token.replace(/\s/gu, '')))
        ).toBe(true)
      const baselines = [...rows.keys()].sort((a, b) => b - a)
      for (let i = 1; i < baselines.length; i++)
        expect((baselines[i - 1] - baselines[i]) / 100).toBeCloseTo(point * 1.1, 1)
      for (const item of moved) {
        expect(Math.hypot(item.transform[0], item.transform[1])).toBeCloseTo(point, 2)
        expect(item.transform[4]).toBeGreaterThanOrEqual(39.99)
        expect(item.transform[4] + item.width).toBeLessThanOrEqual(80.189)
      }
      expect(items.find((item) => item.str === 'Neighbor 17')?.transform.slice(4)).toEqual([
        95, 250
      ])
      expect(items.find((item) => item.str === 'Lower neighbor')?.transform.slice(4)).toEqual([
        40, 204
      ])
    } finally {
      await task?.destroy()
      caller.release()
      registry.dispose()
    }
  }
)

it.each(['Mhalo/a0', 'α / β', 'x/2', '5/y'])(
  'keeps a complete literal ratio atomic among CJK prose: %s',
  (ratio) => {
    const text = `实际比例为${ratio}，随后继续。`,
      start = text.indexOf(ratio)
    expect(
      pdfTranslationLineEnds(text).filter((i) => i > start && i < start + ratio.length)
    ).toEqual([])
    expect(pdfTranslationLineEnds(text)).toContain(text.length)
  }
)
it('keeps a native numerator script and denominator together across anchor seams in an actual wrapped PDF', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman),
    page = pdf.addPage([240, 240])
  page.drawText('Measured ratio:', { font, size: 10, x: 40, y: 190 })
  page.drawText('M', { font, size: 10, x: 40, y: 176 })
  page.drawText('halo', { font, size: 7, x: 49, y: 174.5 })
  page.drawText('/a', { font, size: 10, x: 62, y: 176 })
  page.drawText('0', { font, size: 7, x: 71, y: 174.5 })
  page.drawText('is measured.', { font, size: 10, x: 40, y: 162 })
  page.drawText('Neighbor', { font, size: 10, x: 155, y: 190 })
  const data = await pdf.save(),
    registry = new TestCallerRegistry(),
    caller = registry.acquire({ leaseId: 'ratio-wrap', surface: 'electron' }),
    writer = new PdfTranslationWriter(() => resolve('resources/worker.mjs'))
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const translation = '测量值 Mhalo/a0，数值继续分析。'
    const output = await writer.generate(
      {
        id: 'ratio-wrap',
        data,
        pages: [{ width: 240, height: 240 }],
        units: [
          {
            source: 'Measured ratio: Mhalo/a0 is measured.',
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 39 / 240, y: 41 / 240, width: 64 / 240, height: 44 / 240 }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    task = getDocument({ data: output!, useSystemFonts: true })
    const doc = await task.promise,
      items = (await (await doc.getPage(1)).getTextContent()).items.filter((i) => 'str' in i),
      translated = items.filter((i) => i.str.trim() && i.transform[4] < 120),
      text = translated
        .map((i) => i.str)
        .join('')
        .replace(/\s/gu, '')
    expect(text).toBe(translation.replace(/\s/gu, ''))
    const numerator = translated.find((i) => i.str === 'halo')!,
      denominator = translated.find((i) => i.str === '0')!
    expect(numerator).toBeDefined()
    expect(denominator).toBeDefined()
    expect(numerator.transform[5]).toBeCloseTo(denominator.transform[5], 2)
    expect(items.find((i) => i.str === 'Neighbor')?.transform.slice(4)).toEqual([155, 190])
  } finally {
    await task?.destroy()
    caller.release()
    registry.dispose()
  }
})

it.each([0, 0.126])(
  'keeps original advance and ink frames when a ragged paragraph returns with a %spt inset',
  async (inset) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      page = pdf.addPage([300, 200]),
      first = 'A short note explains the method and describes the measured results.',
      last = 'Further details are available.',
      translation = '1这条简短注释说明研究方法，并介绍测量结果。进一步的详细说明仍可供参考。',
      fragments = [
        {
          pageNumber: 1,
          rect: { x: 40 / 300, y: 43.5 / 200, width: 210 / 300, height: 9.2 / 200 }
        },
        {
          pageNumber: 1,
          rect: { x: (40 + inset) / 300, y: 52.8 / 200, width: 130 / 300, height: 8.2 / 200 }
        }
      ]
    page.drawText('1', { font, size: 5, x: 40, y: 153 })
    page.drawText(first, { font, size: 7.17, x: 42.2, y: 150 })
    page.drawText(last, { font, size: 7.17, x: 40 + inset, y: 141.4 })
    page.drawText('Neighbor 17', { font, size: 8, x: 40, y: 116 })
    const data = await pdf.save(),
      originalBytes = data.slice(),
      registry = new TestCallerRegistry(),
      caller = registry.acquire({ leaseId: 'ragged-row-frames', surface: 'electron' }),
      writer = new PdfTranslationWriter(() => resolve('resources/worker.mjs')),
      unit = { source: '1' + first + ' ' + last, translation, fragments }
    let before: ReturnType<typeof getDocument> | undefined,
      after: ReturnType<typeof getDocument> | undefined
    try {
      const output = await writer.generate(
        { id: 'ragged-row-frames', data, pages: [{ width: 300, height: 200 }], units: [unit] },
        caller.lease
      )
      expect(data).toEqual(originalBytes)
      before = getDocument({ data: data.slice(), useSystemFonts: true })
      after = getDocument({ data: output!.slice(), useSystemFonts: true })
      const original = await before.promise,
        translated = await after.promise,
        sourceItems = (await (await original.getPage(1)).getTextContent()).items.filter(
          (i) => 'str' in i
        ),
        items = (await (await translated.getPage(1)).getTextContent()).items.filter(
          (i) => 'str' in i
        ),
        target = items.filter((i) => /\p{Script=Han}/u.test(i.str)),
        frames = fragments.map((f) => ({
          left: f.rect.x * 300,
          right: (f.rect.x + f.rect.width) * 300,
          top: 200 - f.rect.y * 200,
          bottom: 200 - (f.rect.y + f.rect.height) * 200
        }))
      expect(target).toHaveLength(2)
      expect(
        items
          .filter((i) => i.str.trim() && i.transform[4] < 260 && i.transform[5] > 130)
          .map((i) => i.str)
          .join('')
          .replace(/\s/gu, '')
      ).toBe(translation)
      for (const item of target) {
        expect(item.transform[0]).toBeCloseTo(8, 3)
        const [x, y] = item.transform.slice(4)
        expect(
          frames.filter(
            (f) =>
              x >= f.left - 0.001 &&
              x + item.width <= f.right + 0.001 &&
              y >= f.bottom - 0.001 &&
              y <= f.top + 0.001
          )
        ).toHaveLength(1)
      }
      expect(items.find((i) => i.str === 'Neighbor 17')?.transform).toEqual(
        sourceItems.find((i) => i.str === 'Neighbor 17')?.transform
      )
      // The owned footnote marker can follow its translated row vertically;
      // its original glyph size and horizontal origin remain intact.
      expect(items.find((i) => i.str === '1')?.transform.slice(0, 5)).toEqual(
        sourceItems.find((i) => i.str === '1')?.transform.slice(0, 5)
      )
      const { pathToFileURL } = await import('node:url'),
        { engine } = await import(
          /* @vite-ignore */ pathToFileURL(resolve('resources/pdfium.mjs')).href
        ),
        native = await engine(),
        input = native.open(output!),
        nativePage = native.p.FPDF_LoadPage(input.doc, 0)
      try {
        const ink = native
          .objects(nativePage)
          .filter(
            (o: { type: number; text: string }) => o.type === 1 && /\p{Script=Han}/u.test(o.text)
          )
        expect(ink).toHaveLength(2)
        for (const object of ink) {
          const [left, bottom, right, top] = object.bounds
          expect(
            frames.filter(
              (f) =>
                left >= f.left - 0.001 &&
                right <= f.right + 0.001 &&
                bottom >= f.bottom - 0.001 &&
                top <= f.top + 0.001
            )
          ).toHaveLength(1)
        }
      } finally {
        native.p.FPDF_ClosePage(nativePage)
        input.close()
      }
    } finally {
      await before?.destroy()
      await after?.destroy()
      caller.release()
      registry.dispose()
    }
  }
)
