import { expect, it } from 'vitest'
import { PDFDocument, StandardFonts, rgb, PDFName, PDFString } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pdfPixelRegionBounds, verifyPdfPreservation } from './pdf-translation-preservation'

it('covers fractional pixel-cell intersections with the 2pt guard and uses exclusive integer edges', () => {
  // Pixels x=96 intersect the fractional guard beginning at x=96.224.
  const region = {
    x: 100.224 / 1224,
    y: 850.12958 / 1584,
    width: 472.5061928 / 1224,
    height: 189.28972 / 1584
  }
  expect(pdfPixelRegionBounds(region, 1224, 1584, 4)).toEqual([96, 846, 577, 1044])
  expect(pdfPixelRegionBounds({ x: 0.25, y: 0.25, width: 0.25, height: 0.25 }, 8, 8, 0)).toEqual([
    2, 2, 4, 4
  ])
  expect(pdfPixelRegionBounds({ x: 0, y: 0, width: 1, height: 1 }, 8, 8, 4)).toEqual([0, 0, 8, 8])
})

async function fixture(changed = false): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const page = pdf.addPage([500, 500])
  page.drawText(changed ? 'Translated' : 'Target', { x: 50, y: 450, size: 12, font })
  page.drawText('Retained', { x: changed ? 60 : 50, y: 350, size: 12, font })
  page.drawText('Stay', { x: 50, y: 250, size: 12, font })
  if (!changed) page.drawText('Removed', { x: 50, y: 150, size: 12, font })
  page.drawRectangle(
    changed
      ? { x: 50, y: 248, width: 30, height: 15, color: rgb(1, 1, 1) }
      : { x: 350, y: 150, width: 30, height: 15 }
  )
  page.node.set(
    PDFName.of('Annots'),
    pdf.context.obj([
      pdf.context.register(
        pdf.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: changed ? [60, 20, 110, 40] : [50, 20, 100, 40],
          A: { Type: 'Action', S: 'URI', URI: PDFString.of('https://example.org/preserved') }
        })
      )
    ])
  )
  return pdf.save()
}

const units = [
  { fragments: [{ pageNumber: 1, rect: { x: 0.09, y: 0.07, width: 0.5, height: 0.05 } }] },
  { fragments: [{ pageNumber: 1, rect: { x: 0.09, y: 0.27, width: 0.5, height: 0.05 } }] }
]

it('checks unchanged unselected and safely retained objects, graphics and annotations', async () => {
  const task = getDocument({ data: await fixture(), useSystemFonts: true })
  try {
    const document = await task.promise
    const result = await verifyPdfPreservation(document, document, units, [{ unitIndex: 1 }], [1])
    expect(result.pages[0]).toMatchObject({
      protectedTextObjects: 3,
      retainedTextObjects: 1,
      missingTextObjects: 0,
      changedTextObjects: 0,
      missingOrChangedGraphics: 0,
      protectedAnnotations: 1,
      changedAnnotations: 0,
      addedObjectOverlapCandidates: 0,
      pixels: { scale: 2, guardPoints: 2, changedPixels: 0, retainedChangedPixels: 0 },
      failures: []
    })
  } finally {
    await task.destroy()
  }
})

it('independently detects missing text, moved retained text, removed graphics and annotation movement', async () => {
  const before = getDocument({ data: await fixture(), useSystemFonts: true })
  const after = getDocument({ data: await fixture(true), useSystemFonts: true })
  try {
    const result = await verifyPdfPreservation(
      await before.promise,
      await after.promise,
      units,
      [{ unitIndex: 1 }],
      [1]
    )
    expect(result.pages[0]).toMatchObject({
      missingTextObjects: 1,
      changedTextObjects: 1,
      missingOrChangedGraphics: 1,
      changedAnnotations: 1
    })
    expect(result.pages[0].addedObjectOverlapCandidates).toBeGreaterThan(0)
    expect(result.pages[0].pixels!.changedPixels).toBeGreaterThan(0)
    expect(result.pages[0].pixels!.retainedChangedPixels).toBeGreaterThan(0)
    expect(result.pages[0].failures).toHaveLength(5)
  } finally {
    await before.destroy()
    await after.destroy()
  }
})

