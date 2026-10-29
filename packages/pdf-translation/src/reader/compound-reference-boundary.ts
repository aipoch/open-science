import type { PDFPageProxy } from 'pdfjs-dist'
import type { PdfLayoutPage, PdfLayoutTextItem, PdfTranslationLayout } from './layout.js'

/** Read resolved native advances; no font-name or inferred pitch classification. */
export async function readNativeCommandAdvances(
  page: PDFPageProxy,
  content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>
): Promise<Record<string, number>> {
  const result: Record<string, number> = {}
  if (!content.items.some((i) => 'str' in i && /(?:docker|\.\/[\w./-]+\.sh)/u.test(i.str)))
    return result
  try {
    if (!page.commonObjs || typeof page.getOperatorList !== 'function') return result
    await page.getOperatorList()
    for (const id of new Set(content.items.flatMap((i) => ('str' in i ? [i.fontName] : [])))) {
      const font = page.commonObjs.get(id)
      if (font?.isMonospace !== true || !font.widths || typeof font.widths !== 'object') continue
      const advances = Object.values(font.widths).filter((n) => n !== undefined) as number[]
      if (
        advances.length < 32 ||
        advances.some((n) => !Number.isFinite(n) || n <= 0 || n !== advances[0])
      )
        continue
      result[id] = advances[0] / 1000
    }
  } catch {
    /* Missing native font evidence refuses command restoration. */
  }
  return result
}

type Unit = PdfTranslationLayout['units'][number]
type Box = { x: number; y: number; right: number; bottom: number }
type Entry = { item: PdfLayoutTextItem; key: string }

/** A new-page S-section can contain only its native title/subsection and two
 * sequential figure captions. Restore those whole prose owners without resetting
 * the bibliography interval or changing an independent folio/code/math owner. */
export function nativeSupplementCaptionOwners(
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
  const footer = (i: PdfLayoutTextItem, p: PdfLayoutPage): boolean =>
    /^(?:S?[1-9]\d*)$/u.test(i.str) &&
    i.transform[5] < p.height * 0.1 &&
    Math.abs(i.transform[4] + i.width / 2 - p.width / 2) < i.height * 4
  for (const p of pages) {
    const evidence = p.nativeSectionFontEvidence,
      prior = pages.find((q) => q.page === p.page - 1)
    if (!evidence?.complete || !prior?.nativeSectionFontEvidence?.complete || p.rotation !== 0)
      continue
    const items = p.items.flatMap((item, index) =>
      item.str.trim() ? [{ item, key: `${p.page}:${index}` }] : []
    )
    if (
      items.some((e) => {
        const f = evidence.fonts[e.item.fontName!],
          owner = owners.get(e.key)
        return (
          repeated.has(e.key) ||
          !owner ||
          owner.items.length !== owner.originalStrings.length ||
          owner.originalStrings[owner.items.indexOf(e.key)] !== e.item.str ||
          !valid(e.item) ||
          !f?.nativeMetrics ||
          f.ascent !== e.item.fontAscent ||
          f.descent !== e.item.fontDescent
        )
      })
    )
      continue
    const selected = items.filter((e) => !footer(e.item, p)),
      parts = [...new Set(selected.map((e) => owners.get(e.key)!))].toSorted(
        (a, b) =>
          Math.max(
            ...b.items.map((k) => p.items[Number(k.split(':')[1])]?.transform[5] ?? -Infinity)
          ) -
          Math.max(
            ...a.items.map((k) => p.items[Number(k.split(':')[1])]?.transform[5] ?? -Infinity)
          )
      )
    const keys = new Set(selected.map((e) => e.key))
    if (
      parts.length !== 4 ||
      parts.some(
        (u) =>
          u.sourceOnly ||
          u.preserve ||
          u.risks.length ||
          u.fragments.length !== 1 ||
          u.fragments[0].page !== p.page ||
          u.items.some((k) => !keys.has(k))
      )
    )
      continue
    const [title, caption, subsection, last] = parts,
      number = /^S([1-9]\d*)\s+\p{Lu}/u.exec(title.source)
    if (
      !number ||
      !new RegExp(`^S${number[1]}\\.1\\s+\\p{Lu}`, 'u').test(subsection.source) ||
      !/^Figure S1[:.]\s+\p{Lu}/u.test(caption.source) ||
      !/^Figure S2[:.]\s+\p{Lu}/u.test(last.source)
    )
      continue
    const reference = units
      .filter(
        (u) =>
          /^(?:References|Bibliography)$/u.test(u.source.trim()) &&
          u.fragments.length === 1 &&
          u.fragments[0].page < p.page
      )
      .toSorted((a, b) => b.fragments[0].page - a.fragments[0].page)[0]
    if (!reference) continue
    const referencePage = pages.find((q) => q.page === reference.fragments[0].page),
      referenceItem = referencePage?.items[Number(reference.items[0].split(':')[1])]
    const native = (u: Unit): PdfLayoutTextItem[] =>
        u.items.map((k) => p.items[Number(k.split(':')[1])]),
      t = native(title),
      sub = native(subsection),
      captions = [...native(caption), ...native(last)],
      first = t[0],
      body = captions[0]
    if (
      !referencePage?.nativeSectionFontEvidence?.complete ||
      !referenceItem?.fontName ||
      !first ||
      !body ||
      title.kind !== 'heading-candidate' ||
      subsection.kind !== 'heading-candidate' ||
      first.transform[5] < p.height * 0.75 ||
      Math.abs(first.transform[4] - referenceItem.transform[4]) > body.height * 0.2 ||
      Math.abs(first.height - referenceItem.height) > body.height * 0.02 ||
      first.height <= body.height * 1.2 ||
      t.some((i) => i.fontName !== referenceItem.fontName || i.height !== first.height) ||
      sub.some(
        (i) =>
          i.fontName !== first.fontName || i.height <= body.height * 1.1 || i.height >= first.height
      ) ||
      captions.some(
        (i) =>
          i.fontName !== body.fontName || i.height !== body.height || i.fontName === first.fontName
      ) ||
      [caption, last].some((u) => (u.source.match(/\p{L}{2,}/gu)?.length ?? 0) < 8)
    )
      continue
    const before = prior.items.filter((i) => i.str.trim() && !footer(i, prior)),
      marker = before.findLastIndex((i) => /^\([1-9]\d*\)/u.test(i.str)),
      tail = before
        .slice(marker)
        .map((i) => i.str)
        .join(' ')
    if (
      marker < 0 ||
      !/^\([1-9]\d*\)\s+(?:\p{Lu}\.\s*){1,4}\p{Lu}/u.test(tail) ||
      !/\((?:18|19|20)\d{2}\)\.$/u.test(tail)
    )
      continue
    for (const owner of parts) result.add(owner.items.join('|'))
  }
  return result
}
const union = (boxes: Box[]): Box => ({
  x: Math.min(...boxes.map((b) => b.x)),
  y: Math.min(...boxes.map((b) => b.y)),
  right: Math.max(...boxes.map((b) => b.right)),
  bottom: Math.max(...boxes.map((b) => b.bottom))
})
const overlap = (a: Box, b: Box): boolean =>
  a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom
