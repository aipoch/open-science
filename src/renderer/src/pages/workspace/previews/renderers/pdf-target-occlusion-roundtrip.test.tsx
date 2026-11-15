// @vitest-environment node
// @ts-expect-error This DOM test dependency has no bundled declarations.
import { JSDOM } from 'jsdom'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { renderHook, waitFor, cleanup } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { getDocument as load, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib'
// @ts-expect-error The font fixture dependency has no bundled declarations.
import * as fontkit from 'fontkit'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import {
  createPdfTranslationSource,
  rememberPdfTranslationExtraction,
  extractPdfTranslationSource
} from '@aipoch/pdf-translation/reader'
import { usePdfTranslationDocument } from './use-pdf-translation-document'
import { PdfTranslationWriter } from '@aipoch/pdf-translation/writer'
import { pdfTranslationWorkerPath } from '@aipoch/pdf-translation/resources'

const { getDocument, operators } = vi.hoisted(() => ({ getDocument: vi.fn(), operators: {} }))
vi.mock('../pdfjs', () => ({ pdfjsLib: { getDocument, OPS: operators } }))

async function formCaptionDocument(): Promise<PDFDocumentProxy> {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const font = await pdf.embedFont(
      await readFile(
        join(
          dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
          'standard_fonts/LiberationSans-Regular.ttf'
        )
      ),
      { subset: false }
    ),
    page = pdf.addPage([300, 220]),
    label = font.encodeText('Panel label').toString(),
    form = pdf.context.register(
      pdf.context.flateStream(`0 0 0 rg BT /FixtureFont 12 Tf 10 10 Td ${label} Tj ET`, {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 30, 200, 100],
        Resources: { Font: { FixtureFont: font.ref } }
      })
    )
  page.node.set(
    PDFName.of('Resources'),
    pdf.context.obj({ Font: { Body: font.ref }, XObject: { Panel: form } })
  )
  page.node.set(
    PDFName.of('Contents'),
    pdf.context.register(
      pdf.context.flateStream(
        `q 0.5 0 0 0.5 20 100 cm /Panel Do Q\nBT /Body 12 Tf 20 70 Td ${label} Tj ET\nBT /Body 12 Tf 20 110 Td ${font.encodeText('Visible caption').toString()} Tj ET`
      )
    )
  )
  return load({
    data: await pdf.save(),
    fontExtraProperties: true,
    disableFontFace: true,
    isEvalSupported: false
  }).promise
}

it.each(['hidden', 'auxiliary', 'visible', 'legacy'])(
  'verifies a real worker caption beside native Form text: %s',
  async (kind) => {
    // Keep native PDF objects in the Node realm; the DOM only hosts the React hook.
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
    vi.stubGlobal('window', dom.window)
    vi.stubGlobal('document', dom.window.document)
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const create = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(((
      tag: string,
      options?: ElementCreationOptions
    ) =>
      tag === 'canvas'
        ? createCanvas(1, 1)
        : create(tag, options)) as typeof document.createElement)
    const original = await formCaptionDocument(),
      controller = new AbortController(),
      caller = {
        leaseId: 'caption-roundtrip',
        generation: 1,
        signal: controller.signal,
        isCurrent: () => !controller.signal.aborted
      }
    try {
      const extraction = await extractPdfTranslationSource({
          document: original,
          resourceRequestKey: 'caption-roundtrip',
          signal: caller.signal
        }),
        source = createPdfTranslationSource({
          ...extraction.source,
          resourceRequestKey: 'caption-roundtrip',
          units: extraction.source.units.map((unit) =>
            unit.source === 'Visible caption'
              ? {
                  ...unit,
                  fragments: unit.fragments.map((fragment) => ({
                    ...fragment,
                    rect: { x: 0.06, y: 0.45, width: 0.86, height: 0.1 }
                  }))
                }
              : unit
          )
        })
      rememberPdfTranslationExtraction({
        source,
        coverage:
          kind === 'legacy' ? { ...extraction.coverage, exclusions: [] } : extraction.coverage
      })
      const unit = source.units.find((item) => item.source === 'Visible caption')!
      expect(unit).toBeDefined()
      const translation = '完整的图注翻译。',
        results = {
          source,
          units: source.units.map((item) => ({
            id: item.id,
            translationSource: item.source,
            translation: item === unit ? translation : item.source
          }))
        },
        output = await new PdfTranslationWriter(pdfTranslationWorkerPath).generate(
          {
            id: 'caption-roundtrip',
            data: await original.getData(),
            pages: source.pages,
            preserveUnsupported: true,
            preserveUnmatched: true,
            units: [{ ...unit, translation }]
          },
          caller
        )
      expect(output).toBeDefined()
      let data = output!
      if (kind === 'visible') {
        const changed = await PDFDocument.load(data)
        let edited = 0
        for (const [, object] of changed.context.enumerateIndirectObjects())
          if (
            object instanceof PDFRawStream &&
            object.dict.get(PDFName.of('Subtype')) === PDFName.of('Form')
          ) {
            object.dict.set(PDFName.of('BBox'), changed.context.obj([0, 0, 200, 100]))
            edited++
          }
        expect(edited).toBeGreaterThan(0)
        data = await changed.save()
      }
      Object.assign(operators, OPS)
      const destroyAuxiliary = vi.fn()
      getDocument.mockImplementation((options) => {
        const task = load({
          ...options,
          fontExtraProperties: true,
          disableFontFace: true,
          isEvalSupported: false
        })
        if (options.disableFontFace) {
          const destroy = task.destroy.bind(task)
          task.destroy = async () => {
            destroyAuxiliary()
            await destroy()
          }
        }
        if (kind === 'auxiliary' && !options.disableFontFace)
          return {
            promise: task.promise.then(async (document) => {
              const page = await document.getPage(1)
              await page.getOperatorList()
              // Node eagerly creates paths; hide only the primary browser cache capability.
              const has = page.commonObjs.has.bind(page.commonObjs)
              page.commonObjs.has = (key: string) => !key.includes('_path_') && has(key)
              return document
            }),
            destroy: task.destroy.bind(task)
          }
        return task
      })
      const artifact = { results, data: data! },
        hook = renderHook(() =>
          usePdfTranslationDocument(original, results, artifact, 'caption-roundtrip')
        )
      await waitFor(
        () =>
          expect(hook.result.current.state.status).toBe(
            ['hidden', 'auxiliary'].includes(kind) ? 'ready' : 'error'
          ),
        {
          timeout: 10000,
          interval: 10
        }
      )
      if (['hidden', 'auxiliary'].includes(kind))
        expect(hook.result.current.ready?.retainedUnitIds).not.toContain(unit.id)
      else
        expect(hook.result.current.state).toMatchObject({ failure: { code: 'validation-failed' } })
      expect(destroyAuxiliary).toHaveBeenCalledTimes(kind === 'auxiliary' ? 1 : 0)
      hook.unmount()
    } finally {
      cleanup()
      controller.abort()
      await original.destroy()
      vi.restoreAllMocks()
      vi.clearAllMocks()
      vi.unstubAllGlobals()
      dom.window.close()
    }
  }
)
