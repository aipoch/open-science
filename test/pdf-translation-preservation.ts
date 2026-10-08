import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PdfTranslationPdfRequest } from '../src/shared/pdf-translation'

type NativeObject = {
  type: number
  text: string
  bounds: number[]
  matrix: number[]
  fontName: string
  fontSize: number
}
type Region = { x: number; y: number; width: number; height: number }

// Pixels occupy [x, x + 1) × [y, y + 1); include every cell intersecting the region.
export function pdfPixelRegionBounds(
  region: Region,
  width: number,
  height: number,
  padding: number
): [number, number, number, number] {
  return [
    Math.max(0, Math.floor(region.x * width - padding)),
    Math.max(0, Math.floor(region.y * height - padding)),
    Math.min(width, Math.ceil((region.x + region.width) * width + padding)),
    Math.min(height, Math.ceil((region.y + region.height) * height + padding))
  ]
}

const key = (object: NativeObject): string => JSON.stringify(object)
const label = (object: NativeObject): string =>
  JSON.stringify([object.type, object.text, object.fontName])
const rounded = (value: number): number => Math.round(value * 1000) / 1000
const normalized = (text: string): string => text.normalize('NFC').replace(/\s+/gu, ' ').trim()
const intersects = (a: number[], b: number[]): boolean =>
  Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > 0.1 &&
  Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > 0.1

function difference(before: NativeObject[], after: NativeObject[]): NativeObject[] {
  const counts = new Map<string, number>()
  for (const object of after) counts.set(key(object), (counts.get(key(object)) ?? 0) + 1)
  return before.filter((object) => {
    const count = counts.get(key(object)) ?? 0
    if (!count) return true
    counts.set(key(object), count - 1)
    return false
  })
}

export type PdfPreservationReport = {
  scope: string
  pages: Array<{
    pageNumber: number
    protectedTextObjects: number
    retainedTextObjects: number
    outsideInkOwnedTextObjects: number
    notVerifiedTextObjects: number
    notVerified: Array<{ text: string; bounds: number[] }>
    missingTextObjects: number
    changedTextObjects: number
    missingOrChangedGraphics: number
    notCertifiedGraphics: Array<{ bounds: number[] }>
    graphicsWithoutMatrix: number
    protectedAnnotations: number
    changedAnnotations: number
    addedObjectOverlapCandidates: number
    failures: Array<{ kind: string; text?: string; bounds?: number[] }>
    pixels?: {
      scale: number
      guardPoints: number
      width: number
      height: number
      comparedPixels: number
      maskedPixels: number
      guardOnlyPixels: number
      retainedPixels: number
      changedPixels: number
      retainedChangedPixels: number
      maxChannelDelta: number
      changedBounds: number[] | null
    }
  }>
}

