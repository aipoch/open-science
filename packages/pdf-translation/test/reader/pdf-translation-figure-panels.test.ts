import { expect, it, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import * as fontkit from 'fontkit'
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'
import { applyCachedPdfFigureSources } from '../../src/reader/figure-source.js'
import { nativeFigurePanels, retainNativeFigurePanels } from '../../src/reader/figure-panels.js'
import { createPdfTranslationSource } from '../../src/reader/source.js'

async function fixture(fault = ''): Promise<{
  task: ReturnType<typeof getDocument>
  sourceIdentity: { sourceChecksum: string; sourceSizeBytes: number }
}> {
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
  page.drawText('Register font.', { font })
  const key = page.node.Resources()!.lookup(PDFName.of('Font'), PDFDict).keys()[0].toString(),
    text = (value: string, x: number, y: number, size = 8): string => {
      let cursor = x
      return value
        .split(' ')
        .map((word) => {
          const result = `BT ${key} ${size} Tf ${cursor} ${y} Td ${font.encodeText(word)} Tj ET`
          cursor += font.widthOfTextAtSize(word, size) + size * 0.3
          return result
        })
        .join('\n')
    },
    frame =
      '0 6 m 0 124 l 0 127.3 2.7 130 6 130 c 394 130 l 397.3 130 400 127.3 400 124 c 400 6 l 400 2.7 397.3 0 394 0 c 6 0 l 2.7 0 0 2.7 0 6 c h f',
    body = '1 6 m 1 115 l 399 115 l 399 6 l 399 3.2 396.8 1 394 1 c 6 1 l 3.2 1 1 3.2 1 6 c h f',
    header =
      '1 116 m 1 124 l 1 126.8 3.2 129 6 129 c 394 129 l 396.8 129 399 126.8 399 124 c 399 116 l h f',
    panels = [630, 470, 310].flatMap((y, i) => [
      `q 1 0 0 1 80 ${y} cm`,
      '0 w',
      frame,
      body,
      header,
      ...(fault === 'divider' && i === 0
        ? []
        : [`${fault === 'wide-divider' ? 600 : 0.5} w 215 115 m 215 1 l S`]),
      'Q',
      text(`Panel ${['alpha', 'beta', 'gamma'][i]}`, 90, y + 120),
      text('Instructions for a task.', 90, y + 100),
      text('Observe the situation.', 90, y + 85),
      text('Plan the next step.', 90, y + 70),
      text('Example and explanation.', 310, y + 100),
      text('Keep the example intact.', 310, y + 85),
      text('Check the outcome.', 310, y + 70)
    ])
  page.node.set(
    PDFName.of('Contents'),
    pdf.context.register(
      pdf.context.flateStream(
        [
          text('Shared instructions outside every panel.', 80, 780),
          ...panels,
          ...(fault === 'gap-text' ? [text('Unrelated explanation.', 90, 615)] : []),
          ...(fault === 'gap-paint' ? ['0.5 w 100 615 m 200 615 l S'] : []),
          ...(fault === 'caption'
            ? []
            : [
                text(
                  'Figure 1. Prompt panels with instructions and examples for separate tasks and complete outcomes.',
                  80,
                  285,
                  9
                )
              ])
        ].join('\n')
      )
    )
  )
  const bytes = await pdf.save(),
    sourceIdentity = {
      sourceChecksum: createHash('sha256').update(bytes).digest('hex'),
      sourceSizeBytes: bytes.length
    },
    task = getDocument({
      data: bytes,
      fontExtraProperties: true,
      disableFontFace: true,
      isEvalSupported: false
    })
  return { task, sourceIdentity }
}

it.each([
  'none',
  'divider',
  'wide-divider',
  'gap-text',
  'gap-paint',
  'caption',
  'unknown-glyph',
  'transparent',
  'hairline',
  'duplicate-owner',
  'wrong-text'
])('keeps captioned panels atomic only with complete native evidence (%s)', async (fault) => {
  const { task, sourceIdentity } = await fixture(fault)
  try {
    const document = await task.promise,
      page = await document.getPage(1),
      signal = new AbortController().signal,
      raw = await extractPdfTranslationSource({
        document,
        signal,
        resourceRequestKey: 'anonymous-panels'
      }),
      original = await page.getOperatorList(),
      operators = structuredClone(original)
    // Identity alpha and fill-only zero widths are inert; the negative cases
    // change their real semantics without changing source items or rectangles.
    operators.fnArray.unshift(OPS.setGState)
    operators.argsArray.unshift([[['ca', fault === 'transparent' ? 0.5 : 1]]])
    if (fault === 'hairline') {
      operators.fnArray.push(OPS.setLineWidth, OPS.constructPath)
      operators.argsArray.push(
        [0],
        [
          OPS.stroke,
          [new Float32Array([0, 90, 600, 1, 100, 600])],
          new Float32Array([90, 600, 100, 600])
        ]
      )
    }
    if (fault === 'unknown-glyph') {
      const glyph = operators.argsArray
        .flatMap((a, i) => (operators.fnArray[i] === OPS.showText ? a[0] : []))
        .find((g) => g?.unicode === 'P')
      expect(glyph).toBeDefined()
      glyph.isInFont = false
    }
    page.getOperatorList = async () => operators
    let extraction = raw
    if (fault === 'duplicate-owner' || fault === 'wrong-text') {
      const units = structuredClone(raw.source.units),
        panel = units.find((u) => u.source.includes('Panel alpha'))!
      if (fault === 'duplicate-owner') units.push({ ...panel, id: 'duplicate' })
      else (panel.fragments[0].items[0] as { text: string }).text += '!'
      extraction = { ...raw, source: createPdfTranslationSource({ ...raw.source, units }) }
    }
    const proof = await nativeFigurePanels(extraction.source.units, page, 1)
    if (fault !== 'none') {
      expect(proof).toBeUndefined()
      return
    }
    expect(proof?.regions).toHaveLength(3)
    const result = await applyCachedPdfFigureSources({
      extraction,
      document,
      sourceIdentity,
      sourceId: 'anonymous',
      signal,
      readCached: async () => undefined
    })
    expect(result.source.originalRegions).toHaveLength(3)
    const panels = result.source.units.filter(
      (u) => !u.source.startsWith('Shared') && !u.source.startsWith('Figure')
    )
    expect(panels.length).toBeGreaterThan(3)
    expect(panels.every((u) => u.sourceOnly && u.figure)).toBe(true)
    expect(
      result.source.units
        .filter((u) => u.source.startsWith('Shared') || u.source.startsWith('Figure'))
        .every((u) => !u.sourceOnly && !u.figure)
    ).toBe(true)
    const sources = (value: typeof raw): (string | number)[][] =>
      value.source.units.flatMap((u) =>
        u.fragments.flatMap((f) => f.items.map((i) => [f.pageNumber, i.index, i.text]))
      )
    expect(sources(result)).toEqual(sources(raw))
    expect(result.source.units.map((u) => [u.id, u.source, u.fragments])).toEqual(
      raw.source.units.map((u) => [u.id, u.source, u.fragments])
    )
    expect(result.coverage).toEqual(raw.coverage)
    expect(proof!.current()).toBe(true)
    const changed = operators.argsArray
      .flatMap((a, i) => (operators.fnArray[i] === OPS.showText ? a[0] : []))
      .find((g) => g?.unicode === 'P')
    changed.width += 1
    expect(proof!.current()).toBe(false)
  } finally {
    await task.destroy()
  }
})

it('uses an owned auxiliary document when the primary panel outlines are absent', async () => {
  const { task, sourceIdentity } = await fixture()
  const factory = vi.fn(getDocument)
  vi.stubGlobal('document', {
    createElement: (): ReturnType<typeof createCanvas> => createCanvas(1, 1)
  })
  try {
    const document = await task.promise,
      page = await document.getPage(1),
      signal = new AbortController().signal,
      raw = await extractPdfTranslationSource({
        document,
        signal,
        resourceRequestKey: 'anonymous-panels'
      }),
      has = page.commonObjs.has.bind(page.commonObjs)
    page.commonObjs.has = (key: string): boolean => !key.includes('_path_') && has(key)
    expect(await nativeFigurePanels(raw.source.units, page, 1)).toBeUndefined()
    const result = await retainNativeFigurePanels({
      extraction: raw,
      document,
      sourceIdentity,
      signal,
      nativeDocumentFactory: factory
    })
    expect(factory).toHaveBeenCalledOnce()
    expect(result.source.originalRegions).toHaveLength(3)
    expect(result.source.units.filter((u) => u.figure)).toHaveLength(21)
    expect(document.numPages).toBe(1)
  } finally {
    await task.destroy()
    vi.unstubAllGlobals()
  }
})