it('separates uniquely owned outside ink from unverified shared boundary objects', async () => {
  const before = getDocument({ data: await fixture(), useSystemFonts: true })
  const after = getDocument({ data: await fixture(true), useSystemFonts: true })
  try {
    const target = {
      source: 'Target',
      fragments: [{ pageNumber: 1, rect: { x: 0.09, y: 0.07, width: 0.04, height: 0.05 } }]
    }
    const retained = { ...units[1], source: 'Retained' }
    const owned = await verifyPdfPreservation(
      await before.promise,
      await after.promise,
      [target, retained],
      [{ unitIndex: 1 }]
    )
    expect(owned.pages[0]).toMatchObject({
      outsideInkOwnedTextObjects: 1,
      notVerifiedTextObjects: 0,
      missingTextObjects: 1,
      changedTextObjects: 1
    })
    const shared = await verifyPdfPreservation(
      await before.promise,
      await after.promise,
      [target, retained, target],
      [{ unitIndex: 1 }]
    )
    expect(shared.pages[0]).toMatchObject({
      outsideInkOwnedTextObjects: 0,
      notVerifiedTextObjects: 1,
      missingTextObjects: 1,
      changedTextObjects: 1
    })
    expect(shared.pages[0].notVerified[0].text).toBe('Target')
    expect(shared.pages[0].pixels!.changedPixels).toBeGreaterThan(0)
  } finally {
    await before.destroy()
    await after.destroy()
  }
})

it('never masks retained pixels even within a successful region or its guard', async () => {
  const before = getDocument({ data: await fixture(), useSystemFonts: true })
  const after = getDocument({ data: await fixture(true), useSystemFonts: true })
  try {
    const result = await verifyPdfPreservation(
      await before.promise,
      await after.promise,
      [{ fragments: [{ pageNumber: 1, rect: { x: 0, y: 0, width: 1, height: 1 } }] }, units[1]],
      [{ unitIndex: 1 }],
      [1]
    )
    const pixels = result.pages[0].pixels!
    expect(pixels.retainedPixels).toBeGreaterThan(0)
    expect(pixels.maskedPixels).toBeGreaterThan(0)
    expect(pixels.changedPixels).toBeGreaterThan(0)
    expect(pixels.changedPixels).toBe(pixels.retainedChangedPixels)
  } finally {
    await before.destroy()
    await after.destroy()
  }
})

it('requires independent unchanged outside pixels for a shared text object split', async () => {
  const documents = await Promise.all(
    [false, true].map(async (split) => {
      const pdf = await PDFDocument.create()
      const font = await pdf.embedFont(StandardFonts.Helvetica)
      const page = pdf.addPage([500, 500])
      if (split) {
        page.drawText('cccc', { x: 50, y: 450, size: 12, font })
        page.drawText('bbbb', {
          x: 50 + font.widthOfTextAtSize('aaaa ', 12),
          y: 450,
          size: 12,
          font
        })
      } else page.drawText('aaaa bbbb', { x: 50, y: 450, size: 12, font })
      return {
        task: getDocument({ data: await pdf.save(), useSystemFonts: true }),
        width: font.widthOfTextAtSize('aaaa ', 12)
      }
    })
  )
  try {
    const report = await verifyPdfPreservation(
      await documents[0].task.promise,
      await documents[1].task.promise,
      [
        {
          source: 'aaaa',
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 0.1, y: 0.07, width: documents[0].width / 500, height: 0.05 }
            }
          ]
        }
      ],
      []
    )
    expect(report.pages[0].notVerifiedTextObjects).toBe(1)
    expect(report.pages[0].pixels).toMatchObject({ changedPixels: 0, retainedChangedPixels: 0 })
    expect(report.pages[0].pixels!.guardOnlyPixels).toBeGreaterThan(0)
    expect(report.pages[0].failures).toEqual([])
  } finally {
    for (const { task } of documents) await task.destroy()
  }
})
