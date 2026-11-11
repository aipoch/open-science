import type { PDFPageProxy, PDFDocumentProxy } from 'pdfjs-dist'
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js'
import type { PdfTranslationExtraction } from './extraction.js'
import type { PdfTranslationSourceIdentity } from './table-source.js'
import { createPdfTranslationSource } from './source.js'
import { getPdfTranslationTextContent } from './text-content.js'
import {
  carryNativeCaptionEligibility,
  rememberNativeOrdinaryProseEligibility
} from './caption-eligibility.js'
import { nativeInkPageIdentity, nativeInkPageCurrent } from './auxiliary-native-ink.js'
import { nativeZeroAdvanceRegions } from './native-source-geometry.js'
import type { PdfLayoutPage, PdfLayoutTextItem, PdfTranslationLayout } from './layout.js'
import {
  nativeReferenceFontWitnesses,
  type NativeReferenceEvidence,
  type NativeReferenceFontWitness
} from './native-reference-evidence.js'

export type NativeSectionFontEvidence =
  { complete: true; fonts: Record<string, NativeReferenceFontWitness> } | { complete: false }

/** Reuse resolved embedded fonts; an already proved missing metric stays refused. */
export async function readNativeSectionFontEvidence(
  page: PDFPageProxy,
  content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>,
  reference: NativeReferenceEvidence
): Promise<NativeSectionFontEvidence> {
  if (reference.complete) return { complete: true, fonts: reference.fonts }
  if (
    reference.reason === 'incomplete-native-font' ||
    !page.commonObjs ||
    typeof page.getOperatorList !== 'function'
  )
    return { complete: false }
  try {
    let fonts: Record<string, NativeReferenceFontWitness> | undefined
    try {
      fonts = nativeReferenceFontWitnesses(page, content)
    } catch {
      /* The native objects may not have resolved yet. */
    }
    if (fonts) return { complete: true, fonts }
    await page.getOperatorList()
    fonts = nativeReferenceFontWitnesses(page, content)
    return fonts ? { complete: true, fonts } : { complete: false }
  } catch {
    return { complete: false }
  }
}

type Unit = PdfTranslationLayout['units'][number]
type Box = { x: number; y: number; right: number; bottom: number }
type Entry = { key: string; index: number; item: PdfLayoutTextItem; page: PdfLayoutPage }
const words = (s: string): number => s.match(/\p{L}{2,}/gu)?.length ?? 0
const valid = (i: PdfLayoutTextItem): boolean =>
  i.dir === 'ltr' &&
  !!i.fontName &&
  i.fontVertical === false &&
  i.transform.length === 6 &&
  [...i.transform, i.width, i.height, i.fontAscent, i.fontDescent].every(Number.isFinite) &&
  i.width > 0 &&
  i.height > 0 &&
  i.transform[0] > 0 &&
  i.transform[3] === i.height &&
  i.transform[1] === 0 &&
  i.transform[2] === 0 &&
  i.fontAscent! > 0 &&
  i.fontAscent! <= 1 &&
  i.fontDescent! >= -1 &&
  i.fontDescent! <= 0
const box = (p: PdfLayoutPage, i: PdfLayoutTextItem): Box => ({
  x: i.transform[4],
  y: p.height - i.transform[5] - i.fontAscent! * i.height,
  right: i.transform[4] + i.width,
  bottom: p.height - i.transform[5] - i.fontDescent! * i.height
})
const union = (bs: Box[]): Box => ({
  x: Math.min(...bs.map((b) => b.x)),
  y: Math.min(...bs.map((b) => b.y)),
  right: Math.max(...bs.map((b) => b.right)),
  bottom: Math.max(...bs.map((b) => b.bottom))
})
const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom

/** Restore only whole, independently closed prose owners. The enclosing appendix
 * is not reset: code, mathematics and incomplete owners keep their old policy. */
