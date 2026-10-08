import { describe, expect, it, vi } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import {
  isCurrentTranslation,
  isPdfTranslationResultExtension,
  bindPdfTranslation,
  createPdfTranslationBinder,
  createPdfTranslationSource,
  type PdfTranslation,
  type PdfTranslationResults
} from './pdf-translation'

const input = (): PdfTranslation => ({
  resourceRequestKey: 'version:0',
  fingerprint: 'fingerprint',
  pages: [{ width: 600, height: 800 }],
  units: [
    {
      id: 'p1',
      source: 'A result.',
      translationSource: 'A result.',
      translation: '一项结果。',
      fragments: [
        {
          pageNumber: 1,
          rect: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 },
          items: [{ index: 0, text: 'A result.' }]
        }
      ]
    }
  ]
})
const pdf = (): Pick<PDFDocumentProxy, 'numPages' | 'fingerprints' | 'getPage'> =>
  ({
    numPages: 1,
    fingerprints: ['fingerprint'],
    getPage: vi.fn().mockResolvedValue({
      getViewport: () => ({ width: 600, height: 800 }),
      getTextContent: vi.fn().mockResolvedValue({ items: [{ str: 'A result.' }] }),
      cleanup: vi.fn()
    })
  }) as unknown as Pick<PDFDocumentProxy, 'numPages' | 'fingerprints' | 'getPage'>

const verifyPdfTranslation = async (
  data: PdfTranslation,
  document: ReturnType<typeof pdf>,
  key: string,
  signal: AbortSignal
): Promise<boolean> => {
  const source = createPdfTranslationSource(data)
  return Boolean(
    await bindPdfTranslation(source, { source, units: data.units }, document, key, signal)
  )
}

describe('in-memory PDF translation boundary', () => {
  it('keeps a verified snapshot when parallel results fill earlier gaps or repair translations', () => {
    const source = createPdfTranslationSource(input())
    const previous = { source, units: input().units }
    const current = {
      source,
      units: [{ ...previous.units[0], id: 'earlier' }, ...previous.units]
    }
    expect(isPdfTranslationResultExtension(previous, current)).toBe(true)
    const repaired = {
      ...current,
      units: current.units.map((unit) => ({ ...unit, translation: '修订译文。' }))
    }
    expect(isPdfTranslationResultExtension(previous, repaired)).toBe(false)
    expect(isPdfTranslationResultExtension(previous, repaired, true)).toBe(true)
  })

  it.each(['new source', 'reset', 'removed unit', 'changed source text', 'duplicate unit'])(
    'does not retain a previous snapshot after %s',
    (reason) => {
      const source = createPdfTranslationSource(input())
      const previous = { source, units: input().units }
      const current = { source, units: [...previous.units] }
      if (reason === 'new source') current.source = createPdfTranslationSource(input())
      if (reason === 'reset') current.units = []
      if (reason === 'removed unit') current.units = [{ ...current.units[0], id: 'other' }]
      if (reason === 'changed source text')
        current.units = [{ ...current.units[0], translationSource: 'Changed source.' }]
      if (reason === 'duplicate unit') current.units.push(current.units[0])
      expect(isPdfTranslationResultExtension(previous, current, true)).toBe(false)
    }
  )

  it('accepts exact source evidence and leaves shared page lifetime with the reader', async () => {
    const document = pdf()
    expect(
      await verifyPdfTranslation(input(), document, 'version:0', new AbortController().signal)
    ).toBe(true)
    expect((await document.getPage(1)).cleanup).not.toHaveBeenCalled()
  })
  it.each([
    'wrong version',
    'wrong fingerprint',
    'missing page',
    'invalid bounds',
    'unknown item',
    'changed text',
    'duplicate ownership',
    'duplicate unit',
    'empty source'
  ])('rejects %s', async (reason) => {
    const original = input()
    const data = {
      ...original,
      pages: [...original.pages],
      units: original.units.map((unit) => ({
        ...unit,
        fragments: unit.fragments.map((f) => ({
          ...f,
          rect: { ...f.rect },
          items: f.items.map((item) => ({ ...item }))
        }))
      }))
    }
    if (reason === 'wrong version') data.resourceRequestKey = 'other:0'
    if (reason === 'wrong fingerprint') data.fingerprint = 'other'
    if (reason === 'missing page') data.pages = []
    if (reason === 'invalid bounds') data.units[0].fragments[0].rect.x = NaN
    if (reason === 'unknown item') data.units[0].fragments[0].items[0].index = 2
    if (reason === 'changed text') data.units[0].fragments[0].items[0].text = 'Other source.'
    if (reason === 'duplicate ownership') data.units.push({ ...data.units[0], id: 'second' })
    if (reason === 'duplicate unit') data.units.push({ ...data.units[0] })
    if (reason === 'empty source') data.units[0].source = ' '
    expect(await verifyPdfTranslation(data, pdf(), 'version:0', new AbortController().signal)).toBe(
      false
    )
  })
  it('keeps old-source translations review-only', () => {
    expect(
      isCurrentTranslation({ ...input().units[0], translationSource: 'Previous source.' })
    ).toBe(false)
    expect(isCurrentTranslation({ ...input().units[0], translation: ' ' })).toBe(false)
  })
  it('stops before parsing a page when cancellation arrives during page acquisition', async () => {
    const controller = new AbortController(),
      document = pdf()
    const text = vi.fn()
    vi.mocked(document.getPage).mockImplementation(async () => {
      controller.abort()
      return { getTextContent: text } as unknown as Awaited<ReturnType<PDFDocumentProxy['getPage']>>
    })
    expect(await verifyPdfTranslation(input(), document, 'version:0', controller.signal)).toBe(
      false
    )
    expect(text).not.toHaveBeenCalled()
  })
})

