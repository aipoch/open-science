/* eslint-disable @typescript-eslint/explicit-function-return-type -- Unbundled Node worker. */
import { PDFArray, PDFDict, PDFName, PDFString } from 'pdf-lib'
import { translatedPdfLinkLabel, translatedPdfLinkFragment } from './link-labels.mjs'

const compact = (text) => text.replace(/\s/gu, '')
const contains = (a, b) =>
  a.x >= b.x - 0.002 &&
  a.y >= b.y - 0.002 &&
  a.x + a.width <= b.x + b.width + 0.002 &&
  a.y + a.height <= b.y + b.height + 0.002

// Match only a unique, exact visible spelling. Keep UTF-16 offsets for the
// existing semantic label mapper and the font's per-line placement records.
function span(text, label) {
  const offsets = [],
    chars = []
  for (let i = 0; i < text.length; i++)
    if (!/\s/u.test(text[i])) {
      offsets.push(i)
      chars.push(text[i])
    }
  const haystack = chars.join(''),
    needle = compact(label),
    start = haystack.indexOf(needle)
  if (!needle || start < 0 || haystack.indexOf(needle, start + 1) >= 0) return undefined
  const from = offsets[start],
    end = offsets[start + needle.length - 1] + 1
  return { start: from, text: text.slice(from, end) }
}

