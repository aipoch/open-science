import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import {
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
  PDFOperator,
  PDFOperatorNames,
  StandardFonts,
  clip,
  endPath,
  rectangle
} from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PdfTranslationWriter } from './writer'
import { ApplicationCallerLeaseRegistry } from '../../caller-lifecycle'

it.each([
  'case',
  'unchanged',
  'wrong-case',
  'semantic-change',
  'missing-items',
  'resource-matrix',
  'invocation-matrix',
  'extra-param',
  'extra-owned',
  'body-translation'
])('verifies nested Form ActualText without changing its original paint: %s', async (kind) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    page = pdf.addPage([300, 200]),
    semantic = kind === 'semantic-change' ? 'X' : 'R',
    form = pdf.context.register(
      pdf.context.flateStream(
        `BT /F1 10 Tf 1 0 0 1 40 150 Tm (Sample ) Tj ` +
          `/Span << /ActualText <FEFF00${semantic.charCodeAt(0).toString(16)}> ${kind === 'extra-param' ? '/Other /Value' : ''} >> BDC ` +
          `(r) Tj EMC (ecord) Tj ${kind === 'extra-owned' ? '( EXTRA) Tj' : ''} ET`,
        {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [30, 135, 150, 170],
          Resources: { Font: { F1: font.ref } },
          ...(kind === 'resource-matrix' ? { Matrix: [1, 0, 0, 1, 0, -1] } : {})
        }
      )
    )
  const key = page.node.newXObject('Label', form)
  if (kind === 'invocation-matrix')
    page.pushOperators(
      PDFOperator.of(
        PDFOperatorNames.ConcatTransformationMatrix,
        [1, 0, 0, 1, 0, -1].map(PDFNumber.of)
      )
    )
  page.pushOperators(PDFOperator.of(PDFOperatorNames.DrawObject, [key]))
  page.drawText('Neighbor 17', { font, x: 40, y: 110, size: 10 })
  const data = await pdf.save(),
    registry = new ApplicationCallerLeaseRegistry(),
    caller = registry.acquire({ leaseId: 'nested-actual-text', surface: 'electron' }),
    source = kind === 'wrong-case' ? 'Sample RECORD' : 'Sample record'
  try {
    const output = new PdfTranslationWriter(() =>
      resolve('resources/pdf-translation/worker.mjs')
    ).generateDetailed(
      {
        id: 'nested-actual-text',
        data,
        pages: [{ width: 300, height: 200 }],
        preserveUnsupported: true,
        units: [
          ...(kind === 'body-translation'
            ? [
                {
                  source: 'Neighbor 17',
                  translation: '邻居 17',
                  fragments: [
                    {
                      pageNumber: 1,
                      rect: { x: 39 / 300, y: 78 / 200, width: 100 / 300, height: 16 / 200 }
                    }
                  ]
                }
              ]
            : []),
          {
            source,
            translation: kind === 'unchanged' ? source : '样本记录',
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 39 / 300, y: 38 / 200, width: 100 / 300, height: 16 / 200 },
                ...(kind === 'missing-items'
                  ? {}
                  : {
                      items: [
                        { index: 0, text: 'Sample ' },
                        { index: 1, text: 'r' },
                        { index: 2, text: 'ecord' }
                      ]
                    })
              }
            ]
          }
        ]
      },
      caller.lease
    )
    if (!['case', 'unchanged', 'resource-matrix', 'body-translation'].includes(kind)) {
      await expect(output).rejects.toMatchObject({
        failure: { code: 'source-mismatch', pageNumber: 1 }
      })
      return
    }
    const result = (await output)!
    if (kind === 'body-translation') {
      const task = getDocument({ data: result.data.slice(), useSystemFonts: true })
      try {
        const text = (await (await (await task.promise).getPage(1)).getTextContent()).items
          .flatMap((item) => ('str' in item ? [item.str] : []))
          .join('')
        expect(text).toContain('Sample record')
        expect(text).toContain('邻居 17')
        expect(text).not.toContain('Neighbor 17')
      } finally {
        await task.destroy()
      }
    } else expect(Buffer.from(result.data).equals(Buffer.from(data))).toBe(true)
    expect(result.layoutFailures).toEqual(
      kind === 'unchanged'
        ? []
        : [
            {
              unitIndex: kind === 'body-translation' ? 1 : 0,
              code: 'unsupported-layout',
              phase: 'planning',
              pageNumbers: [1],
              fragmentCount: 1
            }
          ]
    )
  } finally {
    caller.release()
    registry.dispose()
  }
})