describe('owned source and result binding', () => {
  it('freezes source-only restrictions and rejects a result attempting to override them', async () => {
    const original = input(),
      document = pdf()
    const unit = { ...original.units[0], sourceOnly: true as const }
    const source = createPdfTranslationSource({ ...original, units: [unit] })
    expect(source.units[0].sourceOnly).toBe(true)
    expect(Reflect.set(source.units[0], 'sourceOnly', false)).toBe(false)
    const result = { ...original.units[0], sourceOnly: false }
    expect(
      await bindPdfTranslation(
        source,
        { source, units: [result] },
        document,
        'version:0',
        new AbortController().signal
      )
    ).toBeNull()
    expect(document.getPage).not.toHaveBeenCalled()
  })
  it('captures and deeply freezes only source fields before translation', async () => {
    const data = structuredClone(input())
    const source = createPdfTranslationSource(data)
    expect('translation' in source.units[0]).toBe(false)
    expect(Object.isFrozen(source)).toBe(true)
    expect(Object.isFrozen(source.pages[0])).toBe(true)
    expect(Object.isFrozen(source.units[0].fragments[0].items[0])).toBe(true)
    expect(Object.isFrozen(source.units[0].fragments[0].rect)).toBe(true)
    expect(Reflect.set(source.units[0], 'source', 'Other source')).toBe(false)
    expect(Reflect.set(source.units[0].fragments[0].rect, 'x', 0)).toBe(false)
    const mutable = data as unknown as {
      units: { source: string; fragments: { rect: { x: number } }[] }[]
    }
    mutable.units[0].source = 'Changed after extraction'
    mutable.units[0].fragments[0].rect.x = 0
    const bound = await bindPdfTranslation(
      source,
      { source, units: input().units },
      pdf(),
      'version:0',
      new AbortController().signal
    )
    expect(bound?.units[0].source).toBe('A result.')
    expect(bound?.units[0].fragments[0].rect.x).toBe(0.1)
  })

  it('never accepts a replacement snapshot carried by results, even for identical PDF metadata', async () => {
    const source = createPdfTranslationSource(input())
    const replacement = createPdfTranslationSource({
      ...input(),
      units: [{ ...input().units[0], source: 'Unrelated source' }]
    })
    const document = pdf()
    expect(
      await bindPdfTranslation(
        source,
        { source: replacement, units: input().units },
        document,
        'version:0',
        new AbortController().signal
      )
    ).toBeNull()
    expect(document.getPage).not.toHaveBeenCalled()
  })

  it.each(['unknown', 'duplicate', 'empty'] as const)(
    'rejects %s result identities',
    async (kind) => {
      const source = createPdfTranslationSource(input())
      const units =
        kind === 'unknown'
          ? [{ ...input().units[0], id: 'missing' }]
          : kind === 'duplicate'
            ? [input().units[0], input().units[0]]
            : []
      expect(
        await bindPdfTranslation(
          source,
          { source, units },
          pdf(),
          'version:0',
          new AbortController().signal
        )
      ).toBeNull()
    }
  )

  it('ignores source and placement fields injected into a translation result', async () => {
    const source = createPdfTranslationSource(input())
    const tampered = { ...input().units[0], source: '999 patients', fragments: [] }
    const bound = await bindPdfTranslation(
      source,
      { source, units: [tampered] },
      pdf(),
      'version:0',
      new AbortController().signal
    )
    expect(bound?.units[0].source).toBe('A result.')
    expect(bound?.units[0].fragments).toBe(source.units[0].fragments)
    expect(isCurrentTranslation(bound!.units[0])).toBe(true)
  })

  it('keeps a result for a different source review-only without replacing the current source', async () => {
    const source = createPdfTranslationSource(input())
    const bound = await bindPdfTranslation(
      source,
      { source, units: [{ ...input().units[0], translationSource: 'Different source.' }] },
      pdf(),
      'version:0',
      new AbortController().signal
    )
    expect(bound?.units[0].source).toBe('A result.')
    expect(bound?.units[0].translationSource).toBe('Different source.')
    expect(isCurrentTranslation(bound!.units[0])).toBe(false)
  })

  it('captures result strings before asynchronous PDF validation and publishes immutable display data', async () => {
    const source = createPdfTranslationSource(input()),
      document = pdf()
    let finish: (() => void) | undefined
    const page = await document.getPage(1)
    vi.mocked(document.getPage).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(page)
        })
    )
    const record = { id: 'p1', translationSource: 'A result.', translation: '一项结果。' }
    const results: PdfTranslationResults = { source, units: [record] }
    const pending = bindPdfTranslation(
      source,
      results,
      document,
      'version:0',
      new AbortController().signal
    )
    record.translationSource = 'Mutated source'
    record.translation = 'Mutated translation'
    finish!()
    const bound = await pending
    expect(bound?.units[0].translation).toBe('一项结果。')
    expect(bound?.units[0].translationSource).toBe('A result.')
    expect(Object.isFrozen(bound?.units[0])).toBe(true)
    expect(Object.isFrozen(bound?.units)).toBe(true)
    expect(Object.isFrozen(bound)).toBe(true)
  })

  it('does not publish a result cancelled during text extraction', async () => {
    const source = createPdfTranslationSource(input()),
      document = pdf(),
      controller = new AbortController()
    const page = await document.getPage(1)
    const content = await page.getTextContent()
    vi.mocked(page.getTextContent).mockImplementation(async () => {
      controller.abort()
      return content
    })
    expect(
      await bindPdfTranslation(
        source,
        { source, units: input().units },
        document,
        'version:0',
        controller.signal
      )
    ).toBeNull()
  })
})