const valid = (i: PdfLayoutTextItem): boolean =>
  !!i.fontName &&
  i.dir === 'ltr' &&
  i.transform.length === 6 &&
  [...i.transform, i.width, i.height, i.fontAscent, i.fontDescent].every(Number.isFinite) &&
  i.width > 0 &&
  i.height > 0 &&
  i.transform[0] > 0 &&
  i.transform[3] === i.height &&
  i.transform[1] === 0 &&
  i.transform[2] === 0 &&
  i.fontVertical === false &&
  i.fontAscent! > 0 &&
  i.fontAscent! <= 1 &&
  i.fontDescent! >= -1 &&
  i.fontDescent! <= 0
const box = (i: PdfLayoutTextItem, p: PdfLayoutPage): Box => ({
  x: i.transform[4],
  right: i.transform[4] + i.width,
  y: p.height - i.transform[5] - i.fontAscent! * i.height,
  bottom: p.height - i.transform[5] - i.fontDescent! * i.height
})
const words = (s: string): number => s.match(/\p{L}{2,}/gu)?.length ?? 0
function rows(entries: Entry[]): Entry[][] {
  const result: Entry[][] = []
  for (const e of [...entries].sort(
    (a, b) => b.item.transform[5] - a.item.transform[5] || a.item.transform[4] - b.item.transform[4]
  )) {
    const row = result.at(-1)
    if (
      row &&
      Math.abs(e.item.transform[5] - row[0].item.transform[5]) <
        Math.min(e.item.height, row[0].item.height) * 0.05
    )
      row.push(e)
    else result.push([e])
  }
  return result
}
function rowText(row: Entry[]): string {
  return row.reduce((s, e, n) => {
    const prev = row[n - 1]?.item,
      gap = prev ? e.item.transform[4] - prev.transform[4] - prev.width : 0
    return s + (n && gap > Math.max(e.item.height, prev.height) * 0.15 ? ' ' : '') + e.item.str
  }, '')
}
/** Separate complete native compound appendix titles from a preceding bibliography.
 * No source is split, reconstructed, or made eligible here. Existing code/math protection stays intact.
 */
