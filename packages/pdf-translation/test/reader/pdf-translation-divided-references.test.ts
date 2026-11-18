import { expect, test } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'
import { dividedNativeReferences } from '../fixtures/divided-native-references.js'

test.each(['one-rule', 'redundant-rules', 'renamed-font-ids'])(
  'keeps a complete native divided bibliography original without changing its ordinary source: %s',
  async (mode) => {
    const fixture = dividedNativeReferences()
    if (mode === 'redundant-rules') {
      fixture.operators.fnArray.push(OPS.constructPath, OPS.constructPath)
      fixture.operators.argsArray.push(
        [OPS.stroke, [new Float32Array([0, 210, 400, 1, 390, 400])]],
        [OPS.stroke, [new Float32Array([0, 240, 400, 1, 360, 400])]]
      )
    }
    if (mode === 'renamed-font-ids') {
      for (const [id, font] of Object.entries(fixture.fonts)) {
        fixture.fonts['arbitrary-' + id] = font
        fixture.styles['arbitrary-' + id] = fixture.styles[id]
        delete fixture.fonts[id]
        delete fixture.styles[id]
      }
      for (const item of fixture.items) item.fontName = 'arbitrary-' + item.fontName
    }
    const result = await extractPdfTranslationSource({
      document: fixture.document,
      resourceRequestKey: 'anonymous',
      signal: new AbortController().signal
    })
    const references = result.source.units.filter((u) =>
      u.fragments.some((f) => f.items.some((i) => i.index >= 3))
    )
    expect(references.length).toBeGreaterThan(8)
    expect(references.every((u) => u.sourceOnly)).toBe(true)
    expect(
      result.source.units.find((u) => u.source.startsWith('The independent'))?.sourceOnly
    ).toBeUndefined()
    expect(result.coverage.warnings.some((w) => w.reasons.includes('ambiguous-line-hyphen'))).toBe(
      true
    )
    expect(result.coverage.excludedItemCount).toBe(0)
    expect(result.source.units.flatMap((u) => u.fragments.flatMap((f) => f.items))).toHaveLength(
      fixture.items.length
    )
  }
)

test.each([
  'ordinary',
  'author-comma',
  'missing-rule',
  'clip',
  'alpha',
  'missing-font',
  'zero-metric',
  'number-gap',
  'font-role-conflict',
  'occluding-fill'
])('refuses an incomplete divided reference proof: %s', async (mode) => {
  const fixture = dividedNativeReferences()
  if (mode === 'ordinary') fixture.items[3].str = '[1] ' + fixture.ordinary
  if (mode === 'author-comma') fixture.items[3].str = '[1] A. Writer, ' + fixture.ordinary
  if (mode === 'missing-rule')
    fixture.operators.fnArray.length = fixture.operators.argsArray.length = 0
  if (mode === 'clip') {
    fixture.operators.fnArray.unshift(OPS.clip)
    fixture.operators.argsArray.unshift([])
  }
  if (mode === 'alpha') {
    fixture.operators.fnArray.unshift(OPS.setGState)
    fixture.operators.argsArray.unshift([[['ca', 0.5]]])
  }
  if (mode === 'missing-font') delete fixture.fonts.Volume
  if (mode === 'zero-metric') {
    fixture.fonts.Body.ascent = 0
    fixture.styles.Body.ascent = 0
  }
  if (mode === 'number-gap')
    fixture.items.find((i) => i.str.startsWith('[5]'))!.str = '[9] A. Writer, Unclosed record.'
  if (mode === 'font-role-conflict')
    for (const item of fixture.items) if (item.fontName === 'Title') item.fontName = 'Volume'
  if (mode === 'occluding-fill') {
    fixture.operators.fnArray.push(OPS.setFillRGBColor, OPS.constructPath)
    fixture.operators.argsArray.push(
      ['#ffffff'],
      [OPS.fill, [new Float32Array([0, 180, 399, 1, 420, 399, 1, 420, 401, 1, 180, 401, 4])]]
    )
  }
  const result = await extractPdfTranslationSource({
    document: fixture.document,
    resourceRequestKey: 'anonymous',
    signal: new AbortController().signal
  })
  expect(
    result.source.units.filter((u) => !u.sourceOnly).some((u) => u.source.startsWith('[1]'))
  ).toBe(true)
})