it('retains extraction reading order when translation results arrive in reverse order', async () => {
  const first = input().units[0]
  const second = {
    ...first,
    id: 'p2',
    source: 'Another result.',
    fragments: [{ ...first.fragments[0], items: [{ index: 1, text: 'Another result.' }] }]
  }
  const source = createPdfTranslationSource({ ...input(), units: [first, second] })
  const document = pdf(),
    page = await document.getPage(1)
  vi.mocked(page.getTextContent).mockResolvedValue({
    items: [{ str: 'A result.' }, { str: 'Another result.' }],
    styles: {},
    lang: null
  } as Awaited<ReturnType<typeof page.getTextContent>>)
  const secondResult = { id: 'p2', translationSource: second.source, translation: '另一项结果。' }
  const partial = await bindPdfTranslation(
    source,
    { source, units: [secondResult] },
    document,
    'version:0',
    new AbortController().signal
  )
  expect(partial?.units.map((unit) => [unit.id, unit.paragraphNumber])).toEqual([['p2', 2]])
  const result = await bindPdfTranslation(
    source,
    {
      source,
      units: [secondResult, first]
    },
    document,
    'version:0',
    new AbortController().signal
  )
  expect(result?.units.map((u) => u.id)).toEqual(['p1', 'p2'])
  expect(result?.units.map((u) => u.paragraphNumber)).toEqual([1, 2])
})

it('rejects non-text translation records before accessing the PDF', async () => {
  const source = createPdfTranslationSource(input()),
    document = pdf()
  const malformed = {
    source,
    units: [{ ...input().units[0], translation: null }]
  } as unknown as PdfTranslationResults
  expect(
    await bindPdfTranslation(source, malformed, document, 'version:0', new AbortController().signal)
  ).toBeNull()
  expect(document.getPage).not.toHaveBeenCalled()
})

it('reuses exact source verification for append-only results and rechecks replacements and generations', async () => {
  const bind = createPdfTranslationBinder(),
    document = pdf(),
    source = createPdfTranslationSource(input())
  const result = { source, units: input().units },
    signal = new AbortController().signal
  expect(await bind(source, result, document, 'version:0', signal)).not.toBeNull()
  expect(await bind(source, result, document, 'version:0', signal)).not.toBeNull()
  expect(document.getPage).toHaveBeenCalledTimes(1)
  expect(
    await bind(
      source,
      { source, units: [...result.units, result.units[0]] },
      document,
      'version:0',
      signal
    )
  ).toBeNull()
  expect(document.getPage).toHaveBeenCalledTimes(1)
  expect(
    await bind(
      source,
      { source, units: [{ ...result.units[0], translation: '更新' }] },
      document,
      'version:0',
      signal
    )
  ).not.toBeNull()
  expect(document.getPage).toHaveBeenCalledTimes(2)
  const aborted = new AbortController()
  aborted.abort()
  expect(await bind(source, result, document, 'version:0', aborted.signal)).toBeNull()
  expect(await bind(source, result, document, 'other', signal)).toBeNull()
  const next = pdf()
  expect(await bind(source, result, next, 'version:0', signal)).not.toBeNull()
  expect(next.getPage).toHaveBeenCalledTimes(1)
  await createPdfTranslationBinder()(source, result, document, 'version:0', signal)
  expect(document.getPage).toHaveBeenCalledTimes(3)
})

