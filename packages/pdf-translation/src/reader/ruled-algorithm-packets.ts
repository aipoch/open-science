import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PdfLayoutPage, PdfLayoutTextItem, PdfTranslationLayout } from './layout.js'

type Unit = PdfTranslationLayout['units'][number]
type Box = [number, number, number, number]
type Entry = { item: PdfLayoutTextItem; index: number; key: string; owner: Unit }
const text = (entries: Entry[]): string =>
  entries
    .map((entry) => entry.item.str)
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim()
const inside = (a: Box, b: Box): boolean =>
  a[0] >= b[0] && a[1] >= b[1] && a[2] <= b[2] && a[3] <= b[3]
const overlap = (a: Box, b: Box): boolean =>
  a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]

/** Source classification only. The native rule frame and numbered executable
 * flow select whole owners; neither this frame nor its caption is a crop or
 * glyph repaint certificate. Existing readonly owners keep their classification. */
export function nativeRuledAlgorithmOwners(
  units: Unit[],
  pages: PdfLayoutPage[]
): ReadonlySet<string> {
  const result = new Set<string>(),
    owners = new Map<string, Unit>(),
    repeated = new Set<string>()
  for (const owner of units)
    for (const key of owner.items) {
      if (owners.has(key)) repeated.add(key)
      owners.set(key, owner)
    }
  for (const page of pages) {
    const evidence = page.nativeNumberedPacketEvidence
    if (!evidence?.complete || page.rotation !== 0 || page.items.length > 10000) continue
    const entries: Entry[] = page.items.flatMap((item, index) =>
      item.str.trim()
        ? [
            {
              item,
              index,
              key: `${page.page}:${index}`,
              owner: owners.get(`${page.page}:${index}`)!
            }
          ]
        : []
    )
    if (
      !entries.length ||
      entries.some((entry) => {
        const i = entry.item,
          font = evidence.fonts[i.fontName!]
        return (
          !entry.owner ||
          repeated.has(entry.key) ||
          entry.owner.originalStrings[entry.owner.items.indexOf(entry.key)] !== i.str ||
          !font?.nativeMetrics ||
          font.ascent !== i.fontAscent ||
          font.descent !== i.fontDescent ||
          i.dir !== 'ltr' ||
          i.fontVertical !== false ||
          i.transform.length !== 6 ||
          ![...i.transform, i.width, i.height, i.fontAscent, i.fontDescent].every(
            Number.isFinite
          ) ||
          i.width <= 0 ||
          i.height <= 0 ||
          i.transform[0] <= 0 ||
          i.transform[3] !== i.height ||
          i.transform[1] !== 0 ||
          i.transform[2] !== 0
        )
      })
    )
      continue
    const box = (entry: Entry): Box => {
      const i = entry.item
      return [
        i.transform[4],
        i.transform[5] + i.fontDescent! * i.height,
        i.transform[4] + i.width,
        i.transform[5] + i.fontAscent! * i.height
      ]
    }
    if (entries.some((entry) => !inside(box(entry), [0, 0, page.width, page.height]))) continue
    const width = Math.max(0, ...evidence.rules.map((rule) => rule.right - rule.left))
    if (width < page.width * 0.5 || width > page.width * 0.95) continue
    const rails = evidence.rules
      .filter((rule) => rule.right - rule.left === width)
      .toSorted((a, b) => a.baseline - b.baseline)
    if (
      rails.length !== 3 ||
      rails.some((rule) => rule.left !== rails[0].left || rule.right !== rails[0].right)
    )
      continue
    const bounds: Box = [
      rails[0].left,
      rails[0].baseline + rails[0].halfHeight,
      rails[0].right,
      rails[1].baseline - rails[1].halfHeight
    ]
    const body = entries.filter((entry) => inside(box(entry), bounds))
    if (
      !body.length ||
      entries.some((entry) => overlap(box(entry), bounds) && !body.includes(entry))
    )
      continue
    const height = Math.max(...body.map((entry) => entry.item.height))
    // A hanging Algorithm label belongs to its native caption row, not to the
    // body paint frame. A bounded tenth-em alignment is a flow check only.
    const caption = entries.filter(
      ({ item: i }) =>
        i.transform[4] >= bounds[0] - i.height * 0.1 &&
        i.transform[4] + i.width <= bounds[2] &&
        i.transform[5] > rails[1].baseline + rails[1].halfHeight &&
        i.transform[5] < rails[2].baseline - rails[2].halfHeight
    )
    if (!/^(?:Algorithm\s+[1-9]\d*\b|Pseudo code\b)/u.test(text(caption))) continue
    const selected = new Set(body.map((entry) => entry.key)),
      first = Math.min(...body.map((entry) => entry.index)),
      last = Math.max(...body.map((entry) => entry.index)),
      bodyOwners = [...new Set(body.map((entry) => entry.owner))]
    if (
      entries.some(
        (entry) => entry.index >= first && entry.index <= last && !selected.has(entry.key)
      ) ||
      bodyOwners.some((owner) => owner.items.some((key) => !selected.has(key)))
    )
      continue
    const markers = body
      .filter(
        ({ item: i }) =>
          /^([1-9]\d{0,2}):?$/u.test(i.str) && i.transform[4] < bounds[0] + height * 1.8
      )
      .toSorted((a, b) => b.item.transform[5] - a.item.transform[5])
    const closedCommentBridge = (prior: Entry, next: Entry): boolean => {
      const gap = prior.item.transform[5] - next.item.transform[5]
      if (gap <= height * 3) return true
      const between = body.filter((entry) => entry.index > prior.index && entry.index < next.index),
        start = between.findIndex((entry) => /^\/\//u.test(entry.item.str)),
        tail = between.slice(start),
        comment = tail[0]?.item
      if (
        start < 0 ||
        !comment ||
        tail.length > 8 ||
        gap > height * (2 + tail.length * 2) ||
        prior.item.transform[5] - comment.transform[5] > height * 2 ||
        tail.at(-1)!.item.transform[5] - next.item.transform[5] > height * 2
      )
        return false
      return tail.every(({ item }, at) => {
        const before = tail[at - 1]?.item
        return (
          item.fontName === comment.fontName &&
          item.height === comment.height &&
          item.transform[4] >= comment.transform[4] &&
          item.transform[4] - comment.transform[4] <= height * 2 &&
          item.transform[5] < prior.item.transform[5] &&
          item.transform[5] > next.item.transform[5] &&
          (!before ||
            (before.transform[5] >= item.transform[5] &&
              before.transform[5] - item.transform[5] <= height * 2))
        )
      })
    }
    if (
      markers.length < 8 ||
      markers.length > 256 ||
      markers.some((entry, index) => {
        const i = entry.item,
          prior = markers[index - 1]?.item,
          first = markers[0].item
        return (
          Number(i.str.replace(':', '')) !== index + 1 ||
          i.fontName !== first.fontName ||
          Math.abs(i.height - first.height) > height * 0.05 ||
          Math.abs(i.transform[4] + i.width - first.transform[4] - first.width) > height * 0.25 ||
          (prior &&
            (entry.index <= markers[index - 1].index ||
              !closedCommentBridge(markers[index - 1], entry)))
        )
      })
    )
      continue
    const controls = body.filter(({ item }) =>
        /^(?:begin|if|then|for|foreach|while|do|else|return)$/u.test(item.str)
      ),
      names = new Set(controls.map(({ item }) => item.str))
    if (
      !names.has('if') ||
      !names.has('return') ||
      !['for', 'foreach', 'while'].some((name) => names.has(name)) ||
      controls.some(({ item }) => item.fontName !== controls[0].item.fontName) ||
      body.filter(({ item }) => item.str.includes('←')).length < 2 ||
      !text(body.filter((entry) => entry.index >= markers.at(-1)!.index)).includes('return')
    )
      continue
    const preludes = body.filter(
      ({ item, index }) => index < markers[0].index && /^(?:Data|Result):$/u.test(item.str)
    )
    const wordFlow = body.filter(
      ({ item }) => item.height >= height * 0.85 && /\p{L}{2}/u.test(item.str)
    )
    if (
      wordFlow.some((entry) => {
        const i = entry.item
        if (
          markers.some(({ item }) => Math.abs(item.transform[5] - i.transform[5]) < height * 0.05)
        )
          return false
        if (entry.index < markers[0].index)
          return !preludes.some(
            ({ item }) => Math.abs(item.transform[5] - i.transform[5]) < height * 0.05
          )
        const prior = markers.findLast((m) => m.index < entry.index),
          next = markers.find((m) => m.index > entry.index)
        if (!prior || !next) return true
        const interval = body.filter((e) => e.index > prior.index && e.index < next.index)
        if (i.str === 'then' && i.fontName === controls[0].item.fontName) {
          const start = interval.find(
            (e) =>
              e.item.str === 'if' &&
              Math.abs(e.item.transform[5] - prior.item.transform[5]) < height * 0.05
          )
          return (
            !start ||
            i.transform[4] < start.item.transform[4] ||
            i.transform[4] - start.item.transform[4] > height ||
            prior.item.transform[5] - i.transform[5] > height * 2
          )
        }
        const comment = interval.findLast(
          (e) => e.index <= entry.index && /^\/\//u.test(e.item.str)
        )
        if (!comment) return true
        const tail = interval.filter((e) => e.index >= comment.index && e.index <= entry.index)
        return (
          tail.length > 8 ||
          tail.some(({ item }, at) => {
            const before = tail[at - 1]?.item
            return (
              item.fontName !== comment.item.fontName ||
              item.height !== comment.item.height ||
              item.transform[4] < comment.item.transform[4] ||
              item.transform[4] - comment.item.transform[4] > height * 2 ||
              item.transform[5] >= prior.item.transform[5] ||
              item.transform[5] <= next.item.transform[5] ||
              (before &&
                (before.transform[5] < item.transform[5] ||
                  before.transform[5] - item.transform[5] > height * 2))
            )
          })
        )
      })
    )
      continue
    for (const owner of bodyOwners)
      if (
        !owner.sourceOnly &&
        !owner.preserve &&
        owner.risks.every((risk) => risk === 'possible-continuation')
      )
        result.add(owner.items.join('|'))
  }
  return result
}
import type { PDFDocumentProxy, PDFPageProxy, getDocument } from 'pdfjs-dist'
import {
  nativeInkPageCurrent,
  createAuxiliaryNativeAlgorithmCaptionInkReader
} from './auxiliary-native-ink.js'
import { nativeAlgorithmCaptionInk, nativeAlgorithmInkRegions } from './native-source-geometry.js'
import { nativeReferenceFontWitnesses } from './native-reference-evidence.js'
type AlgorithmContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>
type AlgorithmInput = {
  page: PDFPageProxy
  content: AlgorithmContent
  viewport: ReturnType<PDFPageProxy['getViewport']>
  rawPage: PdfLayoutPage
  unreliable: Set<number>
}
const algorithmCaptions = new WeakMap<
  PdfLayoutPage,
  { selected: ReadonlySet<number>; current: () => boolean }
>()
const wrappedAlgorithmProse = new WeakMap<
  PdfLayoutPage,
  { selected: ReadonlySet<number>; current: () => boolean }
>()

// A native line beginning Algorithm may continue the preceding ordinary
// sentence. Close the complete continuation at a separately styled numbered
// section, leaving every original item and the generic listing scan untouched.
function wrappedAlgorithmContinuation(
  input: AlgorithmInput,
  heading: number
): Set<number> | undefined {
  const { content } = input
  const visible = content.items.flatMap((item, index) =>
    'str' in item && item.str.trim() ? [{ item, index }] : []
  )
  const at = visible.findIndex((entry) => entry.index === heading)
  const start = visible[at]?.item,
    previous = visible[at - 1]?.item
  if (
    !start ||
    !previous ||
    previous.fontName !== start.fontName ||
    previous.height !== start.height ||
    !/,\s+(?:and|or)\s*$/u.test(previous.str) ||
    previous.transform[5] - start.transform[5] <= start.height * 0.5 ||
    previous.transform[5] - start.transform[5] > start.height * 1.7 ||
    previous.transform[4] < start.transform[4] ||
    previous.transform[4] > start.transform[4] + start.height * 4
  )
    return
  const tail = visible.slice(at + 1)
  const boundary = tail.findIndex(
    ({ item }) =>
      /^\d+(?:\.\d+)+(?:\s+\p{L}.*)?$/u.test(item.str) &&
      item.height > start.height * 1.1 &&
      item.fontName !== start.fontName
  )
  if (boundary < 0) return
  const body = tail.slice(0, boundary),
    last = body.at(-1)?.item,
    next = tail[boundary].item
  if (
    !last ||
    body.length < 3 ||
    body.length > 256 ||
    !/[.!?]$/u.test(last.str) ||
    body.some(({ item }) =>
      /^(?:Algorithm\s+\d+|Require:|Ensure:|Input:|Output:|\d+[.:]\s|for\b|while\b|if\b|else\b|return\b|end\b)/u.test(
        item.str
      )
    ) ||
    last.transform[5] - next.transform[5] <= start.height * 1.5 ||
    last.transform[5] - next.transform[5] > start.height * 4 ||
    body.some(
      ({ item }) =>
        item.transform[5] > start.transform[5] + start.height ||
        item.transform[5] < next.transform[5] + next.height
    )
  )
    return
  return new Set(body.map(({ index }) => index))
}

const algorithmSetSize = Object.getOwnPropertyDescriptor(Set.prototype, 'size')!.get!,
  algorithmSetHas = Set.prototype.has,
  algorithmSetValues = Set.prototype.values
function algorithmWatch(value: unknown): () => boolean {
  const seen = new Set<object>(),
    objects: { value: object; keys: (string | symbol)[]; proto: object | null }[] = [],
    slots: [object, string | symbol, PropertyDescriptor][] = []
  const visit = (v: unknown): void => {
    if (!v || typeof v !== 'object' || seen.has(v)) return
    seen.add(v)
    if (seen.size > 100000) throw Error('Algorithm native reference budget')
    const keys = Reflect.ownKeys(v)
    objects.push({ value: v, keys, proto: Object.getPrototypeOf(v) })
    for (const k of keys) {
      const d = Object.getOwnPropertyDescriptor(v, k)
      if (!d || !('value' in d)) throw Error('Algorithm native accessor')
      slots.push([v, k, d])
      visit(d.value)
    }
  }
  visit(value)
  return () =>
    objects.every(({ value, keys, proto }) => {
      const now = Reflect.ownKeys(value)
      return (
        Object.getPrototypeOf(value) === proto &&
        now.length === keys.length &&
        now.every((k, i) => k === keys[i])
      )
    }) &&
    slots.every(([o, k, d]) => {
      const n = Object.getOwnPropertyDescriptor(o, k)
      return (
        !!n &&
        ['value', 'get', 'set', 'writable', 'enumerable', 'configurable'].every(
          (x) => n[x as keyof PropertyDescriptor] === d[x as keyof PropertyDescriptor]
        )
      )
    })
}
/** Only this live reader can establish the page-keyed caption exception. No raw
 * evidence field, JSON snapshot or caller-provided owner ID grants admission. */
export function createNativeRuledAlgorithmCaptionReader(options: {
  document: Pick<PDFDocumentProxy, 'getPage' | 'numPages' | 'fingerprints'> &
    Partial<Pick<PDFDocumentProxy, 'getData' | 'getMetadata'>>
  sourceIdentity?: Readonly<{ sourceChecksum: string; sourceSizeBytes: number }>
  nativeDocumentFactory?: typeof getDocument
  signal: AbortSignal
}): { observe: (input: AlgorithmInput) => Promise<void> } {
  const document = options.document,
    signal = options.signal
  return {
    async observe(input: AlgorithmInput): Promise<void> {
      const { page, content, viewport, rawPage, unreliable } = input
      const heading = content.items.findIndex(
        (i) => 'str' in i && /^Algorithm\s+[1-9]\d*\b/u.test(i.str)
      )
      if (heading < 0) return
      const require = content.items.findIndex(
        (i, n) => n > heading && 'str' in i && i.str === 'Require:'
      )
      const wrapped = require < 0 ? wrappedAlgorithmContinuation(input, heading) : undefined
      if (require < 0 && !wrapped) return
      if (wrapped && !rawPage.nativeNumberedPacketEvidence?.complete) return
      const selected =
        wrapped ??
        new Set(
          content.items.flatMap((i, n) =>
            n >= heading && n < require && 'str' in i && i.str.trim() ? [n] : []
          )
        )
      if (!selected.size || selected.size > 256) return
      let auxiliary: ReturnType<typeof createAuxiliaryNativeAlgorithmCaptionInkReader> | undefined
      try {
        options.signal.throwIfAborted()
        const watch = algorithmWatch([
            content,
            rawPage,
            viewport,
            options.sourceIdentity,
            document.fingerprints
          ]),
          viewportValue = [viewport.width, viewport.height, viewport.scale, viewport.rotation],
          viewportProto = Object.getPrototypeOf(viewport),
          sourceIdentity = options.sourceIdentity,
          nativeFactory = options.nativeDocumentFactory,
          fingerprints = document.fingerprints,
          pageCount = document.numPages,
          unreliableProto = Object.getPrototypeOf(unreliable),
          members = [...algorithmSetValues.call(unreliable)],
          setMethods = [unreliable.has, unreliable.values],
          documentGetPage = options.document.getPage,
          pageApis = [page.getOperatorList, page.getTextContent, page.getViewport],
          inputRefs = [input.page, input.content, input.viewport, input.rawPage, input.unreliable]
        const preCurrent = (): boolean => {
          options.signal.throwIfAborted()
          return (
            options.document === document &&
            options.signal === signal &&
            options.sourceIdentity === sourceIdentity &&
            options.nativeDocumentFactory === nativeFactory &&
            document.fingerprints === fingerprints &&
            document.numPages === pageCount &&
            watch() &&
            Object.getPrototypeOf(viewport) === viewportProto &&
            [viewport.width, viewport.height, viewport.scale, viewport.rotation].every(
              (n, i) => n === viewportValue[i]
            ) &&
            Object.getPrototypeOf(unreliable) === unreliableProto &&
            algorithmSetSize.call(unreliable) === members.length &&
            members.every((n) => algorithmSetHas.call(unreliable, n)) &&
            unreliable.has === setMethods[0] &&
            unreliable.values === setMethods[1] &&
            options.document.getPage === documentGetPage &&
            page.getOperatorList === pageApis[0] &&
            page.getTextContent === pageApis[1] &&
            page.getViewport === pageApis[2] &&
            [input.page, input.content, input.viewport, input.rawPage, input.unreliable].every(
              (x, i) => x === inputRefs[i]
            )
          )
        }
        if (!preCurrent() || [...selected].some((i) => algorithmSetHas.call(unreliable, i))) return
        const proxy = await documentGetPage.call(options.document, rawPage.page)
        if (!preCurrent() || proxy !== page) return
        const ops = await page.getOperatorList()
        if (!preCurrent()) return
        if (
          ops.fnArray.length > 100000 ||
          ops.fnArray.length !== ops.argsArray.length ||
          content.items.length > 10000
        )
          return
        let font = '',
          glyphEntries = 0
        const fonts: string[] = [],
          keys = new Set<string>()
        for (let i = 0; i < ops.fnArray.length; i++) {
          const a = ops.argsArray[i],
            op = ops.fnArray[i]
          if (op === OPS.save || op === OPS.paintFormXObjectBegin) fonts.push(font)
          else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) font = fonts.pop() ?? ''
          else if (op === OPS.setFont) font = a?.[0]
          else if (op === OPS.showText && Array.isArray(a?.[0]))
            for (const g of a[0]) {
              if (++glyphEntries > 64000) return
              if (g && typeof g === 'object' && g.isInFont === true)
                keys.add(font + '_path_' + g.fontChar)
            }
          if (keys.size > 10000) return
        }
        const epoch = nativeInkPageCurrent(page, content, viewport, ops, [...keys])
        if (!epoch || !epoch() || !nativeReferenceFontWitnesses(page, content)) return
        const current = (): boolean => preCurrent() && epoch()
        if (
          content.items.length !== rawPage.items.length ||
          rawPage.rotation !== 0 ||
          rawPage.width !== viewport.width ||
          rawPage.height !== viewport.height
        )
          return
        for (const [i, r] of content.items.entries()) {
          if (!('str' in r) || !r.str.trim()) continue
          const b = rawPage.items[i]
          if (
            !b ||
            b.str !== r.str ||
            b.fontName !== r.fontName ||
            b.width !== r.width ||
            b.height !== r.height ||
            b.hasEOL !== r.hasEOL ||
            b.transform.some((n, k) => {
              const [ma, mb, mc, md, mx, my] = viewport.transform,
                [a, b, c, d, x, y] = r.transform
              return (
                n !==
                [
                  ma * a + mc * b,
                  -(mb * a + md * b),
                  ma * c + mc * d,
                  -(mb * c + md * d),
                  ma * x + mc * y + mx,
                  viewport.height - (mb * x + md * y + my)
                ][k]
              )
            })
          )
            return
        }
        let ink = wrapped
          ? await nativeAlgorithmInkRegions(page, content, viewport, rawPage.page, selected)
          : await nativeAlgorithmCaptionInk(page, content, viewport, rawPage.page, selected, ops)
        if (!current()) return
        if (!ink && !wrapped) {
          auxiliary = createAuxiliaryNativeAlgorithmCaptionInkReader(options)
          ink = await auxiliary.read({
            page,
            content,
            viewport,
            pageNumber: rawPage.page,
            selected,
            operatorSnapshot: ops
          })
          if (!current()) return
        }
        await auxiliary?.dispose()
        auxiliary = undefined
        if (!current() || !ink || [...selected].some((i) => !ink!.has(i))) return
        ;(wrapped ? wrappedAlgorithmProse : algorithmCaptions).set(rawPage, { selected, current })
      } catch {
        /* Optional native evidence never changes an unproved listing. */
      } finally {
        await auxiliary?.dispose()
      }
    }
  }
}
/** The final block is already grouped. Only whole caption ownership is read. */
export function nativeRuledAlgorithmCaptionBlock(
  page: PdfLayoutPage,
  items: readonly { index: number; str: string }[]
): boolean {
  try {
    const proof = algorithmCaptions.get(page)
    return (
      !!proof &&
      proof.current() &&
      items.length > 0 &&
      new Set(items.map((i) => i.index)).size === items.length &&
      items.every((i) => proof.selected.has(i.index) && page.items[i.index]?.str === i.str)
    )
  } catch {
    return false
  }
}

/** This exception only removes the generic listing reason from a whole block.
 * Caption authority and independent code/math reasons remain separate. */
export function nativeWrappedAlgorithmProseBlock(
  page: PdfLayoutPage,
  items: readonly { index: number; str: string }[]
): boolean {
  try {
    const proof = wrappedAlgorithmProse.get(page)
    return (
      !!proof &&
      proof.current() &&
      items.length > 0 &&
      new Set(items.map((i) => i.index)).size === items.length &&
      items.every((i) => proof.selected.has(i.index) && page.items[i.index]?.str === i.str) &&
      /[.!?]$/u.test(items.at(-1)!.str) &&
      (items
        .map((i) => i.str)
        .join(' ')
        .match(/\p{L}{2,}/gu)?.length ?? 0) >= 8
    )
  } catch {
    return false
  }
}