export function nativeCompoundAppendixBoundaries(units: Unit[], pages: PdfLayoutPage[]): Set<Unit> {
  const result = new Set<Unit>(),
    counts = new Map<string, number>()
  for (const u of units) for (const k of u.items) counts.set(k, (counts.get(k) ?? 0) + 1)
  const entries = (u: Unit): Entry[] | undefined => {
    if (u.fragments.length !== 1 || u.items.length !== u.originalStrings.length || !u.items.length)
      return
    const page = pages[u.fragments[0].page - 1]
    if (!page || page.page !== u.fragments[0].page || page.rotation !== 0) return
    const a: Entry[] = []
    for (const [n, key] of u.items.entries()) {
      const [p, index] = key.split(':').map(Number),
        item = page.items[index]
      if (
        p !== page.page ||
        !item ||
        item.str !== u.originalStrings[n] ||
        counts.get(key) !== 1 ||
        !valid(item)
      )
        return
      const b = box(item, page)
      if (b.x < 0 || b.y < 0 || b.right > page.width || b.bottom > page.height) return
      a.push({ key, item })
    }
    return a
  }
  const emptyDomain = (owners: Unit[], page: PdfLayoutPage): boolean => {
    const a = owners.flatMap((u) => entries(u) ?? []),
      keys = new Set(a.map((e) => e.key))
    if (!a.length || a.length !== owners.reduce((n, u) => n + u.items.length, 0)) return false
    const domain = union(a.map((e) => box(e.item, page)))
    return !page.items.some(
      (i, n) =>
        i.str.trim() &&
        !keys.has(page.page + ':' + n) &&
        (!valid(i) || overlap(box(i, page), domain))
    )
  }
  // A released appendix still owns literal shell commands and diagnostic output.
  // Establish the native fixed-advance role with a complete command, then retain
  // only complete same-role packets; mixed prose owners are never claimed.
  const protectCommands = (start: number, bodySize: number): boolean => {
    const command = (line: string): boolean => {
      const tokens = line.replace(/(?:\r\n|[\n\r\u2028\u2029])$/u, '').split(/\s+/u)
      let index = 0
      while (/^[A-Z_][A-Z0-9_]*=[A-Za-z0-9_.-]+$/u.test(tokens[index] ?? '')) index += 1
      if (tokens[index] === 'docker')
        return (
          tokens[index + 1] === 'load' &&
          tokens[index + 2] === '-i' &&
          /^[A-Za-z0-9_./-]+$/u.test(tokens[index + 3] ?? '') &&
          tokens.length === index + 4
        )
      if (!/^\.\/[A-Za-z0-9_./-]+\.sh$/u.test(tokens[index] ?? '')) return false
      index += 1
      const option = /^--?[A-Za-z][A-Za-z0-9-]*$/u
      if (!option.test(tokens[index] ?? '')) return false
      while (index < tokens.length) {
        if (!option.test(tokens[index]!)) return false
        index += 1
        // An option-shaped value can also stand alone as the next option.
        if (index < tokens.length && !option.test(tokens[index]!)) {
          if (!/^[A-Za-z0-9_./-]+$/u.test(tokens[index]!)) return false
          index += 1
        }
      }
      return true
    }
    const commandOwners = units
      .slice(start)
      .filter((u) =>
        /^(?:docker\s+load|\.\/[A-Za-z0-9_./-]+\.sh|[A-Z_][A-Z0-9_]*=|#|[-A-Za-z0-9_]+:\s*\*\*\*)/u.test(
          u.source
        )
      )
    const candidates = units.slice(start).flatMap((u) => {
      const a = entries(u)
      if (
        !a ||
        u.risks.length ||
        a.some(
          (e) =>
            e.item.fontName !== a[0].item.fontName ||
            Math.abs(e.item.height - a[0].item.height) > bodySize * 0.01 ||
            e.item.height < bodySize * 0.65 ||
            e.item.height > bodySize * 0.85 ||
            !pages[u.fragments[0].page - 1].nativeCommandAdvances?.[e.item.fontName!] ||
            Math.abs(
              e.item.width -
                Array.from(e.item.str).length *
                  e.item.height *
                  pages[u.fragments[0].page - 1].nativeCommandAdvances![e.item.fontName!]
            ) >
              e.item.height * 0.02
        )
      )
        return []
      return [{ u, a, font: a[0].item.fontName!, size: a[0].item.height }]
    })
    const programs = candidates.filter((c) => rows(c.a).some((r) => command(rowText(r))))
    if (!commandOwners.length) return true
    if (new Set(programs.map((c) => c.font)).size !== 1) return false
    const font = programs[0].font,
      packets: (typeof candidates)[] = [],
      protectedOwners = new Set<Unit>()
    for (const candidate of candidates.filter((c) => c.font === font)) {
      const packet = packets.at(-1),
        previous = packet?.at(-1),
        a = candidate.u.fragments[0],
        b = previous?.u.fragments[0]
      if (
        previous &&
        b &&
        a.page === b.page &&
        Math.abs(a.rect.x - b.rect.x) <= bodySize * 3 &&
        a.rect.y >= b.rect.y &&
        a.rect.y - b.rect.bottom < candidate.size * 2
      )
        packet!.push(candidate)
      else packets.push([candidate])
    }
    for (const packet of packets) {
      const owners = packet.map((c) => c.u),
        page = pages[owners[0].fragments[0].page - 1]
      if (!emptyDomain(owners, page)) continue
      const lines = packet.flatMap((c) => rows(c.a).map(rowText)),
        commands: string[] = []
      let pending = '',
        complete = true
      for (const line of lines) {
        if (line.startsWith('#') && !pending) continue
        pending += (pending ? ' ' : '') + line
        if (pending.endsWith('\\')) pending = pending.slice(0, -1).trimEnd()
        else {
          commands.push(pending)
          pending = ''
        }
      }
      complete = !pending && commands.length > 0 && commands.every(command)
      const output =
        /^[-A-Za-z0-9_]+:\s/u.test(lines[0]) &&
        /\*\*\*/u.test(lines.join(' ')) &&
        /Assertion[^\n]*==[^\n]*failed\./u.test(lines.join(' ')) &&
        /Aborted(?: \(core dumped\))?$/u.test(lines.join(' ')) &&
        lines.every((line) =>
          /^(?:[-A-Za-z0-9_]+:\s*(?:.*\*\*\*.*|[A-Za-z0-9_./-]+:\d+:)?|\*\*\*|Assertion [‘'A-Za-z0-9_ =’]+ failed\.|Aborted(?: \(core dumped\))?)$/u.test(
            line
          )
        )
      if (complete || output)
        for (const owner of owners) {
          owner.sourceOnly = true
          owner.preserve = 'code'
          protectedOwners.add(owner)
        }
    }
    return commandOwners.every((u) => protectedOwners.has(u))
  }
  for (const [at, title] of units.entries()) {
    if (title.sourceOnly || title.risks.length) continue
    const a = entries(title)
    if (!a) continue
    const p = pages[title.fragments[0].page - 1],
      titleRows = rows(a),
      size = Math.max(...a.map((e) => e.item.height)),
      domain = union(a.map((e) => box(e.item, p)))
    const reference = units
      .slice(0, at)
      .findLast((u) => /^(?:References|Bibliography|REFERENCES)$/u.test(u.source))
    if (
      !reference ||
      !entries(reference) ||
      reference.fragments[0].page >= p.page ||
      units.slice(units.indexOf(reference) + 1, at).filter((u) => /^\[\d{1,3}\]/u.test(u.source))
        .length < 2
    )
      continue
    if (
      titleRows.length === 2 &&
      rowText(titleRows[0]) === 'APPENDIX' &&
      /^[A-Z][A-Z ]{2,60} APPENDIX$/u.test(rowText(titleRows[1]))
    ) {
      const [top, sub] = titleRows,
        rowBoxes = titleRows.map((r) => union(r.map((e) => box(e.item, p)))),
        center = (b: Box): number => (b.x + b.right) / 2
      if (
        Math.abs(center(rowBoxes[0]) - center(rowBoxes[1])) > size * 0.2 ||
        top[0].item.transform[5] - sub[0].item.transform[5] < size * 0.8 ||
        top[0].item.transform[5] - sub[0].item.transform[5] > size * 2 ||
        a.some(
          (e) =>
            e.item.fontName !== top[0].item.fontName ||
            e.item.height < size * 0.79 ||
            e.item.height > size
        ) ||
        domain.y > p.height * 0.12
      )
        continue
      const sections = units.filter(
          (u) =>
            u.fragments.length === 1 &&
            u.fragments[0].page === p.page &&
            /^[AB]\. \p{Lu}[\p{L} ()-]{2,80}$/u.test(u.source) &&
            entries(u)
        ),
        first = sections.find((u) => u.source.startsWith('A. ')),
        second = sections.find((u) => u.source.startsWith('B. '))
      if (!first || !second) continue
      const f = entries(first)!,
        s = entries(second)!,
        fr = first.fragments[0].rect,
        sr = second.fragments[0].rect
      const body = units
          .slice(units.indexOf(first) + 1)
          .find((u) => u !== title && u.fragments[0].page === p.page),
        b = body && entries(body)
      if (
        f.length !== 1 ||
        s.length !== 1 ||
        f[0].item.fontName === a[0].item.fontName ||
        s[0].item.fontName !== f[0].item.fontName ||
        Math.abs(f[0].item.height - size) > size * 0.01 ||
        Math.abs(s[0].item.height - size) > size * 0.01 ||
        Math.abs(fr.x - sr.x) > size * 0.2 ||
        fr.y < domain.bottom ||
        fr.y - domain.bottom > size * 2 ||
        sr.y <= fr.bottom ||
        !body ||
        !b ||
        body.sourceOnly ||
        body.kind !== 'prose-candidate' ||
        body.risks.length ||
        words(body.source) < 24 ||
        !/[.!?]$/u.test(body.source) ||
        b.some((e) => Math.abs(e.item.height - size) > size * 0.055) ||
        body.fragments[0].rect.right - body.fragments[0].rect.x < p.width * 0.3 ||
        Math.abs(body.fragments[0].rect.x - fr.x) > size * 0.2 ||
        body.fragments[0].rect.y - fr.bottom < 0 ||
        body.fragments[0].rect.y - fr.bottom > size * 2 ||
        domain.x < fr.x ||
        domain.right > body.fragments[0].rect.right ||
        !emptyDomain([title, first, body], p)
      )
        continue
      if (!protectCommands(Math.min(units.indexOf(first), at), size)) continue
      result.add(units.indexOf(first) < at ? first : title)
      continue
    }
    const appendix = titleRows.find((r) =>
      /^Appendix [A-Z]\. \p{Lu}[\p{L}\d .’'–-]{5,100}$/u.test(rowText(r))
    )
    if (!appendix || titleRows.length !== 2 || domain.y > p.height * 0.12) continue
    const h = appendix[0].item.height,
      subtitle = appendix.at(-1)!.item,
      extra = titleRows.find((r) => r !== appendix)!
    if (
      appendix.length !== 3 ||
      appendix[0].item.str !== 'Appendix' ||
      !/^[A-Z]\.$/u.test(appendix[1].item.str) ||
      appendix.some((e) => Math.abs(e.item.height - h) > h * 0.01) ||
      subtitle.fontName !== appendix[0].item.fontName ||
      extra.length !== 1 ||
      extra[0].item.height < h * 1.2 ||
      extra[0].item.height > h * 2 ||
      words(extra[0].item.str) < 3 ||
      /[()[\];]/u.test(extra[0].item.str) ||
      Math.abs(extra[0].item.transform[5] - appendix[0].item.transform[5]) > h * 0.5
    )
      continue
    const witnesses = pages.slice(0, reference.fragments[0].page - 1).flatMap((page) =>
      page.items.flatMap((i, n) => {
        const previous = page.items.slice(0, n).findLast((e) => e.str.trim())
        return valid(i) &&
          i.fontName === subtitle.fontName &&
          Math.abs(i.height - h) < h * 0.01 &&
          words(i.str) >= 2 &&
          previous &&
          valid(previous) &&
          /^\d{1,2}\.$/u.test(previous.str) &&
          Math.abs(previous.transform[5] - i.transform[5]) < h * 0.01 &&
          i.transform[4] - previous.transform[4] - previous.width > 0 &&
          i.transform[4] - previous.transform[4] - previous.width < h &&
          Math.abs((previous.transform[4] + i.transform[4] + i.width) / 2 - page.width / 2) < h
          ? [{ page: page.page }]
          : []
      })
    )
    if (new Set(witnesses.map((w) => w.page)).size < 2) continue
    const following = units[at + 1],
      body = following && entries(following)
    if (
      !following ||
      !body ||
      following.fragments[0].page !== p.page ||
      following.sourceOnly ||
      words(following.source) < 3 ||
      !/[.!?]$/u.test(following.source) ||
      following.fragments[0].rect.y - domain.bottom < 0 ||
      following.fragments[0].rect.y - domain.bottom > h * 3 ||
      !emptyDomain([title, following], p)
    )
      continue
    result.add(title)
  }
  return result
}
