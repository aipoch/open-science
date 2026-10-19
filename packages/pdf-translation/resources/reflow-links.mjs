/* eslint-disable @typescript-eslint/explicit-function-return-type -- Unbundled Node worker. */
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFString, PDFHexString } from 'pdf-lib'
import { translatedPdfLinkLabel, translatedPdfLinkFragment } from './link-labels.mjs'

const name = (value) => PDFName.of(value)
const string = (value) =>
  value instanceof PDFString || value instanceof PDFHexString
    ? value.decodeText()
    : value instanceof PDFName
      ? value.decodeText()
      : undefined
const contains = (inner, outer) =>
  inner.x >= outer.x - 0.003 &&
  inner.y >= outer.y - 0.003 &&
  inner.x + inner.width <= outer.x + outer.width + 0.003 &&
  inner.y + inner.height <= outer.y + outer.height + 0.003
const compact = (text) => {
  let value = ''
  const offsets = []
  for (let index = 0; index < text.length; index++)
    if (!/\s/u.test(text[index])) {
      value += text[index]
      offsets.push(index)
    }
  return { value, offsets }
}
const uniqueSpan = (text, label) => {
  const target = compact(text),
    needle = compact(label).value
  if (!needle) return
  const index = target.value.indexOf(needle)
  if (index < 0 || target.value.indexOf(needle, index + 1) >= 0) return
  const start = target.offsets[index],
    end = target.offsets[index + needle.length - 1] + 1
  return { start, text: text.slice(start, end) }
}

