type NativeReferenceBlock = {
  x: number
  y: number
  right: number
  bottom: number
  font: number
  source: string
  items: {
    index: number
    page: number
    unsupported: boolean
    fontName?: string
    transform: number[]
    dir: string
    str: string
    width: number
    height: number
  }[]
}

// A centered native page number can obscure an otherwise complete bibliography
// gutter. Prove both numbered columns before restoring their native order.
// This does not reconstruct records, change text or infer missing numbers.
export function nativeNumberedReferenceColumns<T extends NativeReferenceBlock>(
  blocks: T[],
  page: { page: number; width: number; height: number }
): T[] | undefined {
  const markers = blocks.filter((block) => /^\[\d{1,4}\]\s+\p{Lu}/u.test(block.source))
  if (markers.length < 8) return undefined
  if (
    ![page.width, page.height].every((value) => Number.isFinite(value) && value > 0) ||
    blocks.some(
      (block) =>
        ![block.x, block.y, block.right, block.bottom, block.font].every(Number.isFinite) ||
        block.font <= 0 ||
        block.x < 0 ||
        block.y < 0 ||
        block.x >= block.right ||
        block.y >= block.bottom ||
        block.right > page.width ||
        block.bottom > page.height ||
        !block.items.length ||
        block.items.some(
          (item) =>
            item.page !== page.page ||
            !Number.isSafeInteger(item.index) ||
            item.unsupported ||
            !item.fontName ||
            item.dir !== 'ltr' ||
            ![item.width, item.height].every((value) => Number.isFinite(value) && value > 0) ||
            item.transform.length !== 6 ||
            !item.transform.every(Number.isFinite) ||
            item.transform[0] <= 0 ||
            item.transform[3] <= 0 ||
            Math.abs(item.transform[1]) > 0.001 ||
            Math.abs(item.transform[2]) > 0.001
        )
    )
  )
    return undefined
  const font = markers[0].font
  const starts = markers.map((block) => block.x).toSorted((a, b) => a - b)
  const gaps = starts.flatMap((start, index) =>
    index > 0 && start - starts[index - 1] > font * 4 ? [(start + starts[index - 1]) / 2] : []
  )
  if (gaps.length !== 1) return undefined
  const middle = gaps[0]
  const footers = blocks.filter(
    (block) => block.items.length === 1 && block.source === String(block.items[0].page)
  )
  if (footers.length !== 1) return undefined
  const footer = footers[0]
  if (
    footer.right - footer.x > font * 3 ||
    footer.items[0].fontName !== markers[0].items[0]?.fontName ||
    Math.abs(footer.font - font) > font * 0.05 ||
    footer.y < page.height * 0.85 ||
    Math.abs((footer.x + footer.right) / 2 - page.width / 2) > page.width * 0.1
  )
    return undefined
  const body = blocks.filter((block) => block !== footer)
  const lanes = [
    body.filter((block) => block.x < middle),
    body.filter((block) => block.x > middle)
  ].map((lane) => lane.toSorted((a, b) => a.y - b.y || a.x - b.x))
  if (
    lanes.flat().length !== body.length ||
    Math.min(...lanes[1].map((block) => block.x)) -
      Math.max(...lanes[0].map((block) => block.right)) <
      font * 0.9 ||
    footer.x <= Math.max(...lanes[0].map((block) => block.right)) ||
    footer.right >= Math.min(...lanes[1].map((block) => block.x)) ||
    footer.y <= Math.max(...body.map((block) => block.bottom)) ||
    footer.y - Math.max(...body.map((block) => block.bottom)) > font * 3 ||
    Math.max(...body.map((block) => block.bottom)) - Math.min(...body.map((block) => block.y)) <
      page.height * 0.6 ||
    Math.abs(lanes[0][0].y - lanes[1][0].y) > font * 0.5 ||
    footer.items[0].index <=
      Math.max(...body.flatMap((block) => block.items.map((item) => item.index)))
  )
    return undefined
  const records: { number: number; blocks: T[] }[] = []
  for (const lane of lanes) {
    let record: (typeof records)[number] | undefined
    const laneRecords: typeof records = []
    for (const block of lane) {
      const marker = /^\[(\d{1,4})\]\s+\p{Lu}/u.exec(block.source)
      if (marker) {
        if (
          !block.items[0].str.startsWith(`[${marker[1]}]`) ||
          block.items[0].fontName !== markers[0].items[0].fontName ||
          Math.abs(block.font - font) > font * 0.05
        )
          return undefined
        record = { number: Number(marker[1]), blocks: [] }
        laneRecords.push(record)
      }
      if (!record) return undefined
      record.blocks.push(block)
    }
    if (
      laneRecords.length < 4 ||
      laneRecords.some((entry, index) => {
        const text = entry.blocks.map((block) => block.source).join(' ')
        const items = entry.blocks.flatMap((block) => block.items)
        return (
          !/\b(?:19|20)\d{2}\b/u.test(text) ||
          (text.match(/\p{L}{2,}/gu)?.length ?? 0) < 8 ||
          items.some((item, at) => at > 0 && item.index <= items[at - 1].index) ||
          (index > 0 && entry.number !== laneRecords[index - 1].number + 1)
        )
      })
    )
      return undefined
    records.push(...laneRecords)
  }
  const items = lanes.flat().flatMap((block) => block.items)
  return records.every(
    (record, index) => index === 0 || record.number === records[index - 1].number + 1
  ) &&
    new Set(items.map((item) => item.index)).size === items.length &&
    items.every((item, index) => index === 0 || item.index > items[index - 1].index)
    ? [...lanes.flat(), footer]
    : undefined
}
