import type { PDFPageProxy } from 'pdfjs-dist'
import type { TextItem, TextStyle } from 'pdfjs-dist/types/src/display/api.js'

type Rect = Readonly<{ x: number; y: number; width: number; height: number }>
type Metrics = Readonly<{
  ascent: number
  descent: number
  box: readonly number[]
}>
type Viewport = ReturnType<PDFPageProxy['getViewport']>

// Read only ordinary embedded TrueType metrics. Table and glyph-header walks
// have fixed budgets; this is not a general font loader or an ink certificate.
function readProgramMetrics(bytes: Uint8Array): Metrics | undefined {
  if (bytes.length < 64 || bytes.length > 1024 * 1024) return
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = data.getUint16(4)
  if (data.getUint32(0) !== 0x00010000 || count < 7 || count > 64) return
  const directoryEnd = 12 + count * 16
  if (directoryEnd > bytes.length) return
  const tables = new Map<string, { offset: number; length: number }>()
  for (let i = 0; i < count; i++) {
    const record = 12 + i * 16,
      name = String.fromCharCode(...bytes.subarray(record, record + 4)),
      offset = data.getUint32(record + 8),
      length = data.getUint32(record + 12)
    if (
      tables.has(name) ||
      offset % 4 !== 0 ||
      offset < directoryEnd ||
      length === 0 ||
      offset + length > bytes.length
    )
      return
    tables.set(name, { offset, length })
  }
  const ordered = [...tables.values()].sort((a, b) => a.offset - b.offset)
  if (
    ordered.some(
      (table, i) => i > 0 && table.offset < ordered[i - 1].offset + ordered[i - 1].length
    )
  )
    return
  const head = tables.get('head'),
    hhea = tables.get('hhea'),
    maxp = tables.get('maxp'),
    loca = tables.get('loca'),
    glyf = tables.get('glyf'),
    hmtx = tables.get('hmtx'),
    cmap = tables.get('cmap')
  if (
    !head ||
    head.length !== 54 ||
    !hhea ||
    hhea.length !== 36 ||
    !maxp ||
    maxp.length < 32 ||
    !loca ||
    !glyf ||
    !hmtx ||
    !cmap ||
    cmap.length < 4 ||
    data.getUint32(head.offset) !== 0x00010000 ||
    data.getUint32(head.offset + 12) !== 0x5f0f3cf5 ||
    data.getUint32(hhea.offset) !== 0x00010000 ||
    data.getUint32(maxp.offset) !== 0x00010000
  )
    return
  const units = data.getUint16(head.offset + 18),
    glyphs = data.getUint16(maxp.offset + 4),
    format = data.getInt16(head.offset + 50),
    horizontal = data.getUint16(hhea.offset + 34),
    box = [36, 38, 40, 42].map((offset) => data.getInt16(head.offset + offset))
  if (
    units < 16 ||
    units > 16384 ||
    glyphs < 1 ||
    glyphs > 4096 ||
    (format !== 0 && format !== 1) ||
    horizontal < 1 ||
    horizontal > glyphs ||
    hmtx.length < horizontal * 4 + (glyphs - horizontal) * 2 ||
    loca.length < (glyphs + 1) * (format === 0 ? 2 : 4) ||
    box[0] >= box[2] ||
    box[1] >= box[3]
  )
    return
  const location = (index: number): number =>
    format === 0
      ? data.getUint16(loca.offset + index * 2) * 2
      : data.getUint32(loca.offset + index * 4)
  if (location(0) !== 0) return
  for (let i = 0; i < glyphs; i++) {
    const start = location(i),
      end = location(i + 1)
    if (start > end || end > glyf.length || (start !== end && end - start < 10)) return
    if (start === end) continue
    const glyphBox = [2, 4, 6, 8].map((offset) => data.getInt16(glyf.offset + start + offset))
    if (
      glyphBox[0] > glyphBox[2] ||
      glyphBox[1] > glyphBox[3] ||
      glyphBox[0] < box[0] ||
      glyphBox[1] < box[1] ||
      glyphBox[2] > box[2] ||
      glyphBox[3] > box[3]
    )
      return
  }
  return {
    ascent: data.getInt16(hhea.offset + 4) / units,
    descent: data.getInt16(hhea.offset + 6) / units,
    box: box.map((n) => n / units)
  }
}

function programMetrics(bytes: Uint8Array): Metrics | undefined {
  try {
    return readProgramMetrics(bytes)
  } catch {
    // Detached buffers or incomplete native tables retain the original exclusion.
    return undefined
  }
}

