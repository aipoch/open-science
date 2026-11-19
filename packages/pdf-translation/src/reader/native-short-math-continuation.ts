import type { PDFPageProxy } from 'pdfjs-dist'
import type { PdfTranslationSource } from './source.js'
import { nativeMathAtom } from './native-display-packets.js'
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
  content.items.some((i) => 'str' in i && i.str === '∑') &&
  content.items.some((i) => 'str' in i && /^[A-Z][a-z]{1,3}$/u.test(i.str))
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
    if (!identity || !nativeReferenceFontWitnesses(page, content)) return units
    const plans = shortMathContinuationPlans(units, identity.content, pageNumber)
    if (
      key !== JSON.stringify(units) ||
      identity.key !== (await nativeInkPageIdentity(page, content, viewport))?.key ||
      !nativeReferenceFontWitnesses(page, content)
    )
      return units
    return applyShortMathContinuationPlans(units, plans, viewport)
  } catch {
    return units
  }
}
