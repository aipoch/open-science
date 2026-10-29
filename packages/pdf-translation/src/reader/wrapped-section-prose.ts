import type { PDFPageProxy } from 'pdfjs-dist'
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
