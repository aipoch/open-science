import type { PdfLayoutPage, PdfLayoutTextItem } from './layout.js'

type Token = {
  item: PdfLayoutTextItem
  index: number
  page: number
  x: number
  y: number
  right: number
}
type Frame = {
  font: string
  height: number
  gutterFont: string
  gutterHeight: number
  right: number
  x: number
}
type Row = { gutter: Token; body: Token[] }

// A filename alone is not evidence of code. This proof requires a complete,
// consecutive native number gutter, two import statements and one body font.
// It includes comments verbatim, and rejects the entire file on a broken page
// continuation or foreign native content inside its line frame.
export function numberedSourcePackets(pages: PdfLayoutPage[]): Map<number, number[][]> {
  const output = new Map<number, number[][]>()
  const tokens = pages.map((page) =>
    page.items.flatMap((item, index): Token[] => {
      if (!item.str.trim()) return []
      return [
        {
          item,
          index,
          page: page.page,
          x: item.transform[4],
          y: page.height - item.transform[5],
          right: item.transform[4] + item.width
        }
      ]
    })
  )
  const valid = ({ item }: Token): boolean =>
    !!item.fontName &&
    item.dir === 'ltr' &&
    [...item.transform, item.width, item.height].every(Number.isFinite) &&
    item.width > 0 &&
    item.height > 0 &&
    item.transform[0] > 0 &&
    item.transform[3] > 0 &&
    Math.abs(item.transform[1]) < 0.001 &&
    Math.abs(item.transform[2]) < 0.001
  const same = (a: number, b: number): boolean =>
    Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 0.01
  const rows = (parts: Token[], frame?: Frame): Row[] =>
    parts
      .flatMap((gutter): Row[] => {
        if (!/^\d{1,4}$/u.test(gutter.item.str) || !valid(gutter)) return []
        if (
          frame &&
          (!same(gutter.right, frame.right) ||
            !same(gutter.item.height, frame.gutterHeight) ||
            gutter.item.fontName !== frame.gutterFont)
        )
          return []
        const body = parts
          .filter(
            (t) =>
              t !== gutter &&
              Math.abs(t.y - gutter.y) < gutter.item.height * 0.05 &&
              t.x > gutter.right
          )
          .sort((a, b) => a.x - b.x)
        if (!frame && (!body.length || gutter.item.height >= body[0].item.height * 0.7)) return []
        return [{ gutter, body }]
      })
      .sort((a, b) => a.gutter.y - b.gutter.y)
  const headings = tokens.map((parts) =>
    parts.filter(
      (t) =>
        /^[A-Za-z_][\w.-]*\.lean$/u.test(t.item.str) &&
        valid(t) &&
        parts
          .filter((p) => Math.abs(p.y - t.y) < t.item.height * 0.05)
          .every((p) => p === t || /^[A-Z]+\.\d+(?:\.\d+)*$/u.test(p.item.str))
    )
  )
  for (let pi = 0; pi < pages.length; pi++)
    for (const heading of headings[pi]) {
      if (pages[pi].rotation !== 0) continue
      const nextHeading = headings[pi].find((t) => t.y > heading.y)
      const initial = rows(
        tokens[pi].filter((t) => t.y > heading.y && (!nextHeading || t.y < nextHeading.y))
      )
      const first = initial[0]
      if (
        !first ||
        first.gutter.item.str !== '1' ||
        first.gutter.y - heading.y > heading.item.height * 3 ||
        !first.body.length
      )
        continue
      const body = first.body[0].item
      const frame: Frame = {
        font: body.fontName!,
        height: body.height,
        gutterFont: first.gutter.item.fontName!,
        gutterHeight: first.gutter.item.height,
        right: first.gutter.right,
        x: first.body[0].x
      }
      const packets: { page: number; indices: number[] }[] = []
      let ordinal = 1,
        imports = 0,
        failed = false,
        finished = false
      for (let q = pi; q < pages.length && !finished; q++) {
        if (pages[q].rotation !== 0 || (q > pi && pages[q].page !== pages[q - 1].page + 1)) {
          failed = true
          break
        }
        const endHeading = headings[q].find((t) => q !== pi || t.y > heading.y)
        const available = tokens[q].filter(
          (t) => (q !== pi || t.y > heading.y) && (!endHeading || t.y < endHeading.y)
        )
        const candidates = rows(available, frame)
        if (!candidates.length) {
          failed = q > pi && available.length > 0
          finished = true
          break
        }
        if (
          q > pi &&
          available.some((t) => t.y < candidates[0].gutter.y - frame.gutterHeight * 0.05)
        ) {
          failed = true
          break
        }
        const accepted: Token[] = []
        let previousY = candidates[0].gutter.y
        for (let ri = 0; ri < candidates.length; ri++) {
          const row = candidates[ri],
            next = candidates[ri + 1]
          if (
            Number(row.gutter.item.str) !== ordinal ||
            row.gutter.y - previousY > frame.height * 2.5
          ) {
            failed = true
            break
          }
          const end = next?.gutter.y ?? row.gutter.y + frame.height * 2.5
          const owned = available.filter(
            (t) =>
              t.y >= row.gutter.y - frame.gutterHeight * 0.05 &&
              t.y < end - frame.gutterHeight * 0.05
          )
          const ordinary = owned.filter((t) => t !== row.gutter && !['↪', '→'].includes(t.item.str))
          const baselines = [...new Set(owned.map((t) => t.y))].sort((a, b) => a - b)
          if (baselines.some((y, n) => n > 0 && y - baselines[n - 1] > frame.height * 2.5)) {
            failed = true
            break
          }
          if (
            owned.some((t) => !valid(t)) ||
            ordinary.some(
              (t) =>
                t.item.fontName !== frame.font ||
                !same(t.item.height, frame.height) ||
                t.x < frame.x - frame.height * 0.05
            ) ||
            owned
              .filter((t) => t !== row.gutter && ['↪', '→'].includes(t.item.str))
              .some(
                (t) =>
                  t.y === row.gutter.y ||
                  t.x <= frame.right ||
                  t.x >= frame.x + frame.height * 5 ||
                  t.item.height >= frame.height * 0.7
              )
          ) {
            failed = true
            break
          }
          for (const t of ordinary.filter(
            (t) => Math.abs(t.y - row.gutter.y) > frame.height * 0.05
          )) {
            if (
              owned.filter(
                (mark) =>
                  mark.item.str === '↪' && Math.abs(mark.y - t.y) < frame.gutterHeight * 0.05
              ).length !== 1 ||
              owned.filter(
                (mark) =>
                  mark.item.str === '→' && Math.abs(mark.y - t.y) < frame.gutterHeight * 0.05
              ).length !== 1
            ) {
              failed = true
              break
            }
          }
          if (failed) break
          if (/^import\s+[A-Za-z_][\w.]*(?:\s*)$/u.test(row.body.map((t) => t.item.str).join(' ')))
            imports++
          accepted.push(...owned)
          previousY = Math.max(...owned.map((t) => t.y))
          ordinal++
        }
        if (failed) break
        if (!accepted.length) {
          failed = true
          break
        }
        const indices = [...new Set(accepted.map((t) => t.index))].sort((a, b) => a - b)
        if (
          available.some(
            (t) => t.index >= indices[0] && t.index <= indices.at(-1)! && !indices.includes(t.index)
          )
        ) {
          failed = true
          break
        }
        packets.push({ page: pages[q].page, indices })
        const lastY = Math.max(...accepted.map((t) => t.y))
        finished =
          !!endHeading ||
          available.some((t) => t.y > lastY + frame.height * 2.5 && !/^\d+$/u.test(t.item.str))
      }
      if (failed || imports < 2 || ordinal < 4) continue
      for (const packet of packets)
        output.set(packet.page, [...(output.get(packet.page) ?? []), packet.indices])
    }
  return output
}