test.each(['supplement header', 'body mention', 'missing divider'])(
  'retains complete divided references only before an independent supplement opener: %s',
  async (mode) => {
    const fixture = dividedNativeReferences()
    const peers = fixture.items.slice(-5, -2)
    for (let n = 9; n <= 12; n++)
      fixture.items.push(
        ...peers.map((item, index) => {
          const transform = [...item.transform]
          transform[5] -= (n - 7) * 20
          return {
            ...item,
            transform,
            str: index === 0 ? item.str.replace(/^\[\d+\]/u, `[${n}]`) : item.str
          }
        })
      )
    if (mode === 'missing divider')
      fixture.operators.fnArray.length = fixture.operators.argsArray.length = 0
    const [folio, , prototype] = fixture.items
    const page2 = [
      { ...folio, str: '2' },
      {
        ...prototype,
        str: 'Supplementary Material for A New Study',
        width: 220,
        transform: [16, 0, 0, 16, 60, mode === 'body mention' ? 580 : 740],
        height: 16
      },
      { ...prototype, str: 'The supplementary discussion compares additional measurements.' }
    ]
    const getPage = fixture.document.getPage.bind(fixture.document)
    fixture.document.getPage = async (number) =>
      number === 1
        ? getPage(1)
        : ({
            ...fixture.page,
            getTextContent: async () => ({ items: page2, styles: fixture.styles }),
            getOperatorList: async () => ({ fnArray: [], argsArray: [] })
          } as unknown as Awaited<ReturnType<typeof getPage>>)
    Object.defineProperty(fixture.document, 'numPages', { value: 2 })
    const result = await extractPdfTranslationSource({
      document: fixture.document,
      resourceRequestKey: 'anonymous',
      signal: new AbortController().signal
    })
    const references = result.source.units.filter((unit) =>
      /^\[\d+\] A\. Writer/u.test(unit.source)
    )
    expect(references).toHaveLength(12)
    expect(references.every((unit) => unit.sourceOnly)).toBe(mode === 'supplement header')
    expect(
      result.source.units.some(
        (unit) =>
          unit.source.includes('supplementary discussion') &&
          unit.fragments[0].pageNumber === 2 &&
          !unit.sourceOnly
      )
    ).toBe(true)
  }
)

test.each([
  'complete',
  'missing-divider',
  'wrong-folio',
  'number-gap',
  'unquoted-title',
  'running-prose',
  'hanging-prose'
])(
  'retains terminal unheaded divided references only with a complete native packet: %s',
  async (mode) => {
    const fixture = dividedNativeReferences()
    const [folio, ordinary] = fixture.items
    const references = [{ ...folio, str: mode === 'wrong-folio' ? '7' : '2' }]
    for (let n = 1; n <= 8; n++) {
      const x = n <= 4 ? 60 : 330,
        y = 300 - ((n - 1) % 4) * 20,
        ordinal = mode === 'number-gap' && n === 5 ? 10 : n,
        title = mode === 'unquoted-title' && n === 5 ? 'An ordinary claim' : '“A native result,”'
      references.push(
        {
          ...ordinary,
          str: `[${ordinal}] Writer, A., ${title} Journal of Examples`,
          height: 8,
          width: 205,
          transform: [8, 0, 0, 8, x, y]
        },
        {
          ...ordinary,
          str: '10',
          height: 8,
          width: 8,
          fontName: 'Volume',
          hasEOL: false,
          transform: [8, 0, 0, 8, x + 20, y - 10]
        },
        {
          ...ordinary,
          str: ', 21 (2020).',
          height: 8,
          width: 95,
          transform: [8, 0, 0, 8, x + 30, y - 10]
        }
      )
    }
    if (mode === 'hanging-prose')
      references.push({
        ...ordinary,
        str: 'An unrelated sentence with the same hanging indentation.',
        width: 220,
        height: 8,
        transform: [8, 0, 0, 8, 350, 220]
      })
    if (mode === 'running-prose')
      references.splice(1, 0, {
        ...ordinary,
        str: 'An unrelated ordinary paragraph appears before the dividing rule.'
      })
    fixture.document.getPage = async (number) =>
      ({
        ...fixture.page,
        getTextContent: async () => ({
          styles: fixture.styles,
          items: number === 1 ? [folio, ordinary] : references
        }),
        getOperatorList: async () =>
          number === 2 && mode !== 'missing-divider'
            ? fixture.operators
            : { fnArray: [], argsArray: [] }
      }) as unknown as Awaited<ReturnType<typeof fixture.document.getPage>>
    Object.defineProperty(fixture.document, 'numPages', { value: 2 })
    const result = await extractPdfTranslationSource({
      document: fixture.document,
      resourceRequestKey: 'anonymous',
      signal: new AbortController().signal
    })
    const records = result.source.units.filter((unit) => /^\[\d+\] Writer,/u.test(unit.source))
    expect(records).toHaveLength(8)
    expect(records.every((unit) => unit.sourceOnly)).toBe(mode === 'complete')
    expect(
      result.source.units.find((unit) => unit.source === ordinary.str)?.sourceOnly
    ).toBeUndefined()
    expect(result.coverage.excludedItemCount).toBe(0)
  }
)

