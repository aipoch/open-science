import type { PDFPageProxy } from 'pdfjs-dist'
import type { TextItem, TextStyle } from 'pdfjs-dist/types/src/display/api.js'
import { nativeOutlineBox } from './native-source-geometry.js'

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

type Type3Navigation = Readonly<{ regions: ReadonlyMap<number, Rect>; current: () => boolean }>
type NativeData = {
  object: object
  prototype: object | null
  keys: PropertyKey[]
  values: unknown[]
}
// Retain native snapshots by both identity and value across the operator await.
function retainNavigationData(input: unknown[]): (() => boolean) | undefined {
  const objects: NativeData[] = [],
    bytes: { view: ArrayBufferView; copy: Uint8Array; buffer: ArrayBuffer }[] = [],
    seen = new Set<object>()
  let budget = 200000,
    byteBudget = 32 * 1024 * 1024
  const visit = (value: unknown): boolean => {
    if (--budget < 0 || typeof value === 'function' || typeof value === 'symbol') return false
    if (!value || typeof value !== 'object' || seen.has(value)) return true
    seen.add(value)
    if (ArrayBuffer.isView(value)) {
      if (!(value.buffer instanceof ArrayBuffer) || (byteBudget -= value.byteLength) < 0)
        return false
      bytes.push({
        view: value,
        copy: new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice(),
        buffer: value.buffer
      })
      return true
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== null && prototype !== Object.prototype && prototype !== Array.prototype)
      return false
    const descriptors = Object.getOwnPropertyDescriptors(value),
      keys = Reflect.ownKeys(descriptors)
    if (keys.some((key) => typeof key !== 'string' || !('value' in descriptors[key]))) return false
    const values = keys.map((key) => descriptors[key as string].value)
    objects.push({ object: value, prototype, keys, values })
    return values.every(visit)
  }
  try {
    if (!input.every(visit)) return
    return () => {
      try {
        return (
          objects.every((record) => {
            if (Object.getPrototypeOf(record.object) !== record.prototype) return false
            const descriptors = Object.getOwnPropertyDescriptors(record.object),
              keys = Reflect.ownKeys(descriptors)
            return (
              keys.length === record.keys.length &&
              keys.every(
                (key, index) =>
                  key === record.keys[index] &&
                  'value' in descriptors[key as string] &&
                  Object.is(descriptors[key as string].value, record.values[index])
              )
            )
          }) &&
          bytes.every(
            (record) =>
              record.view.buffer === record.buffer &&
              record.view.byteLength === record.copy.length &&
              new Uint8Array(
                record.view.buffer,
                record.view.byteOffset,
                record.view.byteLength
              ).every((value, index) => value === record.copy[index])
          )
        )
      } catch {
        return false
      }
    }
  } catch {
    return
  }
}

/** Actual horizontal Type3 glyph programs may certify original-only oblique
 * navigation even when PDF.js omits the font's vertical flag. No font/style or
 * native item is repaired, and this certificate supplies no repaint authority. */
