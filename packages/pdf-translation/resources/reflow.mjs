/* eslint-disable @typescript-eslint/explicit-function-return-type -- Unbundled Node worker. */
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { deflateSync } from 'node:zlib'
import * as fontkit from 'fontkit'
import { PDFDocument, rgb } from 'pdf-lib'
import { engine } from './pdfium.mjs'

const width = 595.28,
  height = 841.89,
  margin = 44,
  size = 11,
  leading = 18
const contentWidth = width - margin * 2,
  bottom = height - margin
const key = (text) => text.normalize('NFC').replace(/\s/gu, '')
const union = (a, b) => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x),
  height: Math.max(a.y + a.height, b.y + b.height) - Math.min(a.y, b.y)
})
const touches = (a, b, pad = 3) =>
  a.x <= b.x + b.width + pad &&
  a.x + a.width + pad >= b.x &&
  a.y <= b.y + b.height + pad &&
  a.y + a.height + pad >= b.y
const inside = (a, b) =>
  a.x + a.width / 2 >= b.x &&
  a.x + a.width / 2 <= b.x + b.width &&
  a.y + a.height / 2 >= b.y &&
  a.y + a.height / 2 <= b.y + b.height
const contains = (a, b) =>
  a.x >= b.x - 0.002 &&
  a.y >= b.y - 0.002 &&
  a.x + a.width <= b.x + b.width + 0.002 &&
  a.y + a.height <= b.y + b.height + 0.002

// Recursive whitespace cuts keep headings above columns and read the left
// column completely before a right-column References heading. Unit IDs/indices
// remain unchanged, so saved translations and diagnostics still bind exactly.
function readingOrder(entries, depth = 0) {
  if (entries.length < 2 || depth > 24) return entries
  const boxes = entries.map((entry) =>
    entry.fragments.map((fragment) => fragment.rect).reduce(union)
  )
  for (const [axis, extent, minimum] of [
    ['x', 'width', 0.012],
    ['y', 'height', 0.008]
  ]) {
    const intervals = boxes
      .map((rect) => [rect[axis], rect[axis] + rect[extent]])
      .sort((a, b) => a[0] - b[0])
    let end = intervals[0][1],
      best
    for (const [start, right] of intervals.slice(1)) {
      if (start - end >= minimum && (!best || start - end > best.gap))
        best = { at: (end + start) / 2, gap: start - end }
      end = Math.max(end, right)
    }
    if (!best) continue
    const before = [],
      after = []
    entries.forEach((entry, index) =>
      (boxes[index][axis] + boxes[index][extent] / 2 < best.at ? before : after).push(entry)
    )
    if (before.length && after.length)
      return [...readingOrder(before, depth + 1), ...readingOrder(after, depth + 1)]
  }
  return entries
}