export function nativeWrappedSectionProse(
  units: Unit[],
  pages: PdfLayoutPage[]
): ReadonlySet<string> {
  const accepted = new Set<string>(),
    counts = new Map<string, number>()
  for (const u of units) for (const k of u.items) counts.set(k, (counts.get(k) ?? 0) + 1)
  function native(u: Unit | undefined): Entry[] | undefined {
    if (
      !u ||
      u.fragments.length !== 1 ||
      !u.items.length ||
      u.items.length !== u.originalStrings.length
    )
      return
    const p = pages[u.fragments[0].page - 1]
    if (!p || p.rotation !== 0 || !p.nativeSectionFontEvidence?.complete) return
    const es: Entry[] = []
    for (const [n, key] of u.items.entries()) {
      const [number, index] = key.split(':').map(Number),
        item = p.items[index],
        font = p.nativeSectionFontEvidence.fonts[item?.fontName ?? '']
      if (
        number !== p.page ||
        !item ||
        !valid(item) ||
        item.str !== u.originalStrings[n] ||
        counts.get(key) !== 1 ||
        !font?.nativeMetrics ||
        font.ascent !== item.fontAscent ||
        font.descent !== item.fontDescent
      )
        return
      const b = box(p, item)
      if (b.x < 0 || b.y < 0 || b.right > p.width || b.bottom > p.height) return
      es.push({ key, index, item, page: p })
    }
    return es
  }
  function exclusive(us: Unit[]): Box | undefined {
    const es = us.flatMap((u) => native(u) ?? [])
    if (
      !es.length ||
      es.length !== us.reduce((n, u) => n + u.items.length, 0) ||
      new Set(es.map((e) => e.key)).size !== es.length ||
      new Set(es.map((e) => e.page)).size !== 1
    )
      return
    const p = es[0].page,
      b = union(es.map((e) => box(p, e.item))),
      keys = new Set(es.map((e) => e.key))
    return p.items.some(
      (i, n) => i.str.trim() && !keys.has(`${p.page}:${n}`) && (!valid(i) || overlaps(box(p, i), b))
    )
      ? undefined
      : b
  }
  function closedRow(es: Entry[]): boolean {
    const sorted = [...es].sort((a, b) => a.item.transform[4] - b.item.transform[4]),
      last = sorted.at(-1)!,
      p = last.page,
      next = p.items.findIndex((i, n) => n > last.index && !!i.str.trim()),
      emptyBreak = p.items
        .slice(last.index + 1, next < 0 ? undefined : next)
        .some((i) => !i.str.trim() && i.hasEOL === true)
    return (
      sorted.slice(0, -1).every((e) => e.item.hasEOL === false) &&
      (last.item.hasEOL === true || emptyBreak) &&
      sorted.every((e, n) => !n || e.index > sorted[n - 1].index)
    )
  }
  function firstNativeBodyRow(u: Unit): boolean {
    const es = native(u)
    if (!es) return false
    const h = es[0].item.height,
      baseline = es[0].item.transform[5],
      row = es.filter((e) => Math.abs(e.item.transform[5] - baseline) < h * 0.55),
      p = es[0].page,
      keys = new Set(row.map((e) => e.key)),
      domain = union(row.map((e) => box(p, e.item)))
    return (
      words(row.map((e) => e.item.str).join(' ')) >= 6 &&
      closedRow(row) &&
      !p.items.some(
        (i, n) =>
          i.str.trim() && !keys.has(`${p.page}:${n}`) && (!valid(i) || overlaps(box(p, i), domain))
      )
    )
  }
  for (const [index, a] of units.entries()) {
    if (!/^A [A-Z][A-Z ,–—-]{12,}$/u.test(a.source)) continue
    const tail = units[index + 1],
      body = units[index + 2],
      reference = units
        .slice(0, index)
        .findLast((u) => /^(?:References|REFERENCES)$/u.test(u.source)),
      b = units.slice(index + 2).find((u) => /^B [A-Z][A-Z ,–—-]{8,}$/u.test(u.source))
    if (
      !tail ||
      !body ||
      !b ||
      !reference ||
      !/^[A-Z][A-Z ,–—-]{4,}$/u.test(tail.source) ||
      [a, tail, b, reference].some(
        (u) => u.sourceOnly || u.risks.length || u.fragments.length !== 1
      )
    )
      continue
    const pa = a.fragments[0].page,
      pb = b.fragments[0].page,
      prior = units.slice(index - 2, index)
    if (
      pb < pa ||
      pb - pa > 4 ||
      reference.fragments[0].page >= pa ||
      prior.length !== 2 ||
      pages.some(
        (p) =>
          p.page >= Math.min(pa, prior[0].fragments[0].page) &&
          p.page <= pb &&
          !p.nativeSectionFontEvidence?.complete
      )
    )
      continue
    const aa = native(a),
      tt = native(tail),
      bb = native(b),
      rr = native(reference),
      firstBody = native(body),
      priorNative = prior.flatMap((u) => native(u) ?? [])
    if (
      !aa ||
      !tt ||
      !bb ||
      !rr ||
      !firstBody ||
      priorNative.length !== prior.reduce((n, u) => n + u.items.length, 0)
    )
      continue
    const font = aa[0].item.height,
      small = Math.min(...aa.map((e) => e.item.height)),
      name = aa[0].item.fontName,
      titleBox = exclusive([a, tail]),
      priorBox = exclusive(prior),
      bodyBox = exclusive([body]),
      bBox = exclusive([b]),
      priorText = prior.map((u) => u.source).join(' ')
    if (
      !titleBox ||
      !priorBox ||
      !bodyBox ||
      !bBox ||
      aa[0].item.str !== 'A' ||
      bb[0].item.str !== 'B' ||
      aa.length < 3 ||
      bb.length < 3 ||
      a.fragments[0].page !== tail.fragments[0].page ||
      body.fragments[0].page !== pa
    )
      continue
    if (
      !/[.!?]$/u.test(priorText) ||
      !/\b(?:18|19|20)\d{2}[a-z]?\b/u.test(priorText) ||
      !/\b(?:arXiv|journal|proceedings|press)\b/iu.test(priorText) ||
      !/\band\b/u.test(priorText) ||
      !priorText.includes(',') ||
      !closedRow(
        priorNative.filter(
          (e) => Math.abs(e.item.transform[5] - priorNative.at(-1)!.item.transform[5]) < font * 0.02
        )
      )
    )
      continue
    if (
      small / font < 0.78 ||
      small / font > 0.82 ||
      [...aa, ...tt, ...bb, ...rr].some(
        (e) =>
          e.item.fontName !== name ||
          Math.min(Math.abs(e.item.height - font), Math.abs(e.item.height - small)) > font * 0.01
      ) ||
      Math.abs(bb[0].item.height - font) > font * 0.01 ||
      Math.abs(aa[0].item.transform[4] - bb[0].item.transform[4]) > font * 0.1 ||
      Math.abs(aa[0].item.transform[4] - rr[0].item.transform[4]) > font * 0.1
    )
      continue
    if (
      !closedRow(aa) ||
      !closedRow(tt) ||
      !closedRow(bb) ||
      aa.some((e) => Math.abs(e.item.transform[5] - aa[0].item.transform[5]) > font * 0.02) ||
      tt.some((e) => Math.abs(e.item.transform[5] - tt[0].item.transform[5]) > font * 0.02) ||
      aa[1].item.transform[4] - aa[0].item.transform[4] - aa[0].item.width < font * 0.5 ||
      Math.abs(tt[0].item.transform[4] - aa[1].item.transform[4]) > font * 0.05 ||
      aa[0].item.transform[5] - tt[0].item.transform[5] < font ||
      aa[0].item.transform[5] - tt[0].item.transform[5] > font * 1.6 ||
      titleBox.y - priorBox.bottom < font ||
      bodyBox.y - titleBox.bottom < font * 0.5 ||
      bodyBox.y - titleBox.bottom > font * 3 ||
      Math.abs(bodyBox.x - aa[0].item.transform[4]) > font * 0.15 ||
      words(body.source) < 8 ||
      !/\b(?:Section|Theorem|Lemma|Proof|Proposition)\b/u.test(body.source)
    )
      continue
    const following = units[units.indexOf(b) + 1]
    if (
      !following ||
      !/^(?:Proof of|Proposition |Lemma |The |This |We )/u.test(following.source) ||
      words(following.source) < 12 ||
      !native(following) ||
      !firstNativeBodyRow(following)
    )
      continue
    const prose = units
      .slice(index + 2, units.indexOf(b))
      .filter(
        (u) =>
          !u.sourceOnly &&
          !u.preserve &&
          u.kind === 'prose-candidate' &&
          !u.risks.length &&
          words(u.source) >= 8 &&
          /^\p{Lu}/u.test(u.source) &&
          /[.!?]$/u.test(u.source) &&
          native(u) &&
          exclusive([u])
      )
    if (prose.length < 3) continue
    for (const u of [a, tail, ...prose]) accepted.add(u.items.join('|'))
  }
  return accepted
}

