import type { PDFPageProxy } from 'pdfjs-dist'
import type { PdfTranslationSource } from './source.js'
import { nativeClosedMathGrammar, nativeMathAtom } from './native-display-packets.js'
import { nativeDisplayNumber, nativeReferenceFontWitnesses } from './native-reference-evidence.js'
import { nativeInkPageIdentity } from './auxiliary-native-ink.js'
type Unit = PdfTranslationSource['units'][number]
type Content = Awaited<ReturnType<PDFPageProxy['getTextContent']>>
type Item = Extract<Content['items'][number], { str: string }>
type Entry = { item: Item; index: number; owner: Unit }
/** A cheap request gate, never evidence that any owner is mathematical. */
export function hasNativeLiteralMathCandidate(content: Content): boolean {
  const text = content.items.flatMap((i) => ('str' in i ? [i.str] : []))
  return (
    text.some((s) => nativeDisplayNumber(s)) ||
    (text.includes('∇') && text.includes('∑')) ||
    (text.includes('min') && text.includes('\u0000') && text.includes('\u0001'))
  )
}
// A lowered membership domain belongs to the centred minimum it bounds.
function minimumDomainPacket(entries: Entry[], at: number): Entry[] | undefined {
  const minimum = entries[at],
    label = entries[at - 1],
    lead =
      /^\(\d{1,3}\.\d{1,3}\)$/u.test(label?.item.str ?? '') &&
      label.owner.sourceOnly &&
      label.owner.preserve === 'formula' &&
      label.item.fontName === minimum.item.fontName &&
      label.item.transform[5] === minimum.item.transform[5]
        ? entries[at - 2]
        : label,
    [variable, member, set, minus, removed, opening] = entries.slice(at + 1, at + 7),
    h = minimum.item.height,
    y = minimum.item.transform[5],
    lower = [variable, member, set, minus, removed]
  if (
    !lead ||
    !opening ||
    !/\bminimum in$/u.test(lead.item.str) ||
    !lead.item.hasEOL ||
    lead.item.fontName !== minimum.item.fontName ||
    lead.item.transform[5] - y <= h * 1.5 ||
    lead.item.transform[5] - y >= h * 2.2 ||
    !/^[a-z]$/u.test(variable.item.str) ||
    member.item.str !== '∈' ||
    !/^[A-Z]$/u.test(set.item.str) ||
    minus.item.str !== '\\' ||
    !/^[A-Z]$/u.test(removed.item.str) ||
    removed.item.str === set.item.str ||
    opening.item.str !== '\u0000' ||
    minimum.item.transform[4] - lead.item.transform[4] < h * 4 ||
    lower.some(
      ({ item }, n) =>
        item.height <= h * 0.6 ||
        item.height >= h * 0.8 ||
        Math.abs(item.transform[5] - variable.item.transform[5]) > h * 0.05 ||
        (n > 0 &&
          item.transform[4] < lower[n - 1].item.transform[4] + lower[n - 1].item.width - h * 0.05)
    ) ||
    y - variable.item.transform[5] <= h * 0.6 ||
    y - variable.item.transform[5] >= h * 0.8
  )
    return
  const left = variable.item.transform[4],
    right = removed.item.transform[4] + removed.item.width,
    middle = minimum.item.transform[4] + minimum.item.width / 2,
    closeOffset = entries.slice(at + 7, at + 34).findIndex(({ item }) => item.str === '\u0001'),
    closing = at + 7 + closeOffset
  if (
    Math.abs((left + right) / 2 - middle) > h * 0.1 ||
    right - left >= h * 2.5 ||
    opening.item.transform[4] - right < 0 ||
    opening.item.transform[4] - right > h * 0.25 ||
    closeOffset < 0
  )
    return
  const enclosed = entries.slice(at + 7, closing),
    end = entries[closing],
    after = entries[closing + 1]
  if (
    enclosed.length < 5 ||
    !after ||
    !/^is attained\b/u.test(after.item.str) ||
    y - after.item.transform[5] <= h * 1.5 ||
    y - after.item.transform[5] >= h * 2.6 ||
    opening.item.fontName !== end.item.fontName ||
    Math.abs(opening.item.transform[5] - end.item.transform[5]) > h * 0.05 ||
    Math.abs(opening.item.height - h) > h * 0.05 ||
    opening.item.transform[5] - y <= h * 0.6 ||
    opening.item.transform[5] - y >= h ||
    ![opening, ...enclosed, end].every(
      ({ owner }) => owner.sourceOnly && owner.preserve === 'formula'
    ) ||
    enclosed.some(
      ({ item }) =>
        Math.abs(item.transform[5] - y) > h * 0.05 ||
        item.transform[4] < opening.item.transform[4] ||
        item.transform[4] + item.width > end.item.transform[4] + h * 0.05
    )
  )
    return
  return entries.slice(at, closing + 1)
}

