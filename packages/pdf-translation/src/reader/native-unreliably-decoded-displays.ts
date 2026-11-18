import type { PdfLayoutPage, PdfLayoutTextItem } from './layout.js'
import type { PdfTranslationSource } from './source.js'

type Unit = PdfTranslationSource['units'][number]
const marker = /^\(([1-9]\d{0,2})\)$/u
const hasEncodedControl = (text: string): boolean => /\p{Cc}/u.test(text.replace(/[\t\n\r]/gu, ''))
const mathematicalLetter = /[\u{1d400}-\u{1d7ff}]/u
const symbolicAtom = /^[\u{1d400}-\u{1d7ff}\p{Script=Greek}\p{M}\p{N}\p{Sm}\p{P}\p{Cc}ℎ ¸˜¯ºª]+$/u

function upright(item: PdfLayoutTextItem): boolean {
  const [a, b, c, d] = item.transform
  return (
    item.dir === 'ltr' &&
    item.fontVertical === false &&
    !!item.fontName &&
    item.transform.length === 6 &&
    item.transform.every(Number.isFinite) &&
    Number.isFinite(item.width) &&
    (item.width > 0 || (item.width === 0 && /^[∑∏∫]\p{M}*$/u.test(item.str))) &&
    d > 0 &&
    d === item.height &&
    a > 0 &&
    b === 0 &&
    c === 0
  )
}

/** Withdraw only complete owners of already numbered, visibly symbolic displays.
 * A font's missing map is evidence to keep its ink, never to repair its encoding. */
export function unreliablyDecodedDisplayOwners(
  pages: readonly PdfLayoutPage[],
  units: readonly Unit[],
  unreliable: ReadonlySet<string>
): Set<string> {
  const result = new Set<string>()
  if (!unreliable.size) return result
  const owners = new Map<string, { unit: Unit; text: string } | null>()
  for (const unit of units)
    for (const fragment of unit.fragments)
      for (const item of fragment.items) {
        const key = `${fragment.pageNumber}:${item.index}`
        owners.set(key, owners.has(key) ? null : { unit, text: item.text })
      }

  for (const page of pages) {
    const key = (index: number): string => `${page.page}:${index}`
    if (
      page.rotation !== 0 ||
      !page.items.some((item, index) => unreliable.has(key(index)) && hasEncodedControl(item.str))
    )
      continue
    const native = page.items.flatMap((item, index) =>
      item.str.trim() ? [{ item, index, owner: owners.get(key(index)) }] : []
    )
    const markers = native.flatMap((run, at) => {
      const number = Number(marker.exec(run.item.str)?.[1])
      const owner = run.owner?.unit
      return number &&
        upright(run.item) &&
        owner?.sourceOnly &&
        owner.preserve === 'formula' &&
        owner.source === run.item.str &&
        run.owner?.text === run.item.str &&
        owner.fragments.length === 1 &&
        owner.fragments[0].items.length === 1
        ? [{ ...run, number, at }]
        : []
    })
    for (const { item: mark, number, at, index } of markers) {
      const [, , , h, x, y] = mark.transform
      if (
        x < page.width * 0.86 ||
        y < h * 2 ||
        y > page.height - h * 2 ||
        !markers.some(({ item, number: other, index: nativeIndex }) => {
          const delta = other - number
          const [, , , size, left, baseline] = item.transform
          const distance = (y - baseline) * delta
          return (
            Math.abs(delta) === 1 &&
            Math.sign(nativeIndex - index) === delta &&
            item.fontName === mark.fontName &&
            Math.abs(size - h) < h * 0.05 &&
            Math.abs(left + item.width - x - mark.width) < h * 0.08 &&
            distance > h * 1.4 &&
            distance < h * 7
          )
        })
      )
        continue

      const inDisplay = (item: PdfLayoutTextItem): boolean => {
        const [, , , , left, baseline] = item.transform
        return (
          left >= x - page.width * 0.4 &&
          left + item.width <= x - h * 0.8 &&
          Math.abs(y - baseline) <= h * 1.3
        )
      }
      let start = at
      while (start > 0 && at - start < 64 && inDisplay(native[start - 1].item)) start--
      const packet = native.slice(start, at)
      if (
        packet.length < 8 ||
        packet.length === 64 ||
        packet.filter(({ item }) => mathematicalLetter.test(item.str)).length < 4 ||
        !packet.some(
          ({ item, index, owner }) =>
            owner?.unit.sourceOnly &&
            owner.unit.preserve === 'formula' &&
            hasEncodedControl(item.str) &&
            unreliable.has(key(index)) &&
            Math.abs(item.transform[5] - y) < h * 0.05
        ) ||
        packet.some(({ item, owner }) => {
          const [, , , size, , baseline] = item.transform
          return (
            !owner ||
            owner.text !== item.str ||
            !upright(item) ||
            size < h * 0.6 ||
            size > h * 1.05 ||
            !(
              (symbolicAtom.test(item.str) && !/(?:\p{Script=Greek}\p{M}*){3}/u.test(item.str)) ||
              /^(?:[0-9]+ )?[A-Z]$/u.test(item.str) ||
              (/^(?:min|max)$/u.test(item.str) && size < h * 0.8 && baseline - y > h * 0.2)
            )
          )
        })
      )
        continue
      // A marker can sort ahead of a raised script; prove the physical band also
      // contains no unmatched text, even from outside this serialization interval.
      const selected = new Set(packet.map((run) => run.index))
      const left = Math.min(...packet.map(({ item }) => item.transform[4]))
      if (
        native.some(({ item, index: other }) => {
          const [, , , , x0, y0] = item.transform
          return (
            other !== index &&
            !selected.has(other) &&
            x0 < x &&
            x0 + item.width > left &&
            Math.abs(y - y0) <= h * 1.3
          )
        })
      )
        continue
      const complete = new Set(packet.map(({ owner }) => owner!.unit))
      if (
        [...complete].some(
          (unit) =>
            unit.figure ||
            unit.referenceBoundary ||
            unit.fragments.some(
              (fragment) =>
                fragment.pageNumber !== page.page ||
                fragment.items.some((item) => !selected.has(item.index))
            )
        )
      )
        continue
      for (const unit of complete) if (!unit.sourceOnly && !unit.preserve) result.add(unit.id)
    }
  }
  return result
}