export function readReflowLinks(native, source, input, originalDocument) {
  const pageCount = input.pages.length,
    unsafePages = new Set()
  const { p, m } = native,
    result = [],
    geometry = []
  const at = native.alloc(32)
  try {
    for (let number = 1; number <= pageCount; number++) {
      const page = p.FPDF_LoadPage(source.doc, number - 1)
      try {
        if (!p.FPDF_GetPageBoundingBox(page, at)) throw Error('Link page bounds')
        const [left, top, right, bottom] = m.HEAPF32.slice(at / 4, at / 4 + 4)
        geometry.push({ left, top, width: right - left, height: top - bottom })
        let text
        try {
          if (p.FPDFPage_GetRotation(page)) unsafePages.add(number)
          text = p.FPDFText_LoadPage(page)
          const characters = p.FPDFText_CountChars(text)
          if (characters < 0 || characters > 250000) unsafePages.add(number)
          else
            for (let index = 0; index < characters; index++) {
              const angle = p.FPDFText_GetCharAngle(text, index)
              if (
                Number.isFinite(angle) &&
                Math.abs(Math.sin(angle)) <= 0.0001 &&
                Math.cos(angle) >= 0.9999
              )
                continue
              if (p.FPDFText_GetCharBox(text, index, at, at + 8, at + 16, at + 24)) {
                const [x1, x2, y1, y2] = m.HEAPF64.slice(at / 8, at / 8 + 4)
                const rect = {
                  x: (x1 - left) / (right - left),
                  y: (top - y2) / (top - bottom),
                  width: (x2 - x1) / (right - left),
                  height: (y2 - y1) / (top - bottom)
                }
                if (
                  [x1, x2, y1, y2].every(Number.isFinite) &&
                  input.originalRegions?.some(
                    (region) => region.pageNumber === number && contains(rect, region.rect)
                  )
                )
                  continue
              }
              unsafePages.add(number)
              break
            }
          for (let index = 0; index < p.FPDFPage_GetAnnotCount(page); index++) {
            const annotation = p.FPDFPage_GetAnnot(page, index)
            try {
              if (p.FPDFAnnot_GetSubtype(annotation) !== 2) continue
              if (result.length >= 10000) throw Error('Reflow link limit')
              const link = p.FPDFAnnot_GetLink(annotation),
                action = p.FPDFLink_GetAction(link)
              const kind = action ? p.FPDFAction_GetType(action) : 0
              const dest =
                p.FPDFLink_GetDest(source.doc, link) ||
                (kind === 1 ? p.FPDFAction_GetDest(source.doc, action) : 0)
              const entry = { pageNumber: number, index, regions: [], labels: [] }
              result.push(entry)
              const raw = originalDocument
                .getPage(number - 1)
                .node.Annots()
                ?.lookup(index)
              const rawAction = raw instanceof PDFDict ? raw.lookup(PDFName.of('A')) : undefined
              if (
                p.FPDFAnnot_HasKey(annotation, 'AA') ||
                ![0, 1, 3].includes(kind) ||
                (rawAction instanceof PDFDict && rawAction.has(PDFName.of('Next')))
              ) {
                entry.unsupported = true
              }
              if (dest) {
                const target = p.FPDFDest_GetDestPageIndex(source.doc, dest) + 1
                const mode = p.FPDFDest_GetView(dest, at, at + 4)
                const count = m.HEAPU32[at / 4]
                const params = [...m.HEAPF32.slice(at / 4 + 1, at / 4 + 1 + Math.min(count, 4))]
                if (
                  target < 1 ||
                  target > pageCount ||
                  mode < 1 ||
                  mode > 8 ||
                  count > 4 ||
                  !params.every(Number.isFinite) ||
                  // PDFium's view API collapses null FitH/FitV operands to zero.
                  // Do not replace "keep current position" with a guessed coordinate.
                  ([3, 4, 7, 8].includes(mode) && (count !== 1 || params[0] === 0))
                )
                  entry.unsupported = true
                else {
                  entry.destination = { pageNumber: target, mode, params }
                  if (mode === 1) {
                    if (
                      !p.FPDFDest_GetLocationInPage(
                        dest,
                        at,
                        at + 4,
                        at + 8,
                        at + 12,
                        at + 16,
                        at + 20
                      )
                    )
                      entry.unsupported = true
                    else
                      entry.destination.params = [
                        m.HEAP32[at / 4] ? m.HEAPF32[at / 4 + 3] : null,
                        m.HEAP32[at / 4 + 1] ? m.HEAPF32[at / 4 + 4] : null,
                        m.HEAP32[at / 4 + 2] ? m.HEAPF32[at / 4 + 5] : null
                      ]
                  }
                }
              } else if (kind === 3) {
                const length = p.FPDFAction_GetURIPath(source.doc, action, 0, 0)
                if (length < 1 || length > 65536) {
                  entry.unsupported = true
                  continue
                }
                const pointer = native.alloc(length)
                try {
                  p.FPDFAction_GetURIPath(source.doc, action, pointer, length)
                  entry.uri = new TextDecoder('utf-8', { fatal: true }).decode(
                    m.HEAPU8.slice(pointer, pointer + length - 1)
                  )
                  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(entry.uri)) {
                    const base = originalDocument.catalog.lookup(PDFName.of('URI'))
                    const value =
                      base instanceof PDFDict ? base.lookup(PDFName.of('Base')) : undefined
                    try {
                      entry.uri = new URL(entry.uri, value?.decodeText()).href
                    } catch {
                      entry.unsupported = true
                    }
                  }
                } finally {
                  native.free(pointer)
                }
              } else {
                entry.unsupported = true
                continue
              }
              if (!p.FPDFAnnot_GetRect(annotation, at)) throw Error('Link rectangle')
              const coordinates = [...m.HEAPF32.slice(at / 4, at / 4 + 4)]
              entry.rawRect = [
                Math.min(coordinates[0], coordinates[2]),
                Math.min(coordinates[1], coordinates[3]),
                Math.max(coordinates[0], coordinates[2]),
                Math.max(coordinates[1], coordinates[3])
              ]
              const quads = p.FPDFAnnot_CountAttachmentPoints(annotation)
              if (quads > 10000) throw Error('Reflow link quad limit')
              const boxes = []
              for (let q = 0; q < quads; q++) {
                if (!p.FPDFAnnot_GetAttachmentPoints(annotation, q, at)) throw Error('Link quad')
                const points = [...m.HEAPF32.slice(at / 4, at / 4 + 8)]
                const xs = points.filter((_, i) => i % 2 === 0),
                  ys = points.filter((_, i) => i % 2 === 1)
                boxes.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)])
              }
              if (!boxes.length) boxes.push(entry.rawRect)
              for (const [x1, y1, x2, y2] of boxes) {
                if (![x1, y1, x2, y2].every(Number.isFinite)) throw Error('Link rectangle')
                entry.regions.push({
                  x: (x1 - left) / (right - left),
                  y: (top - y2) / (top - bottom),
                  width: (x2 - x1) / (right - left),
                  height: (y2 - y1) / (top - bottom)
                })
                text ??= p.FPDFText_LoadPage(page)
                const length = p.FPDFText_GetBoundedText(text, x1, y2, x2, y1, 0, 0)
                if (length < 0 || length > 100000) throw Error('Link label length')
                const pointer = native.alloc((length + 1) * 2)
                try {
                  const written = p.FPDFText_GetBoundedText(
                    text,
                    x1,
                    y2,
                    x2,
                    y1,
                    pointer,
                    length + 1
                  )
                  entry.labels.push(
                    Buffer.from(m.HEAPU8.slice(pointer, pointer + written * 2))
                      .toString('utf16le')
                      .replace(/\0+$/u, '')
                  )
                } finally {
                  native.free(pointer)
                }
              }
            } finally {
              p.FPDFPage_CloseAnnot(annotation)
            }
          }
        } finally {
          if (text) p.FPDFText_ClosePage(text)
        }
      } finally {
        p.FPDF_ClosePage(page)
      }
    }
    return {
      links: result,
      geometry,
      unsafePages,
      wholeDocument: result.some((link) => link.unsupported)
    }
  } finally {
    native.free(at)
  }
}

