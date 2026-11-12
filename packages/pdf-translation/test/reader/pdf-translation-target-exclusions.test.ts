import { createCanvas } from '@napi-rs/canvas'
import { expect, it, vi } from 'vitest'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { formPage } from '../support/form-page.js'
import { createPdfTranslationTargetExclusions } from '../../src/reader/target-native-exclusions.js'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'
import { getPdfTranslationTextContent } from '../../src/reader/text-content.js'
import {
  getPdfTranslationLayoutSnapshot,
  rememberPdfTranslationExtraction,
  restorePdfTranslationExtraction
} from '../../src/reader/snapshot.js'

it.each([
  'direct',
  'auxiliary',
  'abort',
  'visible',
  'partial',
  'duplicate',
  'stale',
  'wrong-data',
  'legacy',
  'source-set',
  'target-set'
])('filters only uniquely preserved, independently hidden target occurrences: %s', async (kind) => {
  const original = await formPage(),
    controller = new AbortController(),
    signal = controller.signal,
    extraction = await extractPdfTranslationSource({
      document: original,
      resourceRequestKey: 'anonymous',
      signal
    })
  rememberPdfTranslationExtraction(extraction)
  const source =
    kind === 'legacy'
      ? restorePdfTranslationExtraction(
          {
            ...getPdfTranslationLayoutSnapshot(extraction.source)!,
            coverage: { ...extraction.coverage, exclusions: [] }
          },
          'anonymous'
        ).source
      : extraction.source
  const data = await original.getData(),
    target = await getDocument({
      data: data.slice(),
      fontExtraProperties: true,
      disableFontFace: !['auxiliary', 'abort'].includes(kind),
      isEvalSupported: false
    }).promise,
    factory = vi.fn(getDocument),
    verifier = createPdfTranslationTargetExclusions({
      source,
      document: target,
      data: kind === 'wrong-data' ? data.slice(1) : data,
      nativeDocumentFactory: factory,
      signal
    })
  vi.stubGlobal('document', { createElement: () => createCanvas(1, 1) })
  try {
    const page = await target.getPage(1),
      content = await getPdfTranslationTextContent(page),
      sourceContent = await getPdfTranslationTextContent(await original.getPage(1)),
      viewport = page.getViewport({ scale: 1 }),
      operators = await page.getOperatorList()
    if (['auxiliary', 'abort'].includes(kind)) {
      // Node eagerly creates paths; emulate only the browser primary's missing cache.
      const has = page.commonObjs.has.bind(page.commonObjs)
      page.commonObjs.has = (key: string) => !key.includes('_path_') && has(key)
    }
    if (kind === 'visible' || kind === 'partial') {
      const box = operators.argsArray[operators.fnArray.indexOf(OPS.paintFormXObjectBegin)][1]
      box[1] = kind === 'visible' ? 0 : 15
    }
    if (kind === 'duplicate') content.items.push({ ...content.items[0] })
    const proof = await verifier.read({
      pageNumber: 1,
      sourceContent,
      targetPage: page,
      targetContent: content,
      targetViewport: viewport
    })
    const admitted = ['direct', 'auxiliary', 'abort', 'stale', 'source-set', 'target-set'].includes(
      kind
    )
    expect([...(proof?.target ?? [])]).toEqual(admitted ? [0] : [])
    expect([...(proof?.source ?? [])]).toEqual(admitted ? [0] : [])
    expect(factory).toHaveBeenCalledTimes(['auxiliary', 'abort'].includes(kind) ? 1 : 0)
    if (proof) {
      expect(proof.current()).toBe(true)
      if (kind === 'abort') {
        controller.abort()
        expect(proof.current()).toBe(false)
      }
      if (kind === 'stale') {
        operators.argsArray[operators.fnArray.indexOf(OPS.paintFormXObjectBegin)][1][1] = 0
        expect(proof.current()).toBe(false)
      }
      if (kind === 'source-set' || kind === 'target-set') {
        const indexes = (kind === 'source-set' ? proof.source : proof.target) as Set<number>
        indexes.clear()
        indexes.add(1)
        expect(proof.current()).toBe(false)
      }
    }
  } finally {
    await verifier.dispose()
    vi.unstubAllGlobals()
    await target.destroy()
    await original.destroy()
  }
})