/** Negative selection only. It leaves every source owner, item and rectangle unchanged. */
export function nativeLiteralMathCandidates(
  units: readonly Unit[],
  content: Content,
  pageNumber: number
): ReadonlySet<string> {
  const result = new Set<string>(),
    owners = new Map<number, Unit>(),
    counts = new Map<number, number>(),
    texts = new Map<number, string>()
  for (const u of units)
    for (const f of u.fragments)
      if (f.pageNumber === pageNumber)
        for (const i of f.items) {
          owners.set(i.index, u)
          counts.set(i.index, (counts.get(i.index) ?? 0) + 1)
          texts.set(i.index, i.text)
        }
  const entries: Entry[] = content.items.flatMap((i, index) =>
    'str' in i && i.str.trim() ? [{ item: i, index, owner: owners.get(index)! }] : []
  )
  if (
    entries.some((e) => !e.owner || counts.get(e.index) !== 1 || texts.get(e.index) !== e.item.str)
  )
    return result
  const admit = (packet: Entry[], anchor?: Entry): void => {
    const math = packet.filter((e) => e !== anchor),
      h = anchor?.item.height ?? packet[0].item.height,
      selected = new Set(packet.map((e) => e.index)),
      whole = [...new Set(packet.map((e) => e.owner))]
    if (
      !nativeClosedMathGrammar(
        math.map((e) => e.item),
        h
      ) ||
      whole.some(
        (o) =>
          o.source.normalize('NFKC').replace(/\s/gu, '') !==
            o.fragments
              .flatMap((f) => f.items.map((i) => i.text))
              .join('')
              .normalize('NFKC')
              .replace(/\s/gu, '') ||
          o.fragments.some(
            (f) => f.pageNumber !== pageNumber || f.items.some((i) => !selected.has(i.index))
          ) ||
          (o.preserve && !['formula', 'literal'].includes(o.preserve))
      )
    )
      return
    for (const o of whole) if (!o.sourceOnly && !o.preserve) result.add(o.id)
  }
  for (let at = 0; at < entries.length; at++) {
    const anchor = entries[at],
      i = anchor.item,
      h = i.height,
      x = i.transform[4],
      y = i.transform[5],
      number = nativeDisplayNumber(i.str),
      blank = content.items[anchor.index + 1]
    if (
      number &&
      (i.hasEOL || (blank && 'str' in blank && blank.str === '' && blank.hasEOL)) &&
      anchor.owner.fragments.length === 1
    ) {
      // Canonical neighboring equation numbers must agree at the printed right margin.
      if (
        !entries.some((e) => {
          const n = nativeDisplayNumber(e.item.str)
          return (
            n &&
            n.roman === number.roman &&
            Math.abs(n.value - number.value) === 1 &&
            Math.abs(e.item.transform[4] + e.item.width - x - i.width) < h * 0.05
          )
        })
      )
        continue
      let first = at
      while (first > 0) {
        const p = entries[first - 1].item
        if (
          Math.abs(p.transform[5] - y) > h * 5 ||
          p.transform[4] + p.width > x + i.width + h * 0.1 ||
          nativeDisplayNumber(p.str) ||
          !nativeMathAtom(p, h)
        )
          break
        first--
      }
      const equals = entries
        .slice(first, at)
        .filter((e) => e.item.str === '=' && Math.abs(e.item.height - h) < h * 0.05)
      let end = at + 1,
        previousY = y
      while (end < entries.length) {
        const s = entries[end].item
        if (
          s.str !== '=' ||
          Math.abs(s.height - h) >= h * 0.05 ||
          !equals.some((e) => Math.abs(e.item.transform[4] - s.transform[4]) < h * 0.05) ||
          previousY - s.transform[5] < h * 0.75 ||
          previousY - s.transform[5] > h * 3 ||
          y - s.transform[5] > h * 5
        )
          break
        let next = end + 1
        while (next < entries.length) {
          const t = entries[next].item
          if (t.str === '=' && Math.abs(t.transform[4] - s.transform[4]) < h * 0.05) break
          if (
            !nativeMathAtom(t, h) ||
            nativeDisplayNumber(t.str) ||
            Math.abs(t.transform[5] - s.transform[5]) > h * 1.5 ||
            t.transform[4] < s.transform[4] - h * 0.05 ||
            t.transform[4] + t.width >= x - h
          )
            break
          next++
        }
        const outside = entries[next]?.item
        if (
          next - end < 3 ||
          (outside &&
            !nativeDisplayNumber(outside.str) &&
            !nativeMathAtom(outside, h) &&
            Math.abs(outside.transform[5] - s.transform[5]) <= h * 1.5 &&
            outside.transform[4] >= s.transform[4] - h * 0.05 &&
            outside.transform[4] + outside.width < x - h)
        )
          break
        end = next
        previousY = s.transform[5]
      }
      admit(entries.slice(first, end), anchor)
    }
    if (i.str === 'min') {
      const packet = minimumDomainPacket(entries, at)
      if (packet) admit(packet)
    }
    if (i.str === '∇' && anchor.owner.sourceOnly && anchor.owner.preserve === 'formula') {
      let end = at + 1
      while (end < entries.length && end - at < 128) {
        const t = entries[end].item
        if (
          !nativeMathAtom(t, h) ||
          nativeDisplayNumber(t.str) ||
          Math.abs(t.transform[5] - y) > h * 1.6 ||
          t.transform[4] < x - h * 0.1
        )
          break
        end++
      }
      const packet = entries.slice(at, end),
        sum = packet.find(
          (e) => e.item.str === '∑' && e.owner.sourceOnly && e.owner.preserve === 'formula'
        )
      if (
        sum &&
        sum.index - anchor.index < 32 &&
        packet.length >= 12 &&
        /[)\].]$/u.test(packet.at(-1)!.item.str)
      )
        admit(packet)
    }
  }
  return result
}
export async function nativeLiteralMathOwners(
  units: readonly Unit[],
  page: PDFPageProxy,
  content: Content,
  viewport: ReturnType<PDFPageProxy['getViewport']>,
  pageNumber: number
): Promise<ReadonlySet<string>> {
  const empty = new Set<string>()
  try {
    if (
      viewport.scale !== 1 ||
      viewport.rotation !== 0 ||
      !nativeReferenceFontWitnesses(page, content)
    )
      return empty
    const snapshot = JSON.stringify(units),
      identity = await nativeInkPageIdentity(page, content, viewport)
    if (!identity) return empty
    const result = nativeLiteralMathCandidates(units, identity.content, pageNumber)
    return snapshot === JSON.stringify(units) &&
      identity.key === (await nativeInkPageIdentity(page, content, viewport))?.key &&
      nativeReferenceFontWitnesses(page, content)
      ? result
      : empty
  } catch {
    return empty
  }
}
