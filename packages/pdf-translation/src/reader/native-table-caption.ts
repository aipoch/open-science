import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { nativeInkPageIdentity } from './auxiliary-native-ink.js'
import { getPdfTranslationTextContent } from './text-content.js'
import type { PdfTranslationSource } from './source.js'

type Unit = PdfTranslationSource['units'][number]
type Content = Awaited<ReturnType<PDFPageProxy['getTextContent']>>
type Item = Extract<Content['items'][number], { str: string }>
const clean = (s: string): string => s.replace(/\s+/gu, ' ').trim()
const prefix = /^Table ([1-9]\d*): /u

/** Restore only one complete caption owner, never bibliography state or a page.
 * Its native caption style must already have an eligible pre-bibliography precedent. */
export async function nativeTableCaptionOwners(
  units: PdfTranslationSource['units'],
  document: Pick<PDFDocumentProxy, 'getPage'>,
  signal: AbortSignal
): Promise<ReadonlySet<string>> {
  const result = new Set<string>(),
    snapshot = JSON.stringify(units),
    reference = units.find((u) => /^(?:References|Bibliography)$/iu.test(u.source))
  if (!reference || reference.fragments.length !== 1) return result
  const referencePage = reference.fragments[0].pageNumber,
    candidates = units.filter(
      (u) =>
        u.sourceOnly &&
        u.preserve === 'reference' &&
        prefix.test(u.source) &&
        u.fragments.length === 1 &&
        u.fragments[0].pageNumber > referencePage &&
        /[.!?]$/u.test(u.source)
    ),
    cache = new Map<
      number,
      {
        page: PDFPageProxy
        content: Content
        identity: NonNullable<Awaited<ReturnType<typeof nativeInkPageIdentity>>>
      }
    >()
  const pageContext = async (number: number): Promise<ReturnType<typeof cache.get>> => {
    const prior = cache.get(number)
    if (prior) return prior
    const page = await document.getPage(number),
      content = await getPdfTranslationTextContent(page),
      identity = await nativeInkPageIdentity(page, content, page.getViewport({ scale: 1 }))
    signal.throwIfAborted()
    if (!identity) return
    const context = { page, content, identity }
    cache.set(number, context)
    return context
  }
  const packet = (unit: Unit, content: Content): Item[] | undefined => {
    if (unit.fragments.length !== 1) return
    const f = unit.fragments[0],
      indices = f.items.map((i) => i.index),
      selected = new Set(indices)
    if (
      !indices.length ||
      indices.length > 24 ||
      selected.size !== indices.length ||
      indices.some((n, at) => at > 0 && n <= indices[at - 1]) ||
      content.items
        .slice(indices[0], indices.at(-1)! + 1)
        .some((i, n) => 'str' in i && i.str.trim() && !selected.has(indices[0] + n)) ||
      f.items.some(
        (i) =>
          !content.items[i.index] ||
          !('str' in content.items[i.index]) ||
          (content.items[i.index] as Item).str !== i.text ||
          units
            .flatMap((u) =>
              u.fragments.filter((p) => p.pageNumber === f.pageNumber).flatMap((p) => p.items)
            )
            .filter((q) => q.index === i.index).length !== 1
      )
    )
      return
    const items = indices.map((n) => content.items[n] as Item),
      first = items[0]
    if (
      clean(items.map((i) => i.str).join(' ')) !== unit.source ||
      !/^Table [1-9]\d*:$/u.test(first.str) ||
      items.length < 3 ||
      first.fontName === items[1].fontName ||
      items.at(-1)!.fontName !== first.fontName ||
      !items.every(
        (i) =>
          i.dir === 'ltr' &&
          i.fontName &&
          i.width > 0 &&
          i.height > 0 &&
          [...i.transform, i.width, i.height].every(Number.isFinite) &&
          i.transform[0] === i.height &&
          i.transform[1] === 0 &&
          i.transform[2] === 0 &&
          i.transform[3] === i.height &&
          Math.abs(i.height - first.height) < first.height * 0.01
      )
    )
      return
    const lines: Item[][] = []
    for (const item of items) {
      if (
        !lines.length ||
        Math.abs(lines.at(-1)![0].transform[5] - item.transform[5]) > first.height * 0.05
      )
        lines.push([])
      lines.at(-1)!.push(item)
    }
    if (
      lines.length < 2 ||
      lines.length > 6 ||
      lines[0].length < 3 ||
      lines.some(
        (line, n) =>
          (n > 0 &&
            (Math.abs(line[0].transform[4] - first.transform[4]) > first.height * 0.05 ||
              lines[n - 1][0].transform[5] - line[0].transform[5] < first.height ||
              lines[n - 1][0].transform[5] - line[0].transform[5] > first.height * 1.5)) ||
          line.some(
            (i, at) =>
              at > 0 &&
              i.transform[4] < line[at - 1].transform[4] + line[at - 1].width - first.height * 0.05
          )
      )
    )
      return
    return items
  }
  try {
    for (const unit of candidates) {
      const number = unit.fragments[0].pageNumber,
        context = await pageContext(number)
      if (!context) continue
      const current = packet(unit, context.content)
      if (!current) continue
      const first = current[0],
        last = current.at(-1)!,
        h = first.height,
        appendix = units.find(
          (u) =>
            u.referenceBoundary &&
            u.fragments.length === 1 &&
            u.fragments[0].pageNumber === number &&
            /^[A-Z] [A-Z][A-Z ]{8,80}$/u.test(u.source) &&
            u.fragments[0].items[0].index > unit.fragments[0].items.at(-1)!.index
        )
      if (!appendix) continue
      const heading = appendix.fragments[0].items.map((i) => context.content.items[i.index]),
        headingFirst = heading[0]
      if (
        !headingFirst ||
        !('str' in headingFirst) ||
        heading.some(
          (i) =>
            !i ||
            !('str' in i) ||
            i.dir !== 'ltr' ||
            i.height < h * 0.8 ||
            i.height > h * 1.5 ||
            Math.abs(i.transform[5] - headingFirst.transform[5]) > h * 0.05
        ) ||
        appendix.fragments[0].items.some(
          (i, at, all) =>
            (context.content.items[i.index] as Item).str !== i.text ||
            (at > 0 &&
              (i.index <= all[at - 1].index ||
                context.content.items
                  .slice(all[at - 1].index + 1, i.index)
                  .some((q) => 'str' in q && q.str.trim())))
        ) ||
        appendix.source.replace(/\s/gu, '') !==
          (heading as Item[])
            .map((i) => i.str)
            .join('')
            .replace(/\s/gu, '') ||
        last.transform[5] - headingFirst.transform[5] < h * 5
      )
        continue
      // Independently repeated numeric columns distinguish this displaced
      // table caption from a bibliographic title with the same opening words.
      const between = context.content.items.slice(
          unit.fragments[0].items.at(-1)!.index + 1,
          appendix.fragments[0].items[0].index
        ),
        columns: { x: number; baselines: number[] }[] = []
      for (const i of between) {
        if (
          !('str' in i) ||
          !/^\d+(?:\.\d+)?(?:%|±\d+(?:\.\d+)?)?$/u.test(i.str) ||
          i.height < h * 0.6 ||
          i.height > h ||
          i.transform[1] !== 0 ||
          i.transform[2] !== 0 ||
          i.transform[5] >= last.transform[5] - h ||
          i.transform[5] <= headingFirst.transform[5] + h
        )
          continue
        let column = columns.find((c) => Math.abs(c.x - i.transform[4]) < h * 0.2)
        if (!column) {
          column = { x: i.transform[4], baselines: [] }
          columns.push(column)
        }
        if (!column.baselines.some((y) => Math.abs(y - i.transform[5]) < h * 0.1))
          column.baselines.push(i.transform[5])
      }
      if (columns.filter((c) => c.baselines.length >= 3).length < 2) continue
      for (const earlier of units) {
        if (
          earlier.sourceOnly ||
          earlier.preserve ||
          earlier.fragments.length !== 1 ||
          earlier.fragments[0].pageNumber >= referencePage ||
          !prefix.test(earlier.source) ||
          Number(prefix.exec(earlier.source)![1]) >= Number(prefix.exec(unit.source)![1])
        )
          continue
        const precedent = await pageContext(earlier.fragments[0].pageNumber)
        if (!precedent) continue
        const old = packet(earlier, precedent.content)
        if (
          !old ||
          old[0].fontName !== first.fontName ||
          old[1].fontName !== current[1].fontName ||
          old.at(-1)!.fontName !== last.fontName ||
          Math.abs(old[0].height - h) > h * 0.01 ||
          Math.abs(old[0].transform[4] - first.transform[4]) > h * 0.05
        )
          continue
        result.add(unit.id)
        break
      }
    }
    if (snapshot !== JSON.stringify(units)) return new Set<string>()
    for (const { page, content, identity } of cache.values())
      if (
        identity.key !==
        (await nativeInkPageIdentity(page, content, page.getViewport({ scale: 1 })))?.key
      )
        return new Set<string>()
    signal.throwIfAborted()
    return result
  } catch {
    signal.throwIfAborted()
    return new Set<string>()
  }
}
