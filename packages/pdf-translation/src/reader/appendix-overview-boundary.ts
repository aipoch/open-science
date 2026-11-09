import {
  nativeInkPageCurrent,
  createAuxiliaryNativeInkReader,
  createAuxiliaryNativeTerminalCaptionInkReader
} from './auxiliary-native-ink.js'
import { rememberNativeCaptionEligibility } from './caption-eligibility.js'
import { createPdfTranslationSource, type PdfTranslationSource } from './source.js'
import { readNativeReferenceEvidence } from './native-reference-evidence.js'
import {
  nativeAlgorithmInkRegions,
  nativeTerminalPlotCaptionInk,
  nativeTerminalPlotScope
} from './native-source-geometry.js'
import type { PDFDocumentProxy, PDFPageProxy, OPS as PdfOps } from 'pdfjs-dist'
import type { PdfLayoutPage, PdfLayoutTextItem, PdfTranslationLayout } from './layout.js'
type Unit = PdfTranslationLayout['units'][number]
type Content = Awaited<ReturnType<PDFPageProxy['getTextContent']>>
type Outline = NonNullable<Awaited<ReturnType<PDFDocumentProxy['getOutline']>>>
type NativeRef = { num: number; gen: number }
type ProvenLink = {
  indices: number[]
  unsupported?: false
  rect: number[]
  title: string
  destination: string
  targetPage: number
  point: number[]
  reference: NativeRef
  parent: string
  index: number
  siblings: number
}
type Link = { indices: number[]; unsupported: true } | ProvenLink
export type NativeAppendixOverview = {
  /** Private live binding, rechecked after later pages have finished awaiting. */
  current: () => boolean
  heading: {
    index: number
    text: string
    font: string
    transform: number[]
    width: number
    height: number
  }
  links: Link[]
  unreliable: number[]
}
type MetadataDocument = Pick<PDFDocumentProxy, 'numPages' | 'fingerprints'> &
  Partial<Pick<PDFDocumentProxy, 'getOutline' | 'getDestination' | 'getPageIndex'>>
const heading = /^(?:Organization|Overview) of (?:the )?appendices$/u
const compact = (s: string): string => s.replace(/\s/gu, '')
const stable = (x: unknown): string => JSON.stringify(x)
const ref = (x: unknown): x is NativeRef =>
  !!x &&
  typeof x === 'object' &&
  'num' in x &&
  'gen' in x &&
  typeof x.num === 'number' &&
  typeof x.gen === 'number' &&
  Number.isInteger(x.num) &&
  x.num > 0 &&
  Number.isInteger(x.gen) &&
  x.gen >= 0 &&
  Object.keys(x).every((k) => k === 'num' || k === 'gen')
const sameRef = (a: unknown, b: unknown): boolean =>
  ref(a) && ref(b) && a.num === b.num && a.gen === b.gen
const finiteRect = (x: unknown): x is number[] =>
  Array.isArray(x) && x.length === 4 && x.every(Number.isFinite) && x[0] < x[2] && x[1] < x[3]
const nativeBox = (i: PdfLayoutTextItem): number[] => [
  i.transform[4],
  i.transform[5] + i.fontDescent! * i.height,
  i.transform[4] + i.width,
  i.transform[5] + i.fontAscent! * i.height
]
const intersects = (a: number[], b: number[]): boolean =>
  a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
const valid = (i: PdfLayoutTextItem, p: PdfLayoutPage): string | boolean | undefined => {
  const f = p.nativeSectionFontEvidence?.complete
      ? p.nativeSectionFontEvidence.fonts[i.fontName!]
      : undefined,
    t = i.transform,
    b = nativeBox(i)
  return (
    i.str.trim() &&
    i.dir === 'ltr' &&
    i.fontVertical === false &&
    t.length === 6 &&
    [...t, i.width, i.height, i.fontAscent, i.fontDescent].every(Number.isFinite) &&
    i.width > 0 &&
    i.height > 0 &&
    t[0] > 0 &&
    t[1] === 0 &&
    t[2] === 0 &&
    t[3] === i.height &&
    f?.nativeMetrics &&
    f.ascent === i.fontAscent &&
    f.descent === i.fontDescent &&
    b[0] >= 0 &&
    b[1] >= 0 &&
    b[2] <= p.width &&
    b[3] <= p.height
  )
}

/** Only the first visible native showText may certify this ordinary run-in heading. */
function headingUnicode(
  page: PDFPageProxy,
  content: Content,
  ops: Awaited<ReturnType<PDFPageProxy['getOperatorList']>>,
  OPS: typeof PdfOps,
  unreliable: ReadonlySet<number>,
  selected?: number[]
): NativeAppendixOverview['heading'] | undefined {
  const first = content.items.findIndex((i) => 'str' in i && i.str.trim()),
    candidate = content.items[first]
  if (!candidate || !('str' in candidate)) return
  let i = candidate
  const targets = selected
    ?.map((n) => content.items[n])
    .filter((v): v is typeof candidate => !!v && 'str' in v) ?? [candidate]
  let at = 0
  if (
    first < 0 ||
    (selected
      ? targets.length !== selected.length || selected[0] !== first
      : !heading.test(i.str)) ||
    unreliable.has(first) ||
    ops.fnArray.length > 100000 ||
    ops.fnArray.length !== ops.argsArray.length
  )
    return
  let font: string | undefined,
    size: number | undefined,
    matrix: number[] | undefined,
    mode = 0,
    spacing = 0,
    word = 0,
    scale = 100,
    rise = 0,
    fill: unknown = '#000000'
  const allowed = new Set(
    [
      'setFillRGBColor',
      'setStrokeRGBColor',
      'beginText',
      'dependency',
      'setFont',
      'setTextMatrix',
      'setCharSpacing',
      'setWordSpacing',
      'setHScale',
      'setTextRise',
      'setTextRenderingMode',
      'showText'
    ]
      .concat(selected ? ['moveText', 'endText'] : [])
      .map((k) => OPS[k as keyof typeof OPS])
  )
  for (let n = 0; n < Math.min(64, ops.fnArray.length); n++) {
    const op = ops.fnArray[n],
      a = ops.argsArray[n]
    if (!allowed.has(op)) return
    if (op === OPS.setFillRGBColor) fill = a[0]
    if (op === OPS.setFont) {
      font = a[0]
      size = a[1]
    }
    if (selected && op === OPS.beginText) matrix = [1, 0, 0, 1, 0, 0]
    if (selected && op === OPS.endText) matrix = undefined
    if (op === OPS.setTextMatrix) matrix = Array.from(a.length === 1 ? a[0] : a)
    if (selected && op === OPS.moveText) {
      if (!matrix || a.length !== 2 || !a.every(Number.isFinite)) return
      matrix[4] += a[0] * matrix[0] + a[1] * matrix[2]
      matrix[5] += a[0] * matrix[1] + a[1] * matrix[3]
    }
    if (op === OPS.setTextRenderingMode) mode = a[0]
    if (op === OPS.setCharSpacing) spacing = a[0]
    if (op === OPS.setWordSpacing) word = a[0]
    if (op === OPS.setHScale) scale = a[0]
    if (op === OPS.setTextRise) rise = a[0]
    if (op !== OPS.showText) continue
    if (selected) {
      if (
        !font ||
        !matrix ||
        !size ||
        fill !== '#000000' ||
        mode !== 0 ||
        spacing !== 0 ||
        word !== 0 ||
        scale !== 100 ||
        rise !== 0 ||
        matrix[0] !== 1 ||
        matrix[1] !== 0 ||
        matrix[2] !== 0 ||
        matrix[3] !== 1 ||
        !Array.isArray(a?.[0])
      )
        return
      const f = page.commonObjs.get(font),
        glyphs = a[0] as (
          number | { isInFont?: boolean; unicode?: string; accent?: unknown; width?: number }
        )[]
      if (
        f.missingFile !== false ||
        f.isType3Font !== false ||
        f.isInvalidPDFjsFont !== false ||
        f.systemFontInfo !== null ||
        f.vertical !== false ||
        !glyphs.length ||
        glyphs.length > 256 ||
        glyphs.some((g) =>
          typeof g === 'number'
            ? !Number.isFinite(g)
            : !g ||
              g.isInFont !== true ||
              typeof g.unicode !== 'string' ||
              !g.unicode ||
              !!g.accent ||
              !Number.isFinite(g.width) ||
              g.width! <= 0
        )
      )
        return
      let cursor = 0,
        offset = 0
      while (cursor < glyphs.length) {
        while (typeof glyphs[cursor] === 'number') offset -= glyphs[cursor++] as number
        if (cursor === glyphs.length) break
        const target = targets[at],
          style = target && content.styles[target.fontName]
        if (
          !target ||
          unreliable.has(selected[at]) ||
          target.fontName !== font ||
          target.height !== size ||
          target.transform[0] !== size ||
          target.transform[1] !== 0 ||
          target.transform[2] !== 0 ||
          target.transform[3] !== size ||
          f.ascent !== style?.ascent ||
          f.descent !== style?.descent ||
          Math.fround(matrix[4] + (offset * size) / 1000) !== Math.fround(target.transform[4]) ||
          Math.fround(matrix[5]) !== Math.fround(target.transform[5])
        )
          return
        const start = offset,
          expected = compact(target.str)
        let literal = ''
        while (cursor < glyphs.length && literal !== expected) {
          const g = glyphs[cursor++]
          if (typeof g === 'number') offset -= g
          else {
            literal += compact(g.unicode!)
            offset += g.width!
          }
          if (!expected.startsWith(literal)) return
        }
        if (
          literal !== expected ||
          Math.abs(((offset - start) * size) / 1000 - target.width) > target.height * 0.001
        )
          return
        at++
      }
      if (at !== targets.length) continue
      return {
        index: first,
        text: candidate.str,
        font: candidate.fontName,
        transform: [...candidate.transform],
        width: candidate.width,
        height: candidate.height
      }
    }
    i = targets[at]
    if (!i || !('str' in i) || !font || fill !== '#000000') return
    const glyphs = a[0].filter((g: unknown) => g && typeof g === 'object'),
      f = page.commonObjs.get(font),
      st = content.styles[i.fontName]
    if (
      font !== i.fontName ||
      size !== i.height ||
      mode !== 0 ||
      spacing !== 0 ||
      word !== 0 ||
      scale !== 100 ||
      rise !== 0 ||
      !matrix ||
      matrix[0] !== Math.fround(i.transform[0] / i.height) ||
      matrix[1] !== 0 ||
      matrix[2] !== 0 ||
      matrix[3] !== 1 ||
      matrix[4] !== Math.fround(i.transform[4]) ||
      matrix[5] !== Math.fround(i.transform[5]) ||
      !glyphs.length ||
      glyphs.length > 128 ||
      glyphs.some(
        (g: { isInFont?: boolean; unicode?: unknown; accent?: unknown; width?: number }) =>
          g.isInFont !== true ||
          typeof g.unicode !== 'string' ||
          !g.unicode ||
          g.accent ||
          !Number.isFinite(g.width)
      ) ||
      compact(glyphs.map((g: { unicode: string }) => g.unicode).join('')) !== compact(i.str) ||
      f.missingFile !== false ||
      f.isType3Font !== false ||
      f.isInvalidPDFjsFont !== false ||
      f.systemFontInfo !== null ||
      f.vertical !== false ||
      f.ascent !== st.ascent ||
      f.descent !== st.descent
    )
      return
    const advance =
      (a[0].reduce(
        (v: number, g: number | { width: number }) => v + (typeof g === 'number' ? -g : g.width),
        0
      ) *
        i.transform[0]) /
      1000
    if (Math.abs(advance - i.width) > i.height * 0.001) return
    if (++at < targets.length) continue
    i = candidate
    return {
      index: first,
      text: i.str,
      font: i.fontName,
      transform: [...i.transform],
      width: i.width,
      height: i.height
    }
  }
}

