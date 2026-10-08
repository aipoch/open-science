/* eslint-disable @typescript-eslint/explicit-function-return-type -- Worker-only native helper. */
import {
  PDFDocument,
  PDFDict,
  PDFRef,
  PDFName,
  PDFRawStream,
  PDFObjectCopier,
  decodePDFRawStream
} from 'pdf-lib'
import { engine } from './pdfium.mjs'
import { createHash } from 'node:crypto'

// PDFium can assign one overprinted label's text to a different native object
// after its Form is copied to a temporary page. The painted objects themselves
// must remain identical in order, geometry, font, matrix and readable paint state.
export function matchingOverprintFormObjects(left, right, bbox) {
  // A Form invocation contributes its BBox clip to every child. The temporary
  // Contents page has no invocation, but the original BBox is retained on output.
  // Only rectangular clips covering that whole proven resource can be ignored;
  // effective/intrinsic clipping remains part of each ordered child's identity.
  const sameIdentity = (a, b) => {
    const intrinsic = (value) => ({
      ...value,
      clipping: value.clipping.filter((parts) => {
        if (
          !bbox ||
          bbox.length !== 4 ||
          !bbox.every(Number.isFinite) ||
          parts.length !== 5 ||
          parts[0][0] !== 2 ||
          parts.some((part) => !part.slice(2).every(Number.isFinite)) ||
          parts.slice(0, 4).some((part) => part[1]) ||
          !parts[4][1] ||
          parts.slice(1).some((part) => part[0] !== 0)
        )
          return true
        const points = parts.map((part) => part.slice(2)),
          [first, last] = [points[0], points[4]]
        if (
          new Set(points.slice(0, 4).map((point) => point.join(','))).size !== 4 ||
          first[0] !== last[0] ||
          first[1] !== last[1] ||
          points
            .slice(1)
            .some((point, i) => point[0] !== points[i][0] && point[1] !== points[i][1]) ||
          new Set(points.map((point) => point[0])).size !== 2 ||
          new Set(points.map((point) => point[1])).size !== 2
        )
          return true
        const matrix = value.matrix,
          // PDF images paint the unit square. PDFium exposes its matrix and
          // paint bounds as native floats; reproduce that arithmetic exactly,
          // without expanding a clip or introducing a geometric tolerance.
          image =
            value.paintBounds &&
            matrix[0] > 0 &&
            matrix[3] > 0 &&
            matrix[1] === 0 &&
            matrix[2] === 0 &&
            JSON.stringify(value.paintBounds) ===
              JSON.stringify([
                matrix[4],
                matrix[5],
                Math.fround(matrix[4] + matrix[0]),
                Math.fround(matrix[5] + matrix[3])
              ])
              ? value.paintBounds
              : undefined,
          covers = (box) =>
            box &&
            Math.min(...points.map((point) => point[0])) <= box[0] &&
            Math.min(...points.map((point) => point[1])) <= box[1] &&
            Math.max(...points.map((point) => point[0])) >= box[2] &&
            Math.max(...points.map((point) => point[1])) >= box[3]
        return !(covers(bbox) || covers(image))
      })
    })
    return a && b && JSON.stringify(intrinsic(a)) === JSON.stringify(intrinsic(b))
  }
  if (left.length !== right.length || !left.length) return false
  const changed = []
  for (let i = 0; i < left.length; i++) {
    const a = left[i],
      b = right[i]
    if (
      a.type !== b.type ||
      !a.bounds.every(Number.isFinite) ||
      !b.bounds.every(Number.isFinite) ||
      JSON.stringify(a.bounds) !== JSON.stringify(b.bounds) ||
      !sameIdentity(a.identity, b.identity)
    )
      return false
    if (a.text !== b.text) changed.push(i)
  }
  if (!changed.length) return false
  const consumed = new Set()
  for (const i of changed) {
    if (consumed.has(i)) continue
    const a = left[i],
      b = right[i],
      label = a.text || b.text,
      candidates = changed.filter((j) => {
        if (j === i || consumed.has(j)) return false
        const other = left[j],
          target = right[j],
          size = a.identity.size,
          [x, y, edge, top] = a.bounds,
          [ox, oy, oright, otop] = other.bounds,
          overlap = Math.min(top, otop) - Math.max(y, oy)
        return (
          a.type === 1 &&
          other.type === 1 &&
          /^[A-Za-z][A-Za-z0-9 [\]_.-]{1,31}$/u.test(label) &&
          Boolean(a.text) !== Boolean(b.text) &&
          a.text === target.text &&
          b.text === other.text &&
          a.identity.font === other.identity.font &&
          a.identity.size === other.identity.size &&
          size > 0 &&
          Math.abs(x - ox) < size * 0.01 &&
          Math.abs(edge - oright) < size * 0.01 &&
          Math.abs(top - otop) < size * 0.15 &&
          overlap > Math.min(top - y, otop - oy) * 0.85
        )
      })
    if (candidates.length !== 1) return false
    consumed.add(i)
    consumed.add(candidates[0])
  }
  return consumed.size === changed.length
}

