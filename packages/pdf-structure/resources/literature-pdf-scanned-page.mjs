/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createScanOcr } from './literature-pdf-scan-ocr.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { createCanvas } from '@napi-rs/canvas'

const area = (r) => (r[2] - r[0]) * (r[3] - r[1])
const lineRect = (l) => [l.x, l.y, l.x + l.width, l.y + l.height]
const contains = (a, b, margin = 0) =>
  b.every((v, i) => (i < 2 ? v >= a[i] - margin : v <= a[i] + margin))

// A large background image alone does not make native text an OCR layer.
// Track the text rendering mode through graphics-state save/restore instead.
export function isSearchableScan(page, operators) {
  if (page.rotation || page.renderRotation || page.invalidGraphicsBounds) return false
  const carriers = (page.graphicsBounds ?? []).filter(
    (g) => g.kind === 'image' && area(g.normalizedRect) >= 0.85
  )
  if (carriers.length !== 1 || !page.lines?.some((l) => l.text.trim())) return false
  let mode = 0,
    hidden = 0
  const stack = []
  for (const [i, op] of operators.fnArray.entries()) {
    if (op === OPS.save) stack.push(mode)
    else if (op === OPS.restore) mode = stack.pop() ?? 0
    else if (op === OPS.setTextRenderingMode) mode = operators.argsArray[i][0]
    else if (
      [
        OPS.showText,
        OPS.showSpacedText,
        OPS.nextLineShowText,
        OPS.nextLineSetSpacingShowText
      ].includes(op)
    ) {
      if (mode !== 3) return false
      hidden++
    }
  }
  return hidden > 0
}