// Independent post-save comparison: no writer ownership/planner helpers are used here.
export async function verifyPdfPreservation(
  original: PDFDocumentProxy,
  translated: PDFDocumentProxy,
  units: readonly {
    source?: string
    fragments: PdfTranslationPdfRequest['units'][number]['fragments']
  }[],
  failures: readonly { unitIndex: number }[],
  pixelCheckPages: readonly number[] = []
): Promise<PdfPreservationReport> {
  if (
    pixelCheckPages.some(
      (page) => !Number.isSafeInteger(page) || page < 1 || page > original.numPages
    )
  )
    throw new Error('Pixel check pages must identify existing pages')
  const { engine } = await import(
    pathToFileURL(resolve('resources/pdf-translation/pdfium.mjs')).href
  )
  const native = await engine()
  const before = native.open(await original.getData())
  const after = native.open(await translated.getData())
  const at = native.alloc(32)
  const report: PdfPreservationReport = {
    scope:
      'All pages; PDFium top-level text objects not fully contained in one successful fragment, plus retained fragment text, compared as multisets of text/font/size/bounds/matrix rounded to 0.001 PDF units. Non-text object type/bounds/available matrix and annotation semantics are compared; graphicsWithoutMatrix counts objects for which PDFium exposes no matrix; annotation rectangles outside successful regions must stay fixed. Outside-ink objects are exempt only when their complete NFC/whitespace-normalized text belongs to exactly one successful selected source and overlaps its fragment; these are counted separately. Unmatched shared/boundary objects require independent glyph-level review and are counted as notVerified, not confirmed loss. Retained text stays protected. Added-object bounding-box overlaps are candidates requiring review, not confirmed visual occlusion. Object comparison does not inspect nested Form contents, path/image payloads, clipping, transparency or paint order. Requested pages and pages with unverified shared text or changed graphics overlapping successful regions additionally compare PDFium 2x white-background BGRA RGB bytes, flags=0 (annotation appearances excluded), outside pixel cells intersecting successful fragments plus a 2pt guard (floor left/top, ceil right/bottom exclusive). Retained pixel cells override masking. Zero differences certify only those compared pixels at this resolution; masked regions, guard bands and semantic ownership remain uncertified. Geometry candidates are never silently discarded.',
    pages: []
  }
  try {
    for (let pageNumber = 1; pageNumber <= original.numPages; pageNumber++) {
      const sourcePage = native.p.FPDF_LoadPage(before.doc, pageNumber - 1)
      const outputPage = native.p.FPDF_LoadPage(after.doc, pageNumber - 1)
      if (!sourcePage || !outputPage) throw new Error('Cannot inspect native preservation page')
      try {
        const width = native.p.FPDF_GetPageWidthF(sourcePage)
        const height = native.p.FPDF_GetPageHeightF(sourcePage)
        const regions = (retained: boolean): Region[] =>
          units.flatMap((unit, unitIndex) =>
            failures.some((failure) => failure.unitIndex === unitIndex) === retained
              ? unit.fragments.filter((f) => f.pageNumber === pageNumber).map((f) => f.rect)
              : []
          )
        const fitted = regions(false)
        const retained = regions(true)
        const regionBounds = (r: Region): number[] => [
          r.x * width,
          (1 - r.y - r.height) * height,
          (r.x + r.width) * width,
          (1 - r.y) * height
        ]
        const overlaps = (bounds: number[], areas: Region[]): boolean =>
          areas.some((r) => intersects(bounds, regionBounds(r)))
        const inside = (bounds: number[], areas: Region[]): boolean => {
          const x = (bounds[0] + bounds[2]) / 2 / width
          const y = 1 - (bounds[1] + bounds[3]) / 2 / height
          return areas.some(
            (r) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height
          )
        }
        const contained = (bounds: number[], areas: Region[]): boolean =>
          areas.some(
            (r) =>
              bounds[0] >= r.x * width - 0.001 &&
              bounds[2] <= (r.x + r.width) * width + 0.001 &&
              bounds[1] >= (1 - r.y - r.height) * height - 0.001 &&
              bounds[3] <= (1 - r.y) * height + 0.001
          )
        const snapshot = (page: number): NativeObject[] =>
          native
            .objects(page)
            .map(
              (object: {
                obj: number
                type: number
                text: string
                bounds: number[]
              }): NativeObject => {
                const hasMatrix = native.p.FPDFPageObj_GetMatrix(object.obj, at)
                if (!hasMatrix && object.type === 1)
                  throw new Error('Cannot inspect native object matrix')
                const matrix = hasMatrix
                  ? Array.from(native.m.HEAPF32.slice(at / 4, at / 4 + 6), Number).map(rounded)
                  : []
                let fontName = ''
                let fontSize = 0
                if (object.type === 1) {
                  if (!native.p.FPDFTextObj_GetFontSize(object.obj, at))
                    throw new Error('Cannot inspect native font size')
                  fontSize = rounded(native.m.HEAPF32[at / 4])
                  const font = native.p.FPDFTextObj_GetFont(object.obj)
                  const length = native.p.FPDFFont_GetBaseFontName(font, 0, 0)
                  const buffer = native.alloc(length)
                  try {
                    native.p.FPDFFont_GetBaseFontName(font, buffer, length)
                    fontName = Buffer.from(
                      native.m.HEAPU8.slice(buffer, buffer + Math.max(0, length - 1))
                    ).toString('utf8')
                  } finally {
                    native.free(buffer)
                  }
                }
                return {
                  type: object.type,
                  text: object.text ?? '',
                  bounds: object.bounds.map(rounded),
                  matrix,
                  fontName,
                  fontSize
                }
              }
            )
        const oldObjects = snapshot(sourcePage)
        const newObjects = snapshot(outputPage)
        const uniquelyOwned = (object: NativeObject): boolean => {
          const text = normalized(object.text)
          if (!text) return false
          const owners = units.flatMap((unit, unitIndex) =>
            normalized(unit.source ?? '').includes(text) ? [unitIndex] : []
          )
          if (owners.length !== 1 || failures.some((failure) => failure.unitIndex === owners[0]))
            return false
          return overlaps(
            object.bounds,
            units[owners[0]].fragments.filter((f) => f.pageNumber === pageNumber).map((f) => f.rect)
          )
        }
        const outsideInkOwned = oldObjects.filter(
          (o) =>
            o.type === 1 &&
            !contained(o.bounds, fitted) &&
            !inside(o.bounds, retained) &&
            uniquelyOwned(o)
        )
        const outsideInkKeys = new Set(outsideInkOwned.map(key))
        const protectedText = oldObjects.filter(
          (o) =>
            o.type === 1 &&
            ((!contained(o.bounds, fitted) && !outsideInkKeys.has(key(o))) ||
              inside(o.bounds, retained))
        )
        const unmatchedProtected = difference(protectedText, newObjects)
        // A shared object can be legitimately split and rebuilt. Do not call its whole-object
        // difference data loss without an independent glyph-level proof.
        const notVerified = unmatchedProtected.filter(
          (o) => overlaps(o.bounds, fitted) && !inside(o.bounds, retained)
        )
        const unmatched = unmatchedProtected.filter((o) => !notVerified.includes(o))
        const added = difference(newObjects, oldObjects)
        const changedLabels = new Map<string, number>()
        for (const object of added)
          changedLabels.set(label(object), (changedLabels.get(label(object)) ?? 0) + 1)
        let changedTextObjects = 0
        for (const object of unmatched) {
          const count = changedLabels.get(label(object)) ?? 0
          if (count) {
            changedTextObjects++
            changedLabels.set(label(object), count - 1)
          }
        }
        const missingGraphics = difference(
          oldObjects.filter((o) => o.type !== 1),
          newObjects
        )
        const notCertifiedGraphics = missingGraphics.filter(
          (o) => overlaps(o.bounds, fitted) && !overlaps(o.bounds, retained)
        )
        const protectedGraphicsChanges = missingGraphics.filter(
          (o) => !notCertifiedGraphics.includes(o)
        )
        const sourceAnnotations = await (await original.getPage(pageNumber)).getAnnotations()
        const outputAnnotations = await (await translated.getPage(pageNumber)).getAnnotations()
        const annotationKey = (
          annotation: (typeof sourceAnnotations)[number],
          keepRect: boolean
        ): string =>
          JSON.stringify({
            subtype: annotation.subtype,
            url: annotation.url,
            unsafeUrl: annotation.unsafeUrl,
            dest: annotation.dest,
            action: annotation.action,
            contents: annotation.contentsObj?.str,
            ...(keepRect ? { rect: annotation.rect.map(rounded) } : {})
          })
        const remainingAnnotations = [...outputAnnotations]
        let changedAnnotations = 0
        for (const annotation of sourceAnnotations) {
          const keepRect = !inside(annotation.rect, fitted) || inside(annotation.rect, retained)
          const index = remainingAnnotations.findIndex(
            (candidate) =>
              annotationKey(candidate, keepRect) === annotationKey(annotation, keepRect)
          )
          if (index < 0) changedAnnotations++
          else remainingAnnotations.splice(index, 1)
        }
        let pixels: PdfPreservationReport['pages'][number]['pixels']
        if (
          pixelCheckPages.includes(pageNumber) ||
          notVerified.length ||
          notCertifiedGraphics.length
        ) {
          const scale = 2
          const guardPoints = 2
          const pixelWidth = Math.ceil(width * scale)
          const pixelHeight = Math.ceil(height * scale)
          if (pixelWidth * pixelHeight > 20_000_000)
            throw new Error('Pixel check page exceeds 20 million pixels')
          if (
            native.p.FPDF_GetPageWidthF(outputPage) !== width ||
            native.p.FPDF_GetPageHeightF(outputPage) !== height
          )
            throw new Error('Pixel check page dimensions changed')
          const render = (page: number): { data: Uint8Array; stride: number } => {
            const bitmap = native.p.FPDFBitmap_Create(pixelWidth, pixelHeight, 1)
            if (!bitmap) throw new Error('Cannot allocate native pixel check bitmap')
            try {
              native.p.FPDFBitmap_FillRect(bitmap, 0, 0, pixelWidth, pixelHeight, 0xffffffff)
              native.p.FPDF_RenderPageBitmap(bitmap, page, 0, 0, pixelWidth, pixelHeight, 0, 0)
              const pointer = native.p.FPDFBitmap_GetBuffer(bitmap)
              const stride = native.p.FPDFBitmap_GetStride(bitmap)
              return {
                data: native.m.HEAPU8.slice(pointer, pointer + pixelHeight * stride),
                stride
              }
            } finally {
              native.p.FPDFBitmap_Destroy(bitmap)
            }
          }
          const sourcePixels = render(sourcePage)
          const outputPixels = render(outputPage)
          const mask = new Uint8Array(pixelWidth * pixelHeight)
          const mark = (region: Region, padding: number, flag: number): void => {
            const [left, top, right, bottom] = pdfPixelRegionBounds(
              region,
              pixelWidth,
              pixelHeight,
              padding
            )
            for (let y = top; y < bottom; y++)
              for (let x = left; x < right; x++) mask[y * pixelWidth + x] |= flag
          }
          for (const region of fitted) {
            mark(region, guardPoints * scale, 1)
            mark(region, 0, 2)
          }
          // Retained pixels override even a neighboring successful region's guard band.
          for (const region of retained) mark(region, 0, 4)
          pixels = {
            scale,
            guardPoints,
            width: pixelWidth,
            height: pixelHeight,
            comparedPixels: 0,
            maskedPixels: 0,
            guardOnlyPixels: 0,
            retainedPixels: 0,
            changedPixels: 0,
            retainedChangedPixels: 0,
            maxChannelDelta: 0,
            changedBounds: null
          }
          for (let y = 0; y < pixelHeight; y++) {
            for (let x = 0; x < pixelWidth; x++) {
              const flags = mask[y * pixelWidth + x]
              if (flags & 1 && !(flags & 4)) {
                pixels.maskedPixels++
                if (!(flags & 2)) pixels.guardOnlyPixels++
                continue
              }
              pixels.comparedPixels++
              if (flags & 4) pixels.retainedPixels++
              let delta = 0
              for (let channel = 0; channel < 3; channel++)
                delta = Math.max(
                  delta,
                  Math.abs(
                    sourcePixels.data[y * sourcePixels.stride + x * 4 + channel] -
                      outputPixels.data[y * outputPixels.stride + x * 4 + channel]
                  )
                )
              if (!delta) continue
              pixels.changedPixels++
              if (flags & 4) pixels.retainedChangedPixels++
              pixels.maxChannelDelta = Math.max(pixels.maxChannelDelta, delta)
              const bounds = pixels.changedBounds ?? [x, y, x, y]
              pixels.changedBounds = [
                Math.min(bounds[0], x),
                Math.min(bounds[1], y),
                Math.max(bounds[2], x),
                Math.max(bounds[3], y)
              ]
            }
          }
        }
        report.pages.push({
          pageNumber,
          protectedTextObjects: protectedText.length,
          retainedTextObjects: protectedText.filter((o) => inside(o.bounds, retained)).length,
          outsideInkOwnedTextObjects: outsideInkOwned.length,
          notVerifiedTextObjects: notVerified.length,
          notVerified: notVerified.map((o) => ({ text: o.text.slice(0, 120), bounds: o.bounds })),
          missingTextObjects: unmatched.length - changedTextObjects,
          changedTextObjects,
          missingOrChangedGraphics: protectedGraphicsChanges.length,
          notCertifiedGraphics: notCertifiedGraphics.map((o) => ({ bounds: o.bounds })),
          graphicsWithoutMatrix: oldObjects.filter((o) => o.type !== 1 && !o.matrix.length).length,
          protectedAnnotations: sourceAnnotations.length,
          changedAnnotations,
          addedObjectOverlapCandidates: protectedText.filter((o) =>
            added.some((candidate) => intersects(o.bounds, candidate.bounds))
          ).length,
          failures: [
            ...unmatched.map((o) => ({
              kind: 'text-missing-or-changed',
              text: o.text.slice(0, 120),
              bounds: o.bounds
            })),
            ...protectedGraphicsChanges.map((o) => ({
              kind: 'graphics-missing-or-changed',
              bounds: o.bounds
            })),
            ...(changedAnnotations ? [{ kind: 'annotation-missing-or-changed' }] : []),
            ...(pixels?.changedPixels
              ? [{ kind: 'protected-pixels-changed', bounds: pixels.changedBounds! }]
              : [])
          ],
          ...(pixels ? { pixels } : {})
        })
      } finally {
        native.p.FPDF_ClosePage(sourcePage)
        native.p.FPDF_ClosePage(outputPage)
      }
    }
  } finally {
    native.free(at)
    before.close()
    after.close()
  }
  return report
}
