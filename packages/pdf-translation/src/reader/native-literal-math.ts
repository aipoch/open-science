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

const logarithmOperator = /^(?:\d+ )?log$/u

// The printed number and the protected left side bound a display whose logarithm
// may otherwise be sent to translation separately from its lowered base.
function numberedLogarithmOwner(entries: Entry[], at: number, page: number): Unit | undefined {
  const anchor = entries[at],
    label = anchor.item,
    h = label.height,
    [, , , , right, baseline] = label.transform
  if (!anchor.owner.sourceOnly || anchor.owner.preserve !== 'formula') return
  const number = nativeDisplayNumber(label.str)!
  if (
    !entries.some(({ item, owner }) => {
      const other = nativeDisplayNumber(item.str)
      return (
        other &&
        owner.sourceOnly &&
        owner.preserve === 'formula' &&
        other.roman === number.roman &&
        Math.abs(other.value - number.value) === 1 &&
        Math.abs(item.transform[4] - right) < h * 0.05 &&
        Math.abs(item.transform[5] - baseline) > h * 2
      )
    })
  )
    return

  let first = at
  while (first > 0 && at - first < 48) {
    const item = entries[first - 1].item
    if (
      item.hasEOL ||
      item.transform[4] >= right ||
      Math.abs(item.transform[5] - baseline) >= h * 1.15
    )
      break
    first--
  }
  const packet = entries.slice(first, at)
  const offset = packet.findIndex(({ item }) => logarithmOperator.test(item.str))
  if (offset < 2 || packet.length < offset + 4) return
  const operator = packet[offset],
    base = packet[offset + 1].item
  const operand = packet[offset + 2].item
  const relation = packet.slice(0, offset).find(({ item }) => /^[=≡]$/u.test(item.str))
  const gap = (next: Item, prev: Item): number => next.transform[4] - prev.transform[4] - prev.width
  if (
    !relation?.owner.sourceOnly ||
    relation.owner.preserve !== 'formula' ||
    !packet[0].owner.sourceOnly ||
    packet[0].owner.preserve !== 'formula' ||
    operator.owner.sourceOnly ||
    operator.owner.preserve ||
    Math.abs(operator.item.transform[5] - baseline) >= h * 0.05 ||
    base.str !== '2' ||
    base.fontName === operator.item.fontName ||
    base.height < h * 0.6 ||
    base.height > h * 0.8 ||
    baseline - base.transform[5] <= h * 0.1 ||
    baseline - base.transform[5] >= h * 0.4 ||
    gap(base, operator.item) < -h * 0.02 ||
    gap(base, operator.item) > h * 0.1 ||
    !/^[\p{Script=Greek}∥∑(]/u.test(operand.str) ||
    gap(operand, base) < 0 ||
    gap(operand, base) >= h * 0.4 ||
    !/^[,.]$/u.test(packet.at(-1)!.item.str) ||
    gap(label, packet.at(-1)!.item) < h * 4 ||
    packet.some(
      ({ item, owner }) =>
        !nativeMathAtom(item, h) &&
        !(item.str === 'Tr' && owner.sourceOnly && owner.preserve === 'formula')
    )
  )
    return

  const owned = packet.filter(({ owner }) => owner === operator.owner)
  const [fragment] = operator.owner.fragments
  if (
    operator.owner.fragments.length !== 1 ||
    fragment.pageNumber !== page ||
    owned.length !== fragment.items.length ||
    operator.owner.source.replace(/\s/gu, '') !==
      owned
        .map(({ item }) => item.str)
        .join('')
        .replace(/\s/gu, '')
  )
    return
  return operator.owner
}

// A named operator shares the display's baseline while its argument occupies
// the raised and lowered tiers of a protected native delimiter pair.
function numberedExponentialOwner(entries: Entry[], at: number): Unit | undefined {
  const anchor = entries[at],
    label = anchor.item,
    h = label.height
  if (!anchor.owner.sourceOnly || anchor.owner.preserve !== 'formula') return
  const baseline = label.transform[5]
  const packet = entries.slice(Math.max(0, at - 64), at)
  const sameBaseline = (entry: Entry): boolean =>
    Math.abs(entry.item.transform[5] - baseline) < h * 0.05
  const offset = packet.findLastIndex((entry) => entry.item.str === 'exp' && sameBaseline(entry))
  if (offset < 1) return
  const operator = packet[offset],
    open = packet[offset + 1],
    sign = packet[offset + 2]
  if (!open || !sign) return
  const argument = packet.slice(offset + 2).findIndex((entry) => entry.owner !== sign.owner)
  if (argument < 3 || argument > 12) return
  const end = offset + 2 + argument,
    close = packet[end],
    comma = packet.at(-1)!
  const contents = packet.slice(offset + 2, end)
  const loneFormula = (entry: Entry): boolean =>
    entry.owner.sourceOnly === true &&
    entry.owner.preserve === 'formula' &&
    entry.owner.fragments.length === 1 &&
    entry.owner.fragments[0].items.length === 1
  if (
    operator.owner.sourceOnly ||
    operator.owner.preserve ||
    operator.owner.source !== 'exp' ||
    operator.owner.fragments.length !== 1 ||
    operator.owner.fragments[0].items.length !== 1 ||
    open.item.str !== '\u0010' ||
    close.item.str !== '\u0011' ||
    !loneFormula(open) ||
    !loneFormula(close) ||
    open.item.fontName !== close.item.fontName ||
    [operator, open, close].some((entry) => Math.abs(entry.item.height - h) > h * 0.05) ||
    open.item.transform[5] - baseline < h * 0.85 ||
    open.item.transform[5] - baseline > h * 1.4 ||
    Math.abs(open.item.transform[5] - close.item.transform[5]) > h * 0.05 ||
    open.item.transform[4] - operator.item.transform[4] - operator.item.width < 0 ||
    open.item.transform[4] - operator.item.transform[4] - operator.item.width > h * 0.3 ||
    sign.item.str !== '−' ||
    !sameBaseline(sign) ||
    !sign.owner.sourceOnly ||
    sign.owner.preserve !== 'formula' ||
    sign.owner.fragments.length !== 1 ||
    sign.owner.fragments[0].items.length !== contents.length ||
    contents.some(
      (entry) =>
        entry.item.transform[4] < open.item.transform[4] + open.item.width - h * 0.05 ||
        entry.item.transform[4] + entry.item.width > close.item.transform[4] + h * 0.05
    ) ||
    !contents.some((entry) => entry.item.transform[5] - baseline > h * 0.45) ||
    !contents.some((entry) => baseline - entry.item.transform[5] > h * 0.45) ||
    comma.item.str !== ',' ||
    !sameBaseline(comma) ||
    label.transform[4] - comma.item.transform[4] - comma.item.width < h * 4 ||
    !packet.slice(0, offset).some((entry) => /=$/u.test(entry.item.str) && sameBaseline(entry))
  )
    return
  return operator.owner
}

// The consecutive glyphs of a relation centered under a protected display sum
// are its lower limit. The full-size term on the sum's right confirms the row.
function loweredSummationLimit(entries: Entry[], at: number, page: number): Unit | undefined {
  const [anchor, first] = entries.slice(at, at + 2)
  const sum = anchor.item
  const h = sum.height
  const [, , , , x, y] = sum.transform
  const limit = first?.owner
  const [fragment] = limit?.fragments ?? []
  if (
    !anchor.owner.sourceOnly ||
    anchor.owner.preserve !== 'formula' ||
    anchor.owner.fragments.length !== 1 ||
    anchor.owner.fragments[0].items.length !== 1 ||
    !first ||
    !limit ||
    !fragment ||
    limit.sourceOnly ||
    limit.preserve ||
    limit.fragments.length !== 1 ||
    fragment.pageNumber !== page ||
    fragment.items.length < 2 ||
    fragment.items.length > 7
  )
    return
  const parts = entries.slice(at + 1, at + 1 + fragment.items.length)
  const term = entries[at + 1 + fragment.items.length]
  if (!term) return
  const last = parts.at(-1)!.item
  const limitText = parts.map(({ item }) => item.str).join('')
  const simple =
    parts.length === 3 &&
    /^[A-Za-z][∈∼][A-Za-z]$/u.test(limitText) &&
    parts.every(({ item }) => item.str.length === 1) &&
    first.item.fontName === last.fontName &&
    parts[1].item.fontName !== first.item.fontName
  const compound =
    /^[A-Za-z]∈[A-Za-z](?:[a-z]{2}∩[A-Z]|\\\{[a-z]\}|:[a-z]∈[A-Z])?$/u.test(limitText) &&
    first.item.fontName !== parts[1].item.fontName
  if (
    !(simple || compound) ||
    limit.source.replace(/\s/gu, '') !== limitText ||
    ![anchor, ...parts, term].every(
      ({ item }) =>
        item.dir === 'ltr' &&
        item.width > 0 &&
        item.height > 0 &&
        item.transform.every(Number.isFinite) &&
        item.transform[0] > 0 &&
        item.transform[1] === 0 &&
        item.transform[2] === 0 &&
        item.transform[3] > 0
    )
  )
    return
  const limitY = first.item.transform[5]
  const right = last.transform[4] + last.width
  const wide = !simple && compound
  const edge = wide ? Math.max(x + sum.width, right) : x + sum.width
  if (
    parts.some((entry, n) => {
      const previous = parts[n - 1]?.item
      const { item } = entry
      const drop = limitY - item.transform[5]
      const loweredIndex =
        wide &&
        /^[a-z]{2}$/u.test(item.str) &&
        item.fontName !== first.item.fontName &&
        item.height >= h * 0.58 &&
        item.height <= h * 0.63 &&
        drop >= h * 0.08 &&
        drop <= h * 0.12
      return (
        entry.owner !== limit ||
        fragment.items[n].index !== entry.index ||
        (!loweredIndex &&
          (item.height < h * 0.6 ||
            item.height > h * (wide ? 0.82 : 0.75) ||
            Math.abs(drop) >= h * 0.03)) ||
        (previous &&
          Math.abs(item.transform[4] - previous.transform[4] - previous.width) >= h * 0.08)
      )
    }) ||
    Math.abs((first.item.transform[4] + right) / 2 - (x + sum.width / 2)) >= h * 0.1 ||
    y - limitY <= h * 2 ||
    y - limitY >= h * 2.3 ||
    !term.owner.sourceOnly ||
    !nativeMathAtom(term.item, wide ? h * 1.1 : h) ||
    Math.abs(term.item.height - h * (wide ? 1.1 : 1)) >= h * 0.05 ||
    Math.abs(y - term.item.transform[5] - h * 0.95) >= h * 0.06 ||
    term.item.transform[4] < edge - (wide ? h * 0.03 : 0) ||
    term.item.transform[4] >= edge + h * (wide ? 0.4 : 0.25)
  )
    return
  return limit
}

// A protected integral can leave the nested scripts of its stacked limits in
// writable owners. The first integrand atom proves the inline or display row.
function integralLimitOwners(entries: Entry[], at: number, page: number): Unit[] {
  const [anchor, upper, upperScript, lower, lowerScript, next, after] = entries.slice(at, at + 7)
  if (!next) return []
  const open =
    next.item.str === '(' && next.item.fontName === anchor.item.fontName ? next : undefined
  const body = open ? after : next
  const nativeFormula = (entry: Entry): boolean =>
    entry.owner.sourceOnly === true && entry.owner.preserve === 'formula'
  if (
    !body ||
    ![anchor, upper, body, ...(open ? [open] : [])].every(nativeFormula) ||
    anchor.owner !== upper.owner ||
    !/^[A-Za-z]$/u.test(upper.item.str) ||
    upper.item.str !== lower.item.str ||
    !/^[a-z]{2,5}$/u.test(upperScript.item.str) ||
    !/^\d{1,3}$/u.test(lowerScript.item.str) ||
    upper.item.fontName !== lower.item.fontName ||
    upperScript.item.fontName !== lowerScript.item.fontName ||
    new Set([anchor.item.fontName, upper.item.fontName, upperScript.item.fontName]).size !== 3 ||
    ![anchor, upper, upperScript, lower, lowerScript, next, body].every(
      ({ item }) =>
        item.dir === 'ltr' &&
        item.width > 0 &&
        item.height > 0 &&
        item.transform.every(Number.isFinite) &&
        item.transform[0] > 0 &&
        item.transform[1] === 0 &&
        item.transform[2] === 0 &&
        item.transform[3] > 0
    )
  )
    return []

  const em = anchor.item.height
  const x = ({ item }: Entry): number => item.transform[4]
  const y = ({ item }: Entry): number => item.transform[5]
  const right = (entry: Entry): number => x(entry) + entry.item.width
  const inEm = (delta: number, min: number, max: number): boolean =>
    delta >= em * min && delta <= em * max
  const raised = y(anchor) - y(body)
  const lowered = y(body) - y(lower)
  if (
    !inEm(anchor.item.width, 0.4, 0.68) ||
    !inEm(body.item.height, 0.95, 1.05) ||
    !nativeMathAtom(body.item, em) ||
    !(
      (inEm(raised, 1.25, 1.47) && inEm(lowered, 0.8, 1)) ||
      (!open && inEm(raised, 0.7, 0.9) && inEm(lowered, 0.27, 0.45))
    ) ||
    !inEm(y(anchor) - y(upper), 0.18, 0.33) ||
    !inEm(x(upper) - right(anchor), 0.12, 0.55) ||
    !inEm(x(lower) - right(anchor), -0.08, 0.12) ||
    !inEm(x(next) - right(upperScript), 0.02, 0.35) ||
    (open &&
      (!inEm(open.item.height, 0.95, 1.05) ||
        !inEm(y(open) - y(body), 0.7, 0.9) ||
        !inEm(x(body) - right(open), -0.03, 0.12))) ||
    [
      [upper, upperScript],
      [lower, lowerScript]
    ].some(
      ([base, script]) =>
        !inEm(base.item.height, 0.6, 0.8) ||
        !inEm(script.item.height, 0.4, 0.57) ||
        !inEm(y(base) - y(script), 0.06, 0.16) ||
        !inEm(x(script) - right(base), -0.03, 0.12)
    )
  )
    return []

  const wholeOwner = (parts: Entry[]): Unit | undefined => {
    const { owner } = parts[0]
    const [fragment] = owner.fragments
    return !owner.sourceOnly &&
      !owner.preserve &&
      !owner.figure &&
      !owner.referenceBoundary &&
      owner.fragments.length === 1 &&
      fragment.pageNumber === page &&
      fragment.items.length === parts.length &&
      owner.source.replace(/\s/gu, '') === parts.map(({ item }) => item.str).join('') &&
      parts.every(
        ({ owner: partOwner, index }, offset) =>
          partOwner === owner && fragment.items[offset].index === index
      )
      ? owner
      : undefined
  }
  const upperOwner = wholeOwner([upperScript])
  const lowerOwner = wholeOwner([lower, lowerScript])
  if (!upperOwner || (!lowerOwner && !(nativeFormula(lower) && nativeFormula(lowerScript))))
    return []
  return lowerOwner ? [upperOwner, lowerOwner] : [upperOwner]
}

/** Negative selection only. It leaves every source owner, item and rectangle unchanged. */
export function nativeLiteralMathCandidates(
  units: readonly Unit[],
  content: Content,
  pageNumber: number,
  allFontsHaveMetrics = true
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
      whole.some((o) => {
        const source = o.source.normalize('NFKC').replace(/\s/gu, ''),
          native = o.fragments
            .flatMap((f) => f.items.map((i) => i.text))
            .join('')
            .normalize('NFKC')
            .replace(/\s/gu, '')
        // An already protected formula can serialize stacked fractions using `/`.
        const formattedFraction =
          o.sourceOnly &&
          o.preserve === 'formula' &&
          source.replace(/(?<=[\p{L}\d)])\/(?=[\p{L}\d(])/gu, '') === native
        return (
          (source !== native && !formattedFraction) ||
          o.fragments.some(
            (f) => f.pageNumber !== pageNumber || f.items.some((i) => !selected.has(i.index))
          ) ||
          (o.preserve && !['formula', 'literal'].includes(o.preserve))
        )
      })
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
      const logarithm = numberedLogarithmOwner(entries, at, pageNumber)
      if (logarithm) result.add(logarithm.id)
      if (!allFontsHaveMetrics) continue
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
      const exponential = numberedExponentialOwner(entries, at)
      if (exponential) result.add(exponential.id)
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
      // A preceding prose line may end in inline math. Stop that line's owner
      // at the native break before a separately owned, inset display.
      const lead = entries[first - 1],
        prefix = entries[first]
      if (
        lead &&
        prefix.owner === lead.owner &&
        !lead.owner.sourceOnly &&
        !nativeMathAtom(lead.item, h)
      ) {
        let next = first + 1
        while (next < at && entries[next].owner === lead.owner) next++
        const tail = entries[next - 1].item,
          start = entries[next].item
        if (
          next < at &&
          /[,.:;]$/u.test(tail.str) &&
          Math.abs(lead.item.transform[5] - tail.transform[5]) < h * 0.05 &&
          tail.transform[5] - start.transform[5] > h * 1.5 &&
          tail.transform[5] - start.transform[5] < h * 3 &&
          start.transform[4] < tail.transform[4] - h * 2
        )
          first = next
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
    if (!allFontsHaveMetrics) continue
    if (i.str === '∫') {
      for (const owner of integralLimitOwners(entries, at, pageNumber)) result.add(owner.id)
    }
    if (i.str === '∑') {
      const owner = loweredSummationLimit(entries, at, pageNumber)
      if (owner) result.add(owner.id)
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
    if (viewport.scale !== 1 || viewport.rotation !== 0) return empty
    const allFontsHaveMetrics = !!nativeReferenceFontWitnesses(page, content)
    if (
      !allFontsHaveMetrics &&
      !content.items.some((item) => 'str' in item && logarithmOperator.test(item.str))
    )
      return empty
    const snapshot = JSON.stringify(units),
      identity = await nativeInkPageIdentity(page, content, viewport)
    if (!identity) return empty
    const result = nativeLiteralMathCandidates(
      units,
      identity.content,
      pageNumber,
      allFontsHaveMetrics
    )
    return snapshot === JSON.stringify(units) &&
      identity.key === (await nativeInkPageIdentity(page, content, viewport))?.key &&
      allFontsHaveMetrics === !!nativeReferenceFontWitnesses(page, content)
      ? result
      : empty
  } catch {
    return empty
  }
}