function nativeMetrics(font: unknown, style: TextStyle, loadedName: string): Metrics | undefined {
  if (!font || typeof font !== 'object') return
  const f = font as Record<string, unknown>
  if (
    f.type !== 'CIDFontType2' ||
    f.vertical !== false ||
    f.missingFile !== false ||
    f.isInvalidPDFjsFont !== false ||
    f.isType3Font !== false ||
    f.remeasure ||
    f.loadedName !== loadedName ||
    !(f.data instanceof Uint8Array) ||
    JSON.stringify(f.fontMatrix) !== '[0.001,0,0,0.001,0,0]' ||
    !Array.isArray(f.bbox) ||
    f.bbox.length !== 4 ||
    !f.bbox.every(Number.isFinite) ||
    f.ascent !== style.ascent ||
    f.descent !== style.descent
  )
    return
  // This fixed PDF.js getter returns undefined when native remeasurement is not
  // enabled; CanvasGraphics uses the same truthy condition. Keep the raw value.
  const program = programMetrics(f.data),
    box = f.bbox.map((n: number) => n * 0.001)
  if (
    !program ||
    program.ascent !== style.ascent ||
    program.descent !== style.descent ||
    box[0] >= box[2] ||
    box[1] >= box[3]
  )
    return
  return {
    ascent: Math.max(program.ascent, program.box[3], box[3]),
    descent: Math.min(program.descent, program.box[1], box[1]),
    box: [Math.min(0, program.box[0], box[0]), 0, Math.max(0, program.box[2], box[2]), 0]
  }
}

function navigationRect(item: TextItem, viewport: Viewport, metrics: Metrics): Rect | undefined {
  if (
    item.dir !== 'ltr' ||
    item.transform.length !== 6 ||
    viewport.transform.length !== 6 ||
    ![
      ...item.transform,
      ...viewport.transform,
      item.width,
      item.height,
      viewport.width,
      viewport.height
    ].every(Number.isFinite) ||
    item.width <= 0 ||
    item.height <= 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0
  )
    return
  const [a, b, c, d, x, y] = item.transform,
    advance = Math.hypot(a, b),
    font = Math.hypot(c, d),
    angle = Math.atan2(b, a) / (Math.PI / 2)
  if (
    advance <= 0 ||
    font <= 0 ||
    a * d - b * c <= 0 ||
    Math.abs((a * c + b * d) / (advance * font)) > 0.0001 ||
    Math.abs(item.height - font) > 1e-9 ||
    Math.abs(angle - Math.round(angle)) < 0.0001 ||
    metrics.ascent - metrics.descent <= 0 ||
    // A conservative navigation resource bound, not a limit on valid font metrics.
    metrics.ascent - metrics.descent > 4
  )
    return
  const points = [metrics.box[0] * font, item.width + metrics.box[2] * font].flatMap((u) =>
    [metrics.descent * font, metrics.ascent * font].map((v) => {
      const px = x + (a / advance) * u + (c / font) * v,
        py = y + (b / advance) * u + (d / font) * v,
        [ma, mb, mc, md, mx, my] = viewport.transform
      return [ma * px + mc * py + mx, mb * px + md * py + my]
    })
  )
  const xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1]),
    rect = {
      x: Math.min(...xs) / viewport.width,
      y: Math.min(...ys) / viewport.height,
      width: (Math.max(...xs) - Math.min(...xs)) / viewport.width,
      height: (Math.max(...ys) - Math.min(...ys)) / viewport.height
    }
  return Object.values(rect).every(Number.isFinite) &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.x + rect.width <= 1 &&
    rect.y + rect.height <= 1
    ? rect
    : undefined
}

/** Separate original-only navigation bounds; never merge into prose or create a paint region. */
export function readOutlierFontNavigation(
  page: PDFPageProxy,
  content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>,
  viewport: Viewport
): ReadonlyMap<number, Rect> {
  const result = new Map<number, Rect>(),
    candidates = content.items.flatMap((item, index) =>
      'str' in item && item.str.trim() && (content.styles?.[item.fontName]?.ascent ?? 0) > 1
        ? [{ item, index }]
        : []
    )
  if (
    !candidates.length ||
    candidates.length > 256 ||
    typeof page.commonObjs?.has !== 'function' ||
    typeof page.commonObjs?.get !== 'function'
  )
    return result
  const names = new Set(candidates.map(({ item }) => item.fontName))
  if (names.size > 4) return result
  for (const { item, index } of candidates) {
    const style = content.styles[item.fontName]
    if (
      style.vertical !== false ||
      !Number.isFinite(style.ascent) ||
      !Number.isFinite(style.descent) ||
      style.descent > 0 ||
      style.ascent <= style.descent ||
      !page.commonObjs.has(item.fontName)
    )
      continue
    let metrics: Metrics | undefined
    try {
      metrics = nativeMetrics(page.commonObjs.get(item.fontName), style, item.fontName)
    } catch {
      continue
    }
    if (!metrics) continue
    const rect = navigationRect(item, viewport, metrics)
    if (rect) result.set(index, rect)
  }
  return result
}
