// @vitest-environment node
// @ts-expect-error This DOM test dependency has no bundled declarations.
import { JSDOM } from 'jsdom'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createCanvas, type Canvas } from '@napi-rs/canvas'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { getDocument as load, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  PDFDocument,
  pushGraphicsState,
  popGraphicsState,
  concatTransformationMatrix
} from 'pdf-lib'
// @ts-expect-error The font fixture dependency has no bundled declarations.
import * as fontkit from 'fontkit'
import { extractPdfTranslationSource } from '@aipoch/pdf-translation/reader'
import { PdfTranslationWriter } from '@aipoch/pdf-translation/writer'
import { pdfTranslationWorkerPath } from '@aipoch/pdf-translation/resources'
import { usePdfTranslationDocument } from './use-pdf-translation-document'

const { getDocument, operators } = vi.hoisted(() => ({ getDocument: vi.fn(), operators: {} }))
vi.mock('../pdfjs', () => ({ pdfjsLib: { getDocument, OPS: operators } }))

it('round-trips a drop-cap paragraph without sharing its continuation with another owner', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const create = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation(((
    tag: string,
    options?: ElementCreationOptions
  ): HTMLElement | Canvas =>
    tag === 'canvas' ? createCanvas(1, 1) : create(tag, options)) as typeof document.createElement)
  const controller = new AbortController()
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
  )
  const page = pdf.addPage([600, 800])
  page.drawText('V', { x: 60, y: 650, size: 30, font })
  const inset = 60 + font.widthOfTextAtSize('V', 30) + 1
  const row = (text: string, x: number, y: number): void => {
    const sx = (330 - x) / font.widthOfTextAtSize(text, 10)
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(sx, 0, 0, 1, x * (1 - sx), 0)
    )
    page.drawText(text, { x, y, size: 10, font })
    page.pushOperators(popGraphicsState())
  }
  row('ISUAL systems combine several available signals in multi-', inset, 663.2)
  row('modal experiments and recover useful evidence from observations', inset, 651.2)
  row('these methods remain useful across several controlled settings.', 60, 639.2)
  page.drawText('Separate neighboring paragraph remains unchanged.', {
    x: 60,
    y: 590,
    size: 10,
    font
  })
  const original = await load({
    data: await pdf.save(),
    fontExtraProperties: true,
    disableFontFace: true,
    isEvalSupported: false
  }).promise
  try {
    Object.assign(operators, OPS)
    getDocument.mockImplementation((options) =>
      load({ ...options, fontExtraProperties: true, disableFontFace: true, isEvalSupported: false })
    )
    const { source } = await extractPdfTranslationSource({
      document: original,
      resourceRequestKey: 'drop-cap',
      signal: controller.signal
    })
    const prose = source.units.filter(
      (unit) => !unit.sourceOnly && /VISUAL|modal experiments/u.test(unit.source)
    )
    expect(prose).toHaveLength(1)
    const unit = prose[0]
    expect(unit.source).toContain('multi-modal experiments')
    const translation =
      '视觉系统融合多种可用信号，在多模态实验中从观测中恢复有用证据。这些方法在受控环境中仍然有效。'
    const neighboringTranslation = '独立的相邻段落保持可读。'
    const results = {
      source,
      units: source.units
        .filter((item) => !item.sourceOnly)
        .map((item) => ({
          id: item.id,
          translationSource: item.source,
          translation: item === unit ? translation : neighboringTranslation
        }))
    }
    const writer = new PdfTranslationWriter(pdfTranslationWorkerPath)
    Object.assign(window, {
      api: {
        pdfTranslation: {
          generatePdf: (input: Parameters<typeof writer.generateDetailed>[0]) =>
            writer.generateDetailed(input, {
              leaseId: 'drop-cap',
              generation: 1,
              signal: controller.signal,
              isCurrent: () => !controller.signal.aborted
            }),
          cancelPdf: async () => {}
        }
      }
    })
    const hook = renderHook(() =>
      usePdfTranslationDocument(original, results, undefined, 'drop-cap')
    )
    await waitFor(() => expect(hook.result.current.state.status).toBe('ready'), {
      timeout: 15000,
      interval: 20
    })
    expect(hook.result.current.layoutFailures[unit.id]?.code).not.toBe('validation-failed')
    const target = await hook.result.current.ready!.document.getPage(1)
    const text = (await target.getTextContent()).items
      .flatMap((item) => ('str' in item ? [item.str] : []))
      .join('')
    expect(text.replace(/\s/gu, '')).toContain(neighboringTranslation)
    expect(text.replace(/\s/gu, '')).toContain(unit.source.replace(/\s/gu, ''))
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
}, 20000)