it.each(['sequential', 'sparse recovery'])(
  'reads the immutable PDF once across %s results',
  async (order) => {
    const first = input().units[0]
    const units = Array.from({ length: 24 }, (_, index) => ({
      ...first,
      id: String(index),
      source: 'Source ' + index,
      translationSource: 'Source ' + index,
      fragments: [{ ...first.fragments[0], items: [{ index, text: 'Source ' + index }] }]
    }))
    const source = createPdfTranslationSource({ ...input(), units })
    const document = pdf()
    const getTextContent = vi
      .fn()
      .mockResolvedValue({ items: units.map((unit) => ({ str: unit.source })) })
    vi.mocked(document.getPage).mockResolvedValue({
      getViewport: () => ({ width: 600, height: 800 }),
      getTextContent
    } as unknown as Awaited<ReturnType<typeof document.getPage>>)
    const bind = createPdfTranslationBinder()
    const received =
      order === 'sequential'
        ? units
        : [
            ...units.filter((_, index) => index % 2 === 1),
            ...units.filter((_, index) => index % 2 === 0)
          ]
    for (let count = 1; count <= units.length; count++) {
      const result = await bind(
        source,
        { source, units: received.slice(0, count) },
        document,
        'version:0',
        new AbortController().signal
      )
      expect(result?.units).toHaveLength(count)
    }
    expect(document.getPage).toHaveBeenCalledOnce()
    expect(getTextContent).toHaveBeenCalledOnce()
  }
)

it.each([
  ['Dingbats', '✓', true],
  ['ZapfDingbats', '✓', true],
  ['Times-Roman', '✓', false],
  ['Times-Roman', '3', true]
] as const)(
  'binds saved font-decoded source consistently: %s %s',
  async (font, expected, accepted) => {
    const document = pdf(),
      page = await document.getPage(1)
    vi.mocked(page.getTextContent).mockResolvedValue({
      items: [{ str: '3', fontName: 'f1' }]
    } as never)
    Object.assign(page, { commonObjs: { has: () => true, get: () => ({ name: font }) } })
    const data = input()
    const unit = {
      ...data.units[0],
      source: expected,
      translationSource: expected,
      translation: expected,
      fragments: [{ ...data.units[0].fragments[0], items: [{ index: 0, text: expected }] }]
    }
    expect(
      await verifyPdfTranslation(
        { ...data, units: [unit] },
        document,
        'version:0',
        new AbortController().signal
      )
    ).toBe(accepted)
  }
)

it('binds failures to verified source coordinates without accepting source text as a translation', async () => {
  const source = createPdfTranslationSource(input())
  const failure = { reasonCode: 'missing-proper-name' as const, pageNumbers: [1], attempts: 2 }
  const results = { source, units: [], failedUnitIds: ['p1'], failures: { p1: failure } }
  const bound = await bindPdfTranslation(
    source,
    results,
    pdf(),
    'version:0',
    new AbortController().signal
  )
  expect(bound?.units[0]).toMatchObject({
    id: 'p1',
    translation: '',
    translationFailed: true,
    failure,
    fragments: source.units[0].fragments
  })
  expect(isCurrentTranslation(bound!.units[0])).toBe(false)
  expect(
    await bindPdfTranslation(
      source,
      { ...results, failures: { p1: { ...failure, attempts: -1 } } },
      pdf(),
      'version:0',
      new AbortController().signal
    )
  ).toBeNull()
  expect(
    await bindPdfTranslation(
      source,
      { ...results, failedUnitIds: ['unknown'] },
      pdf(),
      'version:0',
      new AbortController().signal
    )
  ).toBeNull()
  expect(
    await bindPdfTranslation(
      source,
      { ...results, units: input().units },
      pdf(),
      'version:0',
      new AbortController().signal
    )
  ).toBeNull()
})

it('does not reuse generated or verified results across editions with identical layouts and text', () => {
  const source = createPdfTranslationSource(input())
  const previous = { source, units: input().units, checkpoint: { source: 'v1', key: 'edition-1' } }
  const next = { ...previous, checkpoint: { source: 'v1', key: 'edition-2' } }
  expect(isPdfTranslationResultExtension(previous, next, true)).toBe(false)
})