/** Native metadata is optional, bounded, and tied to unchanged document/content objects. */
export async function readNativeAppendixOverview({
  document,
  page,
  content,
  rawPage,
  unreliable,
  sourceIdentity,
  signal
}: {
  document: MetadataDocument
  page: PDFPageProxy
  content: Content
  rawPage: PdfLayoutPage
  unreliable: ReadonlySet<number>
  sourceIdentity?: Readonly<{ sourceChecksum: string; sourceSizeBytes: number }>
  signal: AbortSignal
}): Promise<NativeAppendixOverview | undefined> {
  if (
    !(['getOutline', 'getDestination', 'getPageIndex'] as const).every(
      (k) => typeof document[k] === 'function'
    ) ||
    !rawPage.nativeSectionFontEvidence?.complete ||
    !content.items.some(
      (i, index) =>
        'str' in i &&
        heading.test(i.str) &&
        content.items.findIndex((j) => 'str' in j && j.str.trim()) === index
    )
  )
    return
  const fingerprint = document.fingerprints[0],
    fingerprints = document.fingerprints,
    count = document.numPages,
    items = content.items,
    styles = content.styles,
    contentSnapshot = stable(content),
    rawState = (): string =>
      stable([
        rawPage.page,
        rawPage.width,
        rawPage.height,
        rawPage.rotation,
        rawPage.items,
        rawPage.nativeSectionFontEvidence
      ]),
    rawSnapshot = rawState(),
    identitySnapshot = stable(sourceIdentity),
    watched: [unknown, string][] = [],
    guards: (() => boolean)[] = [],
    apis = [
      document.getOutline,
      document.getDestination,
      document.getPageIndex,
      page.getAnnotations,
      page.getOperatorList
    ]
  const current = (): boolean =>
    guards.every((g) => g()) &&
    [
      document.getOutline,
      document.getDestination,
      document.getPageIndex,
      page.getAnnotations,
      page.getOperatorList
    ].every((api, n) => api === apis[n]) &&
    !signal.aborted &&
    document.fingerprints === fingerprints &&
    document.fingerprints[0] === fingerprint &&
    document.numPages === count &&
    content.items === items &&
    content.styles === styles &&
    rawState() === rawSnapshot &&
    stable(sourceIdentity) === identitySnapshot &&
    stable(content) === contentSnapshot &&
    watched.every(([v, s]) => stable(v) === s)
  const bound = async <T>(promise: Promise<T>): Promise<T> => {
    const value = await promise
    if (!current()) throw Error('source changed')
    return value
  }
  const watch = <T>(value: T): T => {
    const snapshot = stable(value)
    if (snapshot.length > 65536) throw Error('metadata budget')
    watched.push([value, snapshot])
    return value
  }
  try {
    if (items.length > 2048 || !current()) return
    const { OPS } = await bound(import('pdfjs-dist/legacy/build/pdf.mjs'))
    const op = await bound(page.getOperatorList()),
      proof = headingUnicode(page, content, op, OPS, unreliable)
    if (!proof) return
    const fn = op.fnArray,
      args = op.argsArray,
      prefix = stable([fn.slice(0, 64), args.slice(0, 64)]),
      length = fn.length,
      font = page.commonObjs.get(proof.font),
      fontProperties = (): unknown[] => [
        font.missingFile,
        font.isType3Font,
        font.isInvalidPDFjsFont,
        font.systemFontInfo,
        font.vertical,
        font.ascent,
        font.descent
      ],
      fontSnapshot = stable(fontProperties())
    guards.push(
      () =>
        op.fnArray === fn &&
        op.argsArray === args &&
        op.fnArray.length === length &&
        op.argsArray.length === length &&
        stable([fn.slice(0, 64), args.slice(0, 64)]) === prefix &&
        page.commonObjs.get(proof.font) === font &&
        stable(fontProperties()) === fontSnapshot
    )
    const outline = watch(await bound(document.getOutline!())),
      nodes: { node: Outline[number]; parent: string; index: number; siblings: number }[] = []
    const visit = (siblings: Outline | null, depth = 0, parent = 'root'): void => {
      if (!Array.isArray(siblings) || depth > 8 || nodes.length + siblings.length > 256)
        throw Error('outline budget')
      siblings.forEach((n, index) => {
        if (
          typeof n.title !== 'string' ||
          typeof n.dest !== 'string' ||
          !Array.isArray(n.items) ||
          n.url ||
          n.unsafeUrl
        )
          throw Error('outline unsupported')
        nodes.push({ node: n, parent, index, siblings: siblings.length })
        visit(n.items, depth + 1, parent + '/' + index)
      })
    }
    visit(outline)
    const annotations = watch(await bound(page.getAnnotations({ intent: 'display' })))
    if (!Array.isArray(annotations) || annotations.length > 128) return
    const links: Link[] = []
    for (const a of annotations) {
      if (a.subtype !== 'Link' || !finiteRect(a.rect)) continue
      const owners = rawPage.items.flatMap((i, index) =>
        i.str.trim() && valid(i, rawPage) && intersects(a.rect, nativeBox(i)) ? [index] : []
      )
      if (!owners.length) continue
      // Further restriction to the exact overview owner happens in the layout phase.
      if (typeof a.dest !== 'string' || a.url || a.unsafeUrl) {
        links.push({ indices: owners, unsupported: true })
        continue
      }
      const matches = nodes.filter((n) => n.node.dest === a.dest)
      if (matches.length !== 1) {
        links.push({ indices: owners, unsupported: true })
        continue
      }
      const n = matches[0],
        destination = watch(await bound(document.getDestination!(a.dest))),
        outlineDestination = watch(await bound(document.getDestination!(n.node.dest as string)))
      if (
        !Array.isArray(destination) ||
        destination.length !== 5 ||
        !sameRef(destination[0], outlineDestination?.[0]) ||
        stable(destination) !== stable(outlineDestination) ||
        destination[1]?.name !== 'XYZ' ||
        !Number.isFinite(destination[2]) ||
        !Number.isFinite(destination[3]) ||
        destination[4] !== null
      ) {
        links.push({ indices: owners, unsupported: true })
        continue
      }
      const targetIndex = await bound(document.getPageIndex!(destination[0]))
      const outlineIndex = await bound(document.getPageIndex!(outlineDestination![0]))
      if (
        targetIndex !== outlineIndex ||
        !Number.isInteger(targetIndex) ||
        targetIndex < 0 ||
        targetIndex >= count
      )
        return
      links.push({
        indices: owners,
        rect: [...a.rect],
        title: n.node.title,
        destination: a.dest,
        targetPage: targetIndex + 1,
        point: destination.slice(2, 4),
        reference: { ...destination[0] },
        parent: n.parent,
        index: n.index,
        siblings: n.siblings
      })
    }
    if (!current()) return
    return { heading: proof, links, unreliable: [...unreliable], current }
  } catch {
    signal.throwIfAborted()
    return
  }
}

/** Exact native owner plus independently closed bibliography and actual first appendix title. */
export function nativeAppendixOverviewBoundary(
  units: Unit[],
  pages: PdfLayoutPage[],
  page: PdfLayoutPage,
  fact: NativeAppendixOverview | undefined
): Unit | undefined {
  if (
    !fact ||
    typeof fact.current !== 'function' ||
    page.rotation !== 0 ||
    !page.nativeSectionFontEvidence?.complete
  )
    return
  try {
    if (!fact.current()) return
  } catch {
    // A late cleanup/replacement must only refuse this optional boundary.
    return
  }
  const counts = new Map()
  for (const u of units) for (const k of u.items) counts.set(k, (counts.get(k) ?? 0) + 1)
  const whole = (
    u: Unit | undefined,
    p: PdfLayoutPage
  ): { index: number; item: PdfLayoutTextItem }[] | undefined => {
    if (
      !u ||
      u.fragments.length !== 1 ||
      u.fragments[0].page !== p.page ||
      u.risks.length ||
      u.sourceOnly ||
      u.preserve ||
      !u.items.length ||
      u.items.length !== u.originalStrings.length ||
      !p.nativeSectionFontEvidence?.complete
    )
      return
    const entries = u.items.map((k, n) => {
      const [a, i] = k.split(':').map(Number),
        item = p.items[i]
      return a === p.page &&
        counts.get(k) === 1 &&
        item?.str === u.originalStrings[n] &&
        valid(item, p)
        ? { index: i, item }
        : undefined
    })
    return entries.every((e): e is NonNullable<typeof e> => !!e) &&
      compact(entries.map((e) => e.item.str).join('')) === compact(u.source)
      ? entries
      : undefined
  }
  const key = page.page + ':' + fact.heading.index,
    owner = units.find((u) => u.items.includes(key)),
    entries = whole(owner, page)
  if (
    !entries ||
    entries[0].index !== fact.heading.index ||
    page.items.findIndex((i) => i.str.trim()) !== fact.heading.index ||
    entries[0].item.str !== fact.heading.text ||
    entries[0].item.fontName !== fact.heading.font ||
    stable(entries[0].item.transform) !== stable(fact.heading.transform) ||
    entries[0].item.width !== fact.heading.width ||
    entries[0].item.height !== fact.heading.height
  )
    return
  if (!owner || entries.some((e) => fact.unreliable.includes(e.index))) return
  const first = entries[0].item,
    body = entries.slice(1),
    indices = new Set(entries.map((e) => e.index))
  if (
    !body.length ||
    first.hasEOL !== false ||
    body[0].item.fontName === first.fontName ||
    body.some(
      (e) =>
        e.item.height !== first.height ||
        e.item.transform[5] > first.transform[5] ||
        e.item.fontName === first.fontName
    ) ||
    body[0].item.transform[5] !== first.transform[5] ||
    body[0].item.transform[4] <= first.transform[4] + first.width
  )
    return
  const labels = [...owner.source.matchAll(/\bAppendix ([A-Z])\b/gu)].map((m) => m[1])
  if (
    labels.length < 2 ||
    labels.length > 26 ||
    labels.some((s, i) => s !== String.fromCharCode(65 + i))
  )
    return
  const minY = Math.min(...entries.map((e) => nativeBox(e.item)[1])),
    maxX = Math.max(...entries.map((e) => nativeBox(e.item)[2]))
  if (
    page.items.some(
      (i, index) =>
        i.str.trim() &&
        !indices.has(index) &&
        (!valid(i, page) ||
          intersects(nativeBox(i), [first.transform[4], minY, maxX, nativeBox(first)[3]]))
    )
  )
    return
  const candidates = fact.links
    .filter((l) => l.indices.some((i) => indices.has(i)))
    .sort(
      (a, b) =>
        Math.min(...a.indices) - Math.min(...b.indices) ||
        ('rect' in a ? a.rect[0] : 0) - ('rect' in b ? b.rect[0] : 0)
    )
  if (!candidates.every((l): l is ProvenLink => !l.unsupported)) return
  const selected = candidates
  if (
    selected.length !== labels.length ||
    selected.some(
      (l, i) =>
        l.unsupported ||
        l.indices.length !== 1 ||
        !indices.has(l.indices[0]) ||
        l.parent !== selected[0].parent ||
        l.index !== selected[0].index + i ||
        l.index !== l.siblings - selected.length + i ||
        l.targetPage < page.page ||
        (i && l.targetPage < selected[i - 1].targetPage)
    ) ||
    new Set(selected.map((l) => l.destination)).size !== selected.length ||
    new Set(selected.map((l) => stable(l.reference))).size !== selected.length
  )
    return
  const firstLink = selected[0]
  if (
    selected.some((link) => {
      const target = pages.find((p) => p.page === link.targetPage)
      return (
        !target ||
        link.point[0] < 0 ||
        link.point[0] > target.width ||
        link.point[1] < 0 ||
        link.point[1] > target.height
      )
    })
  )
    return
  if (firstLink.targetPage !== page.page) return
  const title = units.find(
      (u) => u.source === labels[0] + ' ' + firstLink.title && u.fragments[0]?.page === page.page
    ),
    titleEntries = whole(title, page)
  if (
    !titleEntries ||
    titleEntries.length !== 2 ||
    titleEntries[0].item.str !== labels[0] ||
    titleEntries[1].item.str !== firstLink.title
  )
    return
  const a = titleEntries[0].item,
    b = titleEntries[1].item
  if (
    a.height < first.height * 1.15 ||
    a.height !== b.height ||
    a.fontName !== b.fontName ||
    a.transform[5] !== b.transform[5] ||
    a.transform[4] !== firstLink.point[0] ||
    a.transform[5] >= firstLink.point[1] ||
    firstLink.point[1] - a.transform[5] > a.height * 1.2 ||
    a.transform[5] >= minY ||
    page.items.some(
      (i) => i.str.trim() && i.transform[5] > a.transform[5] && i.transform[5] < firstLink.point[1]
    )
  )
    return
  const prior = pages.find((p) => p.page === page.page - 1)
  if (!prior?.nativeSectionFontEvidence?.complete) return
  const priorOwners = units.filter(
      (u) => u.fragments.length === 1 && u.fragments[0].page === prior.page
    ),
    folio = (u: Unit): boolean =>
      /^\d+$/u.test(u.source) &&
      u.items.length === 1 &&
      (() => {
        const i = prior.items[Number(u.items[0].split(':')[1])]
        return (
          i.transform[5] < prior.height * 0.1 &&
          Math.abs(i.transform[4] + i.width / 2 - prior.width / 2) < i.height * 4
        )
      })()
  const tail = priorOwners.filter((u) => !folio(u)).slice(-2),
    matches = tail.map((u) => /^\[(\d+)\]\s+\p{Lu}.*\b(?:18|19|20)\d{2}\.$/u.exec(u.source))
  if (
    tail.length !== 2 ||
    !matches.every((m): m is RegExpExecArray => !!m) ||
    Number(matches[1][1]) !== Number(matches[0][1]) + 1 ||
    tail.some((u) => !whole(u, prior))
  )
    return
  const last = Math.max(...tail[1].items.map((k) => Number(k.split(':')[1])))
  if (
    prior.items.some(
      (i, n) =>
        n > last &&
        i.str.trim() &&
        !priorOwners.some((u) => folio(u) && u.items.includes(prior.page + ':' + n))
    )
  )
    return
  return owner
}