test.each(['complete', 'open-prose', 'malformed-preprint'])(
  'retains a complete terminal mixed bibliography below closed prose: %s',
  async (mode) => {
    const fixture = dividedNativeReferences()
    const [folio, ordinary] = fixture.items
    const terminal = [{ ...folio, str: '2' }]
    for (const x of [60, 330])
      for (const y of [720, 706])
        terminal.push({
          ...ordinary,
          str:
            x === 330 && y === 706 && mode === 'open-prose'
              ? 'the independent discussion remains open'
              : 'The independent discussion compares the previous measurements.',
          width: 205,
          transform: [12, 0, 0, 12, x, y]
        })
    for (let n = 1; n <= 12; n++) {
      const x = n <= 6 ? 60 : 330,
        y = 300 - ((n - 1) % 6) * 20,
        add = (
          str: string,
          left: number,
          baseline: number,
          width: number,
          fontName = 'Body',
          hasEOL = true
        ): void => {
          terminal.push({
            ...ordinary,
            str,
            fontName,
            hasEOL,
            width,
            height: 8,
            transform: [8, 0, 0, 8, left, baseline]
          })
        }
      add(`[${n}] A. Writer, Measured response, Independent Journal`, x, y, 220)
      if (n === 12) {
        add('External preprint', x + 20, y - 10, 58, 'Body', false)
        add(
          mode === 'malformed-preprint'
            ? 'arXiv:placeholder [math-ph].'
            : 'arXiv:0000.00000 [math-ph].',
          x + 91,
          y - 10,
          100
        )
      } else {
        add(String(n + 10), x + 20, y - 10, 8, 'Volume', false)
        add(', 123 (2020).', x + 30, y - 10, 100)
      }
    }
    fixture.document.getPage = async (number) =>
      ({
        ...fixture.page,
        getTextContent: async () => ({
          styles: fixture.styles,
          items: number === 1 ? [folio, ordinary] : terminal
        }),
        getOperatorList: async () =>
          number === 2 ? fixture.operators : { fnArray: [], argsArray: [] }
      }) as unknown as Awaited<ReturnType<typeof fixture.document.getPage>>
    Object.defineProperty(fixture.document, 'numPages', { value: 2 })
    const result = await extractPdfTranslationSource({
      document: fixture.document,
      resourceRequestKey: 'anonymous',
      signal: new AbortController().signal
    })
    const records = result.source.units.filter((u) => /^\[\d+\] A\. Writer/u.test(u.source))
    expect(records).toHaveLength(12)
    expect(records.every((u) => u.sourceOnly)).toBe(mode === 'complete')
    expect(
      result.source.units.find((u) => u.source.startsWith('The independent discussion compares'))
        ?.sourceOnly
    ).toBeUndefined()
    expect(result.coverage.excludedItemCount).toBe(0)
  }
)
