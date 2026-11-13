// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PDFDict, PDFDocument, PDFName, StandardFonts } from 'pdf-lib'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { createPdfTranslationSource } from '@aipoch/pdf-translation/reader'
import { usePdfTranslationDocument } from './use-pdf-translation-document'

const { getDocument, operators } = vi.hoisted(() => ({ getDocument: vi.fn(), operators: {} }))
vi.mock('../pdfjs', () => ({ pdfjsLib: { getDocument, OPS: operators } }))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

// Native PDFs retain the fused delimiter as one text item, rather than a mock
// claiming a digit-only hit. The paragraph's declared capacity owns both rows.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function fixture(change: string) {
  const sourceText = 'Original discussion [2, 4, 9].'
  const translation =
    change === 'stolen-open'
      ? 'Rewritten discussion [2, [4, 9].'
      : 'Rewritten discussion [2, 4, 9].'
  const make = async (target: boolean): Promise<Uint8Array> => {
    const pdf = await PDFDocument.create(),
      page = pdf.addPage([600, 800]),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      baseline = target ? 660 : 700,
      positions: number[] = []
    if (!target) {
      page.drawText(sourceText, { font, x: 60, y: baseline, size: 12 })
      for (const label of ['2', '4', '9'])
        positions.push(
          60 + font.widthOfTextAtSize(sourceText.slice(0, sourceText.indexOf(label)), 12)
        )
    } else {
      const prefix = change === 'opening' ? 'Rewritten discussion ' : 'Rewritten discussion ['
      page.drawText(prefix, { font, x: 60, y: baseline, size: 12 })
      let x = 60 + font.widthOfTextAtSize(prefix, 12)
      for (const [n, label] of ['2', '4', '9'].entries()) {
        const text =
          n === 0 && change === 'stolen-close'
            ? '2]'
            : n === 2 && change === 'both-delimiters'
              ? '[9]'
              : n === 0 && change === 'opening'
                ? '[2'
                : n === 1 && change === 'stolen-open'
                  ? '[4'
                  : n === 2 && change !== 'distant-close'
                    ? change === 'wrong-digit'
                      ? '8]'
                      : '9]'
                    : label
        const size =
          (n === 2 && change !== 'distant-close') || (n === 0 && change === 'opening') ? 8 : 12
        positions.push(x)
        page.drawText(text, { font, x, y: baseline + (size === 8 ? 0.4 : 0), size })
        x += font.widthOfTextAtSize(text, size)
        if (n < 2) {
          x += 3
          page.drawText(',', { font, x, y: baseline, size: 12 })
          x += font.widthOfTextAtSize(',', 12) + 3
        } else if (change === 'distant-close') {
          x += 20
          page.drawText(']', { font, x, y: baseline, size: 12 })
          x += 4
        }
      }
      page.drawText('.', { font, x: x + 2, y: baseline, size: 12 })
      if (change === 'cross-owner') page.drawText('9]', { font, x: 400, y: 500, size: 8 })
    }
    const links = positions.map((x, n) =>
      pdf.context.register(
        pdf.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [
            target && change === 'wrong-order' ? (positions[1 - n] ?? x) : x,
            target && change === 'cross-owner' && n === 2 ? 499 : baseline - 1,
            (target && change === 'wrong-order' ? (positions[1 - n] ?? x) : x) + 10,
            target && change === 'cross-owner' && n === 2 ? 711 - 200 : baseline + 11
          ],
          A: {
            S: 'URI',
            URI: `https://example.invalid/citation/${target && change === 'wrong-action' && n === 2 ? 'other' : n}`
          }
        })
      )
    )
    if (target && change === 'cross-owner') {
      const link = pdf.context.lookup(links[2], PDFDict)
      if (link) link.set(PDFName.of('Rect'), pdf.context.obj([400, 499, 410, 511]))
    }
    page.node.set(PDFName.of('Annots'), pdf.context.obj(links))
    return pdf.save()
  }
  const { getDocument: load, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  Object.assign(operators, OPS)
  const bytes = await make(false),
    data = await make(true),
    task = load({ data: bytes.slice(), useSystemFonts: true }),
    original = await task.promise,
    content = await (await original.getPage(1)).getTextContent(),
    items = content.items.flatMap((item, index) =>
      'str' in item && item.str.trim() ? [{ index, text: item.str }] : []
    ),
    source = createPdfTranslationSource({
      resourceRequestKey: 'closed-native',
      fingerprint: original.fingerprints[0]!,
      pages: [{ width: 600, height: 800 }],
      units: [
        {
          id: 'paragraph',
          source: sourceText,
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 0.1, y: 0.1, width: 0.8, height: 0.2 },
              items
            }
          ]
        }
      ]
    }),
    results = { source, units: [{ id: 'paragraph', translationSource: sourceText, translation }] }
  return {
    original: original as PDFDocumentProxy,
    task,
    data,
    results,
    load,
    artifact: { results, data }
  }
}
it.each(['closing', 'opening'])(
  'verifies a complete real native citation with a fused %s delimiter',
  async (change) => {
    const f = await fixture(change),
      targetTask = f.load({ data: f.data.slice(), useSystemFonts: true })
    try {
      const native = (await (await (await targetTask.promise).getPage(1)).getTextContent()).items
      expect(native.some((i) => 'str' in i && i.str === (change === 'closing' ? '9]' : '[2'))).toBe(
        true
      )
      getDocument.mockImplementationOnce((options) => f.load({ ...options, useSystemFonts: true }))
      const hook = renderHook(() =>
        usePdfTranslationDocument(f.original, f.results, f.artifact, 'closed-native')
      )
      await waitFor(() => expect(['ready', 'error']).toContain(hook.result.current.state.status), {
        interval: 10
      })
      expect(hook.result.current.state).toMatchObject({ status: 'ready' })
      hook.unmount()
    } finally {
      await targetTask.destroy()
      await f.task.destroy()
    }
  }
)
it.each([
  'stolen-open',
  'stolen-close',
  'both-delimiters',
  'wrong-digit',
  'cross-owner',
  'wrong-action',
  'wrong-order',
  'distant-close'
])('rejects a real native citation without its complete boundary contract: %s', async (change) => {
  const f = await fixture(change)
  try {
    getDocument.mockImplementationOnce((options) => f.load({ ...options, useSystemFonts: true }))
    const hook = renderHook(() =>
      usePdfTranslationDocument(f.original, f.results, f.artifact, 'closed-native')
    )
    await waitFor(() => expect(hook.result.current.state.status).toBe('error'), { interval: 10 })
    expect(hook.result.current.state).toMatchObject({ failure: { code: 'validation-failed' } })
    hook.unmount()
  } finally {
    await f.task.destroy()
  }
})