// Retaining the whole connected component guarantees that a single retry can
// restore both endpoints, including reverse links and cross-page paragraphs.
export function retainLinkedPages(retained, links, units) {
  let previous
  do {
    previous = retained.size
    for (const link of links) {
      const target = link.destination?.pageNumber
      if (retained.has(link.pageNumber) || retained.has(target)) {
        retained.add(link.pageNumber)
        if (target) retained.add(target)
      }
    }
    for (const unit of units)
      if (unit.fragments.some((f) => retained.has(f.pageNumber)))
        for (const f of unit.fragments) retained.add(f.pageNumber)
  } while (previous !== retained.size)
}

export function mapReflowLinks(
  { links, geometry },
  input,
  { originals, lines, crops, placements, sourcePages },
  measure
) {
  const failed = new Set(),
    mapped = []
  const affine = (rect, crop) => ({
    pageNumber: crop.pageNumber,
    rect: {
      x: crop.target.x + ((rect.x - crop.source.x) / crop.source.width) * crop.target.width,
      y: crop.target.y + ((rect.y - crop.source.y) / crop.source.height) * crop.target.height,
      width: (rect.width / crop.source.width) * crop.target.width,
      height: (rect.height / crop.source.height) * crop.target.height
    }
  })
  const cropFor = (number, rect) =>
    crops.filter((c) => c.sourcePage === number && contains(rect, c.source))
  const origin = (link) => {
    if (originals.has(link.pageNumber))
      return [{ pageNumber: originals.get(link.pageNumber), rawRect: link.rawRect }]
    if (link.unsupported) return undefined
    const result = []
    for (const [i, rect] of link.regions.entries()) {
      const images = cropFor(link.pageNumber, rect)
      if (images.length === 1) {
        result.push(affine(rect, images[0]))
        continue
      }
      const owners = input.units.flatMap((unit, unitIndex) =>
        unit.fragments.some((f) => f.pageNumber === link.pageNumber && contains(rect, f.rect))
          ? [{ unit, unitIndex }]
          : []
      )
      if (owners.length !== 1) return undefined
      const { unit, unitIndex } = owners[0],
        source = span(unit.source, link.labels[i])
      if (!source) return undefined
      const target =
        compact(source.text) === compact(unit.source)
          ? { start: 0, text: unit.translation }
          : (translatedPdfLinkLabel(unit.source, unit.translation, source.text, source.start) ??
            translatedPdfLinkFragment(unit.source, unit.translation, source.text, source.start) ??
            (/^(?:https?:\/\/|mailto:|[^\s@]+@)/u.test(source.text) ||
            /^\[\d+(?:\s*[,–-]\s*\d+)*\]$/u.test(source.text) ||
            unit.source === unit.translation
              ? span(unit.translation, source.text)
              : undefined))
      if (!target) return undefined
      let covered = ''
      for (const line of lines.get(unitIndex) ?? []) {
        const start = Math.max(target.start, line.start),
          end = Math.min(target.start + target.text.length, line.start + line.text.length)
        if (start >= end) continue
        const text = line.text.slice(start - line.start, end - line.start)
        covered += text
        result.push({
          pageNumber: line.pageNumber,
          rect: {
            x: line.rect.x + measure(line.text.slice(0, start - line.start)) / 595.28,
            y: line.rect.y,
            width: measure(text) / 595.28,
            height: line.rect.height
          }
        })
      }
      if (compact(covered) !== compact(target.text)) return undefined
    }
    return result.length ? result : undefined
  }
  const destination = (dest) => {
    const original = originals.get(dest.pageNumber)
    if (original) return { pageNumber: original, mode: dest.mode, params: dest.params }
    const { left, top, width, height } = geometry[dest.pageNumber - 1]
    const [a, b, , d] = dest.params
    if ([2, 6].includes(dest.mode) || (dest.mode === 1 && a == null && b == null)) {
      const locations = crops
        .filter((c) => c.sourcePage === dest.pageNumber)
        .map((c) => ({ pageNumber: c.pageNumber, rect: c.target }))
      for (const [index, unit] of input.units.entries())
        if (unit.fragments.some((f) => f.pageNumber === dest.pageNumber))
          locations.push(...(placements.get(index) ?? []))
      locations.sort((a, b) => a.pageNumber - b.pageNumber || a.rect.y - b.rect.y)
      const first = locations[0]
      if (first)
        return {
          pageNumber: first.pageNumber,
          mode: 1,
          params: [first.rect.x * 595.28, (1 - first.rect.y) * 841.89, null]
        }
      const number = sourcePages.findIndex((pages) => pages.includes(dest.pageNumber)) + 1
      return number ? { pageNumber: number, mode: 2, params: [] } : undefined
    }
    const x = dest.mode === 1 || dest.mode === 5 ? a : [4, 8].includes(dest.mode) ? a : null
    const y = dest.mode === 1 ? b : dest.mode === 5 ? d : [3, 7].includes(dest.mode) ? a : null
    const point = {
      x: x == null ? null : (x - left) / width,
      y: y == null ? null : (top - y) / height
    }
    const owns = (r) =>
      (point.x == null || (point.x >= r.x - 0.002 && point.x <= r.x + r.width + 0.002)) &&
      (point.y == null || (point.y >= r.y - 0.002 && point.y <= r.y + r.height + 0.002))
    const images = crops.filter((c) => c.sourcePage === dest.pageNumber && owns(c.source))
    const owners = input.units.flatMap((unit, index) =>
      unit.fragments.some((f) => f.pageNumber === dest.pageNumber && owns(f.rect)) ? [index] : []
    )
    let target
    if (images.length === 1)
      target = affine(
        { x: point.x ?? images[0].source.x, y: point.y ?? images[0].source.y, width: 0, height: 0 },
        images[0]
      )
    else if (owners.length === 1) target = placements.get(owners[0])?.[0]
    if (!target) return undefined
    return {
      pageNumber: target.pageNumber,
      mode: 1,
      params: [target.rect.x * 595.28, (1 - target.rect.y) * 841.89, null]
    }
  }
  for (const link of links) {
    if (link.unsupported && originals.has(link.pageNumber) && !link.destination) continue
    const regions = origin(link),
      target = link.destination ? destination(link.destination) : undefined
    if (!regions || (link.destination && !target)) {
      failed.add(link.pageNumber)
      if (link.destination) failed.add(link.destination.pageNumber)
    } else mapped.push({ link, regions, target })
  }
  return { failed, mapped }
}