export type NativeOutlineRestart = Readonly<Record<never, never>>
const restarts = new WeakMap<
  NativeOutlineRestart,
  {
    current: () => boolean
    heading: number[]
    subsection: number[]
  }
>()

/** A separate native outline branch corroborates a numbered document restart.
 * The actual bibliography end and complete native owners are verified below. */
export async function readNativeOutlineRestart(
  input: Parameters<typeof readNativeAppendixOverview>[0]
): Promise<NativeOutlineRestart | undefined> {
  const { document, page, content, rawPage, signal, unreliable } = input
  const visible = content.items.flatMap((item, index) =>
    'str' in item && item.str.trim() ? [{ item, index }] : []
  )
  if (
    !rawPage.nativeSectionFontEvidence?.complete ||
    rawPage.rotation !== 0 ||
    visible.length < 6 ||
    visible[0].item.str !== '1' ||
    !/^[A-Z][A-Za-z ,–—-]{4,79}$/u.test(visible[1].item.str) ||
    visible[2].item.str !== '1.1' ||
    !/^[A-Z][A-Za-z ,–—-]{4,79}$/u.test(visible[3].item.str) ||
    !document.getOutline ||
    !document.getDestination ||
    !document.getPageIndex
  )
    return
  const selected = visible.slice(0, 4),
    items = content.items,
    styles = content.styles,
    rawItems = rawPage.items,
    rawFont = rawPage.nativeSectionFontEvidence,
    fingerprint = document.fingerprints,
    value = fingerprint[0],
    count = document.numPages,
    outlineApi = document.getOutline,
    destinationApi = document.getDestination,
    pageIndexApi = document.getPageIndex,
    common = page.commonObjs,
    rawValue = stable([
      rawPage.page,
      rawPage.width,
      rawPage.height,
      rawPage.rotation,
      rawItems,
      rawFont
    ]),
    contentValue = stable(content),
    identity = stable(input.sourceIdentity),
    watched: [unknown, string][] = []
  const nativeRefs = items.flatMap((i) => ('str' in i ? [{ item: i, transform: i.transform }] : []))
  let fonts: {
    id: string
    font: ReturnType<PDFPageProxy['commonObjs']['get']>
    style: Content['styles'][string]
    value: string
  }[]
  try {
    fonts = Object.keys(rawFont.fonts).map((id) => {
      const font = common.get(id),
        style = styles[id]
      return {
        id,
        font,
        style,
        value: stable([
          font.missingFile,
          font.isType3Font,
          font.isInvalidPDFjsFont,
          font.systemFontInfo,
          font.vertical,
          font.ascent,
          font.descent,
          style
        ])
      }
    })
  } catch {
    return
  }
  const metadataCurrent: (() => boolean)[] = []
  const current = (): boolean =>
    !signal.aborted &&
    document.fingerprints === fingerprint &&
    fingerprint[0] === value &&
    document.numPages === count &&
    document.getOutline === outlineApi &&
    document.getDestination === destinationApi &&
    document.getPageIndex === pageIndexApi &&
    page.commonObjs === common &&
    content.items === items &&
    content.styles === styles &&
    rawPage.items === rawItems &&
    rawPage.nativeSectionFontEvidence === rawFont &&
    stable([rawPage.page, rawPage.width, rawPage.height, rawPage.rotation, rawItems, rawFont]) ===
      rawValue &&
    stable(content) === contentValue &&
    stable(input.sourceIdentity) === identity &&
    nativeRefs.every((r) => items.includes(r.item) && r.item.transform === r.transform) &&
    fonts.every(
      (r) =>
        common.get(r.id) === r.font &&
        styles[r.id] === r.style &&
        stable([
          r.font.missingFile,
          r.font.isType3Font,
          r.font.isInvalidPDFjsFont,
          r.font.systemFontInfo,
          r.font.vertical,
          r.font.ascent,
          r.font.descent,
          r.style
        ]) === r.value
    ) &&
    watched.every(([v, s]) => stable(v) === s) &&
    metadataCurrent.every((f) => f())
  const bound = async <T>(promise: Promise<T>): Promise<T> => {
    signal.throwIfAborted()
    if (!current()) throw Error('native restart changed')
    const result = await promise
    signal.throwIfAborted()
    if (!current()) throw Error('native restart changed')
    return result
  }
  try {
    if (
      selected.some(
        ({ item, index }) =>
          unreliable.has(index) ||
          !valid(rawItems[index], rawPage) ||
          item.str !== rawItems[index].str
      )
    )
      return
    const first = selected[0].item,
      second = selected[2].item
    if (
      first.fontName !== selected[1].item.fontName ||
      second.fontName !== selected[3].item.fontName ||
      first.fontName !== second.fontName ||
      first.height <= second.height * 1.1 ||
      first.transform[5] !== selected[1].item.transform[5] ||
      second.transform[5] !== selected[3].item.transform[5] ||
      first.transform[4] !== second.transform[4] ||
      second.transform[5] >= first.transform[5] ||
      rawPage.height - first.transform[5] > rawPage.height * 0.16
    )
      return
    const operators = await bound(page.getOperatorList())
    const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    if (
      !current() ||
      !headingUnicode(
        page,
        content,
        operators,
        OPS,
        unreliable,
        selected.map((r) => r.index)
      )
    )
      return
    watched.push([operators, stable(operators)])
    const fn = operators.fnArray,
      args = operators.argsArray,
      entries = args.map((a) => ({
        a,
        first: a?.[0],
        children: Array.isArray(a?.[0]) ? [...a[0]] : undefined
      }))
    metadataCurrent.push(
      () =>
        operators.fnArray === fn &&
        operators.argsArray === args &&
        entries.every(
          (e, i) =>
            args[i] === e.a &&
            e.a?.[0] === e.first &&
            (!e.children || e.children.every((v, j) => e.first[j] === v))
        )
    )
    const outline = await bound(outlineApi.call(document))
    if (!outline || outline.length < 2 || outline.length > 16) return
    watched.push([outline, stable(outline)])
    const rootNodes = [...outline]
    metadataCurrent.push(
      () => outline.length === rootNodes.length && outline.every((n, i) => n === rootNodes[i])
    )
    const roots: { node: Outline[number]; page: number }[] = []
    const destination = async (node: Outline[number]): Promise<number | undefined> => {
      if (
        typeof node.title !== 'string' ||
        node.url ||
        ('action' in node && node.action) ||
        node.unsafeUrl
      )
        return
      const direct = node.dest,
        children = node.items
      metadataCurrent.push(() => node.dest === direct && node.items === children)
      const dest =
        typeof node.dest === 'string'
          ? await bound(destinationApi.call(document, node.dest))
          : node.dest
      if (!Array.isArray(dest) || !ref(dest[0])) return
      watched.push([dest, stable(dest)])
      return 1 + (await bound(pageIndexApi.call(document, dest[0])))
    }
    for (const node of outline) {
      const n = await destination(node)
      if (n === undefined) return
      roots.push({ node, page: n })
    }
    const matches = roots.filter((r) => r.page === rawPage.page)
    if (matches.length !== 1) return
    const root = matches[0],
      at = roots.indexOf(root),
      section = root.node.items[0],
      sub = section?.items[0]
    metadataCurrent.push(() => root.node.items[0] === section && section?.items[0] === sub)
    if (
      !at ||
      roots.slice(0, at).some((r) => r.page >= rawPage.page) ||
      !section ||
      !sub ||
      section.title !== selected[1].item.str ||
      sub.title !== selected[3].item.str ||
      (await destination(section)) !== rawPage.page ||
      (await destination(sub)) !== rawPage.page ||
      !current()
    )
      return
    const certificate = Object.freeze({})
    restarts.set(certificate, {
      current,
      heading: selected.slice(0, 2).map((r) => r.index),
      subsection: selected.slice(2).map((r) => r.index)
    })
    return certificate
  } catch {
    signal.throwIfAborted()
    return
  }
}

/** End only a closed preceding bibliography at its independently native restart.
 * Formula/table/literal flags already present on other owners are untouched. */
