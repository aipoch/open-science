import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PdfTranslationPdfRequest } from '../src/shared/pdf-translation'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const normalizedText = (text: string): string =>
  text.replace(/\s/gu, '').normalize('NFKC').normalize('NFC')

type NativeInk = { text: string; bounds: number[]; transform: number[] }

// A native fraction's dividing rule has no text character. Verify both numeric
// tiers and the unique intervening rule before representing it as a slash.
export function verifiedNumericFractionItems(
  items: readonly { str: string; transform?: number[]; width?: number }[],
  ink: readonly NativeInk[],
  rules: readonly number[][],
  source: string,
  translation: string
): Array<{ str: string; transform?: number[]; width?: number }> {
  const result = items.map((item) => ({ ...item })),
    upright = (part: NativeInk): boolean =>
      part.transform.length === 6 &&
      part.transform.every(Number.isFinite) &&
      part.transform[0] > 0 &&
      part.transform[0] === part.transform[3] &&
      part.transform[1] === 0 &&
      part.transform[2] === 0,
    matches = (part: NativeInk): number[] =>
      items.flatMap((item, index) =>
        item.str.trim() === part.text &&
        item.transform?.every((value, at) => Math.abs(value - part.transform[at]) < 0.0002)
          ? [index]
          : []
      )
  for (const top of ink) {
    if (!/^\d{1,3}$/u.test(top.text) || !upright(top)) continue
    const size = top.transform[0],
      bottoms = ink.filter(
        (bottom) =>
          /^\d{1,3}$/u.test(bottom.text) &&
          upright(bottom) &&
          Math.abs(bottom.transform[0] - size) < size * 0.01 &&
          top.transform[5] - bottom.transform[5] > size * 0.3 &&
          top.transform[5] - bottom.transform[5] < size * 2 &&
          top.bounds[1] > bottom.bounds[3] &&
          Math.abs((top.bounds[0] + top.bounds[2] - bottom.bounds[0] - bottom.bounds[2]) / 2) <
            size * 0.15
      )
    if (bottoms.length !== 1) continue
    const bottom = bottoms[0],
      label = `${top.text}/${bottom.text}`,
      count = (text: string): number =>
        [...text.matchAll(new RegExp(`(?<![\\d/])${label}(?![\\d/])`, 'gu'))].length,
      bars = rules.filter(
        (bar) =>
          bar.length === 4 &&
          bar.every(Number.isFinite) &&
          bar[3] > bar[1] &&
          bar[3] - bar[1] < size * 0.2 &&
          bar[1] > bottom.bounds[3] &&
          bar[3] < top.bounds[1] &&
          Math.abs(bar[0] - Math.min(top.bounds[0], bottom.bounds[0])) < size * 0.25 &&
          Math.abs(bar[2] - Math.max(top.bounds[2], bottom.bounds[2])) < size * 0.25
      ),
      a = matches(top),
      b = matches(bottom)
    if (
      bars.length !== 1 ||
      count(source) !== 1 ||
      count(translation) !== 1 ||
      a.length !== 1 ||
      b.length !== 1 ||
      a[0] >= b[0] ||
      items.slice(a[0] + 1, b[0]).some((part) => part.str.trim())
    )
      continue
    result[a[0]].str = label
    result[b[0]].str = ''
  }
  return result
}