// Edit a Form's native labels as a temporary page, then copy its stream/resources into
// the requesting page's resource chain. Keep its BBox, Matrix, transparency group
// and invocation clipping; flattening a chart would lose those boundaries.
export async function translateFormLabels(data, units, pages, generate, onSavedUnit = undefined) {
  const candidates = units.filter((u) => u.fragments.length === 1)
  if (!candidates.some((u) => u.source !== u.translation)) return data
  // Unrequested pages need no native paint snapshots. Keep the full-document
  // resource ownership scan below so a shared Form is still copied per page.
  const candidatePages = new Set(
    candidates.filter((u) => u.source !== u.translation).map((u) => u.fragments[0].pageNumber)
  )
  const e = await engine(),
    p = e.p,
    input = e.open(data),
    forms = [],
    normalize = (text) => text.normalize('NFKC').replace(/\s/gu, ''),
    multiply = ([a, b, c, d, x, y], [f, g, h, i, j, k]) => [
      a * f + c * g,
      b * f + d * g,
      a * h + c * i,
      b * h + d * i,
      a * j + c * k + x,
      b * j + d * k + y
    ]
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const bitmapIdentity = (bitmap) => {
    if (!bitmap) return undefined
    try {
      const width = p.FPDFBitmap_GetWidth(bitmap),
        height = p.FPDFBitmap_GetHeight(bitmap),
        stride = p.FPDFBitmap_GetStride(bitmap),
        at = p.FPDFBitmap_GetBuffer(bitmap)
      if (!at || width <= 0 || height <= 0 || stride * height > 16 * 1024 ** 2) return undefined
      return [
        width,
        height,
        stride,
        p.FPDFBitmap_GetFormat(bitmap),
        digest(e.m.HEAPU8.slice(at, at + stride * height))
      ]
    } finally {
      p.FPDFBitmap_Destroy(bitmap)
    }
  }
  const fontIdentities = new Map()
  const identity = (obj, doc, page) => {
    const at = e.alloc(64)
    try {
      if (p.FPDFPageObj_CountMarks(obj) !== 0 || !p.FPDFPageObj_GetMatrix(obj, at)) return undefined
      const matrix = [...e.m.HEAPF32.slice(at / 4, at / 4 + 6)]
      if (!matrix.every(Number.isFinite) || !p.FPDFPageObj_GetIsActive(obj, at)) return undefined
      const active = e.m.HEAP32[at / 4],
        color = (fn) =>
          typeof fn === 'function' && fn(obj, at, at + 4, at + 8, at + 12)
            ? [...e.m.HEAPU32.slice(at / 4, at / 4 + 4)]
            : undefined,
        fill = color(p.FPDFPageObj_GetFillColor),
        stroke = color(p.FPDFPageObj_GetStrokeColor),
        segment = (value) => {
          if (!value || !p.FPDFPathSegment_GetPoint(value, at, at + 4)) return undefined
          return [
            p.FPDFPathSegment_GetType(value),
            p.FPDFPathSegment_GetClose(value),
            ...e.m.HEAPF32.slice(at / 4, at / 4 + 2)
          ]
        },
        clip = p.FPDFPageObj_GetClipPath(obj),
        clipping = [],
        clipCount = clip
          ? typeof p.FPDFClipPath_CountPaths === 'function'
            ? p.FPDFClipPath_CountPaths(clip)
            : undefined
          : 0
      // GetClipPath borrows this validated object's CPDF_ClipPath field.
      // PDFium reports -1 when that field has no internal clip reference;
      // it is a valid empty clip, not an unknown path count.
      if (!Number.isInteger(clipCount) || clipCount < -1 || clipCount > 10000) return undefined
      for (let n = 0; n < clipCount; n++) {
        const count = p.FPDFClipPath_CountPathSegments(clip, n)
        if (!Number.isInteger(count) || count < 0 || count > 10000) return undefined
        const parts = Array.from({ length: count }, (_, i) =>
          segment(p.FPDFClipPath_GetPathSegment(clip, n, i))
        )
        if (parts.some((part) => !part)) return undefined
        clipping.push(parts)
      }
      const common = {
          matrix,
          active,
          fill,
          stroke,
          clipping,
          transparency: p.FPDFPageObj_HasTransparency(obj)
        },
        type = p.FPDFPageObj_GetType(obj)
      if (type === 1) {
        const font = p.FPDFTextObj_GetFont(obj)
        if (!font || !p.FPDFTextObj_GetFontSize(obj, at)) return undefined
        const size = e.m.HEAPF32[at / 4]
        if (!Number.isFinite(size) || size <= 0) return undefined
        if (!fontIdentities.has(font)) {
          const length = p.FPDFFont_GetBaseFontName(font, 0, 0)
          if (length <= 0 || length > 512) return undefined
          const buffer = e.alloc(length)
          try {
            if (p.FPDFFont_GetBaseFontName(font, buffer, length) !== length) return undefined
            fontIdentities.set(
              font,
              Buffer.from(e.m.HEAPU8.slice(buffer, buffer + length - 1)).toString('utf8')
            )
          } finally {
            e.free(buffer)
          }
        }
        const paint = bitmapIdentity(p.FPDFTextObj_GetRenderedBitmap(doc, page, obj, 2))
        if (!paint) return undefined
        return {
          ...common,
          font: fontIdentities.get(font),
          size,
          mode: p.FPDFTextObj_GetTextRenderMode(obj),
          paint
        }
      }
      if (type === 2) {
        const count = p.FPDFPath_CountSegments(obj)
        if (count < 0 || count > 10000 || !p.FPDFPath_GetDrawMode(obj, at, at + 4)) return undefined
        const mode = [...e.m.HEAP32.slice(at / 4, at / 4 + 2)],
          parts = Array.from({ length: count }, (_, i) =>
            segment(p.FPDFPath_GetPathSegment(obj, i))
          )
        if (
          ![0, 1, 2].includes(mode[0]) ||
          ![0, 1].includes(mode[1]) ||
          (mode[0] !== 0 && !fill) ||
          (mode[1] !== 0 && !stroke) ||
          parts.some((part) => !part) ||
          !p.FPDFPageObj_GetStrokeWidth(obj, at) ||
          typeof p.FPDFPageObj_GetDashCount !== 'function' ||
          typeof p.FPDFPageObj_GetDashPhase !== 'function' ||
          typeof p.FPDFPageObj_GetDashArray !== 'function'
        )
          return undefined
        const width = e.m.HEAPF32[at / 4],
          cap = p.FPDFPageObj_GetLineCap(obj),
          join = p.FPDFPageObj_GetLineJoin(obj),
          dashCount = p.FPDFPageObj_GetDashCount(obj)
        if (
          !Number.isFinite(width) ||
          width < 0 ||
          ![0, 1, 2].includes(cap) ||
          ![0, 1, 2].includes(join) ||
          !Number.isInteger(dashCount) ||
          dashCount < 0 ||
          dashCount > 1024 ||
          !p.FPDFPageObj_GetDashPhase(obj, at)
        )
          return undefined
        const dashPhase = e.m.HEAPF32[at / 4],
          dash = []
        if (!Number.isFinite(dashPhase)) return undefined
        if (dashCount) {
          const buffer = e.alloc(dashCount * 4)
          try {
            if (!p.FPDFPageObj_GetDashArray(obj, buffer, dashCount)) return undefined
            dash.push(...e.m.HEAPF32.slice(buffer / 4, buffer / 4 + dashCount))
          } finally {
            e.free(buffer)
          }
          if (dash.some((n) => !Number.isFinite(n) || n < 0) || !dash.some((n) => n > 0))
            return undefined
        }
        // PDFium exposes no miter-limit or general blend-mode getter. Compare
        // every readable path field; preserve the publisher's original stream.
        return { ...common, mode, parts, width, cap, join, dash, dashPhase }
      }
      if (type === 3) {
        const paint = bitmapIdentity(p.FPDFImageObj_GetRenderedBitmap(doc, page, obj))
        return paint ? { ...common, paint, paintBounds: e.bounds(obj) } : undefined
      }
      return undefined
    } finally {
      e.free(at)
    }
  }
  const describe = (obj, text, doc, page) => {
    const type = p.FPDFPageObj_GetType(obj)
    let value = ''
    if (type === 1) {
      const size = p.FPDFTextObj_GetText(obj, text, 0, 0),
        at = e.alloc(size)
      try {
        p.FPDFTextObj_GetText(obj, text, at, size)
        value = Buffer.from(e.m.HEAPU8.slice(at, at + size))
          .toString('utf16le')
          .replace(/\0$/, '')
          .trim()
      } finally {
        e.free(at)
      }
    }
    const description = {
      type,
      bounds: e.bounds(obj).map((n) => Math.round(n * 1000) / 1000),
      text: value
    }
    // Preserve the existing exact ordered key. Native paint identity is required
    // only for the narrowly proven overprint text-page assignment fallback.
    Object.defineProperty(description, 'identity', { value: identity(obj, doc, page) })
    return description
  }
  let incompleteTree = false
  try {
    for (let index = 0; index < pages.length; index++) {
      if (!candidatePages.has(index + 1)) continue
      const page = p.FPDF_LoadPage(input.doc, index),
        at = e.alloc(24)
      if (!page) throw Error('Could not open PDF Form page')
      let text
      try {
        // Rotated pages retain the existing fallback until their local mapping is proven.
        const rotated = p.FPDFPage_GetRotation(page) !== 0,
          annotations = []
        if (!p.FPDF_GetPageBoundingBox(page, at)) {
          incompleteTree = true
          continue
        }
        const [left, top] = e.m.HEAPF32.slice(at / 4, at / 4 + 2)
        for (let i = 0; i < p.FPDFPage_GetAnnotCount(page); i++) {
          const annotation = p.FPDFPage_GetAnnot(page, i)
          try {
            if (!annotation || !p.FPDFAnnot_GetRect(annotation, at)) {
              incompleteTree = true
              break
            }
            const rect = [...e.m.HEAPF32.slice(at / 4, at / 4 + 4)]
            if (!rect.every(Number.isFinite)) {
              incompleteTree = true
              break
            }
            annotations.push([
              Math.min(rect[0], rect[2]),
              Math.min(rect[1], rect[3]),
              Math.max(rect[0], rect[2]),
              Math.max(rect[1], rect[3])
            ])
          } finally {
            if (annotation) p.FPDFPage_CloseAnnot(annotation)
          }
        }
        text = p.FPDFText_LoadPage(page)
        const walk = (obj, parent, depth) => {
          if (p.FPDFPageObj_GetType(obj) !== 5) return
          if (depth > 32 || !p.FPDFPageObj_GetMatrix(obj, at)) {
            incompleteTree = true
            return
          }
          const outer = multiply(parent, [...e.m.HEAPF32.slice(at / 4, at / 4 + 6)]),
            count = p.FPDFFormObj_CountObjects(obj)
          if (count < 0 || count > 100000) {
            incompleteTree = true
            return
          }
          const children = Array.from({ length: count }, (_, i) => p.FPDFFormObj_GetObject(obj, i))
          // A graphic-only nested Form (for example, a publisher logo) does
          // not own the surrounding native caption. Keep that parent editable;
          // the writer still checks the child's actual clipped paint. Parents
          // with nested text remain separate to avoid overlapping rewrites.
          let nestedText = false
          for (const child of children)
            if (p.FPDFPageObj_GetType(child) === 5)
              nestedText = walk(child, outer, depth + 1) || nestedText
          const objects = children.map((child) => describe(child, text, input.doc, page))
          if (!objects.some((o) => o.type === 1 && o.text)) return nestedText
          if (nestedText) return true
          forms.push({
            key: JSON.stringify(objects),
            outer,
            page: index + 1,
            left,
            top,
            objects,
            rotated,
            annotations
          })
          return true
        }
        for (const object of e.objects(page)) walk(object.obj, [1, 0, 0, 1, 0, 0], 0)
      } finally {
        if (text) p.FPDFText_ClosePage(text)
        e.free(at)
        p.FPDF_ClosePage(page)
      }
    }
  } finally {
    input.close()
    fontIdentities.clear()
  }
  if (!forms.length || incompleteTree) return data
  const pdf = await PDFDocument.load(data, { updateMetadata: false }),
    temp = await PDFDocument.create(),
    copy = PDFObjectCopier.for(pdf.context, temp.context),
    records = []
  // Optional-content visibility is document-owned; copying its resource refs
  // through a temporary document would detach them from the catalog settings.
  if (pdf.catalog.has(PDFName.of('OCProperties'))) return data
  // Equal geometry alone cannot distinguish independent copies on different
  // pages. Scope that proof to each Form's reachable page resources; unused
  // duplicate resources or repeated instances on the same page remain ambiguous.
  const owners = new Map()
  for (const [index, page] of pdf.getPages().entries()) {
    const visited = new Set()
    const walk = (resources, depth) => {
      if (depth > 32) return
      const xobjects = resources?.lookup(PDFName.of('XObject'))
      if (!(xobjects instanceof PDFDict)) return
      for (const [, ref] of xobjects.entries()) {
        if (!(ref instanceof PDFRef) || visited.has(ref.toString())) continue
        visited.add(ref.toString())
        const raw = pdf.context.lookup(ref)
        if (
          !(raw instanceof PDFRawStream) ||
          raw.dict.get(PDFName.of('Subtype'))?.toString() !== '/Form'
        )
          continue
        const key = ref.toString(),
          pages = owners.get(key) ?? new Set()
        pages.add(index + 1)
        owners.set(key, pages)
        walk(raw.dict.lookup(PDFName.of('Resources')), depth + 1)
      }
    }
    walk(page.node.Resources(), 0)
  }
  for (const [ref, raw] of pdf.context.enumerateIndirectObjects()) {
    if (
      !(raw instanceof PDFRawStream) ||
      raw.dict.get(PDFName.of('Subtype'))?.toString() !== '/Form' ||
      raw.dict.has(PDFName.of('OC')) ||
      ![...(owners.get(ref.toString()) ?? [])].some((page) => candidatePages.has(page))
    )
      continue
    const matrix = raw.dict
      .lookup(PDFName.of('Matrix'))
      ?.asArray?.()
      .map((v) => v.asNumber?.()) ?? [1, 0, 0, 1, 0, 0]
    if (
      matrix.length !== 6 ||
      !matrix.every(Number.isFinite) ||
      matrix[0] <= 0 ||
      matrix[3] <= 0 ||
      matrix[1] !== 0 ||
      matrix[2] !== 0
    )
      continue
    const originalBox = raw.dict
      .lookup(PDFName.of('BBox'))
      ?.asArray?.()
      .map((v) => v.asNumber?.())
    if (!originalBox || originalBox.length !== 4 || !originalBox.every(Number.isFinite)) continue
    // A PDF rectangle can name either diagonal. Canonicalize the temporary
    // page only; preserve the publisher's original Form dictionary on output.
    const bbox = [
      Math.min(originalBox[0], originalBox[2]),
      Math.min(originalBox[1], originalBox[3]),
      Math.max(originalBox[0], originalBox[2]),
      Math.max(originalBox[1], originalBox[3])
    ]
    if (bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) continue
    const page = temp.addPage([bbox[2] - bbox[0], bbox[3] - bbox[1]])
    page.node.set(PDFName.of('MediaBox'), temp.context.obj(bbox))
    page.node.set(PDFName.of('Contents'), temp.context.register(copy.copy(raw)))
    const resources = raw.dict.lookup(PDFName.of('Resources'))
    if (resources) page.node.set(PDFName.of('Resources'), copy.copy(resources))
    records.push({ ref, raw, bbox, matrix })
  }
  if (!records.length) return data
  const native = e.open(await temp.save()),
    matches = []
  try {
    for (let index = 0; index < records.length; index++) {
      const page = p.FPDF_LoadPage(native.doc, index)
      if (!page) throw Error('Could not open PDF Form content')
      const text = p.FPDFText_LoadPage(page)
      try {
        const objects = e.objects(page).map((o) => describe(o.obj, text, native.doc, page)),
          [a, , , d, x, y] = records[index].matrix,
          // PDFium applies the Form's own Matrix to its children; its outer
          // object matrix contains only the invocation transform.
          key = JSON.stringify(
            objects.map((o) => ({
              ...o,
              bounds: o.bounds.map(
                (n, i) => Math.round((i % 2 ? d * n + y : a * n + x) * 1000) / 1000
              )
            }))
          ),
          found = forms.filter(
            (f) =>
              (f.key === key ||
                matchingOverprintFormObjects(f.objects, objects, records[index].bbox)) &&
              owners.get(records[index].ref.toString())?.has(f.page)
          )
        // A shared Form can be edited independently on different pages. Repeated
        // instances on one page still cannot be identified by geometry alone.
        for (const form of found)
          if (found.filter((other) => other.page === form.page).length === 1)
            matches.push({ ...records[index], found: form, objects, key })
      } finally {
        p.FPDFText_ClosePage(text)
        p.FPDF_ClosePage(page)
      }
    }
  } finally {
    native.close()
  }
  const selected = [],
    mapped = [],
    origins = new Map()
  for (const record of matches) {
    // An unused duplicate resource is also ambiguous: geometry cannot identify its reference.
    if (
      matches.filter(
        (m) =>
          m.found === record.found || (m.key === record.key && m.found.page === record.found.page)
      ).length !== 1
    )
      continue
    const form = record.found,
      [a, b, c, d, x, y] = multiply(form.outer, record.matrix)
    if (form.rotated) continue
    if (![a, b, c, d, x, y].every(Number.isFinite) || a <= 0 || d <= 0 || b !== 0 || c !== 0)
      continue
    const [left, bottom, right, top] = record.bbox,
      width = right - left,
      height = top - bottom,
      local = []
    for (const unit of candidates) {
      const fragment = unit.fragments[0]
      if (fragment.pageNumber !== form.page) continue
      const r = fragment.rect,
        size = pages[form.page - 1],
        world = [
          form.left + r.x * size.width,
          form.top - (r.y + r.height) * size.height,
          form.left + (r.x + r.width) * size.width,
          form.top - r.y * size.height
        ],
        box = [(world[0] - x) / a, (world[1] - y) / d, (world[2] - x) / a, (world[3] - y) / d]
      // Parent-page links cannot be reflowed inside a Form. Protect overlapping
      // labels, while unrelated citations elsewhere on the page remain untouched.
      if (
        form.annotations.some(
          (rect) =>
            rect[0] < world[2] && rect[2] > world[0] && rect[1] < world[3] && rect[3] > world[1]
        )
      )
        continue
      // Font/layout padding can extend beyond the Form even when every visible
      // glyph is inside it. Trim that padding, never the owned glyphs below.
      box[0] = Math.max(box[0], left)
      box[1] = Math.max(box[1], bottom)
      box[2] = Math.min(box[2], right)
      box[3] = Math.min(box[3], top)
      if (box[2] <= box[0] || box[3] <= box[1]) continue
      const hit = record.objects.filter(
        (o) =>
          o.type === 1 &&
          o.bounds[0] < box[2] &&
          o.bounds[2] > box[0] &&
          o.bounds[1] < box[3] &&
          o.bounds[3] > box[1]
      )
      if (!hit.length || normalize(hit.map((o) => o.text).join('')) !== normalize(unit.source))
        continue
      // A complete single native capital is a literal diagram tag (for example
      // the NER tag O), not prose. Never replace it with an expanded model label.
      if (/^[A-Z]$/u.test(unit.source) && hit.length === 1 && hit[0].text === unit.source) continue
      // An ellipsis spelling change is not a translation of a variable sequence.
      // Keep independently positioned subscripts in their original diagram cells.
      const identifierSequence =
        /^[A-Z](?:[A-Za-z]|\d+)?[’']?(?:\s*(?:\.\.\.|…)\s*[A-Z](?:[A-Za-z]|\d+)?[’']?)+$/u
      const nativeSubscript = hit.some((script, index) => {
        const base = hit[index - 1],
          lower = script.identity,
          upper = base?.identity,
          size = upper?.size * upper?.matrix[0],
          point = lower?.size * lower?.matrix[0]
        return (
          base &&
          /^[A-Z]$/u.test(base.text) &&
          /^[A-Za-z0-9]$/u.test(script.text) &&
          upper &&
          lower &&
          [upper, lower].every(
            (value) =>
              value.matrix[0] > 0 &&
              value.matrix[1] === 0 &&
              value.matrix[2] === 0 &&
              value.matrix[3] === value.matrix[0]
          ) &&
          point > 0 &&
          point < size * 0.85 &&
          upper.matrix[5] - lower.matrix[5] > size * 0.08 &&
          upper.matrix[5] - lower.matrix[5] < size * 0.5 &&
          lower.matrix[4] - base.bounds[2] >= -size * 0.1 &&
          lower.matrix[4] - base.bounds[2] < size * 0.35
        )
      })
      if (
        nativeSubscript &&
        identifierSequence.test(unit.source) &&
        normalize(unit.source.replace(/\.\.\./gu, '…')) ===
          normalize(unit.translation.replace(/\.\.\./gu, '…'))
      )
        continue
      if (
        hit.some(
          (o) =>
            o.bounds[0] < left ||
            o.bounds[2] > right ||
            o.bounds[1] < bottom ||
            o.bounds[3] > top ||
            o.bounds[0] < box[0] - 0.5 ||
            o.bounds[2] > box[2] + 0.5 ||
            o.bounds[1] < box[1] - 0.5 ||
            o.bounds[3] > box[3] + 0.5
        )
      )
        continue
      const localUnit = {
        source: unit.source,
        translation: unit.translation,
        fragments: [
          {
            pageNumber: selected.length + 1,
            rect: {
              x: (box[0] - left) / width,
              y: (top - box[3]) / height,
              width: (box[2] - box[0]) / width,
              height: (box[3] - box[1]) / height
            }
          }
        ]
      }
      local.push(localUnit)
      origins.set(localUnit, unit)
    }
    // Keep unchanged numeric neighbors in the local request: the writer uses
    // them to prove row alignment before reflowing a merged table label.
    if (local.some((u) => u.source !== u.translation)) {
      selected.push(record)
      mapped.push(...local)
    }
  }
  if (!selected.length) return data
  // Each selected instance needs its own temporary page: translations of a
  // shared running header can differ between pages.
  const layout = await PDFDocument.create(),
    layoutCopy = PDFObjectCopier.for(pdf.context, layout.context)
  for (const { raw, bbox } of selected) {
    const page = layout.addPage([bbox[2] - bbox[0], bbox[3] - bbox[1]])
    page.node.set(PDFName.of('MediaBox'), layout.context.obj(bbox))
    page.node.set(PDFName.of('Contents'), layout.context.register(layoutCopy.copy(raw)))
    const resources = raw.dict.lookup(PDFName.of('Resources'))
    if (resources) page.node.set(PDFName.of('Resources'), layoutCopy.copy(resources))
  }
  let output
  try {
    output = await generate({
      data: await layout.save(),
      units: mapped,
      preserveUnsupported: true,
      pages: selected.map(({ bbox }) => ({ width: bbox[2] - bbox[0], height: bbox[3] - bbox[1] }))
    })
  } catch (error) {
    if (
      ['annotations', 'overflow', 'unsupported-layout', 'source-mismatch', 'multi-region'].includes(
        error.failure?.code
      )
    )
      return data
    throw error
  }
  const rewritten = await PDFDocument.load(output, { updateMetadata: false }),
    back = PDFObjectCopier.for(rewritten.context, pdf.context)
  for (const [index, record] of selected.entries()) {
    const page = rewritten.getPages()[index],
      contents = page.node.Contents(),
      streams =
        contents instanceof PDFRawStream
          ? [contents]
          : contents.asArray().map((ref) => rewritten.context.lookup(ref)),
      bytes = Buffer.concat(
        streams.flatMap((stream) => [decodePDFRawStream(stream).decode(), Buffer.from('\n')])
      ),
      replacement = pdf.context.flateStream(bytes)
    for (const [name, value] of record.raw.dict.entries())
      if (!['/Length', '/Filter', '/DecodeParms', '/Resources'].includes(name.toString()))
        replacement.dict.set(name, value)
    replacement.dict.set(PDFName.of('Resources'), back.copy(page.node.Resources()))
    // Copy only ancestors of the edited leaf. Neither shared Form streams nor
    // inherited page resources may be changed in place.
    const replacementRef = pdf.context.register(replacement),
      copied = new Map(),
      replace = (resources, depth = 0) => {
        if (depth > 32) return
        const xobjects = resources?.lookup(PDFName.of('XObject'))
        if (!(xobjects instanceof PDFDict)) return
        const next = xobjects.clone(pdf.context)
        let changed = false
        for (const [name, ref] of xobjects.entries()) {
          if (!(ref instanceof PDFRef)) continue
          if (ref.toString() === record.ref.toString()) {
            next.set(name, replacementRef)
            changed = true
            continue
          }
          const key = ref.toString()
          if (!copied.has(key)) {
            copied.set(key, undefined)
            const raw = pdf.context.lookup(ref)
            if (
              raw instanceof PDFRawStream &&
              raw.dict.get(PDFName.of('Subtype'))?.toString() === '/Form'
            ) {
              const children = replace(raw.dict.lookup(PDFName.of('Resources')), depth + 1)
              if (children) {
                const parent = raw.clone(pdf.context)
                parent.dict.set(PDFName.of('Resources'), children)
                copied.set(key, pdf.context.register(parent))
              }
            }
          }
          if (copied.get(key)) {
            next.set(name, copied.get(key))
            changed = true
          }
        }
        if (!changed) return
        const result = resources.clone(pdf.context)
        result.set(PDFName.of('XObject'), next)
        return result
      },
      owner = pdf.getPages()[record.found.page - 1],
      resources = replace(owner.node.Resources())
    if (!resources) return data
    owner.node.set(PDFName.of('Resources'), resources)
  }
  const saved = await pdf.save()
  for (const unit of mapped)
    if (unit.source !== unit.translation) onSavedUnit?.(origins.get(unit), unit)
  return saved
}