export function nativeOutlineRestartBoundary(
  units: Unit[],
  pages: PdfLayoutPage[],
  page: PdfLayoutPage,
  certificate: NativeOutlineRestart | undefined
): Unit | undefined {
  const fact = certificate && restarts.get(certificate),
    prior = pages.find((p) => p.page === page.page - 1)
  try {
    if (!fact?.current() || !prior?.nativeSectionFontEvidence?.complete) return
  } catch {
    return
  }
  const counts = new Map<string, number>()
  for (const u of units) for (const key of u.items) counts.set(key, (counts.get(key) ?? 0) + 1)
  const native = (u: Unit, p: PdfLayoutPage): PdfLayoutTextItem[] | undefined => {
    if (
      !u.items.length ||
      u.items.length !== u.originalStrings.length ||
      u.risks.length ||
      u.fragments.some((f) => f.page !== p.page) ||
      u.sourceOnly ||
      u.preserve
    )
      return
    const a = u.items.map((key, n) => {
      const [number, index] = key.split(':').map(Number),
        i = p.items[index]
      return number === p.page &&
        counts.get(key) === 1 &&
        i?.str === u.originalStrings[n] &&
        valid(i, p)
        ? i
        : undefined
    })
    return a.every((i): i is PdfLayoutTextItem => !!i) ? a : undefined
  }
  const exclusive = (u: Unit, p: PdfLayoutPage): boolean => {
    const a = native(u, p)
    if (!a) return false
    const boxes = a.map(nativeBox),
      box = [
        Math.min(...boxes.map((b) => b[0])),
        Math.min(...boxes.map((b) => b[1])),
        Math.max(...boxes.map((b) => b[2])),
        Math.max(...boxes.map((b) => b[3]))
      ],
      keys = new Set(u.items)
    return !p.items.some(
      (i, n) =>
        i.str.trim() &&
        !keys.has(p.page + ':' + n) &&
        (!valid(i, p) || intersects(nativeBox(i), box))
    )
  }
  const match = (indexes: number[]): Unit | undefined =>
    units.find((u) => stable(u.items) === stable(indexes.map((i) => page.page + ':' + i)))
  const title = match(fact!.heading),
    sub = match(fact!.subsection)
  if (
    !title ||
    !sub ||
    title.kind !== 'heading-candidate' ||
    sub.kind !== 'heading-candidate' ||
    !exclusive(title, page) ||
    !exclusive(sub, page)
  )
    return
  const index = units.indexOf(title),
    reference = units.slice(0, index).findLast((u) => /^References$/u.test(u.source)),
    before = units.filter((u) => u.fragments.length === 1 && u.fragments[0].page === prior!.page),
    folio = before.at(-1),
    currentFolio = units.find(
      (u) =>
        u.fragments.length === 1 &&
        u.fragments[0].page === page.page &&
        u.source === '1' &&
        u.preserve === 'literal'
    )
  if (
    !reference ||
    reference.fragments[0].page >= prior!.page ||
    !folio ||
    folio.source !== String(prior!.page) ||
    folio.preserve !== 'literal' ||
    !currentFolio ||
    currentFolio.fragments[0].rect.y < page.height * 0.8
  )
    return
  const entries = before.slice(0, -1),
    claims = entries.flatMap((u) => u.items),
    expected = prior!.items.flatMap((i, n) =>
      i.str.trim() && String(prior!.page) !== i.str ? [prior!.page + ':' + n] : []
    )
  if (stable(claims) !== stable(expected) || entries.some((u) => !native(u, prior!))) return
  const citationItems = prior!.items.filter((item, n) => expected.includes(prior!.page + ':' + n))
  const starts = citationItems.flatMap((item, n) =>
    /^\p{Lu}[\p{L}’'-]+, .{1,220}\((?:18|19|20)\d{2}\)\./u.test(item.str) ? [n] : []
  )

  if (starts.length < 2 || starts[0] !== 0) return
  for (let n = 0; n < starts.length; n++) {
    const text = citationItems
      .slice(starts[n], starts[n + 1])
      .map((item) => item.str)
      .join(' ')
    if (!/\.$/u.test(text) || (text.match(/\p{L}{2,}/gu)?.length ?? 0) < 12) return
  }
  const separateNativeProse = (u: Unit): boolean => {
    const a = native(u, page)
    if (!a) return false
    const keys = new Set(u.items)
    return !page.items.some(
      (i, n) =>
        i.str.trim() &&
        !keys.has(page.page + ':' + n) &&
        (!valid(i, page) || a.some((j) => intersects(nativeBox(i), nativeBox(j))))
    )
  }
  const prose = units
    .slice(units.indexOf(sub) + 1)
    .find(
      (u) =>
        u.fragments.length === 1 &&
        u.fragments[0].page === page.page &&
        u.kind === 'prose-candidate' &&
        !u.sourceOnly &&
        !u.preserve &&
        !u.risks.length &&
        /[.!?]$/u.test(u.source) &&
        (u.source.match(/\p{L}{2,}/gu)?.length ?? 0) >= 20 &&
        separateNativeProse(u)
    )
  if (
    !prose ||
    prose.fragments[0].rect.font >= sub.fragments[0].rect.font * 0.9 ||
    Math.abs(prose.fragments[0].rect.x - title.fragments[0].rect.x) >
      prose.fragments[0].rect.font * 0.2 ||
    prose.fragments[0].rect.right - prose.fragments[0].rect.x < page.width * 0.5
  )
    return
  return fact!.current() ? title : undefined
}

/** Prove an entire unskewed prefix without promoting float32 operator positions
 * into the native double text cursor. Each explicit matrix anchors once. */
function onlinePrefixUnicode(
  page: PDFPageProxy,
  content: Content,
  operators: Awaited<ReturnType<PDFPageProxy['getOperatorList']>>,
  OPS: typeof PdfOps,
  unreliable: ReadonlySet<number>,
  selected: number[]
): boolean {
  if (
    operators.fnArray.length > 100000 ||
    operators.fnArray.length !== operators.argsArray.length ||
    selected[0] !== content.items.findIndex((i) => 'str' in i && i.str.trim())
  )
    return false
  const allowed = new Set(
    [
      'setFillRGBColor',
      'setStrokeRGBColor',
      'beginText',
      'dependency',
      'setFont',
      'setTextMatrix',
      'setCharSpacing',
      'setWordSpacing',
      'setHScale',
      'setTextRise',
      'setTextRenderingMode',
      'showText',
      'moveText',
      'endText'
    ].map((k) => OPS[k as keyof typeof OPS])
  )
  let matrix: number[] | undefined,
    native: number[] | undefined,
    font: string | undefined,
    size = 0,
    fill: unknown = '#000000',
    mode = 0,
    spacing = 0,
    word = 0,
    scale = 100,
    rise = 0,
    at = 0
  for (let n = 0; n < Math.min(64, operators.fnArray.length); n++) {
    const op = operators.fnArray[n],
      a = operators.argsArray[n]
    if (!allowed.has(op)) return false
    if (op === OPS.setFillRGBColor) fill = a[0]
    if (op === OPS.setFont) {
      font = a[0]
      size = a[1]
    }
    if (op === OPS.beginText) {
      matrix = [1, 0, 0, 1, 0, 0]
      native = undefined
    }
    if (op === OPS.endText) {
      matrix = undefined
      native = undefined
    }
    if (op === OPS.setTextMatrix) {
      matrix = Array.from(a.length === 1 ? a[0] : a)
      native = undefined
    }
    if (op === OPS.moveText) {
      if (!matrix || a.length !== 2 || !a.every(Number.isFinite)) return false
      matrix[4] += a[0] * matrix[0] + a[1] * matrix[2]
      matrix[5] += a[0] * matrix[1] + a[1] * matrix[3]
      native = undefined
    }
    if (op === OPS.setTextRenderingMode) mode = a[0]
    if (op === OPS.setCharSpacing) spacing = a[0]
    if (op === OPS.setWordSpacing) word = a[0]
    if (op === OPS.setHScale) scale = a[0]
    if (op === OPS.setTextRise) rise = a[0]
    if (op !== OPS.showText) continue
    const target = content.items[selected[at]],
      glyphs = a?.[0]
    if (
      !target ||
      !('str' in target) ||
      !font ||
      !matrix ||
      !Number.isFinite(size) ||
      size <= 0 ||
      fill !== '#000000' ||
      mode !== 0 ||
      spacing !== 0 ||
      word !== 0 ||
      scale !== 100 ||
      rise !== 0 ||
      !matrix.every(Number.isFinite) ||
      matrix[0] <= 0 ||
      matrix[1] !== 0 ||
      matrix[2] !== 0 ||
      matrix[3] !== 1 ||
      unreliable.has(selected[at]) ||
      target.fontName !== font ||
      target.height !== size ||
      target.dir !== 'ltr' ||
      target.transform[1] !== 0 ||
      target.transform[2] !== 0 ||
      target.transform[3] !== size ||
      !Array.isArray(glyphs) ||
      !glyphs.length ||
      glyphs.length > 256
    )
      return false
    const f = page.commonObjs.get(font),
      style = content.styles[font]
    if (
      f.missingFile !== false ||
      f.isType3Font !== false ||
      f.isInvalidPDFjsFont !== false ||
      f.systemFontInfo !== null ||
      f.vertical !== false ||
      f.ascent !== style?.ascent ||
      f.descent !== style?.descent ||
      stable(f.fontMatrix) !== '[0.001,0,0,0.001,0,0]'
    )
      return false
    let advance = 0,
      leading = 0,
      started = false,
      literal = ''
    for (const g of glyphs) {
      if (typeof g === 'number') {
        if (!Number.isFinite(g)) return false
        advance -= g
        if (!started) leading -= g
      } else {
        if (
          !g ||
          g.isInFont !== true ||
          typeof g.unicode !== 'string' ||
          !g.unicode ||
          g.accent ||
          !Number.isFinite(g.width) ||
          g.width <= 0
        )
          return false
        started = true
        literal += compact(g.unicode)
        advance += g.width
      }
    }
    if (!started || literal !== compact(target.str)) return false
    if (!native) {
      const ratio = target.transform[0] / size
      if (
        leading !== 0 ||
        !Number.isFinite(ratio) ||
        ratio <= 0 ||
        Math.fround(ratio) !== Math.fround(matrix[0]) ||
        Math.fround(target.transform[4]) !== Math.fround(matrix[4]) ||
        Math.fround(target.transform[5]) !== Math.fround(matrix[5])
      )
        return false
      native = [ratio, 0, 0, 1, target.transform[4], target.transform[5]]
    }
    if (
      Math.fround(target.transform[0]) !== Math.fround(native[0] * size) ||
      Math.fround(target.transform[4]) !==
        Math.fround(native[4] + (leading * size * native[0]) / 1000) ||
      Math.fround(target.transform[5]) !== Math.fround(native[5]) ||
      Math.abs(((advance - leading) * size * native[0]) / 1000 - target.width) >
        target.height * 0.001
    )
      return false
    native[4] += (advance * size * native[0]) / 1000
    if (++at === selected.length) return true
  }
  return false
}

/** Separate publisher: the old overview and numbered-outline predicates stay unchanged. */
type NativeOnlineInput = Parameters<typeof readNativeAppendixOverview>[0] & {
  document: Pick<PDFDocumentProxy, 'getPage'>
}
type NativeOnlineFrame = {
  input: NativeOnlineInput
  rawPage: PdfLayoutPage
  current: () => boolean
  operators: Awaited<ReturnType<PDFPageProxy['getOperatorList']>>
  OPS: typeof PdfOps
}

/** Bind already-read native objects; never reconstruct a prior page from JSON. */
async function nativeOnlineFrame(
  input: NativeOnlineInput,
  earlier: readonly NativeOnlineFrame[]
): Promise<NativeOnlineFrame | undefined> {
  const { document, page, content, rawPage, signal, unreliable } = input
  if (
    !rawPage.nativeSectionFontEvidence?.complete ||
    rawPage.rotation !== 0 ||
    content.items.length > 2048
  )
    return
  const items = content.items,
    styles = content.styles,
    common = page.commonObjs,
    rawItems = rawPage.items,
    rawFont = rawPage.nativeSectionFontEvidence,
    rawFonts = rawFont.fonts,
    rawKey = stable([
      rawPage.page,
      rawPage.width,
      rawPage.height,
      rawPage.rotation,
      rawItems,
      rawFont
    ]),
    sourceKey = stable(input.sourceIdentity),
    contentKey = stable(content),
    unreliableMembers = [...unreliable],
    unreliableHas = unreliable.has,
    fingerprint = document.fingerprints,
    fingerprintKey = stable(fingerprint),
    count = document.numPages,
    getPage = document.getPage,
    apis = [page.getTextContent, page.getOperatorList, page.getViewport, page.cleanup],
    nativeRefs = items.map((item) => ({
      item,
      transform: 'str' in item ? item.transform : undefined
    })),
    rawRefs = rawItems.map((item) => ({ item, transform: item.transform }))
  try {
    const fonts = Object.keys(rawFont.fonts).map((id) => {
      const font = common.get(id),
        data = font.data
      return {
        id,
        font,
        data,
        bytes: data instanceof Uint8Array ? data.slice() : undefined,
        originalDataProperty: Object.getOwnPropertyDescriptor(font, 'data'),
        style: styles[id],
        key: stable([
          font.loadedName,
          font.missingFile,
          font.isType3Font,
          font.isInvalidPDFjsFont,
          font.systemFontInfo,
          font.vertical,
          font.ascent,
          font.descent,
          font.fontMatrix
        ])
      }
    })
    if (
      !fonts.length ||
      fonts.length > 64 ||
      fonts.some((f) => !f.bytes?.length) ||
      fonts.reduce((n, f) => n + f.bytes!.length, 0) > 32 * 1024 * 1024
    )
      return
    const nativeGuards: (() => boolean)[] = []
    const current = (): boolean =>
      !signal.aborted &&
      earlier.every((f) => f.current()) &&
      input.document === document &&
      input.page === page &&
      input.content === content &&
      input.rawPage === rawPage &&
      document.getPage === getPage &&
      document.fingerprints === fingerprint &&
      stable(fingerprint) === fingerprintKey &&
      document.numPages === count &&
      page.commonObjs === common &&
      apis.every(
        (f, n) =>
          f === [page.getTextContent, page.getOperatorList, page.getViewport, page.cleanup][n]
      ) &&
      content.items === items &&
      content.styles === styles &&
      stable(content) === contentKey &&
      nativeRefs.every(
        (r, n) => items[n] === r.item && (!('str' in r.item) || r.item.transform === r.transform)
      ) &&
      rawPage.items === rawItems &&
      rawRefs.every((r, n) => rawItems[n] === r.item && r.item.transform === r.transform) &&
      rawPage.nativeSectionFontEvidence === rawFont &&
      rawFont.fonts === rawFonts &&
      stable([rawPage.page, rawPage.width, rawPage.height, rawPage.rotation, rawItems, rawFont]) ===
        rawKey &&
      stable(input.sourceIdentity) === sourceKey &&
      input.unreliable === unreliable &&
      unreliable.has === unreliableHas &&
      unreliable.size === unreliableMembers.length &&
      unreliableMembers.every((index) => unreliable.has(index)) &&
      nativeGuards.every((guard) => guard()) &&
      fonts.every((f) => {
        const data = f.font.data
        return (
          common.get(f.id) === f.font &&
          styles[f.id] === f.style &&
          stable([
            f.font.loadedName,
            f.font.missingFile,
            f.font.isType3Font,
            f.font.isInvalidPDFjsFont,
            f.font.systemFontInfo,
            f.font.vertical,
            f.font.ascent,
            f.font.descent,
            f.font.fontMatrix
          ]) === f.key &&
          data instanceof Uint8Array &&
          f.data instanceof Uint8Array &&
          data.buffer === f.data.buffer &&
          data.byteOffset === f.data.byteOffset &&
          data.length === f.data.length &&
          (!f.originalDataProperty || !('value' in f.originalDataProperty) || data === f.data) &&
          data.every((value, n) => value === f.bytes![n])
        )
      })
    const bound = async <T>(operation: () => Promise<T>): Promise<T> => {
      if (!current()) throw Error('native appendix changed')
      const result = await operation()
      if (!current()) throw Error('native appendix changed')
      return result
    }
    if ((await bound(() => getPage.call(document, rawPage.page))) !== page) return
    const operators = await bound(() => page.getOperatorList()),
      viewport = page.getViewport({ scale: 1 }),
      epoch = nativeInkPageCurrent(page, content, viewport, operators, [])
    if (
      !epoch ||
      !epoch() ||
      !current() ||
      items.length !== rawItems.length ||
      viewport.width !== rawPage.width ||
      viewport.height !== rawPage.height
    )
      return
    nativeGuards.push(epoch)
    const [ma, mb, mc, md, mx, my] = viewport.transform,
      scale = Math.hypot(ma, mb)
    for (const [n, item] of items.entries()) {
      if (!('str' in item) || !item.str.trim()) continue
      const raw = rawItems[n],
        [a, b, c, d, x, y] = item.transform,
        projected = [
          ma * a + mc * b,
          -(mb * a + md * b),
          ma * c + mc * d,
          -(mb * c + md * d),
          ma * x + mc * y + mx,
          viewport.height - (mb * x + md * y + my)
        ]
      if (
        !raw ||
        raw.str !== item.str ||
        raw.fontName !== item.fontName ||
        raw.dir !== item.dir ||
        raw.width !== item.width * scale ||
        raw.height !== item.height * scale ||
        !projected.every((v, at) => v === raw.transform[at]) ||
        raw.fontAscent !== styles[item.fontName]?.ascent ||
        raw.fontDescent !== styles[item.fontName]?.descent ||
        raw.fontVertical !== styles[item.fontName]?.vertical
      )
        return
    }
    const { OPS } = await bound(() => import('pdfjs-dist/legacy/build/pdf.mjs'))
    return current() ? { input, rawPage, current, operators, OPS } : undefined
  } catch {
    signal.throwIfAborted()
    return
  }
}

/** A separate three-page proof; old overview/outline predicates stay unchanged. */
export async function readNativeOnlineAppendixRestart(
  input: NativeOnlineInput,
  preceding: readonly NativeOnlineInput[] = []
): Promise<NativeOutlineRestart | undefined> {
  const { page, content, rawPage, unreliable } = input,
    visible = content.items.flatMap((item, index) =>
      'str' in item && item.str.trim() ? [{ item, index }] : []
    )
  if (
    !rawPage.nativeSectionFontEvidence?.complete ||
    rawPage.rotation !== 0 ||
    content.items.length > 2048 ||
    !/^Online Appendix(?: \([a-z ]{3,60}\))?$/u.test(visible[0]?.item.str ?? '') ||
    preceding.length !== 2
  )
    return
  if (
    preceding.some(
      (p, at) =>
        p.document !== input.document ||
        p.rawPage.page !== rawPage.page - 2 + at ||
        stable(p.sourceIdentity) !== stable(input.sourceIdentity) ||
        p.unreliable.size
    )
  )
    return
  const section = visible.findIndex(
    ({ item }, index) => index > 1 && /^OA-1\. [\p{Lu}][\p{L} ,–—-]{4,100}$/u.test(item.str)
  )
  if (section < 2) return
  const selected = visible.slice(0, section + 1),
    first = selected[0].item,
    sub = selected.at(-1)!.item,
    intro = selected.slice(1, -1)
  if (
    first.fontName !== sub.fontName ||
    first.height !== sub.height ||
    first.transform[4] !== sub.transform[4] ||
    first.transform[5] <= sub.transform[5] ||
    rawPage.height - first.transform[5] > rawPage.height * 0.16 ||
    intro.some(
      ({ item }) =>
        item.height >= first.height * 0.9 ||
        item.transform[5] >= first.transform[5] ||
        item.transform[5] <= sub.transform[5]
    ) ||
    !/[.!?]$/u.test(intro.at(-1)!.item.str) ||
    (intro
      .map(({ item }) => item.str)
      .join(' ')
      .match(/\p{L}{2,}/gu)?.length ?? 0) < 12 ||
    selected.some(
      ({ item, index }) =>
        unreliable.has(index) ||
        !valid(rawPage.items[index], rawPage) ||
        rawPage.items[index].str !== item.str
    )
  )
    return
  const frames: NativeOnlineFrame[] = []
  for (const context of [...preceding, input]) {
    const frame = await nativeOnlineFrame(context, [...frames])
    if (!frame || frames.some((f) => !f.current())) return
    frames.push(frame)
  }
  const current = (): boolean => frames.every((f) => f.current()),
    last = frames.at(-1)!
  try {
    if (
      !current() ||
      !onlinePrefixUnicode(
        page,
        content,
        last.operators,
        last.OPS,
        unreliable,
        selected.map((r) => r.index)
      )
    )
      return
    const certificate = Object.freeze({})
    onlineRestarts.set(certificate, {
      current,
      heading: [selected[0].index],
      subsection: [selected.at(-1)!.index],
      intro: intro.map((r) => r.index),
      pages: frames.map((f) => f.rawPage)
    })
    return certificate
  } catch {
    input.signal.throwIfAborted()
    return
  }
}

const onlineRestarts = new WeakMap<
  NativeOutlineRestart,
  {
    current: () => boolean
    heading: number[]
    subsection: number[]
    intro: number[]
    pages: PdfLayoutPage[]
  }
>()

/** The online prefix is a different proof from a numbered outline branch.
 * Bibliographic native rows may cross owner and page boundaries; Source order
 * stays untouched while every native index must still have one exact owner. */
export function nativeOnlineAppendixRestartBoundary(
  units: Unit[],
  pages: PdfLayoutPage[],
  page: PdfLayoutPage,
  certificate: NativeOutlineRestart | undefined
): Unit | undefined {
  const fact = certificate && onlineRestarts.get(certificate)
  try {
    if (!fact?.current()) return
  } catch {
    return
  }
  if (
    fact!.pages.length !== 3 ||
    fact!.pages[2] !== page ||
    fact!.pages.some((p) => pages.find((candidate) => candidate.page === p.page) !== p)
  )
    return
  const counts = new Map<string, number>()
  for (const unit of units)
    for (const key of unit.items) counts.set(key, (counts.get(key) ?? 0) + 1)
  const native = (u: Unit, p: PdfLayoutPage): PdfLayoutTextItem[] | undefined => {
    if (
      !p.nativeSectionFontEvidence?.complete ||
      p.rotation !== 0 ||
      !u.items.length ||
      u.items.length !== u.originalStrings.length ||
      u.fragments.some((f) => f.page !== p.page)
    )
      return
    const items = u.items.map((key, at) => {
      const [number, ordinal] = key.split(':').map(Number),
        i = p.items[ordinal]
      return number === p.page &&
        counts.get(key) === 1 &&
        i?.str === u.originalStrings[at] &&
        valid(i, p)
        ? i
        : undefined
    })
    return items.every((i): i is PdfLayoutTextItem => !!i) &&
      compact(u.source) === compact(items.map((i) => i!.str).join(''))
      ? (items as PdfLayoutTextItem[])
      : undefined
  }
  const match = (indexes: number[]): Unit | undefined =>
    units.find((u) => stable(u.items) === stable(indexes.map((i) => page.page + ':' + i)))
  const title = match(fact!.heading),
    sub = match(fact!.subsection),
    intro = match(fact!.intro)
  if (
    !title ||
    !sub ||
    !intro ||
    title.kind !== 'heading-candidate' ||
    sub.kind !== 'heading-candidate' ||
    intro.kind !== 'prose-candidate' ||
    [title, sub, intro].some((u) => u.sourceOnly || u.preserve || u.risks.length)
  )
    return
  const a = native(title, page),
    b = native(sub, page),
    prose = native(intro, page)
  if (
    !a ||
    !b ||
    !prose ||
    !/[.!?]$/u.test(intro.source) ||
    (intro.source.match(/\p{L}{2,}/gu)?.length ?? 0) < 12
  )
    return
  const exclusive = (own: PdfLayoutTextItem[]): boolean => {
    const boxes = own.map(nativeBox),
      box = [
        Math.min(...boxes.map((b) => b[0])),
        Math.min(...boxes.map((b) => b[1])),
        Math.max(...boxes.map((b) => b[2])),
        Math.max(...boxes.map((b) => b[3]))
      ]
    return !page.items.some(
      (i) => i.str.trim() && !own.includes(i) && (!valid(i, page) || intersects(nativeBox(i), box))
    )
  }
  if (!exclusive(a) || !exclusive(b) || !exclusive(prose)) return
  const reference = units
      .slice(0, units.indexOf(title))
      .findLast((u) => /^References$/u.test(u.source)),
    referencePage = reference && pages.find((p) => p.page === reference.fragments[0].page)
  if (!reference || !referencePage || referencePage.page !== page.page - 2) return
  const referenceItems = native(reference, referencePage)
  if (
    !referenceItems ||
    referenceItems.length !== 1 ||
    a.length !== 1 ||
    referenceItems[0].fontName !== a[0].fontName ||
    referenceItems[0].height !== a[0].height ||
    referenceItems[0].transform[4] !== a[0].transform[4]
  )
    return
  const currentFolio = units.find(
    (u) =>
      u.fragments.every((f) => f.page === page.page) &&
      u.source === '1' &&
      u.preserve === 'literal' &&
      u.fragments[0].rect.y > page.height * 0.8
  )
  if (!currentFolio) return
  const lines: {
    page: number
    y: number
    left: number
    height: number
    items: PdfLayoutTextItem[]
  }[] = []
  for (let number = referencePage.page; number < page.page; number++) {
    const p = pages.find((p) => p.page === number)
    if (!p?.nativeSectionFontEvidence?.complete || p.rotation !== 0) return
    const own = units.filter(
        (u) => u.fragments.length && u.fragments.every((f) => f.page === number)
      ),
      folio = own.find(
        (u) =>
          u.source === String(number) &&
          u.preserve === 'literal' &&
          u.fragments[0].rect.y > p.height * 0.8
      )
    if (!folio || !native(folio, p)) return
    const claims = new Set(own.flatMap((u) => u.items)),
      expected = p.items.flatMap((i, at) => (i.str.trim() ? [p.page + ':' + at] : []))
    if (
      claims.size !== expected.length ||
      expected.some((key) => !claims.has(key)) ||
      own.some((u) => !native(u, p))
    )
      return
    const excluded = new Set([
      ...folio.items,
      ...(number === referencePage.page ? reference.items : [])
    ])
    const citations = p.items.filter((i, at) => i.str.trim() && !excluded.has(p.page + ':' + at))
    if (
      !citations.length ||
      citations.some(
        (i) =>
          i.height >= a[0].height * 0.9 ||
          i.transform[5] >=
            (number === referencePage.page ? referenceItems[0].transform[5] : p.height)
      )
    )
      return
    const rows: typeof lines = []
    for (const i of citations) {
      const row = rows.find((r) => Math.abs(r.y - i.transform[5]) <= i.height * 0.02)
      if (row) {
        row.items.push(i)
        row.left = Math.min(row.left, i.transform[4])
        row.height = Math.max(row.height, i.height)
      } else
        rows.push({
          page: number,
          y: i.transform[5],
          left: i.transform[4],
          height: i.height,
          items: [i]
        })
    }
    rows.sort((l, r) => r.y - l.y)
    for (const row of rows) {
      row.items.sort((l, r) => l.transform[4] - r.transform[4])
      lines.push(row)
    }
  }
  const left = referenceItems[0].transform[4],
    height = Math.max(...lines.map((r) => r.height)),
    near = (x: number, y: number): boolean => Math.abs(x - y) <= height * 0.02,
    indented = lines.find((row) => !near(row.left, left)),
    indent = indented?.left
  if (
    !lines.length ||
    indent === undefined ||
    indent <= left + height * 0.5 ||
    indent >= left + height * 2 ||
    !near(lines[0].left, left) ||
    lines.some(
      (row) =>
        !near(row.left, left) && (row.left <= left + height * 0.5 || row.left >= left + height * 2)
    )
  )
    return
  const records: { text: string; fonts: Set<string> }[] = []
  for (const row of lines) {
    const text = row.items.map((i) => i.str).join(' ')
    if (near(row.left, left))
      records.push({ text, fonts: new Set(row.items.map((i) => i.fontName!)) })
    else {
      if (!records.length) return
      const record = records[records.length - 1]
      record.text += ' ' + text
      for (const item of row.items) record.fonts.add(item.fontName!)
    }
  }
  if (
    records.length < 2 ||
    records.some(
      ({ text, fonts }) =>
        fonts.size < 2 ||
        !/[.!?]$/u.test(text) ||
        !/\b(?:18|19|20)\d{2}\b/u.test(text) ||
        !/^(?:\p{Lu}[\p{L}’'-]+,|and \p{Lu}|,)/u.test(text)
    )
  )
    return
  return fact!.current() ? title : undefined
}

// Paired contents rows already have a layout proof. This private native binding
// lets that proof survive the later legacy heading inference without granting
// any caption/prose translation capability or changing the original grouping.
const contentsReferences = new WeakMap<
  NativeOutlineRestart,
  {
    page: PdfLayoutPage
    current: () => boolean
    selected: Set<number>
  }
>()

export async function readNativeContentsReference(
  input: NativeOnlineInput
): Promise<NativeOutlineRestart | undefined> {
  const { content, page, rawPage, unreliable, signal } = input
  const visible = content.items.flatMap((item, index) =>
    'str' in item && item.str.trim() ? [{ item, index }] : []
  )
  if (
    !/^(?:table of )?contents$/iu.test(visible[0]?.item.str.trim() ?? '') ||
    !visible.some(({ item }) => /^(?:references|bibliography)$/iu.test(item.str.trim())) ||
    Object.getPrototypeOf(unreliable) !== Set.prototype ||
    Reflect.ownKeys(unreliable).length ||
    unreliable.has !== Set.prototype.has ||
    unreliable.values !== Set.prototype.values ||
    unreliable.size !== 0
  )
    return
  try {
    const frame = await nativeOnlineFrame(input, [])
    if (!frame?.current()) return
    // This contents-only branch certifies text-only native pages. Paths may
    // erase visible glyphs even when their text-show advances remain complete.
    if (frame.operators.fnArray.includes(frame.OPS.constructPath)) return
    const selected = new Set(visible.map(({ index }) => index))
    if (visible.some(({ index }) => !valid(rawPage.items[index], rawPage))) return
    const regions = await nativeAlgorithmInkRegions(
      page,
      content,
      page.getViewport({ scale: 1 }),
      rawPage.page,
      selected
    )
    const current = (): boolean =>
      frame.current() &&
      Object.getPrototypeOf(unreliable) === Set.prototype &&
      Reflect.ownKeys(unreliable).length === 0 &&
      unreliable.has === Set.prototype.has &&
      unreliable.values === Set.prototype.values &&
      Object.getOwnPropertyDescriptor(Set.prototype, 'size')!.get!.call(unreliable) === 0
    if (
      !current() ||
      regions?.size !== selected.size ||
      [...selected].some((index) => !regions.has(index))
    )
      return
    const certificate = Object.freeze({}) as NativeOutlineRestart
    contentsReferences.set(certificate, { page: rawPage, current, selected })
    return certificate
  } catch {
    signal.throwIfAborted()
    return
  }
}

/** Only existing complete native owners participating in the paired lane. */
export function nativeContentsReferenceEntry(
  unit: Unit,
  related: Unit[],
  units: Unit[],
  page: PdfLayoutPage
): boolean {
  const fact = page.nativeContentsReference && contentsReferences.get(page.nativeContentsReference)
  try {
    if (!fact || fact.page !== page || !fact.current() || !related.includes(unit)) return false
    const counts = new Map<string, number>()
    for (const owner of units)
      for (const key of owner.items) counts.set(key, (counts.get(key) ?? 0) + 1)
    return related.every(
      (owner) =>
        owner.items.length > 0 &&
        owner.items.length === owner.originalStrings.length &&
        owner.fragments.length === 1 &&
        owner.fragments[0].page === page.page &&
        owner.items.every((key, at) => {
          const [number, index] = key.split(':').map(Number)
          return (
            number === page.page &&
            fact.selected.has(index) &&
            counts.get(key) === 1 &&
            page.items[index]?.str === owner.originalStrings[at] &&
            valid(page.items[index], page)
          )
        }) &&
        compact(owner.source) === compact(owner.originalStrings.join(''))
    )
  } catch {
    return false
  }
}

type TerminalContext = {
  document: Pick<PDFDocumentProxy, 'numPages' | 'fingerprints' | 'getPage'>
  page: PDFPageProxy
  content: Content
  rawPage: PdfLayoutPage
  viewport: ReturnType<PDFPageProxy['getViewport']>
  unreliable: ReadonlySet<number>
}
function terminalRawPageMatches(context: TerminalContext): boolean {
  const { rawPage, content, viewport } = context
  if (
    rawPage.items.length !== content.items.length ||
    rawPage.width !== viewport.width ||
    rawPage.height !== viewport.height ||
    viewport.transform.length !== 6 ||
    !viewport.transform.every(Number.isFinite)
  )
    return false
  const [ma, mb, mc, md, mx, my] = viewport.transform,
    scale = Math.hypot(ma, mb)
  return content.items.every((item, index) => {
    const raw = rawPage.items[index]
    if (!raw) return false
    // Older extraction snapshots erased spaces. Retain that exact placeholder;
    // observed spaces must satisfy the same complete native projection as text.
    if (
      (!('str' in item) || !item.str.trim()) &&
      raw.str === '' &&
      raw.width === 0 &&
      raw.height === 0 &&
      raw.dir === 'ltr' &&
      raw.transform.length === 6 &&
      raw.transform.every((value) => value === 0) &&
      raw.hasEOL === ('hasEOL' in item ? item.hasEOL : undefined)
    )
      return true
    if (!('str' in item) || !item.str) return false
    if (
      item.transform.length !== 6 ||
      ![...item.transform, item.width, item.height].every(Number.isFinite) ||
      item.width < 0 ||
      item.height < 0
    )
      return false
    const [a, b, c, d, x, y] = item.transform,
      transform = [
        ma * a + mc * b,
        -(mb * a + md * b),
        ma * c + mc * d,
        -(mb * c + md * d),
        ma * x + mc * y + mx,
        viewport.height - (mb * x + md * y + my)
      ],
      style = content.styles[item.fontName]
    return (
      raw.str === item.str &&
      raw.dir === item.dir &&
      raw.fontName === item.fontName &&
      raw.hasEOL === item.hasEOL &&
      raw.width === item.width * scale &&
      raw.height === item.height * scale &&
      raw.fontAscent === style?.ascent &&
      raw.fontDescent === style?.descent &&
      raw.fontVertical === style?.vertical &&
      raw.transform.length === transform.length &&
      transform.every((value, n) => Object.is(value, raw.transform[n]))
    )
  })
}
type TerminalCaption = { indices: Set<number>; number: number }
// A split marker is five original contiguous items, including both observed
// spaces. It never reconstructs a line or changes the published Source text.
function terminalCaptionNumber(content: Content, indices: number[]): number | undefined {
  const start = indices[0],
    first = content.items[start]
  if (!first || !('str' in first)) return
  const whole = /^Fig\.\s+([1-9]\d*)(?:\s+\p{Lu}|$)/u.exec(first.str)
  if (whole) {
    const number = Number(whole[1])
    return Number.isSafeInteger(number) && number > 0 ? number : undefined
  }
  if (first.str !== 'Fig.' || indices[1] !== start + 2 || indices[2] !== start + 4) return
  const tokens = content.items
    .slice(start, start + 5)
    .flatMap((item) => ('str' in item ? [item] : []))
  if (tokens.length !== 5) return
  const [marker, space, number, secondSpace, title] = tokens,
    size = marker.height,
    matrix = marker.transform
  if (
    !size ||
    !Number.isFinite(size) ||
    matrix.length !== 6 ||
    !matrix.every(Number.isFinite) ||
    matrix[0] <= 0 ||
    matrix[0] !== matrix[3] ||
    matrix[1] !== 0 ||
    matrix[2] !== 0 ||
    !/^[1-9]\d*$/u.test(number.str) ||
    !/^\p{Lu}/u.test(title.str) ||
    space.str !== ' ' ||
    secondSpace.str !== ' ' ||
    space.height !== 0 ||
    secondSpace.height !== 0 ||
    space.width >= size ||
    secondSpace.width >= size ||
    number.height !== size ||
    title.height !== size ||
    tokens.some(
      (item, n) =>
        item.dir !== 'ltr' ||
        item.fontName !== marker.fontName ||
        item.hasEOL !== false ||
        !Number.isFinite(item.width) ||
        item.width <= 0 ||
        item.transform.length !== 6 ||
        !item.transform.every(Number.isFinite) ||
        [0, 1, 2, 3, 5].some((at) => !Object.is(item.transform[at], matrix[at])) ||
        (n > 0 &&
          Math.abs(tokens[n - 1].transform[4] + tokens[n - 1].width - item.transform[4]) >
            size * 0.000001)
    )
  )
    return
  const value = Number(number.str)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}
type TerminalFloatProof = {
  current: () => boolean
  captions: TerminalCaption[]
  firstPage: number
  lastPage: number
}
const terminalFloatProofs = new WeakMap<PdfLayoutPage, TerminalFloatProof>()
const terminalEligibleUnits = new WeakMap<
  Unit,
  { current: () => boolean; rawPage: PdfLayoutPage }
>()
const terminalSameDescriptor = (
  a: PropertyDescriptor | undefined,
  b: PropertyDescriptor | undefined
): boolean => {
  if (!a || !b) return a === b
  return ['value', 'get', 'set', 'writable', 'enumerable', 'configurable'].every((field) =>
    Object.is(a[field as keyof PropertyDescriptor], b[field as keyof PropertyDescriptor])
  )
}

// Bind actual data slots, including child identities and descriptors. An equal
// replacement object is not the live evidence object that was verified.
function terminalDataCurrent(roots: unknown[]): (() => boolean) | undefined {
  const held: {
      object: object
      prototype: object | null
      descriptors: PropertyDescriptorMap
      keys: PropertyKey[]
    }[] = [],
    seen = new Set<object>()
  const visit = (value: unknown, depth: number): boolean => {
    if (!value || typeof value !== 'object') return typeof value !== 'function'
    if (depth > 32) return false
    if (seen.has(value)) return true
    if (seen.size >= 32768) return false
    seen.add(value)
    const prototype = Object.getPrototypeOf(value)
    if (![Object.prototype, Array.prototype, null].includes(prototype)) return false
    const descriptors = Object.getOwnPropertyDescriptors(value),
      keys = Reflect.ownKeys(value)
    if (
      keys.some(
        (key) =>
          !('value' in descriptors[key as keyof typeof descriptors]) ||
          !visit(descriptors[key as keyof typeof descriptors].value, depth + 1)
      )
    )
      return false
    held.push({ object: value, prototype, descriptors, keys })
    return true
  }
  if (!roots.every((root) => visit(root, 0))) return
  return () =>
    held.every(({ object, prototype, descriptors, keys }) => {
      const now = Object.getOwnPropertyDescriptors(object),
        currentKeys = Reflect.ownKeys(object)
      return (
        Object.getPrototypeOf(object) === prototype &&
        currentKeys.length === keys.length &&
        keys.every(
          (key, n) =>
            currentKeys[n] === key &&
            Object.hasOwn(now, key) &&
            ['value', 'get', 'set', 'writable', 'enumerable', 'configurable'].every((field) =>
              Object.is(
                now[key as keyof typeof now][field as keyof PropertyDescriptor],
                descriptors[key as keyof typeof descriptors][field as keyof PropertyDescriptor]
              )
            )
        )
      )
    })
}

function terminalPageArrayCurrent(pages: PdfLayoutPage[]): () => boolean {
  const values = [...pages],
    prototype = Object.getPrototypeOf(pages),
    slots = Object.getOwnPropertyDescriptors(pages)
  return () =>
    Object.getPrototypeOf(pages) === prototype &&
    pages.length === values.length &&
    Reflect.ownKeys(pages).length === Reflect.ownKeys(slots).length &&
    values.every(
      (page, n) =>
        pages[n] === page &&
        page.page === n + 1 &&
        Object.getOwnPropertyDescriptor(pages, String(n))?.value === slots[String(n)].value
    )
}

type TerminalSourceInput = Parameters<typeof createPdfTranslationSource>[0]
type TerminalSourceUnit = TerminalSourceInput['units'][number]
type TerminalSourceConstructor = {
  observe: (layoutUnit: Unit, data: TerminalSourceUnit) => void
  create: (input: TerminalSourceInput) => PdfTranslationSource
}

function terminalSourceFragments(
  unit: Unit,
  layout: PdfTranslationLayout
): TerminalSourceUnit['fragments'] | undefined {
  const fragments: TerminalSourceUnit['fragments'][number][] = []
  for (const fragment of unit.fragments) {
    const page = layout.pages[fragment.page - 1],
      block = page?.blocks.find((block) => block.id === fragment.id),
      r = fragment.rect
    if (!page || !block) return
    const items = block.items
      .map((key, n) => ({ index: Number(key.split(':')[1]), text: block.originalStrings[n] }))
      .sort((a, b) => a.index - b.index)
    const overlap = page.blocks.some(
      (other) =>
        other !== block &&
        other.rect.x < r.right &&
        other.rect.right > r.x &&
        other.rect.y < r.bottom &&
        other.rect.bottom > r.y
    )
    if (overlap && block.lines.length > 1)
      for (const line of block.lines)
        fragments.push({
          pageNumber: fragment.page,
          rect: {
            x: line.x / page.width,
            y: line.y / page.height,
            width: (line.right - line.x) / page.width,
            height: (line.bottom - line.y) / page.height
          },
          items: items.filter((item) => line.items.includes(fragment.page + ':' + item.index))
        })
    else
      fragments.push({
        pageNumber: fragment.page,
        rect: {
          x: r.x / page.width,
          y: r.y / page.height,
          width: (r.right - r.x) / page.width,
          height: (r.bottom - r.y) / page.height
        },
        items
      })
  }
  return fragments
}

/** This one-shot local constructor only projects observed real conversion
 * objects. Legacy reference roles remain intact until the final live check. */
export function bindNativeTerminalCaptionLayout(
  layout: PdfTranslationLayout,
  rawPages: PdfLayoutPage[],
  identity: Readonly<{ resourceRequestKey: string; fingerprint: string }>
): TerminalSourceConstructor | undefined {
  const positive = layout.units.filter((unit) => terminalEligibleUnits.has(unit))
  if (!positive.length) return
  const expectedKey = identity.resourceRequestKey,
    expectedFingerprint = identity.fingerprint,
    pageNumbers = new Set(
      positive.flatMap((unit) => unit.fragments.map((fragment) => fragment.page))
    ),
    pages = layout.pages,
    units = layout.units,
    pageObjects = [...pages],
    unitObjects = [...units],
    sizes = rawPages.map((page) => ({ width: page.width, height: page.height })),
    rawCurrent = terminalPageArrayCurrent(rawPages),
    dataCurrent = terminalDataCurrent([
      ...pages.filter((page) => pageNumbers.has(page.page)),
      ...positive
    ]),
    expected = new Map(positive.map((unit) => [unit, terminalSourceFragments(unit, layout)])),
    observed: { unit: Unit; data: TerminalSourceUnit; current: () => boolean }[] = []
  let used = false,
    valid = true
  const current = (): boolean =>
    !!dataCurrent &&
    valid &&
    layout.pages === pages &&
    layout.units === units &&
    pages.length === pageObjects.length &&
    units.length === unitObjects.length &&
    pages.every((page, n) => page === pageObjects[n]) &&
    units.every((unit, n) => unit === unitObjects[n]) &&
    rawCurrent() &&
    rawPages.every((page, n) => page.width === sizes[n].width && page.height === sizes[n].height) &&
    dataCurrent() &&
    positive.every((unit) => terminalEligibleUnits.get(unit)?.current()) &&
    observed.every((entry) => entry.current())
  return {
    observe(unit, data) {
      if (used || !unitObjects.includes(unit) || observed.some((entry) => entry.unit === unit)) {
        valid = false
        return
      }
      const bound = terminalDataCurrent([data])
      if (!bound) {
        valid = false
        return
      }
      observed.push({ unit, data, current: bound })
      const fragments = expected.get(unit)
      if (
        fragments &&
        data.id === unit.id &&
        data.source === unit.source &&
        JSON.stringify(data.fragments) === JSON.stringify(fragments)
      )
        return
      if (positive.includes(unit)) valid = false
    },
    create(input) {
      if (used) return createPdfTranslationSource(input)
      used = true
      const records = positive.map((unit) => observed.find((entry) => entry.unit === unit)),
        positions = observed
          .map((entry) => input.units.indexOf(entry.data))
          .filter((index) => index >= 0)
      const accepted =
        current() &&
        input.resourceRequestKey === expectedKey &&
        input.fingerprint === expectedFingerprint &&
        input.pages === rawPages &&
        input.pages.length === sizes.length &&
        input.pages.every(
          (page, n) => page.width === sizes[n].width && page.height === sizes[n].height
        ) &&
        new Set(input.units.map((unit) => unit.id)).size === input.units.length &&
        positions.every((position, n) => n === 0 || position > positions[n - 1]) &&
        records.every(
          (entry, n) =>
            !!entry &&
            input.units.includes(entry.data) &&
            entry.data.id === positive[n].id &&
            entry.data.source === positive[n].source &&
            entry.data.sourceOnly === true &&
            entry.data.preserve === 'reference' &&
            !entry.data.figure &&
            JSON.stringify(entry.data.fragments) === JSON.stringify(expected.get(positive[n]))
        )
      if (!accepted) return createPdfTranslationSource(input)
      const selected = new Set(records.map((entry) => entry!.data)),
        ids = new Set(records.map((entry) => entry!.data.id))
      const source = createPdfTranslationSource({
        ...input,
        units: input.units.map((unit) => {
          if (!selected.has(unit)) return unit
          const next = { ...unit }
          delete next.sourceOnly
          delete next.preserve
          return next
        })
      })
      if (
        !current() ||
        source.resourceRequestKey !== expectedKey ||
        source.fingerprint !== expectedFingerprint ||
        JSON.stringify(source.pages) !== JSON.stringify(sizes) ||
        records.some((entry, n) => {
          const index = input.units.indexOf(entry!.data),
            unit = source.units[index]
          return (
            !unit ||
            unit.id !== entry!.data.id ||
            unit.source !== entry!.data.source ||
            unit.sourceOnly ||
            unit.preserve ||
            unit.figure ||
            JSON.stringify(unit.fragments) !== JSON.stringify(expected.get(positive[n]))
          )
        })
      )
        return createPdfTranslationSource(input)
      rememberNativeCaptionEligibility(source, ids)
      return source
    }
  }
}

/** Keep bibliography mode for drawings and independent protected owners. Only
 * whole ordinary caption owners inside the verified terminal float suffix are
 * exempted from that mode. Serialized flags or a crop never grant this proof. */
export function rememberNativeTerminalCaptionOwners(units: Unit[], pages: PdfLayoutPage[]): void {
  if (!pages.some((page) => terminalFloatProofs.has(page))) return
  const counts = new Map<string, number>()
  for (const u of units) for (const k of u.items) counts.set(k, (counts.get(k) ?? 0) + 1)
  for (const p of pages) {
    const proof = terminalFloatProofs.get(p)
    if (
      !proof ||
      !proof.current() ||
      pages.length !== proof.lastPage ||
      (pages[proof.firstPage - 1] !== p && p.page === proof.firstPage)
    )
      continue
    if (
      pages
        .slice(proof.firstPage - 1)
        .some((q) => terminalFloatProofs.get(q)?.current !== proof.current)
    )
      continue
    for (const caption of proof.captions) {
      const keys = new Set([...caption.indices].map((i) => p.page + ':' + i)),
        owners = units.filter((u) => u.items.some((k) => keys.has(k)))
      if (
        !owners.length ||
        owners.some(
          (u) =>
            u.fragments.length !== 1 ||
            u.fragments[0].page !== p.page ||
            u.items.length !== u.originalStrings.length ||
            u.items.some(
              (k, n) =>
                !keys.has(k) ||
                counts.get(k) !== 1 ||
                p.items[Number(k.split(':')[1])]?.str !== u.originalStrings[n]
            )
        ) ||
        [...keys].some((k) => !owners.some((u) => u.items.includes(k)))
      )
        continue
      for (const u of owners)
        if (
          !u.sourceOnly &&
          !u.preserve &&
          u.risks.every((r) => r === 'possible-continuation' || r === 'reading-order')
        ) {
          terminalEligibleUnits.set(u, { current: proof.current, rawPage: p })
        }
    }
  }
}

/** Observe only a bounded final suffix. The real record/font/paint and Form
 * lifetimes are closed after the document has finished yielding its pages. */
export function createNativeTerminalCaptionReader(options: {
  document: TerminalContext['document'] & Partial<Pick<PDFDocumentProxy, 'getData' | 'getMetadata'>>
  sourceIdentity?: Readonly<{ sourceChecksum: string; sourceSizeBytes: number }>
  nativeDocumentFactory?: (typeof import('pdfjs-dist'))['getDocument']
  signal: AbortSignal
}): {
  observe: (input: TerminalContext) => void
  prepare: (pages: PdfLayoutPage[]) => Promise<void>
} {
  const contexts: TerminalContext[] = [],
    pageCount = options.document.numPages,
    fingerprints = options.document.fingerprints,
    fingerprint = options.document.fingerprints[0]
  const documentCurrent = (): boolean =>
    options.document.numPages === pageCount &&
    options.document.fingerprints === fingerprints &&
    options.document.fingerprints[0] === fingerprint &&
    !options.signal.aborted
  return {
    observe(input) {
      if (input.rawPage.page >= pageCount - 8) contexts.push(input)
    },
    async prepare(pages) {
      if (
        !documentCurrent() ||
        pageCount !== pages.length ||
        !pages.every((p, n) => p.page === n + 1) ||
        contexts.length > 9
      )
        return
      const book = contexts.findLast((c) => closedBook(c.rawPage))
      if (!book || book.rawPage.page === pageCount || book.unreliable.size) return
      const suffix = contexts.filter((c) => c.rawPage.page > book.rawPage.page)
      if (
        !suffix.length ||
        suffix.length > 8 ||
        suffix.length !== pageCount - book.rawPage.page ||
        suffix.some(
          (c, n) =>
            c.rawPage.page !== book.rawPage.page + n + 1 ||
            c.document !== options.document ||
            c.unreliable.size ||
            !c.rawPage.nativeSectionFontEvidence?.complete
        )
      )
        return
      const auxiliary = createAuxiliaryNativeTerminalCaptionInkReader(options),
        bookAuxiliary = createAuxiliaryNativeInkReader(options),
        frames: {
          context: TerminalContext
          epoch: () => boolean
          evidence: () => boolean
          rawItems: PdfLayoutTextItem[]
          rawKey: string
          items: { item: PdfLayoutTextItem; transform: number[] }[]
          captions: TerminalCaption[]
        }[] = []
      let accepted = false
      const pagesCurrent = terminalPageArrayCurrent(pages)
      const current = (): boolean =>
        documentCurrent() &&
        pagesCurrent() &&
        closedBook(book.rawPage) &&
        frames.every(
          (f) =>
            f.epoch() &&
            f.evidence() &&
            terminalRawPageMatches(f.context) &&
            f.context.rawPage.items === f.rawItems &&
            f.rawItems.length === f.items.length &&
            f.items.every((h, n) => f.rawItems[n] === h.item && h.item.transform === h.transform) &&
            JSON.stringify(f.rawItems) === f.rawKey &&
            pages[f.context.rawPage.page - 1] === f.context.rawPage
        )
      try {
        let expectedNumber: number | undefined
        for (const context of [book, ...suffix]) {
          options.signal.throwIfAborted()
          if (context.page !== (await options.document.getPage(context.rawPage.page))) return
          const operators = await context.page.getOperatorList(),
            epoch = nativeInkPageCurrent(
              context.page,
              context.content,
              context.viewport,
              operators,
              []
            )
          if (!epoch || !epoch() || !terminalRawPageMatches(context)) return
          const raw = context.rawPage,
            reference = raw.nativeReferenceEvidence,
            section = raw.nativeSectionFontEvidence,
            geometry = [raw.page, raw.width, raw.height, raw.rotation],
            keys = [
              'page',
              'width',
              'height',
              'rotation',
              'items',
              'nativeReferenceEvidence',
              'nativeSectionFontEvidence'
            ],
            slots = keys.map((key) => Object.getOwnPropertyDescriptor(raw, key)),
            unreliable = context.unreliable,
            unreliablePrototype = Object.getPrototypeOf(unreliable),
            unreliableSlot = Object.getOwnPropertyDescriptor(context, 'unreliable'),
            heldEvidence = terminalDataCurrent([reference, section])
          if (!heldEvidence) return
          const evidence = (): boolean =>
            raw.nativeReferenceEvidence === reference &&
            raw.nativeSectionFontEvidence === section &&
            keys.every((key, n) =>
              terminalSameDescriptor(Object.getOwnPropertyDescriptor(raw, key), slots[n])
            ) &&
            context.unreliable === unreliable &&
            unreliable.size === 0 &&
            Object.getPrototypeOf(unreliable) === unreliablePrototype &&
            terminalSameDescriptor(
              Object.getOwnPropertyDescriptor(context, 'unreliable'),
              unreliableSlot
            ) &&
            [raw.page, raw.width, raw.height, raw.rotation].every((value, n) =>
              Object.is(value, geometry[n])
            ) &&
            heldEvidence() &&
            (context === book ? reference?.complete === true : section?.complete === true)
          const frame = {
            context,
            epoch,
            evidence,
            rawItems: context.rawPage.items,
            rawKey: JSON.stringify(context.rawPage.items),
            items: context.rawPage.items.map((item) => ({ item, transform: item.transform })),
            captions: [] as TerminalCaption[]
          }
          frames.push(frame)
          if (context === book) {
            const actualReference = await readNativeReferenceEvidence(context.page, context.content)
            if (
              !actualReference.complete ||
              JSON.stringify(actualReference) !==
                JSON.stringify(context.rawPage.nativeReferenceEvidence) ||
              !current()
            )
              return
            const selected = new Set(
              context.content.items.flatMap((item, index) =>
                'str' in item && item.str.trim() ? [index] : []
              )
            )
            const request = {
              page: context.page,
              content: context.content,
              viewport: context.viewport,
              pageNumber: context.rawPage.page,
              selected,
              operatorSnapshot: operators
            }
            const regions =
              (await nativeAlgorithmInkRegions(
                context.page,
                context.content,
                context.viewport,
                context.rawPage.page,
                selected
              )) ?? (await bookAuxiliary.read(request))
            if (
              !regions ||
              regions.size !== selected.size ||
              [...selected].some((index) => !regions.has(index)) ||
              !current()
            )
              return
            continue
          }
          const selected = new Set(
            context.content.items.flatMap((_, index) =>
              terminalCaptionNumber(context.content, [index, index + 2, index + 4]) !== undefined
                ? [index]
                : []
            )
          )
          if (!selected.size) return
          let regions = await nativeTerminalPlotCaptionInk(
            context.page,
            context.content,
            context.viewport,
            context.rawPage.page,
            selected,
            operators
          )
          if (!regions)
            regions = await auxiliary.read({
              page: context.page,
              content: context.content,
              viewport: context.viewport,
              pageNumber: context.rawPage.page,
              selected,
              operatorSnapshot: operators
            })
          if (!regions || !current()) return
          const scope = nativeTerminalPlotScope(regions)
          if (!scope) return
          const forms = scope.forms.toSorted((a, b) => a.bounds[1] - b.bounds[1]),
            outside = [...scope.membership].filter(([, f]) => f === null).map(([index]) => index),
            folio = outside.at(-1)
          if (folio === undefined) return
          const f = context.content.items[folio],
            fb = regions.get(folio)
          if (
            !('str' in f) ||
            f.str !== String(context.rawPage.page) ||
            !fb ||
            Math.abs((fb.x + fb.width / 2) * context.viewport.width - context.viewport.width / 2) >
              f.height * 2 ||
            f.width > f.height * 3
          )
            return
          const body = outside.slice(0, -1),
            groups = forms.map(() => [] as number[])
          for (const index of body) {
            const r = regions.get(index)
            if (!r) return
            const top = r.y * context.viewport.height,
              bottom = (r.y + r.height) * context.viewport.height
            const at = forms.findIndex(
              (form, n) =>
                top > form.bounds[3] && (!forms[n + 1] || bottom < forms[n + 1].bounds[1])
            )
            if (at < 0) return
            groups[at].push(index)
          }
          if (groups.some((g) => !g.length)) return
          for (const [at, indices] of groups.entries()) {
            const items = indices.flatMap((i) => {
              const item = context.content.items[i]
              return 'str' in item ? [item] : []
            })
            if (items.length !== indices.length) return
            const first = items[0],
              last = items.at(-1)!,
              number = terminalCaptionNumber(context.content, indices),
              form = forms[at]
            const rows: { baseline: number; indices: number[] }[] = []
            for (const [n, item] of items.entries()) {
              if (item.height < first.height * 0.55 || item.height > first.height * 1.02) return
              const previous = rows.at(-1)
              if (previous && Math.abs(item.transform[5] - previous.baseline) < first.height * 0.5)
                previous.indices.push(indices[n])
              else {
                if (Math.abs(item.height - first.height) > first.height * 0.02) return
                rows.push({ baseline: item.transform[5], indices: [indices[n]] })
              }
            }
            if (
              rows.some((row, n) => {
                const start = context.content.items[row.indices[0]],
                  endIndex = row.indices.at(-1)!,
                  end = context.content.items[endIndex]
                if (
                  !('str' in start) ||
                  !('str' in end) ||
                  Math.abs(start.transform[4] - form.bounds[0]) > first.height * 0.2
                )
                  return true
                const next = context.content.items.findIndex(
                  (item, index) => index > endIndex && 'str' in item && !!item.str.trim()
                )
                const closed =
                  end.hasEOL === true ||
                  context.content.items
                    .slice(endIndex + 1, next < 0 ? undefined : next)
                    .some((item) => 'str' in item && !item.str.trim() && item.hasEOL === true)
                const endText = scope.sourceTextEnds.get(endIndex),
                  nextForm = forms[at + 1],
                  nativeBoundary =
                    n === rows.length - 1 &&
                    endIndex === indices.at(-1) &&
                    endText !== undefined &&
                    form.end !== undefined &&
                    endText > form.end &&
                    nextForm !== undefined &&
                    endText < nextForm.begin &&
                    next >= 0 &&
                    scope.membership.get(next) === nextForm.begin
                return (
                  (!closed && !nativeBoundary) ||
                  (n > 0 &&
                    (rows[n - 1].baseline - row.baseline < first.height * 0.95 ||
                      rows[n - 1].baseline - row.baseline > first.height * 1.7))
                )
              })
            )
              return
            if (
              number === undefined ||
              indices.some((n, i) => i > 0 && n <= indices[i - 1]) ||
              !/[.!?]$/u.test(last.str.trim()) ||
              items
                .map((i) => i.str)
                .join(' ')
                .match(/\p{L}{2,}/gu)!.length < 12 ||
              !first.height ||
              form.bounds[3] - form.bounds[1] < first.height * 8
            )
              return
            if (expectedNumber !== undefined && number !== expectedNumber) return
            expectedNumber = number + 1
            const boxes = indices.map((i) => regions.get(i)!),
              x = Math.min(...boxes.map((r) => r.x)) * context.viewport.width,
              right = Math.max(...boxes.map((r) => r.x + r.width)) * context.viewport.width,
              top = Math.min(...boxes.map((r) => r.y)) * context.viewport.height,
              bottom = Math.max(...boxes.map((r) => r.y + r.height)) * context.viewport.height
            if (
              Math.abs(x - form.bounds[0]) > first.height * 0.2 ||
              Math.abs(right - x - (form.bounds[2] - form.bounds[0])) > first.height * 2 ||
              top - form.bounds[3] < first.height * 0.25 ||
              top - form.bounds[3] > first.height * 2 ||
              fb.y * context.viewport.height - bottom < first.height * 2
            )
              return
            frame.captions.push({ indices: new Set(indices), number })
          }
        }
        if (frames.slice(1).reduce((n, f) => n + f.captions.length, 0) < 2 || !current()) return
        accepted = true
      } catch {
        options.signal.throwIfAborted()
      } finally {
        await auxiliary.dispose()
        await bookAuxiliary.dispose()
      }
      if (!accepted || !current()) return
      for (const frame of frames.slice(1))
        terminalFloatProofs.set(frame.context.rawPage, {
          current,
          captions: frame.captions,
          firstPage: suffix[0].rawPage.page,
          lastPage: pageCount
        })
    }
  }
}

function closedBook(p: PdfLayoutPage): boolean {
  if (
    p.rotation !== 0 ||
    !p.nativeReferenceEvidence?.complete ||
    p.nativeReferenceEvidence.rules.length ||
    !p.nativeSectionFontEvidence?.complete
  )
    return false
  const entries = p.items.flatMap((item, index) => (item.str.trim() ? [{ item, index }] : [])),
    first = entries[0]?.item
  if (!first) return false
  const last = entries.at(-1)!,
    body = last.item.str === String(p.page) ? entries.slice(0, -1) : entries
  const starts = body.flatMap((e, n) =>
    /^\[([1-9]\d{0,3})\]\s+\p{Lu}/u.test(e.item.str) ? [n] : []
  )
  if (starts.length < 3 || starts.length > 256) return false
  if (
    starts[0] > 0 &&
    (starts[0] !== 1 ||
      !/^(?:References|Bibliography)$/u.test(first.str) ||
      first.height <= body[starts[0]].item.height * 1.05)
  )
    return false
  const font = body[starts[0]].item.height,
    x = body[starts[0]].item.transform[4]
  const numbers = starts.map((n) => Number(body[n].item.str.match(/^\[(\d+)\]/u)![1]))
  if (numbers.some((n, i) => i > 0 && n !== numbers[i - 1] + 1)) return false
  const closedRow = (entry: (typeof entries)[number]): boolean => {
    if (entry.item.hasEOL) return true
    const next = p.items.findIndex((item, index) => index > entry.index && !!item.str.trim())
    return p.items
      .slice(entry.index + 1, next < 0 ? undefined : next)
      .some((item) => !item.str.trim() && item.hasEOL === true)
  }
  for (const [n, start] of starts.entries()) {
    const record = body.slice(start, starts[n + 1] ?? body.length),
      rows: (typeof record)[] = []
    for (const e of record) {
      const row = rows.at(-1)
      if (row && Math.abs(row[0].item.transform[5] - e.item.transform[5]) < font * 0.05) row.push(e)
      else rows.push([e])
    }
    const compact = record
      .map((e) => e.item.str)
      .join('')
      .replace(/\s/gu, '')
    if (
      rows.length < 2 ||
      rows.length > 8 ||
      Math.abs(record[0].item.transform[4] - x) > font * 0.05 ||
      !/(?:\((?:18|19|20)\d{2}\)\.|arXiv:\d{4}\.\d{4,5}(?:v\d+)?\.|https?:\/\/[\w./?#=&%+-]+\.)$/u.test(
        compact
      ) ||
      rows.some(
        (row, i) =>
          !closedRow(row.at(-1)!) ||
          (i > 0 &&
            (row[0].item.transform[4] - x < font * 0.8 ||
              row[0].item.transform[4] - x > font * 3 ||
              rows[i - 1][0].item.transform[5] - row[0].item.transform[5] < font * 0.95 ||
              rows[i - 1][0].item.transform[5] - row[0].item.transform[5] > font * 1.8))
      )
    )
      return false
    if (record.some(({ item }) => !valid(item, p))) return false
  }
  return true
}