export function writeReflowLinks(document, mapped, originals) {
  const modes = ['', 'XYZ', 'Fit', 'FitH', 'FitV', 'FitR', 'FitB', 'FitBH', 'FitBV']
  for (const { link, regions, target } of mapped) {
    const dest =
      target &&
      document.context.obj([
        document.getPage(target.pageNumber - 1).ref,
        PDFName.of(modes[target.mode]),
        ...target.params
      ])
    if (originals.has(link.pageNumber)) {
      // Rewrite the existing dictionary, preserving appearance and quad geometry.
      const page = document.getPage(originals.get(link.pageNumber) - 1)
      const annotation = page.node.Annots().lookup(link.index)
      if (dest) {
        const action = annotation.lookup(PDFName.of('A'))
        const owner =
          annotation.has(PDFName.of('Dest')) || !(action instanceof PDFDict) ? annotation : action
        const key = PDFName.of(owner === annotation ? 'Dest' : 'D')
        const previous = owner.lookup(key)
        if (originals.has(link.destination.pageNumber) && previous instanceof PDFArray) {
          // Preserve null FitH/FitV operands and all original view parameters.
          previous.set(0, document.getPage(target.pageNumber - 1).ref)
        } else owner.set(key, dest)
      }
      continue
    }
    for (const { pageNumber, rect } of regions) {
      const page = document.getPage(pageNumber - 1),
        w = page.getWidth(),
        h = page.getHeight()
      const annotation = document.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Border: [0, 0, 0],
        Rect: [
          rect.x * w,
          (1 - rect.y - rect.height) * h,
          (rect.x + rect.width) * w,
          (1 - rect.y) * h
        ],
        ...(dest
          ? { Dest: dest }
          : {
              A: { S: 'URI', URI: PDFString.of(Buffer.from(link.uri, 'utf8').toString('latin1')) }
            })
      })
      page.node.addAnnot(document.context.register(annotation))
    }
  }
}
