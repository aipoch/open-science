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
    // A pair of column displays can contain repeated undecoded delimiters and
    // raised/lowered labels. Prove the full paired fraction within each row.
    const columnDisplays = native.flatMap((run, at) => {
      const number = Number(marker.exec(run.item.str)?.[1])
      const owner = run.owner?.unit
      const [, , , h, x, y] = run.item.transform
      if (!number || !owner?.sourceOnly || owner.preserve !== 'formula' || !upright(run.item))
        return []
      const band = (item: PdfLayoutTextItem): boolean => Math.abs(item.transform[5] - y) < h * 1.5
      let start = at
      while (start > 0 && at - start < 40 && band(native[start - 1].item)) start--
      const packet = native.slice(start, at + 1)
      const controls = packet.filter(({ item }) => hasEncodedControl(item.str))
      const [open, close, repeatedOpen, repeatedClose] = controls
      const left = Math.min(...packet.map(({ item }) => item.transform[4]))
      if (
        packet.length < 20 ||
        packet.length >= 40 ||
        controls.length !== 4 ||
        controls.map(({ item }) => item.str).join('') !== '\u0012\u0013\u0012\u0013' ||
        controls.some(
          ({ item, index, owner }) =>
            !unreliable.has(key(index)) ||
            !owner?.unit.sourceOnly ||
            owner.unit.preserve !== 'formula' ||
            item.fontName !== open.item.fontName ||
            item.transform[5] - y < h * 1.2
        ) ||
        left >= x - h * 12 ||
        packet.some(
          ({ item, owner }) =>
            !upright(item) ||
            owner?.text !== item.str ||
            item.transform[4] > x ||
            item.height < h * 0.45 ||
            item.height > h * 1.05 ||
            (item.str.match(/\p{L}{2,}/gu) ?? []).some(
              (word) => !/^(?:sgn|in|out|[A-Z]{2})$/u.test(word)
            ) ||
            !/^[\p{L}\p{N}\p{M}\p{Sm}\p{P}\p{Cc} ]+$/u.test(item.str)
        )
      )
        return []
      const between = (a: typeof run, b: typeof run): (typeof run)[] =>
        packet.filter(({ index }) => index > a.index && index < b.index)
      const text = (runs: readonly (typeof run)[]): string =>
        runs.map(({ item }) => item.str).join(' ')
      const derivatives = (a: typeof run, b: typeof run): (typeof run)[] =>
        between(a, b).filter(
          ({ item }) =>
            item.str.startsWith('∂') &&
            item.transform[4] >= a.item.transform[4] + a.item.width &&
            item.transform[4] + item.width <= b.item.transform[4]
        )
      const firstLabels = between(close, repeatedOpen)
      const secondLabels = packet.slice(packet.indexOf(repeatedClose) + 1)
      const fractions = [derivatives(open, close), derivatives(repeatedOpen, repeatedClose)]
      const attachedLabels = (
        delimiter: typeof run,
        upper: typeof run,
        lower: typeof run
      ): boolean => {
        const edge = delimiter.item.transform[4] + delimiter.item.width
        const offset = upper.item.transform[4] - edge
        return (
          upper.item.fontName === lower.item.fontName &&
          Math.abs(upper.item.height - lower.item.height) < h * 0.05 &&
          upper.item.height >= h * 0.6 &&
          upper.item.height <= h * 0.8 &&
          offset >= 0 &&
          offset < h * 0.5 &&
          Math.abs(upper.item.transform[4] - lower.item.transform[4]) < h * 0.05 &&
          upper.item.transform[5] - y > h &&
          y - lower.item.transform[5] > h * 0.75
        )
      }
      if (
        !/^\p{L} \p{L} =\s*(?:− )?sgn$/u.test(text(packet.slice(0, packet.indexOf(open)))) ||
        !/^in [A-Z]{2} ≡\s*(?:− )?sgn$/u.test(text(firstLabels)) ||
        !/^out [A-Z]{2} [.,] \(\d+\)$/u.test(text(secondLabels)) ||
        firstLabels[0]?.item.str !== 'in' ||
        secondLabels[0]?.item.str !== 'out' ||
        !firstLabels[1] ||
        !secondLabels[1] ||
        firstLabels[1].item.str !== secondLabels[1].item.str ||
        !attachedLabels(close, firstLabels[0], firstLabels[1]) ||
        !attachedLabels(repeatedClose, secondLabels[0], secondLabels[1]) ||
        fractions.some(
          ([above, below, ...rest]) =>
            !above ||
            !below ||
            rest.length > 0 ||
            above.item.transform[5] - y < h * 0.5 ||
            y - below.item.transform[5] < h * 0.5
        ) ||
        text(fractions[0]) !== text(fractions[1])
      )
        return []
      const selected = new Set(packet.map(({ index }) => index))
      const complete = new Set(packet.map(({ owner }) => owner!.unit))
      if (
        native.some(
          ({ item, index }) =>
            !selected.has(index) &&
            band(item) &&
            item.transform[4] < x + run.item.width &&
            item.transform[4] + item.width > left
        ) ||
        [...complete].some(
          (unit) =>
            unit.figure ||
            unit.referenceBoundary ||
            unit.fragments.some(
              (fragment) =>
                fragment.pageNumber !== page.page ||
                fragment.items.some(({ index }) => !selected.has(index))
            )
        )
      )
        return []
      return [{ number, x: x + run.item.width, y, h, font: run.item.fontName, complete }]
    })
    for (const display of columnDisplays) {
      if (
        !columnDisplays.some(
          (other) =>
            Math.abs(other.number - display.number) === 1 &&
            display.font === other.font &&
            Math.abs(display.x - other.x) < display.h * 0.08 &&
            Math.abs(display.h - other.h) < display.h * 0.05 &&
            (display.y - other.y) * (other.number - display.number) > display.h * 2.8 &&
            Math.abs(display.y - other.y) < display.h * 4
        )
      )
        continue
      for (const unit of display.complete)
        if (!unit.sourceOnly && !unit.preserve) result.add(unit.id)
    }
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