/** Native link identities are read once, then explicitly rebuilt in the output document. */
export function createReflowLinks(original, input, native) {
  const links = [],
    retained = new Map(),
    textLinks = new Map(),
    crops = [],
    textRows = []
  const pages = original.getPages(),
    context = original.context
  const pageNumbers = new Map(pages.map((page, index) => [page.ref.toString(), index + 1]))
  const lookup = (dict, key) =>
    dict instanceof PDFDict ? context.lookup(dict.get(name(key))) : undefined
  const numbers = (array) =>
    array instanceof PDFArray
      ? array
          .asArray()
          .map((entry) => context.lookup(entry))
          .map((entry) => (entry instanceof PDFNumber ? entry.asNumber() : NaN))
      : []
  let wholeDocument = false,
    visitedNames = 0
  const namedDestinations = new Map()
  const readNames = (node, depth = 0) => {
    if (!(node instanceof PDFDict) || depth > 32 || ++visitedNames > 10000)
      throw Error('Destination tree limit')
    const entries = lookup(node, 'Names')
    if (entries instanceof PDFArray)
      for (let index = 0; index + 1 < entries.size(); index += 2) {
        if (++visitedNames > 10000) throw Error('Destination tree limit')
        const key = string(context.lookup(entries.get(index)))
        if (key !== undefined) namedDestinations.set(key, context.lookup(entries.get(index + 1)))
      }
    const children = lookup(node, 'Kids')
    if (children instanceof PDFArray)
      for (const child of children.asArray()) readNames(context.lookup(child), depth + 1)
  }
  try {
    const legacy = lookup(original.catalog, 'Dests')
    if (legacy instanceof PDFDict)
      for (const [key, value] of legacy.entries())
        namedDestinations.set(key.decodeText(), context.lookup(value))
    const names = lookup(original.catalog, 'Names'),
      destinations = lookup(names, 'Dests')
    if (destinations) readNames(destinations)
  } catch {
    wholeDocument = true
  }
  const destination = (value) => {
    value = context.lookup(value)
    if (string(value) !== undefined) value = namedDestinations.get(string(value))
    if (value instanceof PDFDict) value = lookup(value, 'D')
    if (!(value instanceof PDFArray) || value.size() < 2) return
    const first = value.get(0)
    const number =
      first instanceof PDFNumber ? first.asNumber() + 1 : pageNumbers.get(first?.toString())
    if (!Number.isInteger(number) || number < 1 || number > pages.length) return
    const kind = string(context.lookup(value.get(1))),
      box = pages[number - 1].getCropBox()
    if (!['XYZ', 'Fit', 'FitH', 'FitV', 'FitR', 'FitB', 'FitBH', 'FitBV'].includes(kind)) return
    const coordinate = (index) => {
      const item = index < value.size() ? context.lookup(value.get(index)) : undefined
      return item instanceof PDFNumber && Number.isFinite(item.asNumber())
        ? item.asNumber()
        : undefined
    }
    const x = ['XYZ', 'FitR', 'FitV', 'FitBV'].includes(kind) ? coordinate(2) : undefined,
      y = coordinate(kind === 'XYZ' ? 3 : kind === 'FitH' || kind === 'FitBH' ? 2 : 5)
    return {
      number,
      x: Math.max(0, Math.min(1, ((x ?? box.x) - box.x) / box.width)),
      y: Math.max(0, Math.min(1, 1 - ((y ?? box.y + box.height) - box.y) / box.height))
    }
  }
  const readLabel = (nativePage, rect, box) => {
    const text = native.p.FPDFText_LoadPage(nativePage)
    try {
      const args = [
        text,
        box.x + rect.x * box.width,
        box.y + (1 - rect.y) * box.height,
        box.x + (rect.x + rect.width) * box.width,
        box.y + (1 - rect.y - rect.height) * box.height
      ]
      const length = native.p.FPDFText_GetBoundedText(...args, 0, 0)
      if (length <= 0 || length > 2048) return ''
      const at = native.alloc((length + 1) * 2)
      try {
        const read = native.p.FPDFText_GetBoundedText(...args, at, length + 1)
        return Buffer.from(
          native.m.HEAPU8.slice(at, at + Math.max(0, Math.min(read, length + 1)) * 2)
        )
          .toString('utf16le')
          .replace(/\0+$/u, '')
          .trim()
      } finally {
        native.free(at)
      }
    } finally {
      native.p.FPDFText_ClosePage(text)
    }
  }
  let characterCount = 0
  for (const [index, page] of pages.entries()) {
    const number = index + 1,
      nativePage = native.p.FPDF_LoadPage(native.doc, index)
    if (!nativePage) throw Error('Could not inspect source page')
    try {
      if (native.p.FPDFPage_GetRotation(nativePage)) retained.set(number, 'unsupported-layout')
      const text = native.p.FPDFText_LoadPage(nativePage),
        boxBuffer = native.alloc(32)
      try {
        const count = native.p.FPDFText_CountChars(text)
        characterCount += Math.max(0, count)
        if (count < 0 || count > 250000 || characterCount > 2000000)
          retained.set(number, 'unsupported-layout')
        else
          for (let at = 0; at < count; at++) {
            const angle = native.p.FPDFText_GetCharAngle(text, at)
            if (
              !Number.isFinite(angle) ||
              Math.abs(Math.sin(angle)) > 0.0001 ||
              Math.cos(angle) < 0.9999
            ) {
              // Rotated labels already owned by a retained graphic remain visible
              // in that crop; they do not make ordinary body text unsafe to reflow.
              const box = page.getCropBox()
              if (
                native.p.FPDFText_GetCharBox(
                  text,
                  at,
                  boxBuffer,
                  boxBuffer + 8,
                  boxBuffer + 16,
                  boxBuffer + 24
                )
              ) {
                const [left, right, bottom, top] = native.m.HEAPF64.slice(
                  boxBuffer / 8,
                  boxBuffer / 8 + 4
                )
                const rect = {
                  x: (left - box.x) / box.width,
                  y: 1 - (top - box.y) / box.height,
                  width: (right - left) / box.width,
                  height: (top - bottom) / box.height
                }
                if (
                  [left, right, bottom, top].every(Number.isFinite) &&
                  input.originalRegions?.some(
                    (region) => region.pageNumber === number && contains(rect, region.rect)
                  )
                )
                  continue
              }
              retained.set(number, 'unsupported-layout')
              break
            }
          }
      } finally {
        native.free(boxBuffer)
        native.p.FPDFText_ClosePage(text)
      }
      const annotations = page.node.Annots()
      if (!annotations) continue
      if (annotations.size() > 10000 || links.length + annotations.size() > 20000) {
        wholeDocument = true
        continue
      }
      for (const ref of annotations.asArray()) {
        const annotation = context.lookup(ref)
        if (!(annotation instanceof PDFDict) || string(lookup(annotation, 'Subtype')) !== 'Link')
          continue
        const rawRect = numbers(lookup(annotation, 'Rect')),
          box = page.getCropBox()
        const [left, bottom, right, top] = rawRect
        if (
          rawRect.length !== 4 ||
          !rawRect.every(Number.isFinite) ||
          right <= left ||
          top <= bottom
        ) {
          wholeDocument = true
          continue
        }
        const rect = {
          x: (left - box.x) / box.width,
          y: 1 - (top - box.y) / box.height,
          width: (right - left) / box.width,
          height: (top - bottom) / box.height
        }
        const action = lookup(annotation, 'A'),
          kind = string(lookup(action, 'S'))
        let target
        if (kind === 'URI') {
          const uri = string(lookup(action, 'URI')),
            base = string(lookup(lookup(original.catalog, 'URI'), 'Base'))
          if (uri) {
            try {
              const absolute = new URL(uri, base)
              target = { uri: /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(uri) ? uri : absolute.href }
            } catch {
              /* Preserve the original document if its URI base cannot be transferred. */
            }
          }
        } else if (kind === 'Named') {
          const named = string(lookup(action, 'N'))
          const to = {
            FirstPage: 1,
            LastPage: pages.length,
            NextPage: Math.min(pages.length, number + 1),
            PrevPage: Math.max(1, number - 1)
          }[named]
          if (to) target = { destination: { number: to, x: 0, y: 0 } }
        } else if (kind === 'GoTo' || !action) {
          const to = destination(
            kind === 'GoTo' ? action.get(name('D')) : annotation.get(name('Dest'))
          )
          if (to) target = { destination: to }
        }
        // An unknown action or unresolved destination is never silently removed.
        // Keeping the complete original document also keeps its destination graph intact.
        if (!target || lookup(annotation, 'AA') || lookup(action, 'Next')) {
          wholeDocument = true
          continue
        }
        const link = { number, rect, rawRect, ...target, output: [] }
        links.push(link)
        if (retained.has(number)) continue
        const visual = input.originalRegions?.some(
          (region) => region.pageNumber === number && contains(rect, region.rect)
        )
        if (visual) continue
        const owners = input.units.flatMap((unit, unitIndex) =>
          unit.fragments.some(
            (fragment) => fragment.pageNumber === number && contains(rect, fragment.rect)
          )
            ? [{ unit, unitIndex }]
            : []
        )
        if (owners.length !== 1) {
          link.reference = true
          continue
        }
        const { unit, unitIndex } = owners[0],
          from = unit.source.replace(/\r\n?/gu, '\n'),
          to = unit.translation.replace(/\r\n?/gu, '\n')
        const label = readLabel(nativePage, rect, box),
          sourceSpan = uniqueSpan(from, label)
        const span =
          sourceSpan &&
          (translatedPdfLinkLabel(from, to, sourceSpan.text, sourceSpan.start) ||
            translatedPdfLinkFragment(from, to, sourceSpan.text, sourceSpan.start) ||
            uniqueSpan(to, sourceSpan.text))
        if (!span) {
          link.reference = true
          link.unitIndex = unitIndex
          continue
        }
        const list = textLinks.get(unitIndex) ?? []
        list.push({ link, start: span.start, end: span.start + span.text.length })
        textLinks.set(unitIndex, list)
      }
    } finally {
      native.p.FPDF_ClosePage(nativePage)
    }
  }
  return {
    retained,
    wholeDocument,
    references(unitIndex, sourceNumber) {
      return links.filter(
        (link) =>
          link.reference &&
          !link.output.length &&
          link.number === sourceNumber &&
          (unitIndex === undefined || link.unitIndex === unitIndex)
      )
    },
    originalPage(output, sourceNumber, outputNumber) {
      for (const link of links.filter((entry) => entry.number === sourceNumber))
        link.output.push({ number: outputNumber, rawRect: link.rawRect })
    },
    crop(sourceNumber, rect, target, outputNumber) {
      crops.push({ sourceNumber, rect, target, outputNumber })
      for (const link of links.filter(
        (entry) => entry.number === sourceNumber && contains(entry.rect, rect)
      ))
        if (!link.output.length)
          link.output.push({
            number: outputNumber,
            rect: {
              x: target.x + ((link.rect.x - rect.x) / rect.width) * target.width,
              y: target.y + ((link.rect.y - rect.y) / rect.height) * target.height,
              width: (link.rect.width / rect.width) * target.width,
              height: (link.rect.height / rect.height) * target.height
            }
          })
    },
    text(unitIndex, line, start, rect, outputNumber, measure, pageWidth) {
      textRows.push({ unitIndex, rect, outputNumber })
      for (const entry of textLinks.get(unitIndex) ?? []) {
        const left = Math.max(entry.start, start),
          right = Math.min(entry.end, start + line.length)
        if (left >= right) continue
        entry.link.output.push({
          number: outputNumber,
          rect: {
            ...rect,
            x: rect.x + measure(line.slice(0, left - start)) / pageWidth,
            width: Math.max(1, measure(line.slice(left - start, right - start))) / pageWidth
          }
        })
      }
    },
    finish(output, originalPages) {
      const missing = new Set(
        links.filter((link) => !link.output.length).map((link) => link.number)
      )
      if (missing.size) return missing
      const target = (destination) => {
        const original = originalPages.get(destination.number)
        if (original) {
          const sourceBox = pages[destination.number - 1].getCropBox()
          return {
            number: original,
            x: sourceBox.x + destination.x * sourceBox.width,
            y: sourceBox.y + (1 - destination.y) * sourceBox.height
          }
        }
        const crop = crops.find(
          (crop) =>
            crop.sourceNumber === destination.number &&
            contains({ ...destination, width: 0, height: 0 }, crop.rect)
        )
        if (crop) {
          const page = output.getPage(crop.outputNumber - 1)
          return {
            number: crop.outputNumber,
            x:
              (crop.target.x +
                ((destination.x - crop.rect.x) / crop.rect.width) * crop.target.width) *
              page.getWidth(),
            y:
              (1 -
                crop.target.y -
                ((destination.y - crop.rect.y) / crop.rect.height) * crop.target.height) *
              page.getHeight()
          }
        }
        const candidates = textRows
          .flatMap((row) =>
            input.units[row.unitIndex].fragments
              .filter((fragment) => fragment.pageNumber === destination.number)
              .map((fragment) => ({
                ...row,
                distance:
                  Math.abs(fragment.rect.y - destination.y) +
                  Math.abs(fragment.rect.x - destination.x) * 0.2
              }))
          )
          .sort((a, b) => a.distance - b.distance || a.outputNumber - b.outputNumber)
        const row = candidates[0]
        if (!row) return
        const page = output.getPage(row.outputNumber - 1)
        return {
          number: row.outputNumber,
          x: row.rect.x * page.getWidth(),
          y: (1 - row.rect.y) * page.getHeight()
        }
      }
      for (const link of links) {
        const dest = link.destination && target(link.destination)
        if (link.destination && !dest) return new Set([link.destination.number])
        for (const placement of link.output) {
          const page = output.getPage(placement.number - 1),
            rect = placement.rect
          const annotation = output.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            P: page.ref,
            Rect: placement.rawRect ?? [
              rect.x * page.getWidth(),
              (1 - rect.y - rect.height) * page.getHeight(),
              (rect.x + rect.width) * page.getWidth(),
              (1 - rect.y) * page.getHeight()
            ],
            Border: [0, 0, 0],
            ...(link.uri
              ? {
                  A: {
                    S: 'URI',
                    URI: PDFString.of(Buffer.from(link.uri, 'utf8').toString('latin1'))
                  }
                }
              : { Dest: [output.getPage(dest.number - 1).ref, 'XYZ', dest.x, dest.y, null] })
          })
          page.node.addAnnot(output.context.register(annotation))
        }
      }
      return new Set()
    }
  }
}
