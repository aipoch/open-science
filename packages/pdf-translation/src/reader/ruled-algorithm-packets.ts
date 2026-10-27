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