type ProseInput = {
  extraction: PdfTranslationExtraction
  document: Pick<PDFDocumentProxy, 'getPage' | 'fingerprints' | 'numPages'>
  sourceIdentity: PdfTranslationSourceIdentity
  signal: AbortSignal
}
type ProseOwner = PdfTranslationExtraction['source']['units'][number]
type ProseContent = Awaited<ReturnType<typeof getPdfTranslationTextContent>>
type ProseFrame = {
  page: PDFPageProxy
  number: number
  content: ProseContent
  viewport: ReturnType<PDFPageProxy['getViewport']>
  fonts: Record<string, NativeReferenceFontWitness>
  zeros: Map<number, { page: number; x: number; y: number; width: number; height: number }>
  current: () => boolean
  verify: () => Promise<boolean>
}
const proseStable = (v: unknown): string => JSON.stringify(v)
function proseReferences(value: unknown): () => boolean {
  const seen = new Set<object>(),
    slots: [object, string, object][] = []
  const visit = (v: unknown): void => {
    if (!v || typeof v !== 'object' || seen.has(v)) return
    seen.add(v)
    if (seen.size > 100000) throw Error('Native prose reference budget.')
    if (ArrayBuffer.isView(v)) return
    for (const k of Object.keys(v)) {
      const d = Object.getOwnPropertyDescriptor(v, k)
      if (!d || !('value' in d)) throw Error('Native prose accessor.')
      if (d.value && typeof d.value === 'object') {
        slots.push([v, k, d.value])
        visit(d.value)
      }
    }
  }
  try {
    visit(value)
  } catch {
    return () => false
  }
  return () => slots.every(([o, k, v]) => Object.getOwnPropertyDescriptor(o, k)?.value === v)
}