it.each([
  'case',
  'kerned',
  'ascii-mark',
  'semantic-change',
  'missing-mark',
  'wrong-case',
  'clip',
  'extra-owned',
  'changed-glyph',
  'extra-param',
  'missing-items'
])('uses explicit ActualText case metadata only with unchanged native ink: %s', async (kind) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    page = pdf.addPage([300, 200]),
    registry = new ApplicationCallerLeaseRegistry(),
    caller = registry.acquire({ leaseId: 'actual-text', surface: 'electron' }),
    semantic = kind === 'semantic-change' ? 'method' : 'arch'
  page.drawText('', { font, x: 40, y: 150, size: 10 })
  if (kind === 'clip') page.pushOperators(rectangle(44, 140, 80, 22), clip(), endPath())
  if (kind !== 'missing-mark')
    page.pushOperators(
      PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [
        PDFName.of('Span'),
        // @ts-expect-error BDC accepts an inline property dictionary; pdf-lib types omit it.
        pdf.context.obj({
          ActualText:
            kind === 'ascii-mark' ? PDFString.of(semantic) : PDFHexString.fromText(semantic),
          ...(kind === 'extra-param' ? { Other: PDFName.of('Value') } : {})
        })
      ])
    )
  if (kind === 'kerned') {
    const key = page.node.newFontDictionary(font.name, font.ref)
    page.pushOperators(
      PDFOperator.of(PDFOperatorNames.BeginText),
      PDFOperator.of(PDFOperatorNames.SetFontAndSize, [key, PDFNumber.of(10)]),
      PDFOperator.of(PDFOperatorNames.SetTextMatrix, [1, 0, 0, 1, 40, 150].map(PDFNumber.of)),
      PDFOperator.of(PDFOperatorNames.ShowTextAdjusted, [
        pdf.context.obj([font.encodeText('AR'), 18, font.encodeText('CH')])
      ]),
      PDFOperator.of(PDFOperatorNames.EndText)
    )
  } else
    page.drawText(kind === 'changed-glyph' ? 'ARCK' : 'ARCH', { font, x: 40, y: 150, size: 10 })
  if (kind !== 'missing-mark') page.pushOperators(PDFOperator.of(PDFOperatorNames.EndMarkedContent))
  if (kind === 'extra-owned') page.drawText('OTHER', { font, x: 90, y: 150, size: 10 })
  page.drawText('Neighbor', { font, x: 40, y: 112, size: 10 })
  const data = await pdf.save(),
    original = data.slice(),
    source = kind === 'wrong-case' || kind === 'missing-mark' ? 'Arch' : 'ARCH',
    writer = new PdfTranslationWriter(() => resolve('resources/pdf-translation/worker.mjs'))
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const output = writer.generate(
      {
        id: 'actual-text',
        data,
        pages: [{ width: 300, height: 200 }],
        units: [
          {
            source,
            translation: '研究',
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 39 / 300, y: 38 / 200, width: 100 / 300, height: 15 / 200 },
                ...(kind === 'missing-items' ? {} : { items: [{ index: 0, text: source }] })
              }
            ]
          }
        ]
      },
      caller.lease
    )
    if (!['case', 'kerned', 'ascii-mark'].includes(kind)) {
      await expect(output).rejects.toMatchObject({ failure: { code: expect.any(String) } })
    } else {
      task = getDocument({ data: (await output)!, useSystemFonts: true })
      const items = (await (await task.promise).getPage(1)).getTextContent()
      const text = (await items).items.filter((item) => 'str' in item)
      expect(text.map((item) => item.str).join('')).toBe('研究Neighbor')
      expect(text.find((item) => item.str === 'Neighbor')?.transform.slice(4)).toEqual([40, 112])
    }
    expect(data).toEqual(original)
  } finally {
    await task?.destroy()
    caller.release()
    registry.dispose()
  }
})
