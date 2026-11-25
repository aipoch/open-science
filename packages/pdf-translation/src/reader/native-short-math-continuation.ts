import type { PDFPageProxy } from 'pdfjs-dist'
import type { PdfTranslationSource } from './source.js'
import { nativeMathAtom, nativePaints } from './native-display-packets.js'
import { nativeReferenceFontWitnesses } from './native-reference-evidence.js'
import { nativeInkPageIdentity } from './auxiliary-native-ink.js'
type Unit = PdfTranslationSource['units'][number]
type Content = Awaited<ReturnType<PDFPageProxy['getTextContent']>>
type Item = Extract<Content['items'][number], { str: string }>
type Entry = { item: Item; index: number; owner: Unit }
type Plan = { prefixId: string; nextId: string; starter: Entry; prefix: Entry[] }
const normalized = (value: string): string => value.normalize('NFKC').replace(/\s/gu, '')
const upright = (item: Item): boolean =>
  item.dir === 'ltr' &&
  typeof item.fontName === 'string' &&
  !!item.fontName &&
  Number.isFinite(item.width) &&
  item.width > 0 &&
  Number.isFinite(item.height) &&
  item.height > 0 &&
  item.transform.length === 6 &&
  item.transform.every(Number.isFinite) &&
  item.transform[0] > 0 &&
  item.transform[3] > 0 &&
  item.transform[1] === 0 &&
  item.transform[2] === 0 &&
  item.transform[0] >= item.height * 0.5 &&
  item.transform[0] <= item.height * 2 &&
  Math.abs(item.transform[3] - item.height) < item.height * 0.01
export const hasNativeShortMathContinuation = (content: Content): boolean =>
  (content.items.some((i) => 'str' in i && i.str === '∑') &&
    content.items.some((i) => 'str' in i && /^[A-Z][a-z]{1,3}$/u.test(i.str))) ||
  ['(a)', '(b)', 'or'].every((text) => content.items.some((i) => 'str' in i && i.str === text)) ||
  (content.items.some((i) => 'str' in i && i.str === '√') &&
    content.items.some(
      (i) =>
        'str' in i &&
        (i.str === 'log' ||
          /^(?:Thus|Hence|Therefore) (?:from|by|using) \(?\d+\.\d+\)?,?$/u.test(i.str))
    ))
