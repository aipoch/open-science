import { getPdfTranslationTextContent } from './pdf-translation-text-content'
import type { PDFPageProxy } from 'pdfjs-dist'
import { pdfjsLib } from '../pdfjs'
import { isCurrentTranslation, type PdfTranslationUnit } from './pdf-translation'

export type PdfInlineRect = { x: number; y: number; width: number; height: number }
export type PdfInlineLayout = {
  id: string
  text: string
  rect: PdfInlineRect
  size: number
  lines: { text: string; x: number; y: number }[]
}
type Call = {
  text: string
  font: string
  fill: string | undefined
  x: number
  y: number
  transform: number[]
  epoch: number
  width: number
  emptyInk: boolean
}
const ink = (s: string): string => s.normalize('NFKC').replace(/\s/gu, '')
const overlaps = (a: PdfInlineRect, b: PdfInlineRect): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

export function isMappedPdfSpace(
  font: string,
  sourceFont: string,
  unicode: ReadonlySet<string> | undefined,
  emptyInk: boolean
): boolean {
  return (
    emptyInk &&
    font.split(/[\s,"']+/).includes(sourceFont) &&
    unicode?.size === 1 &&
    ink([...unicode][0]) === ''
  )
}

// Keep complete scientific tokens intact. Unsupported scripts stay in the linked paragraph view.
export function pdfTranslationBreaks(text: string): number[] {
  const ends = new Set(
    [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(
      (s) => s.index + s.segment.length
    )
  )
  for (const match of text.matchAll(
    /\bp\s*[=<>≤≥]\s*\d+(?:\.\d+)?|[\p{Script=Latin}\p{Script=Greek}\p{M}\d]+(?:[-‐‑/.±–−][\p{Script=Latin}\p{Script=Greek}\p{M}\d]+)*(?:\s*(?:%|mg\/mL|mmol\/L|mmHg|mg|kg|mL|μg|ng|cm|mm)(?![A-Za-z]))?/gu
  ))
    for (const end of ends)
      if (end > match.index && end < match.index + match[0].length) ends.delete(end)
  for (const end of ends)
    if (
      /[（(［[｛{《「『【“‘]$/u.test(text.slice(0, end).trimEnd()) ||
      /^[，。！？；：、,.;:!?）)］\]｝}》」』】”’％%]/u.test(text.slice(end).trimStart()) ||
      /^\s/u.test(text.slice(end))
    )
      ends.delete(end)
  ends.add(text.length)
  return [...ends].sort((a, b) => a - b)
}
export function fitPdfTranslation(
  ctx: CanvasRenderingContext2D,
  id: string,
  text: string,
  rect: PdfInlineRect
): PdfInlineLayout | undefined {
  if (
    !text.trim() ||
    text.length > 8000 ||
    /[\n\r\p{Script=Arabic}\p{Script=Hebrew}]/u.test(text) ||
    !Object.values(rect).every(Number.isFinite) ||
    rect.width <= 2 ||
    rect.height <= 2
  )
    return
  const ends = pdfTranslationBreaks(text)
  for (let size = 12; size >= 9; size -= 0.5) {
    ctx.font = `${size}px sans-serif`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    const lines: PdfInlineLayout['lines'] = []
    let start = 0,
      y = rect.y + 1
    while (start < text.length) {
      let stop = start
      for (const end of ends) {
        if (end <= start) continue
        const m = ctx.measureText(text.slice(start, end))
        if (
          Math.max(m.width, m.actualBoundingBoxRight) + Math.max(0, m.actualBoundingBoxLeft) <=
          rect.width - 2
        )
          stop = end
        else break
      }
      if (stop === start) break
      const value = text.slice(start, stop),
        m = ctx.measureText(value)
      y += m.actualBoundingBoxAscent
      if (y + m.actualBoundingBoxDescent > rect.y + rect.height - 1) break
      lines.push({ text: value, x: rect.x + 1 + Math.max(0, m.actualBoundingBoxLeft), y })
      y += Math.max(size * 1.35 - m.actualBoundingBoxAscent, m.actualBoundingBoxDescent)
      start = stop
    }
    if (start === text.length) return { id, text, rect, size, lines }
  }
  return undefined
}
export function countUnsupportedPdfPixels(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
  mask: Uint8ClampedArray
): number {
  if (a.length !== b.length || a.length !== mask.length || a.length % 4)
    throw Error('Pixel dimensions differ')
  let n = 0
  for (let i = 0; i < a.length; i += 4)
    if (
      !mask[i + 3] &&
      (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3])
    )
      n++
  return n
}

// Own temporary canvases and render tasks only; the reader owns page/document lifetime.
// ponytail: bounded native fill-text subset; complex PDF paint and unresolved fonts stay linked.
export async function renderPdfTranslationInline(
  page: PDFPageProxy,
  pageNumber: number,
  units: readonly PdfTranslationUnit[],
  signal: AbortSignal
): Promise<{ canvas: HTMLCanvasElement; layouts: PdfInlineLayout[] } | undefined> {
  const base = page.getViewport({ scale: 1 }),
    scale = 2
  if (base.rotation !== 0 || base.width * base.height * scale * scale > 2500000) return
  const content = await getPdfTranslationTextContent(page),
    ops = await page.getOperatorList()
  signal.throwIfAborted()
  const forbidden = [
    pdfjsLib.OPS.beginGroup,
    pdfjsLib.OPS.clip,
    pdfjsLib.OPS.eoClip,
    pdfjsLib.OPS.setTextRenderingMode,
    pdfjsLib.OPS.paintFormXObjectBegin
  ]
  if (ops.fnArray.some((op) => forbidden.includes(op))) return
  const chars = new Map<string, Set<string>>()
  let font = ''
  const stack: string[] = []
  for (let i = 0; i < ops.fnArray.length; i++) {
    const args = ops.argsArray[i]
    if (ops.fnArray[i] === pdfjsLib.OPS.save) stack.push(font)
    else if (ops.fnArray[i] === pdfjsLib.OPS.restore) font = stack.pop() ?? ''
    else if (ops.fnArray[i] === pdfjsLib.OPS.setFont) font = args[0]
    else if (ops.fnArray[i] === pdfjsLib.OPS.showText)
      for (const glyph of args[0]) {
        if (typeof glyph === 'number') continue
        if (
          !font ||
          typeof glyph.fontChar !== 'string' ||
          typeof glyph.unicode !== 'string' ||
          glyph.accent
        )
          return
        const key = font + '\0' + glyph.fontChar
        if (!chars.has(key)) chars.set(key, new Set())
        chars.get(key)!.add(glyph.unicode)
      }
  }
  const canvases: HTMLCanvasElement[] = [],
    viewport = page.getViewport({ scale })
  const make = (): HTMLCanvasElement => {
    const c = document.createElement('canvas')
    c.width = Math.ceil(viewport.width)
    c.height = Math.ceil(viewport.height)
    canvases.push(c)
    return c
  }
  const pixels = (c: HTMLCanvasElement): Uint8ClampedArray =>
    c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height).data
  const selected = new Set<number>(),
    inserts = new Map<number, PdfInlineLayout>(),
    mask = make(),
    mc = mask.getContext('2d')!,
    calls: Call[] = []
  let retained: HTMLCanvasElement | undefined
  const render = async (
    observe: boolean,
    remove: boolean,
    refill: boolean
  ): Promise<HTMLCanvasElement> => {
    signal.throwIfAborted()
    const c = make(),
      ctx = c.getContext('2d', { willReadFrequently: true })!,
      native = ctx.fillText.bind(ctx),
      restores: (() => void)[] = []
    let index = 0,
      epoch = 0
    if (observe) {
      for (const name of [
        'fill',
        'stroke',
        'clip',
        'fillRect',
        'strokeRect',
        'drawImage'
      ] as const) {
        const original = ctx[name]
        Object.defineProperty(ctx, name, {
          configurable: true,
          value: (...args: unknown[]) => {
            epoch++
            return Reflect.apply(original, ctx, args)
          }
        })
        restores.push(() => {
          Reflect.deleteProperty(ctx, name)
        })
      }
      ctx.fillText = (text, x, y, ...rest): void => {
        const m = ctx.getTransform(),
          metrics = ctx.measureText(text),
          current = {
            text,
            x,
            y,
            font: ctx.font,
            fill: typeof ctx.fillStyle === 'string' ? ctx.fillStyle : undefined,
            transform: [m.a, m.b, m.c, m.d, m.e, m.f],
            epoch,
            width: metrics.width,
            emptyInk:
              metrics.actualBoundingBoxLeft === 0 &&
              metrics.actualBoundingBoxRight === 0 &&
              metrics.actualBoundingBoxAscent === 0 &&
              metrics.actualBoundingBoxDescent === 0
          },
          n = index++
        if (!remove) calls.push(current)
        else if (JSON.stringify(current) !== JSON.stringify(calls[n]))
          throw Error('Source paint changed')
        if (remove && selected.has(n)) {
          if (
            rest.length ||
            ctx.fontStretch !== 'normal' ||
            ctx.fontVariantCaps !== 'normal' ||
            ctx.globalAlpha !== 1 ||
            ctx.globalCompositeOperation !== 'source-over' ||
            ctx.filter !== 'none' ||
            ctx.shadowBlur ||
            ctx.shadowOffsetX ||
            ctx.shadowOffsetY
          )
            throw Error('Unsupported text paint')
          if (!refill) {
            mc.setTransform(m)
            mc.font = ctx.font
            mc.textAlign = ctx.textAlign
            mc.textBaseline = ctx.textBaseline
            mc.direction = ctx.direction
            mc.fontKerning = ctx.fontKerning
            mc.letterSpacing = ctx.letterSpacing
            mc.wordSpacing = ctx.wordSpacing
            mc.fillStyle = '#000'
            mc.fillText(text, x, y)
          }
          const layout = refill ? inserts.get(n) : undefined
          if (layout) {
            ctx.save()
            try {
              ctx.setTransform(scale, 0, 0, scale, 0, 0)
              ctx.font = `${layout.size}px sans-serif`
              ctx.fontKerning = 'auto'
              ctx.letterSpacing = '0px'
              ctx.wordSpacing = '0px'
              ctx.direction = 'ltr'
              ctx.textAlign = 'left'
              ctx.textBaseline = 'alphabetic'
              for (const line of layout.lines) native(line.text, line.x, line.y)
            } finally {
              ctx.restore()
            }
          }
          return
        }
        native(text, x, y, ...rest)
      }
      restores.push(() => {
        Reflect.deleteProperty(ctx, 'fillText')
      })
    }
    const task = page.render({ canvas: c, canvasContext: ctx, viewport }),
      abort = (): void => task.cancel()
    signal.addEventListener('abort', abort, { once: true })
    try {
      signal.throwIfAborted()
      await task.promise
      signal.throwIfAborted()
      if (remove && index !== calls.length) throw Error('Source paint count changed')
    } finally {
      signal.removeEventListener('abort', abort)
      restores.forEach((f) => f())
    }
    return c
  }
  try {
    const original = await render(true, false, false),
      originalPixels = pixels(original),
      native = await render(false, false, false)
    const pixelsOnce = pixels(native)
    if (originalPixels.some((value, i) => value !== pixelsOnce[i])) return
    native.width = 0
    const rows = content.items.flatMap((item, index) =>
      'str' in item && item.str.trim() ? [{ ...item, index }] : []
    )
    const ownership = rows.map((item) => ({ item, calls: [] as number[], text: '' }))
    for (const [n, call] of calls.entries()) {
      const [a, b, c, d, e, f] = call.transform,
        x = a * call.x + c * call.y + e,
        y = b * call.x + d * call.y + f
      if (Math.abs(b) > 0.001 || Math.abs(c) > 0.001 || a <= 0 || d <= 0) continue
      const candidates = ownership.filter(({ item }) => {
        const [ia, ib, ic, id, ix, iy] = item.transform
        return (
          item.dir === 'ltr' &&
          ia > 0 &&
          id > 0 &&
          Math.abs(ib) < 0.001 &&
          Math.abs(ic) < 0.001 &&
          call.font.split(/[\s,"']+/).includes(item.fontName) &&
          Math.abs(y - (base.height - iy) * scale) < 0.1 &&
          x >= ix * scale - 0.1 &&
          x < (ix + item.width) * scale - 0.1
        )
      })
      if (candidates.length !== 1) continue
      const row = candidates[0],
        unicode = chars.get(row.item.fontName + '\0' + call.text)
      if (unicode?.size !== 1) continue
      row.calls.push(n)
      row.text += [...unicode][0]
    }
    const layouts: PdfInlineLayout[] = [],
      measure = document.createElement('canvas').getContext('2d')!
    for (const unit of units) {
      if (
        !isCurrentTranslation(unit) ||
        unit.fragments.length !== 1 ||
        unit.fragments[0].pageNumber !== pageNumber
      )
        continue
      const fragment = unit.fragments[0],
        owned = fragment.items.map((i) =>
          ownership.find((o) => o.item.index === i.index && o.item.str === i.text)
        )
      if (owned.some((row) => !row?.calls.length || ink(row.text) !== ink(row.item.str))) continue
      // Short labels/headings and mixed font/size runs retain their original hierarchy.
      // This is a conservative prose subset, not semantic heading detection.
      if (
        unit.source.trim().split(/\s+/u).length < 12 ||
        new Set(owned.map((row) => row!.item.fontName)).size !== 1 ||
        new Set(owned.map((row) => row!.item.height)).size !== 1 ||
        owned.some((row) => row!.item.height > 12)
      )
        continue
      const ids = owned.flatMap((row) => row!.calls).sort((a, b) => a - b),
        first = ids[0],
        last = ids.at(-1)!
      if (
        !calls[first]?.fill ||
        ids.some((id) => calls[id].fill !== calls[first].fill) ||
        ids.some((id) => /\b(?:bold|italic|oblique)\b/.test(calls[id].font)) ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => selected.has(id) || calls[id].epoch !== calls[first].epoch) ||
        calls.slice(first, last + 1).some((call, i) => {
          if (ids.includes(first + i)) return false
          // Embedded PDF fonts can paint spaces through private-use characters.
          // Only an exact same-font Unicode space with empty ink may be interleaved.
          const unicode = chars.get(owned[0]!.item.fontName + '\0' + call.text)
          return !isMappedPdfSpace(call.font, owned[0]!.item.fontName, unicode, call.emptyInk)
        })
      )
        continue
      const r = fragment.rect,
        rect = {
          x: r.x * base.width,
          y: r.y * base.height,
          width: r.width * base.width,
          height: r.height * base.height
        }
      if (layouts.some((l) => overlaps(l.rect, rect))) continue
      if (
        rows.some(
          (item) =>
            !fragment.items.some((i) => i.index === item.index) &&
            overlaps(rect, {
              x: item.transform[4],
              y: base.height - item.transform[5] - item.height,
              width: item.width,
              height: item.height
            })
        )
      )
        continue
      const layout = fitPdfTranslation(measure, unit.id, unit.translation, rect)
      if (!layout) continue
      // Inspect actual translated ink, not only Canvas metrics, at the fixed raster scale.
      const probe = make(),
        pc = probe.getContext('2d')!
      pc.scale(scale, scale)
      pc.font = `${layout.size}px sans-serif`
      for (const line of layout.lines) pc.fillText(line.text, line.x, line.y)
      const data = pixels(probe)
      let fits = true
      for (let i = 3; i < data.length; i += 4)
        if (data[i]) {
          const x = (((i - 3) / 4) % probe.width) / scale,
            y = Math.floor((i - 3) / 4 / probe.width) / scale
          if (x < rect.x || x > rect.x + rect.width || y < rect.y || y > rect.y + rect.height) {
            fits = false
            break
          }
        }
      probe.width = 0
      if (!fits) continue
      ids.forEach((id) => selected.add(id))
      inserts.set(first, layout)
      layouts.push(layout)
    }
    if (!layouts.length) return
    const removed = await render(true, true, false)
    if (countUnsupportedPdfPixels(originalPixels, pixels(removed), pixels(mask))) return
    const output = await render(true, true, true),
      allowed = make(),
      ac = allowed.getContext('2d')!
    // The refill must change only its independently measured translated ink support.
    ac.scale(scale, scale)
    for (const layout of layouts) {
      ac.font = `${layout.size}px sans-serif`
      for (const line of layout.lines) ac.fillText(line.text, line.x, line.y)
    }
    if (countUnsupportedPdfPixels(pixels(removed), pixels(output), pixels(allowed))) return
    retained = output
    return { canvas: output, layouts }
  } finally {
    for (const c of canvases) if (c !== retained) c.width = 0
  }
}