// Native reused accents may precede their base in PDF text order. Move only an
// isolated native accent item, never an accent already attached inside prose text.
export function normalizedNativeText(
  items: readonly { str: string; transform?: number[]; width?: number }[]
): string {
  const parts = items.map((item) => item.str.replace(/\s/gu, ''))
  for (let index = 0; index < parts.length; index++) {
    const mark = parts[index]
    if (mark !== '\u0302' && mark !== 'ˆ' && mark !== '¯') continue
    let next = index + 1
    while (next < parts.length && !parts[next]) next++
    if (!/^[\p{Script=Latin}\p{Script=Greek}]/u.test(parts[next] ?? '')) continue
    if (mark === 'ˆ' || mark === '¯') {
      // A spacing accent is also ordinary prose. Reorder only an isolated raised
      // item whose native geometry identifies exactly one single-letter base.
      const hat = items[index],
        matrix = hat.transform
      if (
        !matrix ||
        matrix.length !== 6 ||
        !matrix.every(Number.isFinite) ||
        matrix[0] <= 0 ||
        matrix[0] !== matrix[3] ||
        matrix[1] !== 0 ||
        matrix[2] !== 0 ||
        !Number.isFinite(hat.width) ||
        hat.width! <= 0 ||
        (mark === '¯' && (hat.width! < matrix[0] * 0.4 || hat.width! > matrix[0] * 0.6))
      )
        continue
      const center = matrix[4] + hat.width! / 2
      const owners = items.flatMap((item, itemIndex) => {
        const base = item.transform
        if (
          !/^[\p{Script=Latin}\p{Script=Greek}]$/u.test(item.str.replace(/\s/gu, '')) ||
          !base ||
          base.length !== 6 ||
          !base.every(Number.isFinite) ||
          base[0] <= 0 ||
          base[0] !== base[3] ||
          base[1] !== 0 ||
          base[2] !== 0 ||
          Math.abs(base[0] - matrix[0]) > 0.0001 ||
          !Number.isFinite(item.width) ||
          item.width! <= 0 ||
          center < base[4] ||
          center > base[4] + item.width! ||
          matrix[5] - base[5] < base[0] * 0.1 ||
          matrix[5] - base[5] > base[0] * 0.5
        )
          return []
        return [itemIndex]
      })
      if (owners.length !== 1 || owners[0] !== next) continue
    }
    parts[next] = parts[next][0] + mark + parts[next].slice(1)
    parts[index] = ''
  }
  return normalizedText(parts.join(''))
}

export async function verifyPdfUnits(
  document: PDFDocumentProxy,
  entries: readonly {
    source?: string
    sourceIndex: number
    translation: string
    fragments: PdfTranslationPdfRequest['units'][number]['fragments']
  }[],
  failures: readonly { unitIndex: number }[],
  original?: PDFDocumentProxy
): Promise<
  Array<{
    sourceIndex: number
    pageNumbers: number[]
    retained: boolean
    translationFound: boolean
  }>