const mathText = /^[\p{Script=Latin}\p{Script=Greek}\p{N}\s+\-−=∈∼·|(),.:;'′[\]{}]+$/u
/** One explicit seam class: an existing protected sum followed by its lowered
 * domain, native math face, a short body starter and the next complete body row. */
export function shortMathContinuationPlans(
  units: readonly Unit[],
  content: Content,
  pageNumber: number
): readonly Plan[] {
  const owners = new Map<number, Unit>(),
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
  const entries: Entry[] = content.items.flatMap((item, index) =>
    'str' in item && item.str.trim() ? [{ item, index, owner: owners.get(index)! }] : []
  )
  if (
    entries.some((e) => !e.owner || counts.get(e.index) !== 1 || texts.get(e.index) !== e.item.str)
  )
    return []
  const plans: Plan[] = []
  for (let at = 0; at < units.length - 1; at++) {
    const u = units[at],
      next = units[at + 1]
    if (
      u.sourceOnly ||
      u.preserve ||
      next.sourceOnly ||
      next.preserve ||
      u.fragments.length !== 1 ||
      next.fragments.length !== 1 ||
      u.fragments[0].pageNumber !== pageNumber ||
      next.fragments[0].pageNumber !== pageNumber
    )
      continue
    const owned = entries.filter((e) => e.owner === u),
      following = entries.filter((e) => e.owner === next),
      starter = owned.at(-1),
      first = following[0],
      last = following.at(-1)
    if (
      !starter ||
      !first ||
      !last ||
      owned.length < 3 ||
      !/^[A-Z][a-z]{1,3}$/u.test(starter.item.str) ||
      !u.source.endsWith(' ' + starter.item.str) ||
      !/^[a-z][a-z,;: ]/u.test(first.item.str) ||
      !/[.!?]$/u.test(next.source) ||
      (next.source.match(/[A-Za-z]+/gu) ?? []).length < 4
    )
      continue
    const s = starter.item,
      h = s.height,
      body = s.fontName,
      base = s.transform[5],
      prefix = owned.slice(0, -1),
      full = prefix.filter((e) => e.item.height >= h * 0.85),
      domain = prefix.slice(
        0,
        prefix.findIndex((e) => e.item.height >= h * 0.85)
      ),
      previous = entries[entries.indexOf(prefix[0]) - 1],
      sum = previous?.item
    const boundary = content.items[starter.index + 1],
      lineEnd =
        s.hasEOL || (boundary && 'str' in boundary && boundary.str === '' && boundary.hasEOL)
    if (
      !lineEnd ||
      !sum ||
      sum.str !== '∑' ||
      !previous.owner.sourceOnly ||
      previous.owner.preserve !== 'formula' ||
      previous.owner.fragments.length !== 1 ||
      previous.owner.fragments[0].pageNumber !== pageNumber ||
      previous.owner.fragments[0].items.length !== 1 ||
      Math.abs(sum.height - h) > h * 0.05 ||
      domain.length < 1 ||
      full.length < 1
    )
      continue
    const domainText = domain.map((e) => e.item.str).join(''),
      firstDomain = domain[0].item,
      firstFull = full[0].item
    if (![previous, ...owned, ...following].every((e) => upright(e.item))) continue
    const stack: string[] = []
    let balanced = true
    for (const char of domainText) {
      if ('([{'.includes(char)) stack.push(char)
      else if (
        ')]}'.includes(char) &&
        stack.pop() !== ({ ')': '(', ']': '[', '}': '{' } as Record<string, string>)[char]
      )
        balanced = false
    }
    if (
      stack.length !== 0 ||
      !balanced ||
      !/[∈=]/u.test(domainText) ||
      domain.some(
        (e) =>
          e.item.height < h * 0.6 ||
          e.item.height > h * 0.8 ||
          Math.abs(e.item.transform[5] - firstDomain.transform[5]) > h * 0.05
      ) ||
      Math.abs(firstDomain.transform[4] - sum.transform[4] - sum.width) > h * 0.1 ||
      sum.transform[5] - firstDomain.transform[5] < h * 0.8 ||
      sum.transform[5] - firstDomain.transform[5] > h * 1.3 ||
      base - firstDomain.transform[5] < h * 0.15 ||
      base - firstDomain.transform[5] > h * 0.45
    )
      continue
    if (
      prefix.some(
        (e) =>
          !mathText.test(e.item.str) ||
          e.item.height < h * 0.45 ||
          e.item.height > h * 1.05 ||
          Math.abs(e.item.transform[5] - base) > h * 0.55 ||
          (e.item.height >= h * 0.85 && (e.item.fontName === body || !nativeMathAtom(e.item, h)))
      ) ||
      prefix
        .slice(domain.length)
        .some((e) => e.item.fontName === body && /[A-Za-z]{2,}/u.test(e.item.str)) ||
      Math.abs(firstFull.transform[5] - base) > h * 0.05
    )
      continue
    if (
      prefix.some(
        (e, n) => n > 0 && e.item.transform[4] < prefix[n - 1].item.transform[4] - h * 0.1
      ) ||
      s.transform[4] - prefix.at(-1)!.item.transform[4] - prefix.at(-1)!.item.width < h * 0.15 ||
      s.transform[4] - prefix.at(-1)!.item.transform[4] - prefix.at(-1)!.item.width > h * 0.5
    )
      continue
    if (
      entries[entries.indexOf(starter) + 1] !== first ||
      owned.some((e, n) => entries[entries.indexOf(prefix[0]) + n] !== e) ||
      following.some((e, n) => entries[entries.indexOf(first) + n] !== e)
    )
      continue
    if (
      first.item.fontName !== body ||
      last.item.fontName !== body ||
      Math.abs(first.item.height - h) > h * 0.05 ||
      Math.abs(last.item.height - h) > h * 0.05 ||
      base - first.item.transform[5] < h * 1.1 ||
      base - first.item.transform[5] > h * 1.6 ||
      following.some(
        (e) =>
          (e.item.height >= h * 0.85 &&
            Math.abs(e.item.transform[5] - first.item.transform[5]) > h * 0.05) ||
          (e.item.height < h * 0.85 &&
            Math.abs(e.item.transform[5] - first.item.transform[5]) > h * 0.6)
      )
    )
      continue
    const peers = entries.filter(
      (e) =>
        upright(e.item) &&
        e.owner !== u &&
        e.owner !== next &&
        !e.owner.sourceOnly &&
        !e.owner.preserve &&
        e.item.fontName === body &&
        Math.abs(e.item.height - h) < h * 0.05 &&
        (e.item.str.match(/[A-Za-z]+/gu) ?? []).length >= 8 &&
        Math.abs(e.item.transform[4] - first.item.transform[4]) < h * 0.1 &&
        Math.abs(e.item.transform[4] + e.item.width - s.transform[4] - s.width) < h * 0.1 &&
        Math.abs(e.item.transform[5] - base) < h * 15
    )
    if (
      !peers.length ||
      first.item.transform[4] >= prefix[0].item.transform[4] - h * 4 ||
      last.item.transform[4] + last.item.width > s.transform[4] + s.width + h * 0.1
    )
      continue
    if (
      [u, next].some(
        (o) =>
          normalized(o.source) !==
          normalized(o.fragments.flatMap((f) => f.items.map((i) => i.text)).join(''))
      )
    )
      continue
    plans.push({ prefixId: u.id, nextId: next.id, starter, prefix })
  }
  return plans
}
export function applyShortMathContinuationPlans(
  units: readonly Unit[],
  plans: readonly Plan[],
  viewport: { width: number; height: number }
): readonly Unit[] {
  let result = units
  if (
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  )
    return units
  for (const plan of plans) {
    const u = result.find((u) => u.id === plan.prefixId),
      next = result.find((u) => u.id === plan.nextId)
    if (
      !u ||
      !next ||
      u.sourceOnly ||
      u.preserve ||
      next.sourceOnly ||
      next.preserve ||
      u.fragments.length !== 1 ||
      next.fragments.length !== 1
    )
      continue
    const f = u.fragments[0],
      s = plan.starter.item
    if (
      !Object.values(f.rect).every(Number.isFinite) ||
      f.rect.x < 0 ||
      f.rect.y < 0 ||
      f.rect.width <= 0 ||
      f.rect.height <= 0 ||
      f.rect.x + f.rect.width > 1 ||
      f.rect.y + f.rect.height > 1
    )
      continue
    const right =
        Math.max(...plan.prefix.map((e) => e.item.transform[4] + e.item.width)) / viewport.width,
      x = s.transform[4] / viewport.width
    if (
      right > f.rect.x + f.rect.width ||
      right <= f.rect.x ||
      x < right ||
      x + s.width / viewport.width > f.rect.x + f.rect.width + 0.00001
    )
      continue
    const prefix = {
      ...u,
      source: u.source.slice(0, -s.str.length).trimEnd(),
      sourceOnly: true as const,
      preserve: 'literal' as const,
      fragments: [
        {
          ...f,
          rect: { ...f.rect, width: right - f.rect.x },
          items: f.items.filter((i) => i.index !== plan.starter.index)
        }
      ]
    }
    const continuation = {
      ...next,
      source: s.str + ' ' + next.source,
      fragments: [
        {
          ...f,
          rect: { ...f.rect, x, width: s.width / viewport.width },
          items: [{ index: plan.starter.index, text: s.str }]
        },
        ...next.fragments
      ]
    }
    result = result.map((owner) => (owner === u ? prefix : owner === next ? continuation : owner))
  }
  return result
}
// Keep an original stacked reciprocal in place when its final conjunction is prose.
async function splitDisplayedAlternative(
  units: readonly Unit[],
  page: PDFPageProxy,
  { content, operators, viewport }: NonNullable<Awaited<ReturnType<typeof nativeInkPageIdentity>>>,
  pageNumber: number
): Promise<readonly Unit[]> {
  const read = (claim: { index: number; text: string }): Item | undefined => {
    const item = content.items[claim.index]
    return item && 'str' in item && item.str === claim.text && upright(item) ? item : undefined
  }
  const replacements = new Map<Unit, Unit[]>()
  let paints: Awaited<ReturnType<typeof nativePaints>>
  for (let index = 0; index < units.length - 1; index++) {
    const unit = units[index],
      next = units[index + 1],
      [f] = unit.fragments,
      [g] = next.fragments,
      source = /^\(a\)([A-Za-z])\(([A-Za-z])\)=1\/\(\(\2([+−-])([A-Za-z])\)\)([2-9])or$/u.exec(
        normalized(unit.source)
      )
    if (
      !source ||
      !unit.source.endsWith(' or') ||
      unit.sourceOnly ||
      unit.preserve ||
      unit.figure ||
      unit.referenceBoundary ||
      !next.sourceOnly ||
      next.preserve !== 'formula' ||
      !normalized(next.source).startsWith('(b)' + source[1] + '(' + source[2] + ')=') ||
      unit.fragments.length !== 1 ||
      next.fragments.length !== 1 ||
      f.pageNumber !== pageNumber ||
      g.pageNumber !== pageNumber
    )
      continue
    const native = f.items.map(read),
      alternative = g.items.slice(0, 2).map(read)
    if (
      native.length !== 13 ||
      native.some((i) => !i) ||
      alternative.length !== 2 ||
      alternative.some((i) => !i)
    )
      continue
    const items = native as Item[],
      [marker, fn, open, argument, equals, top, ...tail] = items,
      [left, base, operator, constant, close, power, word] = tail,
      [otherMarker, otherFn] = alternative as Item[],
      h = marker.height,
      y = marker.transform[5],
      near = (a: number, b: number, limit = 0.04): boolean => Math.abs(a - b) < h * limit,
      right = (item: Item): number => item.transform[4] + item.width
    if (
      [marker.str, fn.str, open.str, argument.str, equals.str, top.str].join('') !==
        '(a)' + source[1] + '(' + source[2] + ') =1' ||
      [left.str, base.str, operator.str, constant.str, close.str, power.str, word.str].join('') !==
        '(' + source[2] + source[3] + source[4] + ')' + source[5] + 'or' ||
      word.str !== 'or' ||
      !word.hasEOL ||
      otherMarker.str !== '(b)' ||
      otherFn.str !== fn.str ||
      marker.fontName !== word.fontName ||
      marker.fontName !== otherMarker.fontName ||
      otherFn.fontName !== fn.fontName ||
      !near(marker.transform[4], otherMarker.transform[4], 0.08) ||
      !near(fn.transform[4], otherFn.transform[4]) ||
      !near(y - otherMarker.transform[5], h * 2, 0.1) ||
      [fn, open, argument, equals, word].some(
        (i) => !near(i.height, h) || !near(i.transform[5], y)
      ) ||
      [left, base, operator, constant, close].some(
        (i) => !near(i.height, top.height) || !near(i.transform[5], left.transform[5])
      ) ||
      !near(top.height, h * 0.7) ||
      !near(top.transform[5] - y, h * 0.4, 0.08) ||
      !near(y - left.transform[5], h * 0.4, 0.08) ||
      !near(power.height, h * 0.5) ||
      !near(power.transform[5] - left.transform[5], h * 0.28, 0.08) ||
      !near(power.transform[4], right(close)) ||
      !near((left.transform[4] + right(power)) / 2, top.transform[4] + top.width / 2, 0.15) ||
      word.transform[4] - right(power) < h * 0.25 ||
      word.transform[4] - right(power) > h * 0.65 ||
      [...f.items, ...g.items.slice(0, 2)].some(
        ({ index }, n, list) =>
          n > 0 &&
          (index <= list[n - 1].index ||
            content.items
              .slice(list[n - 1].index + 1, index)
              .some((item) => 'str' in item && item.str.trim()))
      ) ||
      !nativeReferenceFontWitnesses(page, { ...content, items: [...items, otherMarker, otherFn] })
    )
      continue
    paints ??= await nativePaints(operators, viewport, true)
    if (!paints) return units
    const box = [
        f.rect.x * viewport.width,
        f.rect.y * viewport.height,
        (f.rect.x + f.rect.width) * viewport.width,
        (f.rect.y + f.rect.height) * viewport.height
      ],
      others = paints.filter(
        ({ bounds: [x1, y1, x2, y2] }) => x2 > box[0] && x1 < box[2] && y2 > box[1] && y1 < box[3]
      ),
      [bar] = others
    if (
      others.length !== 1 ||
      !bar.plainBlack ||
      (!bar.horizontalRule && bar.path.length !== 0) ||
      bar.bounds[3] - bar.bounds[1] <= 0 ||
      bar.bounds[3] - bar.bounds[1] > h * 0.07 ||
      !near(left.transform[4], bar.bounds[0]) ||
      !near(right(power), bar.bounds[2], 0.08) ||
      bar.bounds[1] < viewport.height - top.transform[5] ||
      bar.bounds[3] > viewport.height - left.transform[5] - left.height * 0.65
    )
      continue
    const cut = word.transform[4] / viewport.width,
      prefixRight = Math.max(bar.bounds[2], right(power)) / viewport.width
    if (prefixRight <= f.rect.x || prefixRight >= cut || cut >= f.rect.x + f.rect.width) continue
    replacements.set(unit, [
      {
        ...unit,
        source: unit.source.slice(0, -3),
        sourceOnly: true,
        preserve: 'formula',
        fragments: [
          {
            ...f,
            items: f.items.slice(0, -1),
            rect: { ...f.rect, width: prefixRight - f.rect.x }
          }
        ]
      },
      {
        ...unit,
        id: unit.id + '-conjunction',
        source: word.str,
        fragments: [
          {
            ...f,
            items: [f.items.at(-1)!],
            rect: { ...f.rect, x: cut, width: f.rect.x + f.rect.width - cut }
          }
        ]
      }
    ])
  }
  return units.flatMap((u) => replacements.get(u) ?? [u])
}

async function splitRadicalContinuation(
  units: readonly Unit[],
  { content, operators, viewport }: NonNullable<Awaited<ReturnType<typeof nativeInkPageIdentity>>>,
  pageNumber: number
): Promise<readonly Unit[]> {
  const edits = new Map<Unit, Unit[]>()
  const read = ({ index, text }: { index: number; text: string }): Item | undefined => {
    const item = content.items[index]
    return item && 'str' in item && item.str === text && upright(item) ? item : undefined
  }
  let paints: Awaited<ReturnType<typeof nativePaints>>
  for (const owner of units) {
    const [first, second] = owner.fragments
    if (
      owner.sourceOnly ||
      owner.preserve ||
      owner.figure ||
      owner.referenceBoundary ||
      owner.fragments.length !== 2 ||
      first.pageNumber !== pageNumber ||
      second.pageNumber !== pageNumber ||
      first.items.length !== 4 ||
      second.items.length !== 1
    )
      continue
    const [lead, left, numerator, denominator, tail] = [...first.items, ...second.items].map(read)
    if (
      !lead ||
      !left ||
      !numerator ||
      !denominator ||
      !tail ||
      !/^[A-Z][\p{L} ,'’()-]{6,}\b[A-Z]{1,5}\s*=$/u.test(lead.str) ||
      left.str !== '|' ||
      !/^[a-z]$/u.test(numerator.str) ||
      !/^[2-9]$/u.test(denominator.str) ||
      !/^(?:Thus|Hence|Therefore) (?:from|by|using) \(?\d+\.\d+\)?,?$/u.test(tail.str) ||
      normalized(owner.source) !==
        normalized(lead.str + left.str + numerator.str + '/' + denominator.str + tail.str)
    )
      continue
    const relevant = content.items
      .slice(first.items[3].index + 1, second.items[0].index)
      .flatMap((item, index) =>
        'str' in item && item.str.trim() ? [{ item, index: first.items[3].index + 1 + index }] : []
      )
    const head = relevant[0],
      end = relevant.at(-1),
      closer = relevant.at(-2)
    if (
      relevant.length < 5 ||
      !head ||
      !end ||
      !closer ||
      head.item.str !== '√' ||
      closer.item.str !== left.str ||
      end.item.str !== '.' ||
      relevant.some(({ item }) => !upright(item) || !/^[a-z\d−+√|. ]+$/u.test(item.str))
    )
      continue
    const separate = units.filter(
      (unit) =>
        unit.sourceOnly &&
        unit.preserve === 'formula' &&
        unit.fragments.length === 1 &&
        unit.fragments[0].pageNumber === pageNumber &&
        unit.fragments[0].items.every(({ index }) =>
          relevant.some((claim) => claim.index === index)
        )
    )
    if (
      separate.length !== 2 ||
      separate[0].source !== '√' ||
      separate[0].fragments[0].items.length !== 1 ||
      separate[0].fragments[0].items[0].index !== head.index ||
      separate[1].fragments[0].items.length !== relevant.length - 1 ||
      separate[1].fragments[0].items.some(
        (claim, index) => claim.index !== relevant[index + 1].index
      )
    )
      continue
    const h = lead.height,
      leftEdge = (i: Item): number => i.transform[4],
      baseline = (i: Item): number => i.transform[5],
      rightEdge = (i: Item): number => leftEdge(i) + i.width,
      near = (a: number, b: number, limit = 0.04): boolean => Math.abs(a - b) < h * limit
    if (
      lead.fontName !== tail.fontName ||
      left.fontName !== closer.item.fontName ||
      !near(h, tail.height) ||
      !near(h, left.height) ||
      !near(h, head.item.height) ||
      !near(leftEdge(lead), leftEdge(tail)) ||
      !near(baseline(lead), baseline(left)) ||
      !near(baseline(lead), baseline(closer.item)) ||
      !near(baseline(lead) - baseline(tail), h * 1.36, 0.12) ||
      !near(leftEdge(left) - rightEdge(lead), h * 0.33, 0.12) ||
      !near(numerator.height, h * 0.7) ||
      !near(denominator.height, numerator.height) ||
      !near(baseline(numerator) - baseline(lead), h * 0.4, 0.08) ||
      !near(baseline(lead) - baseline(denominator), h * 0.35, 0.08) ||
      !near(
        leftEdge(numerator) + numerator.width / 2,
        leftEdge(denominator) + denominator.width / 2
      ) ||
      !near(leftEdge(head.item) - rightEdge(denominator), h * 0.12, 0.08) ||
      !near(baseline(head.item) - baseline(lead), h * 1.19, 0.08)
    )
      continue
    paints ??= await nativePaints(operators, viewport, true)
    if (!paints) return units
    const smallBar = paints.filter(
      ({ bounds: [x1, y1, x2, y2], plainBlack }) =>
        plainBlack &&
        near(x1, leftEdge(denominator)) &&
        near(x2, rightEdge(denominator), 0.08) &&
        y1 >= viewport.height - baseline(numerator) &&
        y2 < viewport.height - baseline(lead) &&
        y2 > y1 &&
        y2 - y1 < h * 0.07
    )
    if (smallBar.length !== 1 || edits.has(owner) || edits.has(separate[1])) continue
    const split = leftEdge(left) / viewport.width,
      endOfLead = rightEdge(lead) / viewport.width,
      endOfFirst = first.rect.x + first.rect.width
    if (endOfLead <= first.rect.x || endOfLead >= split || split >= endOfFirst) continue
    edits.set(owner, [
      {
        ...owner,
        source: lead.str,
        fragments: [
          {
            ...first,
            rect: { ...first.rect, width: endOfLead - first.rect.x },
            items: first.items.slice(0, 1)
          }
        ]
      },
      {
        ...owner,
        id: owner.id + '-radical-coefficient',
        source: left.str + ' ' + numerator.str + '/' + denominator.str,
        sourceOnly: true,
        preserve: 'formula',
        fragments: [
          {
            ...first,
            rect: { ...first.rect, x: split, width: endOfFirst - split },
            items: first.items.slice(1)
          }
        ]
      }
    ])
    edits.set(separate[1], [
      separate[1],
      { ...owner, id: owner.id + '-radical-seam', source: tail.str, fragments: [second] }
    ])
  }
  return units.flatMap((unit) => edits.get(unit) ?? [unit])
}

// Keep a split logarithmic radicand native when a prose owner includes its last glyphs.
async function preserveRadicalLogSeams(
  units: readonly Unit[],
  { content, operators, viewport }: NonNullable<Awaited<ReturnType<typeof nativeInkPageIdentity>>>,
  pageNumber: number
): Promise<readonly Unit[]> {
  const entries = content.items.flatMap((item, index) =>
    'str' in item && item.str.trim() ? [{ item, index }] : []
  )
  const native = new Map<number, string>(
    units.flatMap((u) =>
      u.sourceOnly && u.preserve === 'formula'
        ? u.fragments.flatMap((f) =>
            f.pageNumber === pageNumber ? f.items.map((i) => [i.index, i.text] as const) : []
          )
        : []
    )
  )
  const edits = new Map<Unit, Unit[]>()
  let paints: Awaited<ReturnType<typeof nativePaints>>
  for (const owner of units) {
    const [first, ...rest] = owner.fragments
    if (
      owner.sourceOnly ||
      owner.preserve ||
      owner.figure ||
      owner.referenceBoundary ||
      !rest.length ||
      owner.fragments.some((f) => f.pageNumber !== pageNumber || f.unclippedRect) ||
      first.items[0]?.text !== 'log' ||
      !/^[a-z]$/u.test(first.items[1]?.text ?? '') ||
      normalized(owner.source) !==
        normalized(owner.fragments.flatMap((f) => f.items.map((i) => i.text)).join('')) ||
      !owner.source.startsWith('log ' + first.items[1].text + ' ')
    )
      continue
    const at = entries.findIndex(({ index }) => index === first.items[0].index)
    const [radical, stem, log, argument, next] = entries.slice(Math.max(at - 2, 0), at + 3)
    if (
      at < 2 ||
      !next ||
      radical.item.str !== '√' ||
      !/^[a-z]\/$/u.test(stem.item.str) ||
      log.item.str !== 'log' ||
      argument.index !== first.items[1].index ||
      argument.item.str !== first.items[1].text ||
      native.get(radical.index) !== radical.item.str ||
      native.get(stem.index) !== stem.item.str ||
      ![radical, stem, log, argument].every(({ item }) => upright(item))
    )
      continue
    const h = log.item.height,
      y = log.item.transform[5],
      stemX = stem.item.transform[4],
      right = argument.item.transform[4] + argument.item.width,
      bottom = viewport.height - y
    if (
      Math.abs(stem.item.transform[5] - y) > h * 0.02 ||
      Math.abs(argument.item.transform[5] - y) > h * 0.02 ||
      Math.abs(stemX - radical.item.transform[4] - radical.item.width) > h * 0.06 ||
      radical.item.transform[5] - y < h * 0.8 ||
      radical.item.transform[5] - y > h ||
      stem.item.fontName !== argument.item.fontName
    )
      continue
    paints ??= await nativePaints(operators, viewport, true)
    const rules = paints?.filter(
      ({ hull: [x1, y1, x2, y2], plainBlack, path }) =>
        plainBlack &&
        !path.length &&
        Math.abs(x1 - stemX) < h * 0.06 &&
        Math.abs(x2 - right) < h * 0.06 &&
        y2 > y1 &&
        y2 - y1 < h * 0.07 &&
        y1 > bottom - h * 0.98 &&
        y2 < bottom - h * 0.8
    )
    if (rules?.length !== 1) continue
    const preserved = {
      ...owner,
      sourceOnly: true as const,
      preserve: 'formula' as const
    }
    const shortTail = rest[0].items
    if (
      first.items.length === 2 &&
      rest.length === 1 &&
      shortTail.length === 2 &&
      shortTail[0].text === '.' &&
      /^[A-Z][a-z]{1,7}$/u.test(shortTail[1].text)
    ) {
      edits.set(owner, [preserved])
      continue
    }
    const prose = first.items[2]
    const cut = next.item.transform[4] / viewport.width
    const mathSource = 'log ' + argument.item.str
    const trailingSource = owner.source.slice(mathSource.length + 1)
    if (
      first.items.length !== 3 ||
      prose.index !== next.index ||
      prose.text !== next.item.str ||
      !/^[a-z]{2,} [a-z]{2,}/u.test(prose.text) ||
      !trailingSource.startsWith(prose.text) ||
      !upright(next.item) ||
      Math.abs(next.item.transform[5] - y) > h * 0.02 ||
      next.item.transform[4] - right < h * 0.15 ||
      next.item.transform[4] - right > h * 0.5 ||
      right / viewport.width <= first.rect.x ||
      cut >= first.rect.x + first.rect.width
    )
      continue
    edits.set(owner, [
      {
        ...preserved,
        id: owner.id + '-radicand',
        source: mathSource,
        fragments: [
          {
            ...first,
            items: first.items.slice(0, 2),
            rect: {
              ...first.rect,
              width: right / viewport.width - first.rect.x
            }
          }
        ]
      },
      {
        ...owner,
        source: trailingSource,
        fragments: [
          {
            ...first,
            items: [prose],
            rect: {
              ...first.rect,
              x: cut,
              width: first.rect.x + first.rect.width - cut
            }
          },
          ...rest
        ]
      }
    ])
  }
  return units.flatMap((u) => edits.get(u) ?? [u])
}

export async function nativeShortMathContinuations(
  units: readonly Unit[],
  page: PDFPageProxy,
  content: Content,
  viewport: ReturnType<PDFPageProxy['getViewport']>,
  pageNumber: number
): Promise<readonly Unit[]> {
  try {
    if (
      viewport.scale !== 1 ||
      viewport.rotation !== 0 ||
      JSON.stringify(viewport.transform) !== JSON.stringify([1, 0, 0, -1, 0, viewport.height])
    )
      return units
    const key = JSON.stringify(units),
      identity = await nativeInkPageIdentity(page, content, viewport)
    if (!identity) return units
    const hasSum = identity.content.items.some((i) => 'str' in i && i.str === '∑')
    const plans =
      hasSum && nativeReferenceFontWitnesses(page, content)
        ? shortMathContinuationPlans(units, identity.content, pageNumber)
        : []
    const alternatives = await splitDisplayedAlternative(units, page, identity, pageNumber)
    const radicalContinuations = await splitRadicalContinuation(alternatives, identity, pageNumber)
    const corrected = await preserveRadicalLogSeams(radicalContinuations, identity, pageNumber)
    if (
      key !== JSON.stringify(units) ||
      identity.key !== (await nativeInkPageIdentity(page, content, viewport))?.key ||
      (plans.length && !nativeReferenceFontWitnesses(page, content))
    )
      return units
    return applyShortMathContinuationPlans(corrected, plans, viewport)
  } catch {
    return units
  }
}