/** Reprove whole ordinary paragraphs after membership-changing structure work.
 * This local text proof never clears the document's legacy reference anchor. */
export async function restoreNativeOrdinaryAppendixProse(
  input: ProseInput
): Promise<PdfTranslationExtraction> {
  const { extraction, document, sourceIdentity, signal } = input,
    source = extraction.source
  signal.throwIfAborted()
  const headings = source.units.filter((u) => /^[A-Z]\. Appendix$/u.test(u.source))
  if (
    headings.length !== 1 ||
    !Object.isFrozen(source) ||
    new Set(source.units.map((u) => u.id)).size !== source.units.length ||
    !/^[a-f0-9]{64}$/u.test(sourceIdentity.sourceChecksum) ||
    !Number.isSafeInteger(sourceIdentity.sourceSizeBytes) ||
    sourceIdentity.sourceSizeBytes <= 0
  )
    return extraction
  const heading = headings[0],
    hi = source.units.indexOf(heading),
    letter = heading.source[0],
    reference = source.units
      .slice(0, hi)
      .findLast((u) => /^(?:References|Bibliography)$/u.test(u.source)),
    subsection = source.units
      .slice(hi + 1)
      .find((u) => new RegExp('^' + letter + '\\.1\\. \\p{Lu}', 'u').test(u.source)),
    candidates = source.units
      .slice(hi + 1)
      .filter(
        (u) =>
          u.sourceOnly &&
          u.preserve === 'reference' &&
          !u.figure &&
          u.fragments.length === 1 &&
          u.fragments[0].items.length >= 2 &&
          u.fragments[0].items.length <= 8 &&
          (u.source.match(/[A-Za-z]{2,}/gu)?.length ?? 0) >= 14 &&
          /^[A-Z][A-Za-z0-9 ,.'’():;–—-]+[.!?]$/u.test(u.source)
      )
  if (
    !reference ||
    !subsection ||
    !candidates.length ||
    candidates.length > 16 ||
    [heading, reference, subsection].some((u) => u.fragments.length !== 1) ||
    heading.fragments[0].pageNumber <= reference.fragments[0].pageNumber ||
    subsection.fragments[0].pageNumber !== heading.fragments[0].pageNumber
  )
    return extraction
  const startPage = heading.fragments[0].pageNumber,
    endPage = startPage - 1,
    needed = new Set([
      reference.fragments[0].pageNumber,
      endPage,
      startPage,
      ...candidates.map((u) => u.fragments[0].pageNumber)
    ]),
    laterAppendix = source.units.slice(hi + 1).find((u) => /^[A-Z]\. Appendix$/u.test(u.source))
  if (needed.size > 16 || laterAppendix) return extraction
  const sourceKey = proseStable(source),
    identityKey = proseStable(sourceIdentity),
    fingerprintArray = document.fingerprints,
    fingerprint = fingerprintArray[0],
    getPage = document.getPage,
    rootRefs = proseReferences([source, sourceIdentity]),
    frames = new Map<number, ProseFrame>(),
    opened = new Set<PDFPageProxy>()
  const current = (): boolean => {
    signal.throwIfAborted()
    return (
      input.extraction === extraction &&
      extraction.source === source &&
      input.document === document &&
      input.sourceIdentity === sourceIdentity &&
      document.getPage === getPage &&
      document.fingerprints === fingerprintArray &&
      fingerprintArray[0] === fingerprint &&
      source.fingerprint === fingerprint &&
      source.pages.length === document.numPages &&
      rootRefs() &&
      proseStable(source) === sourceKey &&
      proseStable(sourceIdentity) === identityKey
    )
  }
  if (!current()) return extraction
  let accepted: Set<string> | undefined,
    cleanupOk = true
  try {
    for (const number of needed) {
      const page = await document.getPage(number)
      opened.add(page)
      if (!current()) return extraction
      const methods = [page.getTextContent, page.getOperatorList, page.getViewport, page.cleanup],
        ref = page.ref,
        view = page.view,
        common = page.commonObjs,
        commonGet = common?.get,
        commonHas = common?.has,
        readCurrent = (): boolean =>
          current() &&
          page.ref === ref &&
          page.view === view &&
          page.commonObjs === common &&
          common.get === commonGet &&
          common.has === commonHas &&
          [page.getTextContent, page.getOperatorList, page.getViewport, page.cleanup].every(
            (m, i) => m === methods[i]
          )
      if (!common || !readCurrent()) return extraction
      const viewport = page.getViewport({ scale: 1 }),
        expected = source.pages[number - 1]
      if (
        !expected ||
        page.rotate !== 0 ||
        viewport.rotation !== 0 ||
        viewport.width !== expected.width ||
        viewport.height !== expected.height ||
        proseStable(viewport.transform) !== proseStable([1, 0, 0, -1, 0, viewport.height])
      )
        return extraction
      const content = await getPdfTranslationTextContent(page)
      if (!readCurrent()) return extraction
      const before = await nativeInkPageIdentity(page, content, viewport)
      if (!readCurrent() || !before) return extraction
      const fonts = nativeReferenceFontWitnesses(page, content)
      if (!fonts) return extraction
      const operators = await page.getOperatorList()
      if (!readCurrent()) return extraction
      const zeros = await nativeZeroAdvanceRegions(page, content, viewport, number)
      if (!readCurrent()) return extraction
      const fontIds = [
          ...new Set(content.items.flatMap((i) => ('str' in i && i.str.trim() ? [i.fontName] : [])))
        ],
        chars = new Set<string>(),
        walk = (v: unknown): void => {
          if (!v || typeof v !== 'object') return
          if ('fontChar' in v && typeof v.fontChar === 'string') chars.add(v.fontChar)
          if (Array.isArray(v)) for (const child of v) walk(child)
        }
      for (const args of operators.argsArray) walk(args)
      const outlines = fontIds.flatMap((id) =>
          [...chars].flatMap((c) => {
            const key = id + '_path_' + c
            return page.commonObjs.has(key) ? [key] : []
          })
        ),
        sync = nativeInkPageCurrent(page, content, viewport, operators, outlines)
      if (!sync) return extraction
      const refs = proseReferences([content, operators]),
        fontRefs = fontIds.map((id) => [id, common.get(id)] as const),
        frameCurrent = (): boolean =>
          readCurrent() &&
          sync() &&
          refs() &&
          fontRefs.every(([id, font]) => common.get(id) === font),
        verify = async (): Promise<boolean> => {
          if (
            !frameCurrent() ||
            (await document.getPage(number)) !== page ||
            !frameCurrent() ||
            (await page.getOperatorList()) !== operators ||
            !frameCurrent()
          )
            return false
          const after = await nativeInkPageIdentity(page, content, viewport)
          return frameCurrent() && !!after && after.key === before.key
        }
      frames.set(number, {
        page,
        number,
        content,
        viewport,
        fonts,
        zeros,
        current: frameCurrent,
        verify
      })
    }
    const counts = new Map<string, number>()
    for (const u of source.units)
      for (const f of u.fragments)
        for (const i of f.items) {
          const key = f.pageNumber + ':' + i.index
          counts.set(key, (counts.get(key) ?? 0) + 1)
        }
    const own = (
      u: ProseOwner
    ): { frame: ProseFrame; entries: { index: number; item: TextItem }[] } | undefined => {
      if (u.fragments.length !== 1 || !u.fragments[0].items.length || u.fragments[0].unclippedRect)
        return
      const f = u.fragments[0],
        frame = frames.get(f.pageNumber)
      if (!frame) return
      const entries: { index: number; item: TextItem }[] = []
      for (const i of f.items) {
        const item = frame.content.items[i.index]
        if (
          !item ||
          !('str' in item) ||
          item.str !== i.text ||
          !i.text.trim() ||
          counts.get(f.pageNumber + ':' + i.index) !== 1
        )
          return
        entries.push({ index: i.index, item })
      }
      return { frame, entries }
    }
    const horizontal = (i: TextItem, p: ProseFrame): boolean => {
      const f = p.fonts[i.fontName]
      return (
        !!f?.nativeMetrics &&
        i.dir === 'ltr' &&
        i.transform.length === 6 &&
        [...i.transform, i.width, i.height].every(Number.isFinite) &&
        i.width > 0 &&
        i.height > 0 &&
        i.transform[0] === i.height &&
        i.transform[3] === i.height &&
        i.transform[1] === 0 &&
        i.transform[2] === 0
      )
    }
    const nativeBox = (i: TextItem, p: ProseFrame, index: number): Box | undefined => {
      const f = p.fonts[i.fontName]
      if (
        !f ||
        i.transform.length !== 6 ||
        ![...i.transform, i.width, i.height].every(Number.isFinite)
      )
        return
      if (i.width === 0) {
        const z = p.zeros.get(index)
        return z
          ? {
              x: z.x * p.viewport.width,
              right: (z.x + z.width) * p.viewport.width,
              y: z.y * p.viewport.height,
              bottom: (z.y + z.height) * p.viewport.height
            }
          : undefined
      }
      const [a, b, c, d, x, y] = i.transform,
        h = Math.hypot(a, b),
        v = Math.hypot(c, d)
      if (
        i.width <= 0 ||
        i.height <= 0 ||
        h <= 0 ||
        v <= 0 ||
        a * d - b * c <= 0 ||
        Math.abs(a * c + b * d) > h * v * 0.0001
      )
        return
      const ps = [0, i.width].flatMap((u) =>
        [f.descent, f.ascent].map((t) =>
          p.viewport.convertToViewportPoint(x + (a / h) * u + c * t, y + (b / h) * u + d * t)
        )
      )
      return {
        x: Math.min(...ps.map((p) => p[0])),
        right: Math.max(...ps.map((p) => p[0])),
        y: Math.min(...ps.map((p) => p[1])),
        bottom: Math.max(...ps.map((p) => p[1]))
      }
    }
    const exclusive = (u: ProseOwner): Box | undefined => {
      const o = own(u)
      if (!o || o.entries.some((e) => !horizontal(e.item, o.frame))) return
      const bs = o.entries.map((e) => nativeBox(e.item, o.frame, e.index))
      if (bs.some((b) => !b)) return
      const domain = union(bs as Box[]),
        keys = new Set(o.entries.map((e) => e.index))
      if (
        domain.x < 0 ||
        domain.y < 0 ||
        domain.right > o.frame.viewport.width ||
        domain.bottom > o.frame.viewport.height
      )
        return
      for (const [index, i] of o.frame.content.items.entries()) {
        if (!('str' in i) || !i.str.trim() || keys.has(index)) continue
        const b = nativeBox(i, o.frame, index)
        if (!b || overlaps(domain, b)) return
      }
      return domain
    }
    const hr = own(heading),
      rr = own(reference),
      sr = own(subsection),
      hb = exclusive(heading),
      rb = exclusive(reference),
      sb = exclusive(subsection),
      intro = source.units.slice(hi + 1, source.units.indexOf(subsection))
    if (
      !hr ||
      !rr ||
      !sr ||
      !hb ||
      !rb ||
      !sb ||
      hr.entries.length !== 1 ||
      rr.entries.length !== 1 ||
      sr.entries.length !== 1 ||
      intro.length !== 1 ||
      !own(intro[0]) ||
      !exclusive(intro[0])
    )
      return extraction
    const h = hr.entries[0].item,
      r = rr.entries[0].item,
      sh = sr.entries[0].item
    if (
      h.fontName !== r.fontName ||
      h.fontName !== sh.fontName ||
      h.height !== r.height ||
      h.height !== sh.height ||
      Math.abs((hb.x + hb.right) / 2 - hr.frame.viewport.width / 2) > h.height * 0.05 ||
      Math.abs((rb.x + rb.right) / 2 - rr.frame.viewport.width / 2) > r.height * 0.05 ||
      hb.y > hr.frame.viewport.height * 0.16 ||
      sb.y <= hb.bottom ||
      sb.y - hb.bottom > h.height * 9 ||
      intro[0].fragments[0].rect.y <= heading.fragments[0].rect.y ||
      intro[0].fragments[0].rect.y >= subsection.fragments[0].rect.y
    )
      return extraction
    const tail = frames.get(endPage)!,
      visible = tail.content.items.flatMap((i, index) => {
        if (!('str' in i) || !i.str.trim()) return []
        const b = nativeBox(i, tail, index)
        if (!b) throw Error('Incomplete bibliography native bounds.')
        if (i.str === String(endPage) && b.y > tail.viewport.height * 0.9 && i.width < i.height * 2)
          return []
        return [{ item: i, index, box: b }]
      }),
      last = visible.at(-1),
      tailText = visible.map((e) => e.item.str).join(' ')
    if (
      !last ||
      !/\bpp\.\s*\d+[–-]\d+\.$/u.test(last.item.str) ||
      (tailText.match(/\b(?:18|19|20)\d{2}\b/gu)?.length ?? 0) < 3 ||
      (tailText.match(/\bIn:/gu)?.length ?? 0) < 3 ||
      visible.some((e) => counts.get(endPage + ':' + e.index) !== 1) ||
      !(
        last.item.hasEOL ||
        tail.content.items
          .slice(last.index + 1)
          .some((i) => 'str' in i && !i.str.trim() && i.hasEOL)
      )
    )
      return extraction
    const bodyFont = own(intro[0])!.entries[0].item
    accepted = new Set()
    for (const u of candidates) {
      const o = own(u),
        b = exclusive(u)
      if (
        !o ||
        !b ||
        u.fragments[0].pageNumber < startPage ||
        o.entries.map((e) => e.item.str).join(' ') !== u.source ||
        o.entries.some(
          (e) => e.item.fontName !== bodyFont.fontName || e.item.height !== bodyFont.height
        ) ||
        b.right - b.x < o.frame.viewport.width * 0.5
      )
        continue
      const rows: { baseline: number; entries: typeof o.entries }[] = []
      for (const e of o.entries) {
        let row = rows.at(-1)
        if (!row || Math.abs(row.baseline - e.item.transform[5]) > 1e-6) {
          row = { baseline: e.item.transform[5], entries: [] }
          rows.push(row)
        }
        row.entries.push(e)
      }
      if (
        rows.length < 2 ||
        rows.some(
          (row, n) =>
            !row.entries.at(-1)!.item.hasEOL ||
            (n > 0 &&
              (rows[n - 1].baseline - row.baseline <= bodyFont.height ||
                rows[n - 1].baseline - row.baseline > bodyFont.height * 1.6)) ||
            row.entries.some(
              (e, k) =>
                k > 0 &&
                e.item.transform[4] <
                  row.entries[k - 1].item.transform[4] + row.entries[k - 1].item.width
            )
        )
      )
        continue
      accepted.add(u.id)
    }
    if (!accepted.size) return extraction
    for (const frame of frames.values())
      if (!(await frame.verify()) || !current()) return extraction
  } catch {
    signal.throwIfAborted()
    return extraction
  } finally {
    for (const page of opened) {
      try {
        await Promise.resolve(page.cleanup())
      } catch {
        cleanupOk = false
      }
    }
  }
  // Cleanup is the final await; no promise may intervene before immutable publication.
  if (
    !cleanupOk ||
    !accepted?.size ||
    !current() ||
    ![...frames.values()].every((f) => f.current())
  )
    return extraction
  const restored = carryNativeCaptionEligibility(
    source,
    createPdfTranslationSource({
      ...source,
      units: source.units.map((u) => {
        if (!accepted!.has(u.id)) return u
        const next = { ...u }
        delete next.sourceOnly
        delete next.preserve
        return next
      })
    })
  )
  rememberNativeOrdinaryProseEligibility(restored, accepted)
  return Object.freeze({ ...extraction, source: restored })
}