> {
  const contents = new Map<number, Awaited<ReturnType<PDFDocumentProxy['getPage']>>>()
  const text = new Map<
    number,
    Awaited<ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['getTextContent']>>
  >()
  const originalBoxes = new Map<
    number,
    Array<{ x: number; y: number; width: number; height: number }>
  >()
  const radicalInk = new Map<
    number,
    Array<{ text: string; bounds: number[]; transform: number[] }>
  >()
  const fractionRules = new Map<number, number[][]>()
  for (const pageNumber of new Set(
    entries.flatMap(({ fragments }) => fragments.map((f) => f.pageNumber))
  )) {
    const page = await document.getPage(pageNumber)
    contents.set(pageNumber, page)
    text.set(pageNumber, await page.getTextContent())
    if (original) {
      const sourcePage = await original.getPage(pageNumber),
        viewport = sourcePage.getViewport({ scale: 1 }),
        content = await sourcePage.getTextContent()
      const boxes = content.items.flatMap((item) => {
        if (!('str' in item) || !item.str.trim()) return []
        const length = Math.hypot(item.transform[0], item.transform[1])
        if (!length) return []
        const dx = item.transform[0] / length,
          dy = item.transform[1] / length
        const points = [
          [0, 0],
          [item.width, 0],
          [0, item.height],
          [item.width, item.height]
        ].map(([a, b]) => ({
          x: (item.transform[4] + dx * a - dy * b) / viewport.width,
          y: 1 - (item.transform[5] + dy * a + dx * b) / viewport.height
        }))
        const x = Math.min(...points.map((point) => point.x)),
          y = Math.min(...points.map((point) => point.y))
        return [
          {
            x,
            y,
            width: Math.max(...points.map((point) => point.x)) - x,
            height: Math.max(...points.map((point) => point.y)) - y
          }
        ]
      })
      for (const annotation of await sourcePage.getAnnotations()) {
        const [left, bottom, right, top] = annotation.rect
        boxes.push({
          x: left / viewport.width,
          y: 1 - top / viewport.height,
          width: (right - left) / viewport.width,
          height: (top - bottom) / viewport.height
        })
      }
      originalBoxes.set(pageNumber, boxes)
    }
  }
  // Some native radical fonts put the ink below their text origin. PDF.js's
  // em-box center then lies outside a correctly owned region. Verify actual
  // output ink, without expanding the region or supplying a missing symbol.
  const radicalPages = [...text].filter(
    ([pageNumber, content]) =>
      contents.get(pageNumber)!.rotate % 360 === 0 &&
      content.items.some((item) => 'str' in item && item.str === '√')
  )
  const fractionPages = [...text].filter(([pageNumber]) =>
    entries.some(
      (entry) =>
        /\d{1,3}\/\d{1,3}/u.test(entry.source ?? '') &&
        entry.fragments.some((fragment) => fragment.pageNumber === pageNumber)
    )
  )
  if (radicalPages.length || fractionPages.length) {
    const { engine } = await import(
      pathToFileURL(resolve('resources/pdf-translation/pdfium.mjs')).href
    )
    const native = await engine(),
      input = native.open(await document.getData()),
      at = native.alloc(28)
    try {
      for (const pageNumber of new Set(
        [...radicalPages, ...fractionPages].map(([number]) => number)
      )) {
        const page = native.p.FPDF_LoadPage(input.doc, pageNumber - 1)
        if (!page) throw new Error('Could not verify native radical ink')
        try {
          const candidates = []
          const objects = native.objects(page)
          fractionRules.set(
            pageNumber,
            objects
              .filter((object: { obj: number; type: number; bounds: number[] }) => {
                if (
                  object.type !== 3 ||
                  object.bounds[2] - object.bounds[0] > 20 ||
                  object.bounds[3] - object.bounds[1] > 2
                )
                  return false
                const bitmap = native.p.FPDFImageObj_GetRenderedBitmap(input.doc, page, object.obj)
                if (!bitmap) return false
                try {
                  const width = native.p.FPDFBitmap_GetWidth(bitmap),
                    height = native.p.FPDFBitmap_GetHeight(bitmap),
                    stride = native.p.FPDFBitmap_GetStride(bitmap),
                    pointer = native.p.FPDFBitmap_GetBuffer(bitmap)
                  if (
                    native.p.FPDFBitmap_GetFormat(bitmap) !== 4 ||
                    width < 2 ||
                    width > 32 ||
                    height !== 1
                  )
                    return false
                  const pixels = native.m.HEAPU8.slice(pointer, pointer + stride)
                  return Array.from({ length: width }, (_, x) =>
                    pixels.slice(x * 4, x * 4 + 4)
                  ).every(
                    (pixel: Uint8Array) =>
                      pixel[0] === 0 && pixel[1] === 0 && pixel[2] === 0 && pixel[3] === 255
                  )
                } finally {
                  native.p.FPDFBitmap_Destroy(bitmap)
                }
              })
              .map((object: { bounds: number[] }) => object.bounds)
          )
          for (const object of objects) {
            // Native extraction may suppress a coincident text object's label.
            // Include it in the uniqueness proof rather than borrowing its twin.
            if (object.type !== 1) continue
            if (
              !native.p.FPDFPageObj_GetMatrix(object.obj, at) ||
              !native.p.FPDFTextObj_GetFontSize(object.obj, at + 24)
            )
              throw new Error('Could not verify native radical transform')
            const size = native.m.HEAPF32[(at + 24) / 4]
            candidates.push({
              text: object.text?.trim() ?? '',
              bounds: object.bounds,
              transform: Array.from(native.m.HEAPF32.slice(at / 4, at / 4 + 6), (value, index) =>
                index < 4 ? Number(value) * size : Number(value)
              )
            })
          }
          radicalInk.set(pageNumber, candidates)
        } finally {
          native.p.FPDF_ClosePage(page)
        }
      }
    } finally {
      native.free(at)
      input.close()
    }
  }
  return entries.map((entry, unitIndex) => {
    const pageNumbers = [...new Set(entry.fragments.map((f) => f.pageNumber))]
    const actual = pageNumbers
      .map((pageNumber) => {
        const viewport = contents.get(pageNumber)!.getViewport({ scale: 1 })
        // The writer may join a proven, same-column short tail into the preceding
        // row rectangle. Verify the derived paragraph region as well as source ink.
        const regions = entry.fragments
          .filter((f) => f.pageNumber === pageNumber)
          .map((f) => ({ ...f.rect }))
        for (let index = 1; index < regions.length; index++) {
          const previous = regions[index - 1],
            current = regions[index]
          const merged = {
            x: Math.min(previous.x, current.x),
            y: previous.y,
            width:
              Math.max(previous.x + previous.width, current.x + current.width) -
              Math.min(previous.x, current.x),
            height: current.y + current.height - previous.y
          }
          const overlaps = (a: typeof merged, b: typeof merged): boolean =>
            a.x < b.x + b.width &&
            a.x + a.width > b.x &&
            a.y < b.y + b.height &&
            a.y + a.height > b.y
          // Native planning can join aligned publisher rows through an empty
          // interline gap. Verify that same footprint against the original text
          // and annotations, rather than treating a font's em-box center in that
          // gap as missing text. Graphics still require native preflight/render QA.
          const gapClear =
            !originalBoxes.has(pageNumber) ||
            !originalBoxes
              .get(pageNumber)!
              .some(
                (box) =>
                  overlaps(box, merged) && !overlaps(box, previous) && !overlaps(box, current)
              )
          const bodyRows =
            originalBoxes.has(pageNumber) &&
            Math.abs(previous.x - current.x) * viewport.width <= 0.5 &&
            (Math.abs(previous.x + previous.width - current.x - current.width) * viewport.width <=
              0.5 ||
              (index === regions.length - 1 &&
                pageNumber === entry.fragments.at(-1)?.pageNumber &&
                current.width < previous.width &&
                (entry.source?.match(/[A-Za-z]{2,}/gu)?.length ?? 0) >= 8)) &&
            current.y - previous.y - previous.height >= -0.05 / viewport.height &&
            current.y - previous.y - previous.height <=
              Math.min(previous.height, current.height) * 0.5 &&
            gapClear
          if (bodyRows) {
            regions[index - 1] = merged
            regions.splice(index--, 1)
          } else if (
            gapClear &&
            Math.abs(previous.x - current.x) < 0.0001 &&
            current.y >= previous.y &&
            current.y <= previous.y + previous.height + 0.0001 &&
            current.width <= previous.width + 0.0001
          ) {
            previous.height = Math.max(previous.height, current.y + current.height - previous.y)
            regions.splice(index--, 1)
          }
        }
        const items = text
          .get(pageNumber)!
          .items.filter((item) => 'str' in item)
          .filter((item) => {
            const length = Math.hypot(item.transform[0], item.transform[1])
            if (!length) return false
            const dx = item.transform[0] / length,
              dy = item.transform[1] / length
            const x =
              (item.transform[4] + (dx * item.width) / 2 - (dy * item.height) / 2) / viewport.width
            const y =
              1 -
              (item.transform[5] + (dy * item.width) / 2 + (dx * item.height) / 2) / viewport.height
            if (
              regions.some(
                (rect) =>
                  x >= rect.x &&
                  x <= rect.x + rect.width &&
                  y >= rect.y &&
                  y <= rect.y + rect.height
              )
            )
              return true
            if (item.str !== '√') return false
            const matches = (radicalInk.get(pageNumber) ?? []).filter((candidate) =>
              candidate.transform.every(
                (value, index) => Math.abs(value - item.transform[index]) < 0.0001
              )
            )
            if (matches.length !== 1 || matches[0].text !== '√') return false
            const [left, bottom, right, top] = matches[0].bounds
            return regions.some(
              (rect) =>
                left >= rect.x * viewport.width - 0.0001 &&
                right <= (rect.x + rect.width) * viewport.width + 0.0001 &&
                top <= (1 - rect.y) * viewport.height + 0.0001 &&
                bottom >= (1 - rect.y - rect.height) * viewport.height - 0.0001
            )
          })
        return normalizedNativeText(
          verifiedNumericFractionItems(
            items,
            radicalInk.get(pageNumber) ?? [],
            fractionRules.get(pageNumber) ?? [],
            entry.source ?? '',
            entry.translation
          )
        )
      })
      .join('')
    return {
      sourceIndex: entry.sourceIndex,
      pageNumbers,
      retained: failures.some((failure) => failure.unitIndex === unitIndex),
      translationFound:
        normalizedText(entry.translation).length > 0 &&
        actual.includes(normalizedText(entry.translation))
    }
  })
}