export async function readNativeType3Navigation(
  page: PDFPageProxy,
  content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>,
  viewport: Viewport,
  options: { signal: AbortSignal; current: () => boolean }
): Promise<Type3Navigation | undefined> {
  const { signal, current } = options
  const viewportData = (): unknown[] => [
    viewport.width,
    viewport.height,
    viewport.rotation,
    viewport.scale,
    viewport.transform
  ]
  const originalViewport = viewportData(),
    sourceCurrent = retainNavigationData([content, ...originalViewport])
  if (!sourceCurrent) return
  try {
    signal.throwIfAborted()
    if (
      !current() ||
      !content.items.some(
        (item) =>
          'str' in item &&
          item.str.trim() &&
          item.width > 0 &&
          Math.abs(
            Math.atan2(item.transform[1], item.transform[0]) / (Math.PI / 2) -
              Math.round(Math.atan2(item.transform[1], item.transform[0]) / (Math.PI / 2))
          ) > 0.0001 &&
          content.styles[item.fontName]?.vertical === undefined
      )
    )
      return
    const [{ OPS, Util }, operators] = await Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      page.getOperatorList()
    ])
    signal.throwIfAborted()
    if (
      !current() ||
      !sourceCurrent() ||
      !viewportData().every((value, index) => Object.is(value, originalViewport[index]))
    )
      return
    const operatorCurrent = retainNavigationData([operators])
    if (
      !operatorCurrent ||
      operators.fnArray.length !== operators.argsArray.length ||
      operators.fnArray.length > 100000
    )
      return
    type Box = number[]
    const finite = (value: unknown, length: number): value is number[] =>
      (Array.isArray(value) || ArrayBuffer.isView(value)) &&
      'length' in value &&
      value.length === length &&
      Array.from(value as number[]).every(Number.isFinite)
    const valid = (box: Box): boolean => finite(box, 4) && box[0] < box[2] && box[1] < box[3]
    const inside = (inner: Box, outer: Box): boolean =>
      inner.every((value, index) =>
        index < 2 ? value >= outer[index] - 1e-6 : value <= outer[index] + 1e-6
      )
    const transform = (box: Box, matrix: number[]): Box => {
      const points = [box[0], box[2]].flatMap((x) =>
        [box[1], box[3]].map((y) => [
          matrix[0] * x + matrix[2] * y + matrix[4],
          matrix[1] * x + matrix[3] * y + matrix[5]
        ])
      )
      return [
        Math.min(...points.map((p) => p[0])),
        Math.min(...points.map((p) => p[1])),
        Math.max(...points.map((p) => p[0])),
        Math.max(...points.map((p) => p[1]))
      ]
    }
    const union = (boxes: Box[]): Box => [
      Math.min(...boxes.map((b) => b[0])),
      Math.min(...boxes.map((b) => b[1])),
      Math.max(...boxes.map((b) => b[2])),
      Math.max(...boxes.map((b) => b[3]))
    ]
    const fontKeys = [
      'isType3Font',
      'vertical',
      'missingFile',
      'isInvalidPDFjsFont',
      'remeasure',
      'loadedName',
      'fontMatrix',
      'ascent',
      'descent',
      'charProcOperatorList'
    ]
    type Field = { owner: object | null; descriptor: PropertyDescriptor | undefined }
    const field = (object: object, key: string): Field => {
      let owner: object | null = object
      while (owner && !Object.prototype.hasOwnProperty.call(owner, key))
        owner = Object.getPrototypeOf(owner)
      return { owner, descriptor: owner ? Object.getOwnPropertyDescriptor(owner, key) : undefined }
    }
    const fieldSame = (a: Field, b: Field): boolean =>
      a.owner === b.owner &&
      !!a.descriptor === !!b.descriptor &&
      (!a.descriptor ||
        (!!b.descriptor &&
          ['configurable', 'enumerable', 'writable', 'get', 'set', 'value'].every((key) =>
            Object.is(
              a.descriptor![key as keyof PropertyDescriptor],
              b.descriptor![key as keyof PropertyDescriptor]
            )
          )))
    const fonts = new Map<
      string,
      { object: Record<string, unknown>; values: unknown[]; seal: () => boolean; fields: Field[] }
    >()
    const programs: {
      table: Record<string, unknown>
      name: string
      object: unknown
      field: Field
      seal: () => boolean
    }[] = []
    const font = (name: string): Record<string, unknown> | undefined => {
      if (fonts.has(name)) return fonts.get(name)!.object
      if (!page.commonObjs.has(name)) return
      const object = page.commonObjs.get(name) as Record<string, unknown>,
        values = fontKeys.map((key) => object[key]),
        seal = retainNavigationData(
          values.filter((_, index) => fontKeys[index] !== 'charProcOperatorList')
        )
      if (!seal) return
      fonts.set(name, { object, values, seal, fields: fontKeys.map((key) => field(object, key)) })
      return object
    }
    type State = {
      ctm: number[]
      tm: number[]
      line: number[]
      font: string
      size: number
      mode: number
      char: number
      word: number
      scale: number
      rise: number
      fill: string
      alpha: number
      clip: Box
      safe: boolean
    }
    const identity = (): number[] => [1, 0, 0, 1, 0, 0]
    let state: State = {
        ctm: identity(),
        tm: identity(),
        line: identity(),
        font: '',
        size: 0,
        mode: 0,
        char: 0,
        word: 0,
        scale: 100,
        rise: 0,
        fill: '#000000',
        alpha: 1,
        clip: [-1e9, -1e9, 1e9, 1e9],
        safe: true
      },
      path: Box | undefined
    const stack: State[] = [],
      glyphs: {
        text: string
        font: string
        glyph: Record<string, unknown>
        matrix: number[]
        end: number[]
        showText: number
        kerningBefore: number[]
        state: State
      }[] = []
    const snapshot = (): State => ({
      ...state,
      ctm: [...state.ctm],
      tm: [...state.tm],
      line: [...state.line],
      clip: [...state.clip]
    })
    const clip = (box: Box): void => {
      state.clip = [
        Math.max(state.clip[0], box[0]),
        Math.max(state.clip[1], box[1]),
        Math.min(state.clip[2], box[2]),
        Math.min(state.clip[3], box[3])
      ]
    }
    for (let i = 0; i < operators.fnArray.length; i++) {
      const op = operators.fnArray[i],
        a = operators.argsArray[i]
      if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
        stack.push(snapshot())
        if (op === OPS.paintFormXObjectBegin) {
          if (a[0] !== null) {
            if (!finite(a[0], 6)) return
            state.ctm = Util.transform(state.ctm, a[0])
          }
          if (!finite(a[1], 4) || state.ctm[1] !== 0 || state.ctm[2] !== 0) return
          clip(transform(a[1], state.ctm))
        }
      } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
        if (!stack.length) return
        state = stack.pop()!
      } else if (op === OPS.transform) {
        if (!finite(a, 6)) return
        state.ctm = Util.transform(state.ctm, a)
      } else if (op === OPS.beginText) {
        state.tm = identity()
        state.line = identity()
      } else if (op === OPS.setFont) {
        state.font = a[0]
        state.size = a[1]
      } else if (op === OPS.setTextMatrix) {
        const matrix = finite(a, 6) ? a : a?.[0]
        if (!finite(matrix, 6)) return
        state.tm = [...matrix]
        state.line = [...matrix]
      } else if (op === OPS.moveText) {
        if (!finite(a, 2)) return
        state.line = Util.transform(state.line, [1, 0, 0, 1, a[0], a[1]])
        state.tm = [...state.line]
      } else if (op === OPS.setTextRenderingMode) state.mode = a[0]
      else if (op === OPS.setCharSpacing) state.char = a[0]
      else if (op === OPS.setWordSpacing) state.word = a[0]
      else if (op === OPS.setHScale) state.scale = a[0]
      else if (op === OPS.setTextRise) state.rise = a[0]
      else if (op === OPS.setFillRGBColor) {
        if (typeof a[0] !== 'string' || !/^#[0-9a-f]{6}$/iu.test(a[0])) state.safe = false
        else state.fill = a[0]
      } else if (op === OPS.setGState) {
        if (!Array.isArray(a?.[0])) return
        for (const [key, value] of a[0]) {
          if (key === 'ca') state.alpha = value
          else if ((key === 'BM' && value !== 'Normal') || (key === 'SMask' && value !== false))
            state.safe = false
          else if (key === 'Font') {
            state.font = value[0]
            state.size = value[1]
          } else if (!['CA', 'LW', 'LC', 'LJ', 'ML', 'D', 'RI', 'FL', 'BM', 'SMask'].includes(key))
            state.safe = false
        }
      } else if (op === OPS.constructPath) {
        path = undefined
        const points = a?.[1]?.[0]
        if (
          points &&
          points.length === 13 &&
          [0, 3, 6, 9, 12].every((at, n) => points[at] === [0, 1, 1, 1, 4][n]) &&
          state.ctm[1] === 0 &&
          state.ctm[2] === 0
        ) {
          const xs = [points[1], points[4], points[7], points[10]],
            ys = [points[2], points[5], points[8], points[11]]
          if (
            xs.every(Number.isFinite) &&
            ys.every(Number.isFinite) &&
            new Set(xs).size === 2 &&
            new Set(ys).size === 2
          )
            path = transform(
              [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
              state.ctm
            )
        }
      } else if (op === OPS.clip || op === OPS.eoClip) {
        if (!path) state.safe = false
        else clip(path)
      } else if (op === OPS.showText) {
        if (!Array.isArray(a?.[0])) return
        let kerning = [0, 0]
        for (const value of a[0]) {
          if (typeof value === 'number') {
            if (!Number.isFinite(value)) return
            const before = Util.transform(state.ctm, state.tm).slice(4, 6)
            state.tm = Util.transform(state.tm, [
              1,
              0,
              0,
              1,
              (-value * state.size * state.scale) / 100000,
              0
            ])
            const after = Util.transform(state.ctm, state.tm).slice(4, 6)
            if (![...before, ...after].every(Number.isFinite)) return
            kerning = kerning.map((value, at) => value + after[at] - before[at])
            continue
          }
          if (
            !value ||
            typeof value !== 'object' ||
            typeof value.unicode !== 'string' ||
            !Number.isFinite(value.width)
          )
            return
          const matrix = Util.transform(
              state.ctm,
              Util.transform(state.tm, [
                (state.size * state.scale) / 100,
                0,
                0,
                state.size,
                0,
                state.rise
              ])
            ),
            saved = snapshot(),
            advance =
              (((value.width * state.size) / 1000 + state.char + (value.isSpace ? state.word : 0)) *
                state.scale) /
              100
          state.tm = Util.transform(state.tm, [1, 0, 0, 1, advance, 0])
          glyphs.push({
            text: value.unicode,
            font: state.font,
            glyph: value,
            matrix,
            end: Util.transform(state.ctm, state.tm).slice(4, 6),
            showText: i,
            kerningBefore: kerning,
            state: saved
          })
          kerning = [0, 0]
        }
      } else if (
        ![
          OPS.endText,
          OPS.dependency,
          OPS.setStrokeRGBColor,
          OPS.setLineJoin,
          OPS.setLineCap,
          OPS.setLineWidth,
          OPS.setDash
        ].includes(op)
      )
        state.safe = false
    }
    if (stack.length) return
    const visible = glyphs.flatMap((g) =>
        Array.from(g.text.normalize('NFD'))
          .filter((c) => !/\s/u.test(c))
          .map((c) => ({ c, g }))
      ),
      regions = new Map<number, Rect>()
    let offset = 0
    for (const [index, item] of content.items.entries()) {
      if (!('str' in item)) continue
      const chars = Array.from(item.str.normalize('NFD')).filter((c) => !/\s/u.test(c))
      if (!chars.length) continue
      const firstOffset = offset,
        part = visible.slice(offset, offset + chars.length)
      offset += chars.length
      if (
        (firstOffset > 0 && visible[firstOffset - 1].g === part[0]?.g) ||
        (offset < visible.length && visible[offset].g === part.at(-1)?.g)
      )
        return
      if (
        part.map((x) => x.c).join('') !== chars.join('') ||
        part.some((x) => x.g.font !== item.fontName)
      )
        return
      const angle = Math.atan2(item.transform[1], item.transform[0]) / (Math.PI / 2),
        style = content.styles[item.fontName]
      if (Math.abs(angle - Math.round(angle)) < 0.0001 || style?.vertical !== undefined) continue
      const f = font(item.fontName),
        owned = [...new Set(part.map((x) => x.g))]
      if (
        !f ||
        f.isType3Font !== true ||
        (f.vertical !== undefined && f.vertical !== false) ||
        f.missingFile !== false ||
        f.isInvalidPDFjsFont !== false ||
        f.remeasure ||
        f.loadedName !== item.fontName ||
        JSON.stringify(f.fontMatrix) !== '[0.001,0,0,0.001,0,0]' ||
        f.ascent !== style.ascent ||
        f.descent !== style.descent ||
        !Number.isFinite(style.ascent) ||
        !Number.isFinite(style.descent) ||
        style.ascent <= style.descent ||
        !finite(item.transform, 6) ||
        item.width <= 0 ||
        item.height <= 0 ||
        item.dir !== 'ltr' ||
        !owned.length
      )
        continue
      const start = owned[0].matrix,
        baseline = Math.hypot(start[0], start[1]),
        height = Math.hypot(start[2], start[3]),
        last = owned.at(-1)!.end
      if (
        !baseline ||
        !height ||
        Math.abs(start[0] * start[2] + start[1] * start[3]) > baseline * height * 0.0001 ||
        start[0] * start[3] - start[1] * start[2] <= 0 ||
        start.some((v, n) => Math.abs(v - item.transform[n]) > 1e-6) ||
        Math.abs(item.height - height) > 1e-6 ||
        Math.abs(
          ((last[0] - start[4]) * start[0] + (last[1] - start[5]) * start[1]) / baseline -
            item.width
        ) > 1e-6
      )
        continue
      if (
        owned.some(
          (g, at) =>
            g.matrix.slice(0, 4).some((value, n) => Math.abs(value - start[n]) > 1e-6) ||
            (at > 0 &&
              g.matrix.slice(4, 6).some(
                (value, n) =>
                  Math.abs(
                    value -
                      owned[at - 1].end[n] -
                      // Only numeric TJ entries in this same native show-text operand
                      // explain a gap. Matrix/move-text changes retain the old refusal.
                      (g.showText === owned[at - 1].showText ? g.kerningBefore[n] : 0)
                  ) > 1e-6
              ))
        )
      )
        continue
      const inks: Box[] = []
      for (const g of owned) {
        const program = (
          f.charProcOperatorList as
            Record<string, { fnArray: number[]; argsArray: unknown[][] }> | undefined
        )?.[g.glyph.operatorListId as string]
        if (program && !programs.some((p) => p.object === program)) {
          const table = f.charProcOperatorList as Record<string, unknown>,
            name = g.glyph.operatorListId as string,
            seal = retainNavigationData([program])
          if (!seal) break
          programs.push({ table, name, object: program, field: field(table, name), seal })
        }
        if (
          !g.state.safe ||
          g.state.mode !== 0 ||
          g.state.alpha !== 1 ||
          g.state.fill.toLowerCase() === '#ffffff' ||
          g.state.char !== 0 ||
          g.state.word !== 0 ||
          g.state.scale !== 100 ||
          g.state.rise !== 0 ||
          g.glyph.isInFont !== true ||
          !Number.isFinite(g.glyph.width) ||
          !(Number(g.glyph.width) > 0) ||
          g.glyph.accent ||
          !program ||
          program.fnArray.length !== 2 ||
          program.argsArray.length !== 2 ||
          program.fnArray[0] !== OPS.setCharWidthAndBounds ||
          program.fnArray[1] !== OPS.constructPath ||
          !finite(program.argsArray[0], 6) ||
          program.argsArray[0][0] !== g.glyph.width ||
          program.argsArray[0][1] !== 0 ||
          ![OPS.fill, OPS.eoFill].includes(program.argsArray[1][0] as number)
        )
          break
        const paths = program.argsArray[1][1] as ArrayLike<number>[],
          bounds = nativeOutlineBox(paths?.[0]),
          declaration = program.argsArray[0].slice(2) as number[]
        if (
          !paths ||
          paths.length !== 1 ||
          !bounds ||
          !valid(declaration) ||
          !inside(bounds, declaration)
        )
          break
        const ink = transform(bounds, Util.transform(g.matrix, [0.001, 0, 0, 0.001, 0, 0]))
        if (!valid(ink) || !inside(ink, g.state.clip)) break
        inks.push(ink)
      }
      if (inks.length !== owned.length) continue
      const box = transform(union(inks), viewport.transform),
        rect = {
          x: box[0] / viewport.width,
          y: box[1] / viewport.height,
          width: (box[2] - box[0]) / viewport.width,
          height: (box[3] - box[1]) / viewport.height
        }
      if (
        Object.values(rect).every(Number.isFinite) &&
        rect.x >= 0 &&
        rect.y >= 0 &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.x + rect.width <= 1 &&
        rect.y + rect.height <= 1
      )
        regions.set(index, rect)
    }
    if (offset !== visible.length || !regions.size) return
    const outputCurrent = retainNavigationData(
        [...regions].flatMap(([index, rect]) => [index, rect])
      ),
      entries = [...regions]
    const validNow = (): boolean =>
      !signal.aborted &&
      current() &&
      sourceCurrent() &&
      operatorCurrent() &&
      viewportData().every((value, index) => Object.is(value, originalViewport[index])) &&
      [...fonts].every(
        ([name, f]) =>
          page.commonObjs.get(name) === f.object &&
          f.seal() &&
          fontKeys.every(
            (key, index) =>
              fieldSame(field(f.object, key), f.fields[index]) &&
              (key === 'fontMatrix'
                ? finite(f.object[key], 6) &&
                  finite(f.values[index], 6) &&
                  Array.from(f.object[key] as number[]).every((value, at) =>
                    Object.is(value, (f.values[index] as number[])[at])
                  )
                : Object.is(f.object[key], f.values[index]))
          )
      ) &&
      programs.every(
        (p) =>
          p.table[p.name] === p.object && fieldSame(field(p.table, p.name), p.field) && p.seal()
      ) &&
      !!outputCurrent?.() &&
      regions.size === entries.length &&
      entries.every(([index, rect]) => regions.get(index) === rect)
    if (!validNow()) return
    return { regions, current: validNow }
  } catch {
    signal.throwIfAborted()
    return
  }
}
