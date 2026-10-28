import type { PdfLayoutPage, PdfTranslationLayout } from './layout.js'
import type { PdfTranslationSource } from './source.js'
type Unit = PdfTranslationSource['units'][number]
type Box = { x: number; y: number; right: number; bottom: number }
type Line = PdfTranslationLayout['pages'][number]['blocks'][number]['lines'][number]
type Certified = {
  source: Unit
  unit: PdfTranslationLayout['units'][number]
  block: PdfTranslationLayout['pages'][number]['blocks'][number]
  lines: Line[]
}
type Part = { kind: 'retained-author' | 'institution' | 'email'; lines: Line[] }
// Candidate vocabulary never admits a source without the complete native suffix proof.
const mail = /^[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+$/u
const mailRow = /^(?:E-?mail(?: address)?\s*:\s*)?[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+$/iu
const institution = (text: string): boolean =>
  /\b(?:university|department|institute|school|college|laborator(?:y|ies)|faculty|academy)\b/iu.test(
    text
  ) &&
  !/\b(?:1[6-9]|20)\d{2}\b/u.test(text) &&
  !/^\s*(?:\[|\d+[.)])/u.test(text) &&
  !/^(?:The|A|An|Research|Experiments?|Results?|Methods?)\b/iu.test(text) &&
  !/\b(?:we|our|this|these|is|are|was|were|has|have|provides?|discuss(?:es|ed)?|propos(?:e|es|ed)|demonstrat(?:e|es|ed))\b/iu.test(
    text
  )
const authorLine = (text: string): boolean =>
  /^[\p{Lu}][\p{L}\p{M}´.'\u2019-]*(?: [\p{Lu}][\p{L}\p{M}´.'\u2019-]*){1,5}$/u.test(text)
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const compact = (s: string): string => s.replace(/\s/gu, '')
const box = (lines: Box[]): Box => ({
  x: Math.min(...lines.map((l) => l.x)),
  y: Math.min(...lines.map((l) => l.y)),
  right: Math.max(...lines.map((l) => l.right)),
  bottom: Math.max(...lines.map((l) => l.bottom))
})
const validBox = (r: Box | undefined): boolean =>
  !!r && [r.x, r.y, r.right, r.bottom].every(Number.isFinite) && r.right > r.x && r.bottom > r.y

/** Reclassify only a complete terminal contact suffix. Existing layout lines are
 * navigation bounds, not glyph outlines or permission to repaint a region. */
export function terminalContactSources(
  units: readonly Unit[],
  layout: PdfTranslationLayout,
  pages: PdfLayoutPage[],
  pageCount: number
): readonly Unit[] {
  const fail = (): readonly Unit[] => units
  try {
    const page = pages.at(-1),
      evidence = page?.nativeSectionFontEvidence
    if (
      !page ||
      page.page !== pageCount ||
      page.rotation !== 0 ||
      !evidence?.complete ||
      !evidence.fonts ||
      !Number.isFinite(page.width) ||
      !Number.isFinite(page.height)
    )
      return fail()
    const keys = new Map<
        string,
        { unit: Unit; item: Unit['fragments'][number]['items'][number] }[]
      >(),
      sourceById = new Map(units.map((u) => [u.id, u])),
      layoutById = new Map(layout.units.map((u) => [u.id, u]))
    if (sourceById.size !== units.length || layoutById.size !== layout.units.length) return fail()
    for (const u of units)
      for (const f of u.fragments)
        for (const i of f.items) {
          const key = f.pageNumber + ':' + i.index
          if (!keys.has(key)) keys.set(key, [])
          keys.get(key)!.push({ unit: u, item: i })
        }
    const native = new Map<
      string,
      { item: PdfLayoutPage['items'][number]; x: number; right: number; y: number; bottom: number }
    >()
    for (const [index, item] of page.items.entries()) {
      if (!item.str.trim()) continue
      const f = item.fontName && evidence.fonts[item.fontName],
        m = item.transform
      if (
        !f ||
        f.nativeMetrics !== true ||
        f.vertical !== false ||
        !Number.isFinite(f.ascent) ||
        f.ascent <= 0 ||
        f.ascent > 1 ||
        !Number.isFinite(f.descent) ||
        f.descent > 0 ||
        f.descent < -1 ||
        f.ascent !== item.fontAscent ||
        f.descent !== item.fontDescent ||
        item.fontVertical !== false ||
        m?.length !== 6 ||
        ![...m, item.width, item.height].every(Number.isFinite) ||
        item.dir !== 'ltr' ||
        m[0] <= 0 ||
        m[3] !== item.height ||
        m[1] !== 0 ||
        m[2] !== 0 ||
        item.width < 0 ||
        item.height <= 0
      )
        return fail()
      native.set(page.page + ':' + index, {
        item,
        x: m[4],
        right: m[4] + item.width,
        y: page.height - m[5] - f.ascent * item.height,
        bottom: page.height - m[5] - f.descent * item.height
      })
    }
    const references = units.filter(
      (u) =>
        u.sourceOnly &&
        u.preserve === 'reference' &&
        /^(?:references|bibliography)$/iu.test(u.source.trim())
    )
    if (!references.length) return fail()
    const certify = (source: Unit): Certified | undefined => {
      const u = layoutById.get(source.id)
      if (
        !u ||
        source.figure ||
        source.fragments.some((f) => f.unclippedRect) ||
        u.fragments.length !== 1 ||
        source.fragments.length !== 1 ||
        u.fragments[0].page !== page.page ||
        source.fragments[0].pageNumber !== page.page ||
        u.source !== source.source ||
        u.risks.some((r) => r !== 'possible-continuation') ||
        u.items.length !== u.originalStrings.length ||
        new Set(u.items).size !== u.items.length
      )
        return
      const b = layout.pages[page.page - 1]?.blocks.find((b) => b.id === u.fragments[0].id)
      if (
        !b ||
        !b.lines.length ||
        !same(b.items, u.items) ||
        !same(b.originalStrings, u.originalStrings) ||
        b.lines.some((l) => !validBox(l)) ||
        !same(
          b.lines.flatMap((l) => l.items),
          u.items
        ) ||
        b.lines.map((l) => l.text).join(' ') !== source.source ||
        compact(u.originalStrings.join('')) !== compact(source.source)
      )
        return
      for (const [index, line] of b.lines.entries()) {
        const entries = line.items.map((key) => native.get(key)),
          previous = b.lines[index - 1]
        if (
          !entries.length ||
          entries.some(
            (entry) =>
              !entry ||
              entry.x < line.x - 1e-7 ||
              entry.right > line.right + 1e-7 ||
              page.height - entry.item.transform[5] < line.y ||
              page.height - entry.item.transform[5] > line.bottom
          ) ||
          Math.max(...entries.map((entry) => entry!.item.transform[5])) -
            Math.min(...entries.map((entry) => entry!.item.transform[5])) >
            1e-7 ||
          (previous &&
            (line.y < previous.bottom ||
              line.y - previous.bottom > u.fragments[0].rect.font ||
              Math.min(line.right, previous.right) <= Math.max(line.x, previous.x)))
        )
          return
      }
      const sourceItems = source.fragments[0].items
      if (
        !same(
          sourceItems.map((i) => page.page + ':' + i.index),
          u.items
        ) ||
        sourceItems.some((i, n) => i.text !== u.originalStrings[n]) ||
        u.items.some(
          (key, n) =>
            native.get(key)?.item.str !== u.originalStrings[n] ||
            !((native.get(key)?.item.width ?? 0) > 0) ||
            keys.get(key)?.length !== 1
        )
      )
        return
      const expected = {
        x: b.rect.x / page.width,
        y: b.rect.y / page.height,
        width: (b.rect.right - b.rect.x) / page.width,
        height: (b.rect.bottom - b.rect.y) / page.height
      }
      if (!same(source.fragments[0].rect, expected)) return
      return { source, unit: u, block: b, lines: b.lines }
    }
    const plans = new Map<string, Certified & { parts: Part[] }>(),
      mails: Certified[] = []
    for (const source of units) {
      if (
        !source.fragments.some(
          (f) => f.pageNumber === page.page && f.items.some((i) => mail.test(i.text))
        )
      )
        continue
      const c = certify(source)
      if (!c || ![undefined, 'reference', 'literal'].includes(source.preserve)) return fail()
      const at = c.lines.findIndex((l) => mailRow.test(l.text.trim()))
      if (
        at !== c.lines.length - 1 ||
        at < 0 ||
        c.lines.some((l, n) => n !== at && /@/u.test(l.text)) ||
        c.lines[at].items.filter((k) => mail.test(native.get(k)!.item.str)).length !== 1
      )
        return fail()
      const before = c.lines.slice(0, at),
        prefix = before.map((l) => l.text).join(' '),
        firstInstitution = before.findIndex((l) => institution(l.text))
      if (before.length && firstInstitution < 0 && !/^\([\p{L}\p{M}. '\u2019-]+\)$/u.test(prefix))
        return fail()
      let parts: Part[]
      if (firstInstitution >= 0) {
        if (source.sourceOnly && source.preserve !== 'reference') return fail()
        const author = before.slice(0, firstInstitution),
          body = before.slice(firstInstitution)
        if (
          !institution(body.map((l) => l.text).join(' ')) ||
          author.length > 1 ||
          (author.length && !authorLine(author[0].text))
        )
          return fail()
        parts = [
          ...(author.length ? [{ kind: 'retained-author' as const, lines: author }] : []),
          { kind: 'institution', lines: body },
          { kind: 'email', lines: [c.lines[at]] }
        ]
      } else parts = [{ kind: 'email', lines: c.lines }]
      plans.set(source.id, { ...c, parts })
      mails.push(c)
    }
    if (!mails.length) return fail()
    for (const c of mails) {
      if (plans.get(c.source.id)!.parts.some((p) => p.kind === 'institution')) continue
      const position = layout.units.indexOf(c.unit),
        previous = layout.units[position - 1],
        s = previous && sourceById.get(previous.id)
      if (!s || !institution(s.source) || s.sourceOnly !== true || s.preserve !== 'reference')
        continue
      const p = certify(s)
      if (!p) return fail()
      const last = p.lines.at(-1)!,
        first = c.lines[0],
        gap = first.y - last.bottom,
        overlap = Math.min(last.right, first.right) - Math.max(last.x, first.x)
      if (gap < 0 || gap > c.unit.fragments[0].rect.font || overlap <= 0) return fail()
      plans.set(s.id, { ...p, parts: [{ kind: 'institution', lines: p.lines }] })
    }
    const ordered = [...plans.values()].sort(
        (a, b) => units.indexOf(a.source) - units.indexOf(b.source)
      ),
      claimed = new Set(ordered.flatMap((p) => p.unit.items)),
      first = Math.min(...ordered.flatMap((p) => p.lines.map((l) => l.y)))
    const beforeReferences = references.some((r) =>
      r.fragments.every((f) => f.pageNumber < page.page || f.rect.y * page.height < first)
    )
    if (!beforeReferences) return fail()
    for (const plan of ordered)
      if (
        plan.parts.some(
          (_, index) => index > 0 && sourceById.has(plan.source.id + ':contact-' + index)
        )
      )
        return fail()
    for (const [key, item] of native) {
      if (claimed.has(key) || item.bottom < first) continue
      const owner = keys.get(key)
      const folio =
        owner?.length === 1 &&
        owner[0].unit.sourceOnly &&
        owner[0].unit.fragments.length === 1 &&
        owner[0].unit.fragments[0].items.length === 1 &&
        item.item.str === String(page.page) &&
        item.x >= page.width * 0.4 &&
        item.right <= page.width * 0.6 &&
        item.y > page.height * 0.9
      if (!folio) return fail()
    }
    const out: Unit[] = []
    let boundary = false
    for (const source of units) {
      const p = plans.get(source.id)
      if (!p) {
        out.push(source)
        continue
      }
      const parts = p.parts.map((part, index) => {
        const one = { ...source },
          sourceKeys = new Set(part.lines.flatMap((l) => l.items))
        if (p.parts.length > 1) {
          const r = box(part.lines)
          one.id = index ? source.id + ':contact-' + index : source.id
          one.source = part.lines.map((l) => l.text).join(' ')
          one.fragments = [
            {
              ...source.fragments[0],
              rect: {
                x: r.x / page.width,
                y: r.y / page.height,
                width: (r.right - r.x) / page.width,
                height: (r.bottom - r.y) / page.height
              },
              items: source.fragments[0].items.filter((i) =>
                sourceKeys.has(page.page + ':' + i.index)
              )
            }
          ]
        }
        if (part.kind === 'institution') {
          delete one.sourceOnly
          delete one.preserve
          if (!boundary) {
            one.referenceBoundary = true
            boundary = true
          }
        } else if (part.kind === 'email') {
          one.sourceOnly = true
          one.preserve = 'literal'
        }
        return { kind: part.kind, keys: [...sourceKeys], expected: one }
      })
      if (
        parts.map((p) => p.expected.source).join(' ') !== source.source ||
        !same(
          parts.flatMap((p) => p.expected.fragments.flatMap((f) => f.items)),
          source.fragments.flatMap((f) => f.items)
        )
      )
        return fail()
      out.push(...parts.map((p) => p.expected))
    }
    return out
  } catch {
    return fail()
  }
}