// Ruled scan captions provide measured column boundaries independently of OCR
// font metrics. Keep this recovery local to that layout, not a generic OCR parser.
export function recoverRuledScanElements(page, candidates, raster, tokens = []) {
  const { data, width, height } = raster
  const sx = width / page.width,
    sy = height / page.height
  const ink = (x, y) => {
    const i = (y * width + x) * 4
    return data[i + 3] > 128 && Math.min(data[i], data[i + 1], data[i + 2]) < 160
  }
  const rules = []
  for (let y = 0; y < height; y++) {
    let first = -1,
      last = -1
    for (let x = 0; x <= width; x++) {
      if (x < width && ink(x, y)) {
        if (first < 0) first = x
        last = x
      } else if (first >= 0 && x - last > Math.ceil(sx)) {
        if ((last - first) / sx >= page.width * 0.08) {
          const rect = [first / sx, y / sy, (last + 1) / sx, (y + 1) / sy]
          const prior = rules.findLast(
            (r) =>
              y / sy - r[3] <= 1 &&
              rect[3] - r[1] <= 3 &&
              Math.min(r[2], rect[2]) - Math.max(r[0], rect[0]) >
                Math.min(r[2] - r[0], rect[2] - rect[0]) * 0.3
          )
          if (prior) {
            prior[0] = Math.min(prior[0], rect[0])
            prior[2] = Math.max(prior[2], rect[2])
            prior[3] = rect[3]
          } else rules.push(rect)
        }
        first = -1
      }
    }
  }
  for (let i = rules.length - 1; i >= 0; i--)
    if (rules[i][2] - rules[i][0] < page.width * 0.25) rules.splice(i, 1)
  const captionRows = (bounds, splitColumns = false) => {
    if (!tokens.length)
      return page.lines.filter((l) => l.text.trim() && contains(bounds, lineRect(l), 2))
    const rows = []
    for (const token of tokens
      .filter((t) => t.text.trim() && contains(bounds, t.rect, 2))
      .sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0])) {
      let row = rows.find(
        (r) =>
          Math.min(r.bottom, token.rect[3]) - Math.max(r.y, token.rect[1]) >
          Math.min(r.bottom - r.y, token.rect[3] - token.rect[1]) * 0.5
      )
      if (!row) {
        row = { y: token.rect[1], bottom: token.rect[3], items: [] }
        rows.push(row)
      }
      row.items.push(token)
      row.y = Math.min(row.y, token.rect[1])
      row.bottom = Math.max(row.bottom, token.rect[3])
    }
    return rows
      .sort((a, b) => a.y - b.y)
      .flatMap((row) => {
        const sorted = row.items.sort((a, b) => a.rect[0] - b.rect[0]),
          groups = [[]]
        for (const item of sorted) {
          const prev = groups.at(-1).at(-1)
          if (splitColumns && prev && item.rect[0] - prev.rect[2] > 12) groups.push([])
          groups.at(-1).push(item)
        }
        return groups.map((items) => {
          return {
            x: items[0].rect[0],
            y: row.y,
            width: Math.max(...items.map((t) => t.rect[2])) - items[0].rect[0],
            height: row.bottom - row.y,
            text: items
              .map(
                (t, i) => (i && t.rect[0] - items[i - 1].rect[2] > 0.8 ? ' ' : '') + t.text.trim()
              )
              .join('')
          }
        })
      })
  }
  const local = candidates.filter((c) => c.page === page.pageNumber)
  const elements = []
  const aligned = (r, c) => Math.abs(r[0] - c.rect[0]) <= 8 && r[2] >= c.rect[0] + 70
  const sameLane = (a, b) => Math.abs(a[0] - b[0]) < 5 && Math.abs(a[2] - b[2]) < 5
  const tightInk = (rect) => {
    const x0 = Math.max(0, Math.ceil(rect[0] * sx)),
      x1 = Math.min(width, Math.floor(rect[2] * sx))
    const y0 = Math.max(0, Math.ceil(rect[1] * sy)),
      y1 = Math.min(height, Math.floor(rect[3] * sy))
    let left = x1,
      right = x0,
      top = y1,
      bottom = y0,
      pixels = 0
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++)
        if (ink(x, y)) {
          left = Math.min(left, x)
          right = Math.max(right, x + 1)
          top = Math.min(top, y)
          bottom = Math.max(bottom, y + 1)
          pixels++
        }
    if (pixels < 100 || bottom - top < 12 * sy || right - left < 30 * sx) return
    return [
      Math.max(rect[0], left / sx - 2),
      Math.max(rect[1], top / sy - 2),
      Math.min(rect[2], right / sx + 2),
      Math.min(rect[3], bottom / sy + 2)
    ]
  }
  for (const c of local) {
    const kind = /^(?:Fig\.?|Figure)\s+\d/i.test(c.lines[0])
      ? 'figure'
      : /^Table\s+\d/i.test(c.lines[0])
        ? 'table'
        : undefined
    if (!kind) continue
    const start = page.lines.find(
      (l) => Math.abs(l.y - c.rect[1]) < 3 && Math.abs(l.x - c.rect[0]) < 8
    )
    if (!start) continue
    let captionBounds, bodyBounds
    if (kind === 'figure') {
      const upper = rules
        .filter((r) => aligned(r, c) && r[3] <= start.y + 7 && start.y - r[3] < 14)
        .at(-1)
      if (!upper) continue
      const lower = rules.find(
        (r) =>
          sameLane(r, upper) &&
          r[1] > start.y + start.height &&
          r[1] - upper[3] <= page.height * 0.2
      )
      if (!lower) continue
      captionBounds = [upper[0] - 2, start.y - 1, upper[2] + 2, lower[1]]
      const precedingRules = rules.filter(
        (r) =>
          r[3] < Math.min(upper[1] - 12, page.height * 0.08) &&
          r[0] <= upper[0] + 5 &&
          r[2] >= upper[2] - 5
      )
      let top = precedingRules.at(-1)?.[3] ?? page.height * 0.03
      // Long prose in the same column bounds a lower figure, but plot labels do not.
      const proseRows = captionRows([upper[0] - 2, top, upper[2] + 2, upper[1] - 3], true)
      for (const l of proseRows)
        if (l.text.length > 55 && l.width > page.width * 0.25) top = Math.max(top, l.y + l.height)
      for (const l of proseRows)
        if (l.y >= top - l.height && l.y <= top + 5 && l.text.length > 15)
          top = Math.max(top, l.y + l.height)
      bodyBounds = [upper[0] - 2, top + 3, upper[2] + 2, upper[1] - 3]
    } else {
      const upper = rules.find(
        (r) => aligned(r, c) && r[1] >= c.rect[3] - 2 && r[1] - c.rect[3] < 30
      )
      if (!upper) continue
      const lower = rules
        .filter(
          (r) =>
            sameLane(r, upper) &&
            r[1] > upper[3] + 30 &&
            !local.some(
              (other) =>
                other !== c &&
                other.rect[1] > upper[3] &&
                other.rect[1] < r[1] &&
                other.rect[0] >= upper[0] - 3 &&
                other.rect[2] <= upper[2] + 3
            ) &&
            !captionRows([upper[0] - 3, upper[3], upper[2] + 3, r[1]], true).some(
              (l) =>
                l.text.length > 60 &&
                l.width > Math.min((upper[2] - upper[0]) * 0.75, page.width * 0.25)
            )
        )
        .at(-1)
      if (!lower) continue
      captionBounds = [upper[0] - 2, start.y - 1, upper[2] + 2, upper[1]]
      bodyBounds = [upper[0] - 2, upper[1] - 1, upper[2] + 2, lower[3] + 1]
      // Keep an immediately attached, explicitly marked footnote in the image.
      // Its OCR text is not evidence for structured scientific values.
      const notes = captionRows(
        [
          upper[0] - 2,
          lower[3],
          upper[2] + 2,
          Math.min(page.height * 0.94, lower[3] + page.height * 0.12)
        ],
        true
      )
      if (notes[0] && notes[0].y - lower[3] < 12 && /^[*†‡#]/.test(notes[0].text)) {
        let bottom = lower[3]
        for (const note of notes) {
          if (note.y - bottom > 12) break
          bottom = note.y + note.height
        }
        bodyBounds[3] = bottom + 2
      }
    }
    const rows = captionRows(captionBounds)
    if (
      !rows.length ||
      !rows[0].text.startsWith(start.text.split(/\s+/)[0]) ||
      rows.some((l, i) => i > 0 && /^(?:FIGURE|TABLE)\s+\d/i.test(l.text))
    )
      continue
    if (local.some((other) => other !== c && contains(bodyBounds, other.rect))) continue
    const rect = tightInk(bodyBounds)
    if (!rect || area(rect) > page.width * page.height * 0.8) continue
    elements.push({
      kind,
      rect,
      caption: {
        ...c,
        lines: rows.map((l) => l.text),
        rect: [
          Math.min(...rows.map((l) => l.x)),
          Math.min(...rows.map((l) => l.y)),
          Math.max(...rows.map((l) => l.x + l.width)),
          Math.max(...rows.map((l) => l.y + l.height))
        ]
      }
    })
  }
  return elements.filter(
    (e) =>
      !elements.some(
        (other) =>
          other !== e &&
          Math.min(e.rect[2], other.rect[2]) > Math.max(e.rect[0], other.rect[0]) &&
          Math.min(e.rect[3], other.rect[3]) > Math.max(e.rect[1], other.rect[1])
      )
  )
}

