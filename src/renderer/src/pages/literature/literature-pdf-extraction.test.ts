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
