import { expect, it, vi } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'

it.each([false, true])(
  'includes a page-terminal comparison tail on the same native rail (%s)',
  async (offset) => {
    const e = 10
    const runs = [
      ['A technician can assemble the equipment on a workbench', 326, 139, 236],
      ['using hand tools. Install the cover once the assembly has', 317, 127.5, 245],
      ['been inspected. Leave room on the shelf for the devices', 317, 116, 245],
      ['that accompany the kit. After the indicators are lit, the', 317, 104.5, 245],
      ['operator can review the current record before returning', 317, 93, 245],
      ['to the main display. The next screen shows a message similar', 317, 81.5, 245],
      ['to', offset ? 323 : 317, 70, 9]
    ] as const
    const items = runs.map(([str, x, y, width], index) => ({
      str,
      fontName: 'body',
      width,
      hasEOL: index < runs.length - 1,
      dir: 'ltr',
      height: e,
      transform: [e, 0, 0, e, x, y]
    }))
    const pages = [items, [{ ...items[0], str: 'Normal operation resumes on the following page.' }]]
    const { source } = await extractPdfTranslationSource({
      document: {
        numPages: pages.length,
        fingerprints: ['synthetic'],
        getPage: vi.fn(async (page: number) => ({
          rotate: 0,
          getViewport: () => ({ width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] }),
          getTextContent: async () => ({
            items: pages[page - 1],
            styles: { body: { ascent: 0.69, descent: -0.194, vertical: false } }
          }),
          cleanup: vi.fn()
        }))
      } as unknown as PDFDocumentProxy,
      resourceRequestKey: 'synthetic',
      signal: new AbortController().signal
    })
    const paragraph = source.units.find((unit) => unit.source.startsWith('A technician'))!
    expect(paragraph.source.endsWith(offset ? 'message similar' : 'message similar to')).toBe(true)
    expect(paragraph.fragments[0].items.at(-1)?.index).toBe(offset ? 5 : 6)
    expect(source.units.some((unit) => unit.source === 'to')).toBe(offset)
  }
)