export async function readScannedPageElements(page, geometry, candidates, ocr) {
  const viewport = page.getViewport({
    scale: Math.min(2, 2400 / Math.max(geometry.width, geometry.height)),
    rotation: geometry.renderRotation
  })
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
  try {
    const context = canvas.getContext('2d')
    await page.render({ canvas, canvasContext: context, viewport }).promise
    const native = page.getViewport({ scale: 1, rotation: geometry.renderRotation })
    const tokens = (await page.getTextContent()).items
      .filter((i) => i.str?.trim())
      .map((i) => tableTextToken(i, native, geometry.renderRotation))
    const raster = context.getImageData(0, 0, canvas.width, canvas.height)
    const nativeElements = recoverRuledScanElements(geometry, candidates, raster, tokens)
    if (!ocr || !nativeElements.length) return nativeElements
    const session = createScanOcr(ocr)
    try {
      const ocrViewport = page.getViewport({
        scale: Math.min(3, 2400 / Math.max(geometry.width, geometry.height)),
        rotation: geometry.renderRotation
      })
      canvas.width = Math.ceil(ocrViewport.width)
      canvas.height = Math.ceil(ocrViewport.height)
      await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: ocrViewport })
        .promise
      const recognized = await session.recognize(
        await canvas.encode('png'),
        canvas.width,
        canvas.height,
        geometry
      )
      if (!recognized) return nativeElements
      const recovered = recoverRuledScanElements(geometry, candidates, raster, recognized)
      return reconcileScanCaptions(nativeElements, recovered, recognized)
    } catch {
      return nativeElements
    } finally {
      await session.close()
    }
  } finally {
    canvas.width = 1
    canvas.height = 1
  }
}

// Fresh OCR may improve text, but cannot move a proved native crop or transfer
// the caption of a neighboring column with the same vertical position.
export function reconcileScanCaptions(elements, recovered, recognized) {
  const label = (element) =>
    element.caption.lines[0].match(/^(?:FIG(?:URE)?\.?|TABLE)\s+(\d+)/i)?.[1]
  return elements.map((element) => {
    const matches = recovered.filter(
      (e) =>
        e.kind === element.kind &&
        e.caption.page === element.caption.page &&
        label(e) === label(element) &&
        Math.abs(e.caption.rect[0] - element.caption.rect[0]) < 15 &&
        Math.abs(e.caption.rect[1] - element.caption.rect[1]) < 15
    )
    if (matches.length !== 1) return element
    const replacement = matches[0]
    if (
      replacement.caption.lines.length < element.caption.lines.length ||
      replacement.caption.rect[3] < element.caption.rect[3] - 5
    )
      return element
    const words = recognized.filter((t) => contains(replacement.caption.rect, t.rect, 1))
    return words.length && words.every((t) => t.confidence >= 60)
      ? { ...element, caption: replacement.caption }
      : element
  })
}