// PNG encoding stays inside the bounded worker; no files, browser or external executable.
function png(pixels, stride, x, y, w, h) {
  const scan = Buffer.alloc((w * 3 + 1) * h)
  for (let row = 0; row < h; row++)
    for (let col = 0; col < w; col++) {
      const at = (y + row) * stride + (x + col) * 4,
        out = row * (w * 3 + 1) + 1 + col * 3
      scan[out] = pixels[at + 2]
      scan[out + 1] = pixels[at + 1]
      scan[out + 2] = pixels[at]
    }
  const chunk = (name, data) => {
    const type = Buffer.from(name),
      body = Buffer.concat([type, data])
    let crc = 0xffffffff
    for (const byte of body) {
      crc ^= byte
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    const result = Buffer.alloc(data.length + 12)
    result.writeUInt32BE(data.length)
    body.copy(result, 4)
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4)
    return result
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(w)
  header.writeUInt32BE(h, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(scan)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

export async function generateReflow(input) {
  const document = await PDFDocument.create(),
    bytes = await readFile(new URL('./NotoSansSC-Regular.otf', import.meta.url)),
    face = fontkit.create(bytes)
  document.registerFontkit({
    create(data) {
      const font = fontkit.create(data),
        subset = font.createSubset.bind(font)
      font.createSubset = () => {
        const value = subset()
        value.encodeStream = () => Readable.from([value.encode()])
        return value
      }
      return font
    }
  })
  // Keep distinct Unicode identities for characters sharing the same glyph outline.
  const aliases = new Map(),
    ranks = new Map(),
    fonts = []
  for (const unit of input.units)
    for (const char of unit.translation) {
      if (ranks.has(char) || /\s/u.test(char)) continue
      const glyph = face.glyphForCodePoint(char.codePointAt(0)).id
      if (!glyph) continue
      const list = aliases.get(glyph) ?? []
      ranks.set(char, list.length)
      list.push(char)
      aliases.set(glyph, list)
    }
  const count = Math.max(1, ...[...aliases.values()].map((a) => a.length))
  for (let i = 0; i < count; i++)
    fonts.push(
      await document.embedFont(bytes, { subset: true, features: { liga: false, kern: false } })
    )
  const measure = (text) =>
    [...text].reduce(
      (sum, char) =>
        sum + (face.glyphForCodePoint(char.codePointAt(0)).advanceWidth / face.unitsPerEm) * size,
      0
    )
  const lines = (text) => {
    const result = []
    let line = ''
    const add = (token) => {
      if (token === '\n') {
        result.push(line)
        line = ''
        return
      }
      if (measure(line + token) <= contentWidth) {
        line += token
        return
      }
      if (line.trim()) {
        result.push(line.trimEnd())
        line = ''
      }
      token = token.trimStart()
      for (const char of token) {
        if (measure(line + char) > contentWidth) {
          result.push(line)
          line = ''
        }
        line += char
      }
    }
    for (const token of text
      .replace(/\r\n?/gu, '\n')
      .match(
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|\n|[^\S\n]+|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu
      ) ?? [])
      add(token)
    if (line.trim()) result.push(line.trimEnd())
    return result
  }
  const native = await engine(),
    source = native.open(input.data),
    { p } = native
  const sourcePageNumbers = [],
    sourcePages = [],
    originalPageNumbers = [],
    placements = new Map(),
    layoutFailures = []
  // An original page without any replacement needs no reflow at all. In particular,
  // bibliography text must not be expanded into overlapping screenshots of rows.
  const changedPages = new Set(
    input.units
      .filter((unit) => unit.translation !== unit.source)
      .flatMap((unit) => unit.fragments.map((fragment) => fragment.pageNumber))
  )
  const footerCandidates = input.units.flatMap((unit, index) =>
    unit.translation === unit.source && /^\d{1,6}$/u.test(unit.source.trim())
      ? unit.fragments
          .filter(
            ({ rect }) =>
              rect.y > 0.9 &&
              rect.x > 0.3 &&
              rect.x + rect.width < 0.7 &&
              rect.width < 0.15 &&
              rect.height < 0.035
          )
          .map((fragment) => ({ index, fragment, number: Number(unit.source.trim()) }))
      : []
  )
  // Require a consecutive number at the same footer position on a neighboring
  // source page; a lone numeric table value must remain original content.
  const footerUnits = new Set(
    footerCandidates
      .filter((candidate) =>
        footerCandidates.some(
          (peer) =>
            Math.abs(peer.fragment.pageNumber - candidate.fragment.pageNumber) === 1 &&
            peer.number - candidate.number ===
              peer.fragment.pageNumber - candidate.fragment.pageNumber &&
            Math.abs(peer.fragment.rect.y - candidate.fragment.rect.y) < 0.015 &&
            Math.abs(peer.fragment.rect.x - candidate.fragment.rect.x) < 0.03
        )
      )
      .map((candidate) => candidate.index)
  )
  let originalDocument
  let page, cursor, sourceNumber
  const newPage = () => {
    if (sourcePageNumbers.length >= 2000) throw Error('Reflow page limit')
    page = document.addPage([width, height])
    cursor = margin
    sourcePageNumbers.push(sourceNumber)
    sourcePages.push([sourceNumber])
  }
  const markSources = (number, sources = [sourceNumber]) => {
    const mapped = sourcePages[number - 1]
    for (const source of sources) if (!mapped.includes(source)) mapped.push(source)
    mapped.sort((a, b) => a - b)
  }
  const place = (unitIndex, rect, text = '', number = sourcePageNumbers.length) => {
    markSources(
      number,
      input.units[unitIndex].fragments.map((f) => f.pageNumber)
    )
    const fragments = placements.get(unitIndex) ?? []
    const previous = fragments.at(-1)
    if (previous?.pageNumber === number && text && previous.text) {
      previous.rect = union(previous.rect, rect)
      previous.text += '\n' + text
    } else fragments.push({ pageNumber: number, rect, text })
    placements.set(unitIndex, fragments)
  }
  try {
    if (p.FPDF_GetPageCount(source.doc) !== input.pages.length) throw Error('Source pages changed')
    for (let number = 1; number <= input.pages.length; number++) {
      sourceNumber = number
      if (!changedPages.has(number)) {
        if (sourcePageNumbers.length >= 2000) throw Error('Reflow page limit')
        originalDocument ??= await PDFDocument.load(input.data, { updateMetadata: false })
        const [originalPage] = await document.copyPages(originalDocument, [number - 1])
        document.addPage(originalPage)
        sourcePageNumbers.push(number)
        sourcePages.push([number])
        originalPageNumbers.push(sourcePageNumbers.length)
        for (const [index, unit] of input.units.entries())
          for (const fragment of unit.fragments)
            if (fragment.pageNumber === number) place(index, fragment.rect)
        // Original pages are complete page objects and cannot share a text-flow page.
        page = undefined
        cursor = margin
        continue
      }
      // Keep the active reflow page across source-page boundaries. Original-page
      // identity is retained separately; it must not force a mostly empty output page.
      const dimensions = input.pages[number - 1],
        nativePage = p.FPDF_LoadPage(source.doc, number - 1)
      let bitmap
      try {
        const rotation = p.FPDFPage_GetRotation(nativePage)
        // Crop geometry is expressed in the PDF.js default viewport. For unusual
        // rotations preserve the complete visible page before its reflowed text.
        const objects = [],
          matrixBuffer = native.alloc(24)
        // A publisher Form may wrap the entire page. Walk through it to locate
        // actual figures, rather than copying its body text as one giant image.
        const multiply = (a, b) => [
          a[0] * b[0] + a[2] * b[1],
          a[1] * b[0] + a[3] * b[1],
          a[0] * b[2] + a[2] * b[3],
          a[1] * b[2] + a[3] * b[3],
          a[0] * b[4] + a[2] * b[5] + a[4],
          a[1] * b[4] + a[3] * b[5] + a[5]
        ]
        let visited = 0
        const visit = (object, matrix, depth) => {
          if (++visited > 100000 || depth > 16) throw Error('PDF graphic nesting limit')
          const type = p.FPDFPageObj_GetType(object)
          if (type === 1) return
          if (type === 5 && p.FPDFPageObj_GetMatrix(object, matrixBuffer)) {
            const next = multiply(matrix, [
              ...native.m.HEAPF32.slice(matrixBuffer / 4, matrixBuffer / 4 + 6)
            ])
            for (let i = 0; i < p.FPDFFormObj_CountObjects(object); i++)
              visit(p.FPDFFormObj_GetObject(object, i), next, depth + 1)
            return
          }
          const b = native.bounds(object),
            corners = [
              [b[0], b[1]],
              [b[0], b[3]],
              [b[2], b[1]],
              [b[2], b[3]]
            ].map(([x, y]) => [
              matrix[0] * x + matrix[2] * y + matrix[4],
              matrix[1] * x + matrix[3] * y + matrix[5]
            ])
          objects.push({
            type,
            bounds: [
              Math.min(...corners.map((c) => c[0])),
              Math.min(...corners.map((c) => c[1])),
              Math.max(...corners.map((c) => c[0])),
              Math.max(...corners.map((c) => c[1]))
            ]
          })
        }
        try {
          for (let i = 0; i < p.FPDFPage_CountObjects(nativePage); i++)
            visit(p.FPDFPage_GetObject(nativePage, i), [1, 0, 0, 1, 0, 0], 0)
        } finally {
          native.free(matrixBuffer)
        }
        const scale = Math.min(2, 2400 / Math.max(dimensions.width, dimensions.height))
        const pw = Math.ceil(dimensions.width * scale),
          ph = Math.ceil(dimensions.height * scale)
        const crop = async (rect) => {
          if (!bitmap) {
            bitmap = p.FPDFBitmap_Create(pw, ph, 1)
            if (!bitmap) throw Error('Bitmap allocation')
            p.FPDFBitmap_FillRect(bitmap, 0, 0, pw, ph, 0xffffffff)
            p.FPDF_RenderPageBitmap(bitmap, nativePage, 0, 0, pw, ph, 0, 1)
          }
          const x = Math.max(0, Math.floor(rect.x * pw)),
            y = Math.max(0, Math.floor(rect.y * ph))
          const w = Math.max(1, Math.min(pw - x, Math.ceil((rect.x + rect.width) * pw) - x)),
            h = Math.max(1, Math.min(ph - y, Math.ceil((rect.y + rect.height) * ph) - y))
          const stride = p.FPDFBitmap_GetStride(bitmap),
            at = p.FPDFBitmap_GetBuffer(bitmap)
          const image = await document.embedPng(
            png(native.m.HEAPU8.subarray(at, at + stride * ph), stride, x, y, w, h)
          )
          let drawWidth = Math.min(contentWidth, rect.width * dimensions.width),
            drawHeight = (drawWidth * h) / w
          if (drawHeight > bottom - margin) {
            drawWidth *= (bottom - margin) / drawHeight
            drawHeight = bottom - margin
          }
          if (!page || cursor + drawHeight > bottom + 0.001) newPage()
          markSources(sourcePageNumbers.length)
          const target = {
            x: margin / width,
            y: cursor / height,
            width: drawWidth / width,
            height: drawHeight / height
          }
          page.drawImage(image, {
            x: margin,
            y: height - cursor - drawHeight,
            width: drawWidth,
            height: drawHeight
          })
          cursor += drawHeight + 12
          return target
        }
        const graphics = rotation
          ? [{ x: 0, y: 0, width: 1, height: 1 }]
          : (input.originalRegions ?? [])
              .filter((region) => region.pageNumber === number)
              .map((region) => ({ ...region.rect }))
        for (const object of rotation ? [] : objects) {
          if (object.type === 1) continue
          const [left, low, right, high] = object.bounds
          if (
            (right - left < 3 && high - low < 3) ||
            right < left ||
            high < low ||
            ![left, low, right, high].every(Number.isFinite)
          )
            continue
          const rect = {
            x: Math.max(0, left / dimensions.width),
            y: Math.max(0, 1 - high / dimensions.height),
            width: Math.min(1, (right - left) / dimensions.width),
            height: Math.min(1, (high - low) / dimensions.height)
          }
          if (rect.width * rect.height > 0.85 && object.type !== 3) continue
          // Merge connected diagram paths into one crop, retaining labels in place.
          let merged = rect
          for (let i = 0; i < graphics.length;) {
            if (touches(merged, graphics[i], 0.006)) {
              merged = union(merged, graphics.splice(i, 1)[0])
              i = 0
            } else i++
          }
          graphics.push(merged)
        }
        // Isolated rules/underlines are decoration, not separate figures. Join
        // horizontally separated parts of a figure occupying the same rows.
        for (let i = graphics.length - 1; i >= 0; i--)
          if (graphics[i].width < 0.005 || graphics[i].height < 0.005) graphics.splice(i, 1)
        for (let i = 0; i < graphics.length; i++)
          for (let j = i + 1; j < graphics.length;) {
            const a = graphics[i],
              b = graphics[j]
            if (a.y <= b.y + b.height + 0.01 && b.y <= a.y + a.height + 0.01) {
              graphics[i] = union(a, b)
              graphics.splice(j, 1)
              j = i + 1
            } else j++
          }
        const pageUnits = readingOrder(
          input.units.flatMap((unit, unitIndex) => {
            const fragments = unit.fragments.filter((f) => f.pageNumber === number)
            if (!fragments.length) return []
            // A publisher's old footer number is not body content. Reflowing it can
            // otherwise create a continuation page containing only that number.
            if (footerUnits.has(unitIndex)) return []
            return [{ unit, unitIndex, fragments }]
          })
        )
        // Include protruding labels at the edge of a figure without capturing adjacent prose.
        for (const graphic of graphics)
          for (const { unit, fragments } of pageUnits)
            for (const f of fragments) {
              if (/^(?:Table|Tab\.|Figure|Fig\.)\s*\d/iu.test(unit.source)) continue
              if (f.rect.height < 0.045 && touches(graphic, f.rect, 0.003))
                Object.assign(graphic, union(graphic, f.rect))
            }
        graphics.sort((a, b) => a.y - b.y || a.x - b.x)
        const drawn = new Map()
        const originals = new Map(),
          originalDrawn = new Set()
        let group
        for (const entry of pageUnits) {
          if (
            entry.unit.source !== entry.unit.translation ||
            entry.unit.kind === 'text' ||
            entry.unit.kind === 'reference' ||
            entry.fragments.length !== 1 ||
            graphics.some((g) => contains(entry.fragments[0].rect, g))
          ) {
            group = undefined
            continue
          }
          const rect = entry.fragments[0].rect
          if (
            !group ||
            rect.y < group.rect.y ||
            rect.y - group.rect.y - group.rect.height > 0.022 ||
            Math.abs(rect.x - group.rect.x) > 0.035
          )
            group = { rect: { ...rect }, entries: [] }
          else group.rect = union(group.rect, rect)
          group.entries.push(entry.unitIndex)
          originals.set(entry.unitIndex, group)
        }
        for (const { unit, unitIndex, fragments } of pageUnits) {
          for (const graphic of graphics) {
            if (
              drawn.has(graphic) ||
              !(
                fragments.some((f) => inside(f.rect, graphic)) ||
                graphic.y + graphic.height <= fragments[0].rect.y
              )
            )
              continue
            const target = await crop(graphic)
            drawn.set(graphic, { target, number: sourcePageNumbers.length })
          }
          // Unchanged labels already belong to the original figure. Output them
          // once through that image instead of repeating them as prose below it.
          if (
            unit.translation === unit.source &&
            fragments.every((fragment) =>
              graphics.some((graphic) => contains(fragment.rect, graphic))
            )
          ) {
            for (const fragment of fragments) {
              const graphic = graphics.find((graphic) => contains(fragment.rect, graphic)),
                painted = drawn.get(graphic)
              if (painted) place(unitIndex, painted.target, '', painted.number)
            }
            continue
          }
          if (
            unit.translation === unit.source &&
            ((unit.kind !== 'text' && unit.kind !== 'reference') ||
              unit.fragments.some((fragment) => fragment.pageNumber !== number))
          ) {
            const group = originals.get(unitIndex)
            if (group) {
              if (!originalDrawn.has(group)) {
                const target = await crop(group.rect)
                for (const index of group.entries) place(index, target)
                originalDrawn.add(group)
              }
              continue
            }
            for (const fragment of fragments) {
              const graphic = graphics.find((g) => contains(fragment.rect, g))
              if (!graphic) place(unitIndex, await crop(fragment.rect))
            }
            continue
          }
          const supported = [...unit.translation].every(
            (c) => /\s/u.test(c) || face.hasGlyphForCodePoint(c.codePointAt(0))
          )
          if (!supported) {
            for (const fragment of unit.fragments)
              if (fragment.pageNumber === number) place(unitIndex, await crop(fragment.rect))
            if (unit.translation !== unit.source && unit.fragments[0].pageNumber === number)
              layoutFailures.push({
                unitIndex,
                code: 'font',
                phase: 'glyphs',
                pageNumbers: [...new Set(unit.fragments.map((f) => f.pageNumber))],
                fragmentCount: unit.fragments.length
              })
            continue
          }
          // Joined paragraphs are emitted once, at their first source fragment.
          if (unit.fragments[0].pageNumber !== number) continue
          const paragraphLines = lines(unit.translation)
          // Keep at least two lines together where possible. Avoid a one-line
          // paragraph tail, without reserving an entire long paragraph's height.
          if (page && cursor + Math.min(2, paragraphLines.length) * leading > bottom) newPage()
          for (const [lineIndex, line] of paragraphLines.entries()) {
            const remaining = paragraphLines.length - lineIndex
            if (
              page &&
              remaining === 2 &&
              paragraphLines.length > 2 &&
              cursor + 2 * leading > bottom
            )
              newPage()
            if (!page || cursor + leading > bottom) newPage()
            let x = margin,
              run = '',
              rank = 0
            const flush = () => {
              if (run) {
                page.drawText(run, {
                  x,
                  y: height - cursor - size,
                  font: fonts[rank],
                  size,
                  color: rgb(0.08, 0.08, 0.08)
                })
                x += measure(run)
                run = ''
              }
            }
            for (const char of line) {
              const next = ranks.get(char) ?? 0
              if (next !== rank) {
                flush()
                rank = next
              }
              run += char
            }
            flush()
            if (key(line))
              place(
                unitIndex,
                {
                  x: margin / width,
                  y: cursor / height,
                  width: Math.max(1, measure(line)) / width,
                  height: leading / height
                },
                line
              )
            cursor += leading
          }
          cursor += 10
        }
        for (const graphic of graphics) if (!drawn.has(graphic)) await crop(graphic)
        // A page without located source text remains fully visible.
        if (!pageUnits.length && !graphics.length) await crop({ x: 0, y: 0, width: 1, height: 1 })
      } finally {
        if (bitmap) p.FPDFBitmap_Destroy(bitmap)
        p.FPDF_ClosePage(nativePage)
      }
    }
    const data = await document.save()
    if (data.length > 64 * 1024 ** 2) throw Error('Reflow output size')
    return {
      data,
      layoutFailures,
      reflow: {
        sourcePageNumbers,
        sourcePages,
        originalPageNumbers,
        units: [...placements].map(([unitIndex, fragments]) => ({ unitIndex, fragments }))
      }
    }
  } finally {
    source.close()
  }
}
