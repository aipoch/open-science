import { afterEach, describe, expect, it, vi } from 'vitest'
import { literatureItemInputSchema } from '../../../../shared/literature'
import { extractLiteraturePdfDraft, completeLiteraturePdfDraft } from './literature-pdf-metadata'

const pdf = vi.hoisted(() => ({ getDocument: vi.fn() }))
vi.mock('../workspace/previews/pdfjs', () => ({ pdfjsLib: pdf }))
const title = 'Proteins regulate replication through stabilization'
const doi = '10.1234/article'
const fallback = literatureItemInputSchema.parse({ itemType: 'journalArticle', title: 'paper' })
const resolved = { ...fallback, title, containerTitle: 'Example Journal' }
const publication = `References\n10.1234/reference\nSubmitted 5 June 2024\nAccepted 11 February 2025\nPublished 19 March 2025\n${doi}`
const item = (str: string, height = 10): { str: string; height: number; hasEOL: boolean } => ({
  str,
  height,
  hasEOL: true
})

const setup = (
  last = publication,
  first = [item(title, 18), item('Abstract and body')],
  pages = 15
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Preserve each mock's inferred callable signature.
) => {
  const cleanup = vi.fn()
  const destroy = vi.fn()
  const getPage = vi.fn(async (n: number) => ({
    getTextContent: vi.fn(async () => ({
      items: n === 1 ? first : [item(n === pages ? last : 'Body')]
    })),
    cleanup
  }))
  pdf.getDocument.mockReturnValue({
    promise: Promise.resolve({
      numPages: pages,
      getPage,
      destroy,
      getMetadata: async () => ({ info: { Title: 'Generic publisher title' } })
    })
  })
  const lookup = vi.fn().mockResolvedValue(resolved)
  vi.stubGlobal('window', { api: { literature: { lookupMetadata: lookup } } })
  const file = new File(['%PDF-1.4'], 'paper.pdf')
  return { file, lookup, getPage, cleanup, destroy }
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('PDF terminal publication DOI fallback', () => {
  it('checks the prominent first-page title before adopting the publication DOI and reuses its lookup', async () => {
    const { file, lookup, getPage, destroy } = setup()
    const draft = await extractLiteraturePdfDraft(file, fallback)
    expect(draft.identifiers).toEqual([{ scheme: 'doi', value: doi, isPrimary: true }])
    expect((await completeLiteraturePdfDraft(draft)).title).toBe(title)
    expect(lookup).toHaveBeenCalledExactlyOnceWith(doi)
    expect(getPage.mock.calls.map(([n]) => n)).toEqual([1, 2, 15])
    expect(destroy).toHaveBeenCalledOnce()
  })
  it.each([
    'References\n10.1234/reference',
    `Published 19 March 2025\n${doi}`,
    `Accepted 11 February 2025\nPublished 19 March 2025\n${doi}\n10.1234/other`,
    `Accepted 11 February 2025\nPublished 19 March 2025\nReferences\n${doi}`
  ])('does not query an ambiguous or reference-only tail: %s', async (last) => {
    const { file, lookup } = setup(last)
    expect((await extractLiteraturePdfDraft(file, fallback)).identifiers).toEqual([])
    expect(lookup).not.toHaveBeenCalled()
  })
  it('rejects a real referenced work even when its title occurs in the body or embedded metadata', async () => {
    const { file, lookup } = setup(publication, [
      item('The current article has a different title', 18),
      item(title)
    ])
    lookup.mockResolvedValue({ ...resolved, title })
    expect((await extractLiteraturePdfDraft(file, fallback)).identifiers).toEqual([])
  })
  it('retains the local draft when lookup fails', async () => {
    const { file, lookup, destroy } = setup()
    lookup.mockRejectedValue(new Error('offline'))
    expect((await extractLiteraturePdfDraft(file, fallback)).title).toBe('Generic publisher title')
    expect(destroy).toHaveBeenCalledOnce()
  })
  it('cleans up a failing last page and preserves the already extracted metadata', async () => {
    const { file, getPage, cleanup, destroy } = setup()
    getPage.mockImplementation(async (n) => ({
      getTextContent: vi.fn(async () => {
        if (n === 15) throw new Error('unreadable page')
        return { items: [item(title, 18)] }
      }),
      cleanup
    }))
    expect((await extractLiteraturePdfDraft(file, fallback)).title).toBe('Generic publisher title')
    expect(cleanup).toHaveBeenCalledTimes(3)
    expect(destroy).toHaveBeenCalledOnce()
  })
  it.each(['', 'Short'])(
    'does not query without a substantial prominent title: %s',
    async (text) => {
      const { file, lookup } = setup(publication, [item(text, 18)])
      expect((await extractLiteraturePdfDraft(file, fallback)).identifiers).toEqual([])
      expect(lookup).not.toHaveBeenCalled()
    }
  )
  it('preserves a detected PMID as a secondary identifier', async () => {
    const { file } = setup(publication, [item(title, 18), item('PMID: 40106570')])
    expect((await extractLiteraturePdfDraft(file, fallback)).identifiers).toEqual([
      { scheme: 'doi', value: doi, isPrimary: true },
      { scheme: 'pmid', value: '40106570', isPrimary: false }
    ])
  })
  it('keeps an existing first-page DOI without reading the last page', async () => {
    const { file, lookup, getPage } = setup(publication, [item(title, 18), item('10.1234/front')])
    expect((await extractLiteraturePdfDraft(file, fallback)).identifiers[0].value).toBe(
      '10.1234/front'
    )
    expect(getPage.mock.calls.map(([n]) => n)).toEqual([1, 2])
    expect(lookup).not.toHaveBeenCalled()
  })
  it('does not reread a one-page PDF or read an oversized file', async () => {
    const { file, getPage } = setup('', [item(title, 18)], 1)
    await extractLiteraturePdfDraft(file, fallback)
    expect(getPage.mock.calls.map(([n]) => n)).toEqual([1])
    const oversized = new File([], 'large.pdf')
    Object.defineProperty(oversized, 'size', { value: 51 * 1024 * 1024 })
    expect(await extractLiteraturePdfDraft(oversized, fallback)).toBe(fallback)
    expect(pdf.getDocument).toHaveBeenCalledOnce()
  })
})

// Minimal real PDF: split large-font title, generic Info title, and a publication DOI on page 3.
// Keep the publisher pattern reproducible without embedding a user's copyrighted article.
const publicationPdf = (): Uint8Array<ArrayBuffer> => {
  const streams = [
    'BT /F1 18 Tf 30 700 Td (Proteins regulate replication) Tj 0 -22 Td (through stabilization) Tj /F1 10 Tf 0 -30 Td (Abstract and body) Tj ET',
    'BT /F1 10 Tf 30 700 Td (Body) Tj ET',
    'BT /F1 10 Tf 30 700 Td (References) Tj 0 -15 Td (10.1234/reference) Tj 0 -30 Td (Accepted 11 February 2025) Tj 0 -15 Td (Published 19 March 2025) Tj 0 -15 Td (10.1234/article) Tj ET'
  ]
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [5 0 R 7 0 R 9 0 R] /Count 3 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Title (Generic publisher title) >>',
    ...streams.flatMap((stream, i) => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${6 + i * 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
    ])
  ]
  let text = '%PDF-1.4\n'
  const offsets = objects.map((object, i) => {
    const offset = text.length
    text += `${i + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const xref = text.length
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  text += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(text)
}

it('extracts and completes a real PDF using PDF.js font geometry and text joining', async () => {
  const { lookup } = setup()
  const realPdf = await import('pdfjs-dist/legacy/build/pdf.mjs')
  pdf.getDocument.mockImplementation(realPdf.getDocument)
  const file = new File([publicationPdf()], 'article.pdf', { type: 'application/pdf' })
  const local = await extractLiteraturePdfDraft(file, fallback)
  expect(local.identifiers).toEqual([{ scheme: 'doi', value: doi, isPrimary: true }])
  expect((await completeLiteraturePdfDraft(local)).title).toBe(title)
  expect(lookup).toHaveBeenCalledExactlyOnceWith(doi)
})

it('uses PMID-only drafts and retains verified remote identifiers', async () => {
  const { lookup } = setup()
  const draft = {
    ...fallback,
    identifiers: [{ scheme: 'pmid' as const, value: '12345678', isPrimary: true }]
  }
  lookup.mockResolvedValue({
    ...resolved,
    abstract: 'Verified abstract',
    identifiers: [
      { scheme: 'pmid', value: '12345678', isPrimary: true },
      { scheme: 'doi', value: doi, isPrimary: false }
    ]
  })
  const completed = await completeLiteraturePdfDraft(draft)
  expect(lookup).toHaveBeenCalledWith('pmid:12345678')
  expect(completed.identifiers).toEqual([
    ...draft.identifiers,
    { scheme: 'doi', value: doi, isPrimary: false }
  ])
})

it('retains first-page text when embedded metadata and a later page fail', async () => {
  const { file, getPage, destroy, cleanup } = setup(
    '',
    [item(title, 18), item('10.1234/article')],
    2
  )
  const model = await pdf.getDocument().promise
  model.getMetadata = async () => {
    throw new Error('bad Info dictionary')
  }
  getPage.mockImplementation(async (n) => ({
    getTextContent: vi.fn(async () => {
      if (n === 2) throw new Error('bad page')
      return { items: [item(title, 18), item('10.1234/article')] }
    }),
    cleanup
  }))
  const notice = vi.fn()
  const draft = await extractLiteraturePdfDraft(file, fallback, notice)
  expect(draft.title).toBe(title)
  expect(draft.identifiers[0].value).toBe(doi)
  expect(notice).toHaveBeenCalledWith({ textUnavailable: true })
  expect(cleanup).toHaveBeenCalledTimes(2)
  expect(destroy).toHaveBeenCalledOnce()
})

it('uses XMP title and authors when Info contains only a filename', async () => {
  const { file } = setup('', [], 1)
  const model = await pdf.getDocument().promise
  model.getMetadata = async () => ({
    info: { Title: 'article.pdf' },
    metadata: {
      get: (key: string) =>
        ({ 'dc:title': title, 'dc:creator': ['Alice Example', 'Bob Example'], 'prism:doi': doi })[
          key
        ]
    }
  })
  const draft = await extractLiteraturePdfDraft(file, fallback)
  expect(draft).toMatchObject({
    title,
    creators: [{ familyName: 'Alice Example' }, { familyName: 'Bob Example' }],
    identifiers: [{ scheme: 'doi', value: doi }]
  })
})

it('reports PDFs with no text while retaining embedded metadata', async () => {
  const { file, destroy } = setup('', [], 1)
  const notice = vi.fn()
  const draft = await extractLiteraturePdfDraft(file, fallback, notice)
  expect(draft.title).toBe('Generic publisher title')
  expect(notice).toHaveBeenCalledWith({ textUnavailable: true })
  expect(destroy).toHaveBeenCalledOnce()
})

it('reports lookup failure without discarding the extracted abstract', async () => {
  const { lookup } = setup()
  lookup.mockRejectedValue(new Error('offline'))
  const draft = {
    ...fallback,
    abstract: 'Locally extracted evidence.',
    identifiers: [{ scheme: 'doi' as const, value: doi, isPrimary: true }]
  }
  const notice = vi.fn()
  expect(await completeLiteraturePdfDraft(draft, notice)).toBe(draft)
  expect(notice).toHaveBeenCalledWith({ lookupFailed: true })
})

it('does not replace a prominent PDF title with a cited paper returned by DOI lookup', async () => {
  const { file, lookup } = setup('', [item(title, 18), item('10.1234/citation')], 1)
  lookup.mockResolvedValue({
    ...resolved,
    title: 'A different cited paper',
    abstract: 'Wrong abstract'
  })
  const draft = await extractLiteraturePdfDraft(file, fallback)
  const notice = vi.fn()
  const completed = await completeLiteraturePdfDraft(draft, notice)
  expect(completed.abstract).toBe('')
  expect(completed.identifiers).toEqual([])
  expect(completed.url).toBe('')
  expect(notice).toHaveBeenCalledWith({ lookupFailed: true })
})

it('uses geometry to end a structured abstract even when the final line has no EOL flag', async () => {
  const lines = [
    [
      'Background: The study investigates an important question using direct experimental evidence.',
      400
    ],
    ['Methods: We compared samples in a controlled study.', 370],
    ['Results: The observed effect was consistent across samples.', 340],
    ['Conclusions: The evidence supports further investigation.', 310],
    ['', 265],
    ['This is body text and must not be included in the abstract.', 265]
  ] as const
  const { file } = setup(
    '',
    lines.map(([str, y]) => ({
      str,
      height: 9,
      hasEOL: !str,
      transform: [9, 0, 0, 9, 40, y]
    })),
    1
  )
  const draft = await extractLiteraturePdfDraft(file, fallback)
  expect(draft.abstract).toContain('Background:')
  expect(draft.abstract).toContain('Conclusions: The evidence supports further investigation.')
  expect(draft.abstract).not.toContain('body text')
})
