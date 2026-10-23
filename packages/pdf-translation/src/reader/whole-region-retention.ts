import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js'
import type { PdfStructureResult } from '@aipoch/pdf-structure/result'
import type { PdfTranslationExtraction } from './extraction.js'
import type { PdfTranslationSourceIdentity } from './table-source.js'
import { createPdfTranslationSource } from './source.js'
import {
  nativeLabelRegion,
  nativeZeroAdvanceRegions,
  nativeAlgorithmInkRegions
} from './native-source-geometry.js'

type Region = PdfStructureResult['elements'][number]['regions'][number]
const inside = (r: Region, outer: Region): boolean =>
  r.page === outer.page &&
  r.x >= outer.x - 1e-6 &&
  r.y >= outer.y - 1e-6 &&
  r.x + r.width <= outer.x + outer.width + 1e-6 &&
  r.y + r.height <= outer.y + outer.height + 1e-6
const overlaps = (a: Region, b: Region): boolean =>
  a.page === b.page &&
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height

/** Results have passed the cache schema/identity checks at the reader entry point. */
async function retainWholeRegionSources(
  {
    extraction,
    document,
    results,
    sourceIdentity,
    signal
  }: {
    extraction: PdfTranslationExtraction
    document: Pick<PDFDocumentProxy, 'numPages' | 'fingerprints' | 'getPage'>
    results: readonly PdfStructureResult[]
    sourceIdentity: PdfTranslationSourceIdentity
    signal: AbortSignal
  },
  focus?: PdfStructureResult['elements'][number],
  focusInk?: ReadonlyMap<number, Region>
): Promise<PdfTranslationExtraction> {
  signal.throwIfAborted()
  const source = extraction.source,
    identity = { ...sourceIdentity }
  const current = (): boolean =>
    !!source.fingerprint &&
    source.fingerprint === document.fingerprints[0] &&
    source.pages.length === document.numPages
  if (!current()) return extraction
  const elements = results.flatMap((result) => result.elements)
  const owners = new Map<string, (typeof source.units)[number]>(),
    unitIds = new Set<string>(),
    claims = new Map<string, number>()
  const unitKeys = (unit: (typeof source.units)[number]): string[] =>
    unit.fragments.flatMap((f) => f.items.map((i) => `${f.pageNumber}:${i.index}`))
  for (const unit of source.units) {
    if (unitIds.has(unit.id)) return extraction
    unitIds.add(unit.id)
    for (const key of unitKeys(unit)) {
      if (owners.has(key)) return extraction
      owners.set(key, unit)
    }
  }
  for (const element of elements)
    for (const item of [
      ...(element.sourceItems ?? []),
      ...(element.nativeBody?.sourceItems ?? [])
    ]) {
      const key = `${item.pageNumber}:${item.index}`
      claims.set(key, (claims.get(key) ?? 0) + 1)
    }
  const native = new Map<
      number,
      {
        content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>
        viewport: ReturnType<PDFPageProxy['getViewport']>
        page: PDFPageProxy
        zero?: Awaited<ReturnType<typeof nativeZeroAdvanceRegions>>
      }
    >(),
    retained = new Set<string>(),
    proseCaptions = new Set<string>(),
    mathWarnings = new Set<string>()
  // A successful body proof does not by itself release its title. Restore only
  // a complete, uniquely owned plain-text caption with its own native evidence.
  const algorithmCaption = (element: (typeof elements)[number]): string | undefined => {
    const caption = element.caption
    if (!caption || caption.regions.length !== 1) return
    const region = caption.regions[0],
      evidence = native.get(region.page)
    if (
      !evidence ||
      evidence.viewport.rotation !== 0 ||
      extraction.coverage.pageDiagnostics?.some((d) => d.pageNumber === region.page)
    )
      return
    const title = /^(Algorithm\s+(?:[A-Z]\.?)?\d+)\s+(.+)$/u.exec(caption.text),
      tail = title?.[2]
    if (
      !tail ||
      !/^[\p{Script=Latin}]+(?:[’'–-][\p{Script=Latin}]+)*(?:\s+[\p{Script=Latin}]+(?:[’'–-][\p{Script=Latin}]+)*){4,}[.]?$/u.test(
        tail
      )
    )
      return
    const items: { index: number; item: TextItem; region: Region }[] = []
    for (const [index, item] of evidence.content.items.entries()) {
      if (!('str' in item) || !item.str.trim()) continue
      const style = evidence.content.styles[item.fontName]
      // Unknown geometry anywhere on this page cannot exclude foreign text
      // from the caption. This never changes the separate body proof.
      if (
        !style ||
        style.vertical !== false ||
        !Number.isFinite(style.ascent) ||
        !Number.isFinite(style.descent) ||
        style.ascent <= 0 ||
        style.ascent > 1 ||
        style.descent > 0 ||
        style.descent < -1 ||
        style.ascent <= style.descent ||
        item.dir !== 'ltr' ||
        item.transform.length !== 6 ||
        ![...item.transform, item.height, item.width].every(Number.isFinite) ||
        item.transform[0] <= 0 ||
        item.transform[1] !== 0 ||
        item.transform[2] !== 0 ||
        Math.abs(item.transform[3] - item.height) > 1e-6 ||
        item.height <= 0 ||
        item.width <= 0
      )
        return
      const nativeRegion = nativeLabelRegion(item, style, evidence.viewport, region.page)
      if (!nativeRegion) return
      if (!overlaps(nativeRegion, region)) continue
      if (!inside(nativeRegion, region)) return
      items.push({ index, item, region: nativeRegion })
    }
    // One whole label run and one whole prose run: never assemble a title
    // by admitting separately styled mathematical letters into plain words.
    if (items.length !== 2 || items[0].item.str !== title![1] || items[1].item.str !== tail) return
    const first = items[0].item,
      unit = owners.get(region.page + ':' + items[0].index)
    if (
      !unit?.sourceOnly ||
      unit.fragments.length !== 1 ||
      unit.source !== caption.text ||
      extraction.coverage.warnings.some((w) => w.unitId === unit.id) ||
      items.map(({ item }) => item.str.trim()).join(' ') !== caption.text
    )
      return
    const keys = new Set(items.map(({ index }) => region.page + ':' + index))
    if (unitKeys(unit).length !== keys.size || unitKeys(unit).some((key) => !keys.has(key))) return
    for (const { index, item, region: nativeRegion } of items) {
      const key = region.page + ':' + index
      if (
        claims.has(key) ||
        owners.get(key) !== unit ||
        Math.abs(item.height - first.height) > 1e-6 ||
        Math.abs(item.transform[5] - first.transform[5]) > 1e-6 ||
        !unit.fragments[0].items.some((i) => i.index === index && i.text === item.str) ||
        elements.some(
          (other) =>
            other !== element &&
            [...other.regions, ...(other.caption?.regions ?? [])].some((r) =>
              overlaps(nativeRegion, r)
            )
        )
      )
        return
    }
    return unit.id
  }
  for (const result of results) {
    if (
      result.sourceChecksum !== identity.sourceChecksum ||
      result.sourceSizeBytes !== identity.sourceSizeBytes ||
      result.pageCount !== document.numPages
    )
      continue
    for (const element of result.elements) {
      if (focus && element !== focus) continue
      const body = element.nativeBody
      if (!body || !element.caption || !body.sourceItems.length) continue
      const math = body.kind === 'math-table'
      if (
        math
          ? element.kind !== 'table' ||
            !!element.table ||
            !!element.tableParts ||
            element.issues.length !== 1 ||
            element.issues[0].code !== 'no-source-cell-grid'
          : body.kind !== 'algorithm' || element.kind !== 'algorithm' || element.issues.length > 0
      )
        continue
      try {
        const wanted = new Map(body.sourceItems.map((i) => [`${i.pageNumber}:${i.index}`, i])),
          bodyOwners = new Set<(typeof source.units)[number]>()
        if (wanted.size !== body.sourceItems.length) continue
        let valid = true
        for (const [key, item] of wanted) {
          const owner = owners.get(key)
          if (
            claims.get(key) !== 1 ||
            !owner ||
            !owner.fragments.some(
              (f) =>
                f.pageNumber === item.pageNumber &&
                f.items.some((i) => i.index === item.index && i.text === item.text)
            )
          ) {
            valid = false
            break
          }
          bodyOwners.add(owner)
        }
        if (!valid || [...bodyOwners].some((u) => unitKeys(u).some((k) => !wanted.has(k)))) continue
        for (const owner of bodyOwners)
          for (const fragment of owner.fragments) {
            const regions =
              focusInk && focus === element
                ? fragment.items.map((i) => focusInk.get(i.index))
                : [{ page: fragment.pageNumber, ...fragment.rect }]
            for (const region of regions)
              if (
                !region ||
                region.page !== fragment.pageNumber ||
                !element.regions.some((r) => inside(region, r)) ||
                elements.some(
                  (e) =>
                    (e !== element && e.regions.some((r) => overlaps(region, r))) ||
                    e.caption?.regions.some((r) => overlaps(region, r))
                )
              )
                valid = false
          }
        if (!valid) continue
        const seen = new Set<string>()
        for (const pageNumber of new Set(element.regions.map((r) => r.page))) {
          signal.throwIfAborted()
          if (!current()) return extraction
          if (!result.processedPages.includes(pageNumber)) {
            valid = false
            break
          }
          if (!native.has(pageNumber)) {
            const page = await document.getPage(pageNumber),
              viewport = page.getViewport({ scale: 1 }),
              expected = source.pages[pageNumber - 1]
            if (
              !expected ||
              ![viewport.width, viewport.height].every((n) => Number.isFinite(n) && n > 0) ||
              Math.abs(viewport.width - expected.width) > 1e-6 ||
              Math.abs(viewport.height - expected.height) > 1e-6
            ) {
              valid = false
              break
            }
            native.set(pageNumber, { content: await page.getTextContent(), viewport, page })
          }
          signal.throwIfAborted()
          if (!current()) return extraction
          const evidence = native.get(pageNumber)!
          const { content, viewport } = evidence
          for (const [index, item] of content.items.entries()) {
            if (!('str' in item) || !item.str.trim()) continue
            const region =
                focusInk && focus === element
                  ? focusInk.get(index)
                  : nativeLabelRegion(item, content.styles?.[item.fontName], viewport, pageNumber),
              key = `${pageNumber}:${index}`,
              claim = wanted.get(key)
            // Unknown native geometry cannot prove that a text item lies outside the body.
            if (!region) {
              if (!claim && item.width === 0 && owners.has(key)) {
                evidence.zero ??= await nativeZeroAdvanceRegions(
                  evidence.page,
                  content,
                  viewport,
                  pageNumber
                )
                signal.throwIfAborted()
                if (!current()) return extraction
                const ink = evidence.zero.get(index)
                const external = owners.get(key)
                const protectedRegions = [
                  ...elements.flatMap((e) => [...e.regions, ...(e.caption?.regions ?? [])]),
                  ...source.units
                    .filter((u) => u !== external)
                    .flatMap((u) => u.fragments.map((f) => ({ page: f.pageNumber, ...f.rect })))
                ]
                if (
                  ink &&
                  protectedRegions.every(
                    (r) =>
                      r.page !== ink.page ||
                      ink.x + ink.width < r.x ||
                      r.x + r.width < ink.x ||
                      ink.y + ink.height < r.y ||
                      r.y + r.height < ink.y
                  )
                )
                  continue
              }
              valid = false
              break
            }
            if (!element.regions.some((r) => overlaps(region, r))) {
              if (claim) valid = false
              continue
            }
            const captionOverlap = element.caption.regions.some((r) => overlaps(region, r))
            if (!claim && captionOverlap && element.caption.regions.some((r) => inside(region, r)))
              continue
            if (
              !claim ||
              claim.text !== item.str ||
              captionOverlap ||
              !element.regions.some((r) => inside(region, r)) ||
              elements.some(
                (e) =>
                  (e !== element && e.regions.some((r) => overlaps(region, r))) ||
                  e.caption?.regions.some((r) => overlaps(region, r))
              )
            ) {
              valid = false
              break
            }
            seen.add(key)
          }
          if (!valid) break
        }
        if (!valid || seen.size !== wanted.size) continue
        if (!math) {
          const caption = algorithmCaption(element)
          if (caption) proseCaptions.add(caption)
        }
        for (const owner of bodyOwners) {
          retained.add(owner.id)
          if (math) mathWarnings.add(owner.id)
        }
      } catch {
        signal.throwIfAborted()
        // A body without complete evidence cannot affect independently proved bodies.
      }
    }
  }
  signal.throwIfAborted()
  if (!current() || !retained.size) return extraction
  const units = source.units.map((u) => {
    if (u.fragments.some((fragment) => fragment.unclippedRect)) return u
    if (proseCaptions.has(u.id)) {
      const caption = { ...u }
      delete caption.sourceOnly
      if (caption.preserve === 'reference') delete caption.preserve
      return caption
    }
    return retained.has(u.id) && !u.sourceOnly ? { ...u, sourceOnly: true as const } : u
  })
  const warnings = new Map(extraction.coverage.warnings.map((w) => [w.unitId, new Set(w.reasons)]))
  for (const id of mathWarnings) {
    if (!warnings.has(id)) warnings.set(id, new Set())
    warnings.get(id)!.add('table-structure-unreliable')
  }
  return Object.freeze({
    ...extraction,
    source: createPdfTranslationSource({ ...source, units }),
    coverage: mathWarnings.size
      ? Object.freeze({
          ...extraction.coverage,
          warnings: Object.freeze(
            [...warnings].map(([unitId, reasons]) =>
              Object.freeze({ unitId, reasons: Object.freeze([...reasons]) })
            )
          )
        })
      : extraction.coverage
  })
}

// A grouped paragraph can contain two already separate native fragments: the
// algorithm caption followed by its first body row. Only split that existing
// boundary; a mixed fragment or any unowned/external text remains untouched.
async function splitAlgorithmCaptionOwner(
  input: Parameters<typeof retainWholeRegionSources>[0],
  element: PdfStructureResult['elements'][number]
): Promise<
  { extraction: PdfTranslationExtraction; ink?: ReadonlyMap<number, Region> } | undefined
> {
  const { extraction, document, signal } = input,
    source = extraction.source,
    caption = element.caption,
    body = element.nativeBody
  if (
    element.kind !== 'algorithm' ||
    element.issues.length ||
    body?.kind !== 'algorithm' ||
    !body.sourceItems.length ||
    body.sourceItems.length > 4096 ||
    caption?.regions.length !== 1
  )
    return
  const wanted = new Set(body.sourceItems.map((i) => `${i.pageNumber}:${i.index}`)),
    keys = (u: (typeof source.units)[number]): string[] =>
      u.fragments.flatMap((f) => f.items.map((i) => `${f.pageNumber}:${i.index}`)),
    mixed = source.units.filter(
      (u) => keys(u).some((k) => wanted.has(k)) && keys(u).some((k) => !wanted.has(k))
    )
  if (mixed.length !== 1 || wanted.size !== body.sourceItems.length) return
  const owner = mixed[0],
    id = owner.id + ':algorithm-body',
    region = caption.regions[0]
  if (
    owner.sourceOnly ||
    owner.fragments.length < 2 ||
    owner.fragments.length > 16 ||
    source.units.some((u) => u.id === id) ||
    extraction.coverage.warnings.some((w) => w.unitId === owner.id) ||
    extraction.coverage.pageDiagnostics?.some((d) => d.pageNumber === region.page)
  )
    return
  const captionFragments: (typeof owner.fragments)[number][] = [],
    bodyFragments: (typeof owner.fragments)[number][] = [],
    bodyFirst = owner.fragments[0].items.every((i) => wanted.has(`${region.page}:${i.index}`))
  const grammar = bodyFirst
    ? /^Algorithm\s+(?:[A-Z]\.?)?\d+(?:\.\d+)*:?\s+[\p{Script=Latin}]+(?:[’'–-][\p{Script=Latin}]+)*(?:\s+[\p{Script=Latin}]+(?:[’'–-][\p{Script=Latin}]+)*)+[.]?$/u
    : /^Algorithm\s+(?:[A-Z]\.?)?\d+(?:\.\d+)*\s+[\p{Script=Latin}]+(?:[’'–-][\p{Script=Latin}]+)*(?:\s+[\p{Script=Latin}]+(?:[’'–-][\p{Script=Latin}]+)*)+$/u
  if (!grammar.test(caption.text)) return
  for (const fragment of owner.fragments) {
    if (fragment.pageNumber !== region.page || !fragment.items.length) return
    const flags = fragment.items.map((i) => wanted.has(`${fragment.pageNumber}:${i.index}`))
    if (flags.every(Boolean) && (!bodyFirst || !captionFragments.length))
      bodyFragments.push(fragment)
    else if (flags.every((f) => !f) && (bodyFirst || !bodyFragments.length))
      captionFragments.push(fragment)
    else return
  }
  if (!captionFragments.length || !bodyFragments.length) return
  const captionItems = captionFragments.flatMap((f) => f.items),
    bodyItems = bodyFragments.flatMap((f) => f.items),
    bodyText = bodyItems.map((i) => i.text).join(' ')
  if (
    captionItems.map((i) => i.text).join(' ') !== caption.text ||
    owner.source !== (bodyFirst ? bodyText + ' ' + caption.text : caption.text + ' ' + bodyText) ||
    (bodyFirst
      ? Math.max(...bodyItems.map((i) => i.index)) >= Math.min(...captionItems.map((i) => i.index))
      : Math.max(...captionItems.map((i) => i.index)) >= Math.min(...bodyItems.map((i) => i.index)))
  )
    return
  const elements = input.results.flatMap((r) => r.elements)
  if (
    elements.some((e) =>
      [...(e.sourceItems ?? []), ...(e.nativeBody?.sourceItems ?? [])].some(
        (i) => i.pageNumber === region.page && captionItems.some((c) => c.index === i.index)
      )
    )
  )
    return
  signal.throwIfAborted()
  const page = await document.getPage(region.page),
    viewport = page.getViewport({ scale: 1 }),
    content = await page.getTextContent(),
    seen = new Set<number>()
  signal.throwIfAborted()
  if (
    source.fingerprint !== document.fingerprints[0] ||
    source.pages.length !== document.numPages ||
    viewport.scale !== 1 ||
    viewport.rotation !== 0
  )
    return
  let ink: ReadonlyMap<number, Region> | undefined
  if (bodyFirst) {
    if (
      element.regions.length !== 1 ||
      element.regions[0].page !== region.page ||
      body.sourceItems.some((i) => i.pageNumber !== region.page)
    )
      return
    ink = await nativeAlgorithmInkRegions(
      page,
      content,
      viewport,
      region.page,
      new Set([...body.sourceItems.map((i) => i.index), ...captionItems.map((i) => i.index)])
    )
    signal.throwIfAborted()
    if (!ink || source.fingerprint !== document.fingerprints[0]) return
  }
  for (const [index, item] of content.items.entries()) {
    if (!('str' in item) || !item.str.trim()) continue
    const style = content.styles[item.fontName]
    if (
      !ink &&
      (!style ||
        style.vertical !== false ||
        !Number.isFinite(style.ascent) ||
        !Number.isFinite(style.descent) ||
        style.ascent <= 0 ||
        style.ascent > 1 ||
        style.descent > 0 ||
        style.descent < -1 ||
        item.dir !== 'ltr' ||
        item.transform.length !== 6 ||
        ![...item.transform, item.height, item.width].every(Number.isFinite) ||
        item.transform[0] <= 0 ||
        item.transform[1] !== 0 ||
        item.transform[2] !== 0 ||
        Math.abs(item.transform[3] - item.height) > 1e-6 ||
        item.height <= 0 ||
        item.width <= 0)
    )
      return
    const nativeRegion =
      ink?.get(index) ?? (!ink ? nativeLabelRegion(item, style, viewport, region.page) : undefined)
    if (!nativeRegion) return
    if (!overlaps(nativeRegion, region)) continue
    const claim = captionItems.find((i) => i.index === index)
    if (
      !claim ||
      claim.text !== item.str ||
      !inside(nativeRegion, region) ||
      elements.some(
        (e) =>
          e !== element &&
          [...e.regions, ...(e.caption?.regions ?? [])].some((r) => overlaps(nativeRegion, r))
      )
    )
      return
    seen.add(index)
  }
  if (seen.size !== captionItems.length) return
  const captionUnit = { ...owner, source: caption.text, fragments: captionFragments },
    bodyUnit = { id, source: bodyText, fragments: bodyFragments }
  const units = source.units.flatMap((u) =>
    u !== owner ? [u] : bodyFirst ? [bodyUnit, captionUnit] : [captionUnit, bodyUnit]
  )
  return {
    extraction: { ...extraction, source: createPdfTranslationSource({ ...source, units }) },
    ink
  }
}

// Captionless diff packets have their own native proof; the mechanism tag alone
// never grants a translation contract or changes an existing graphical owner.
async function retainNativeDiffCodeSources(
  input: Parameters<typeof retainWholeRegionSources>[0]
): Promise<PdfTranslationExtraction> {
  const { extraction, document, results, sourceIdentity, signal } = input,
    source = extraction.source,
    elements = results.flatMap((r) => r.elements),
    candidates = elements.filter(
      (e) =>
        e.kind === 'figure' &&
        !e.caption &&
        !e.nativeBody &&
        e.issues.length === 1 &&
        e.issues[0].code === 'native-diff-code-packet'
    )
  if (
    !candidates.length ||
    candidates.length > 16 ||
    !source.fingerprint ||
    source.fingerprint !== document.fingerprints[0] ||
    source.pages.length !== document.numPages
  )
    return extraction
  const owners = new Map<string, (typeof source.units)[number]>(),
    claims = new Map<string, number>(),
    retained = new Set<string>()
  const keys = (u: (typeof source.units)[number]): string[] =>
    u.fragments.flatMap((f) => f.items.map((i) => f.pageNumber + ':' + i.index))
  const ids = new Set<string>()
  for (const unit of source.units) {
    if (ids.has(unit.id)) return extraction
    ids.add(unit.id)
    for (const key of keys(unit)) {
      if (owners.has(key)) return extraction
      owners.set(key, unit)
    }
  }
  for (const e of elements)
    for (const i of [...(e.sourceItems ?? []), ...(e.nativeBody?.sourceItems ?? [])]) {
      const key = i.pageNumber + ':' + i.index
      claims.set(key, (claims.get(key) ?? 0) + 1)
    }
  try {
    for (const element of candidates) {
      signal.throwIfAborted()
      const result = results.find((r) => r.elements.includes(element)),
        wanted = element.sourceItems
      if (
        !result ||
        result.sourceChecksum !== sourceIdentity.sourceChecksum ||
        result.sourceSizeBytes !== sourceIdentity.sourceSizeBytes ||
        result.pageCount !== document.numPages ||
        element.regions.length !== 1 ||
        !wanted?.length ||
        wanted.length > 4096
      )
        return extraction
      const region = element.regions[0],
        pageNumber = region.page,
        expected = source.pages[pageNumber - 1]
      if (
        !expected ||
        !result.processedPages.includes(pageNumber) ||
        !Object.values(region).every(Number.isFinite) ||
        region.width <= 0 ||
        region.height <= 0 ||
        region.x < 0 ||
        region.y < 0 ||
        region.x + region.width > 1 ||
        region.y + region.height > 1
      )
        return extraction
      const page = await document.getPage(pageNumber),
        viewport = page.getViewport({ scale: 1 }),
        content = await page.getTextContent(),
        selected = new Set(wanted.map((i) => i.index))
      signal.throwIfAborted()
      if (
        viewport.width !== expected.width ||
        viewport.height !== expected.height ||
        selected.size !== wanted.length ||
        wanted.some(
          (i, n) =>
            i.pageNumber !== pageNumber ||
            !Number.isSafeInteger(i.index) ||
            i.index < 0 ||
            (n > 0 && i.index <= wanted[n - 1].index)
        )
      )
        return extraction
      const ink = await nativeAlgorithmInkRegions(page, content, viewport, pageNumber, selected)
      signal.throwIfAborted()
      if (!ink) return extraction
      const bodyOwners = new Set<(typeof source.units)[number]>(),
        rows: { baseline: number; text: string; first: number; last: number; right: number }[] = []
      let fontName: string | undefined,
        height = 0
      for (const item of wanted) {
        const raw = content.items[item.index],
          key = pageNumber + ':' + item.index,
          owner = owners.get(key)
        if (
          !raw ||
          !('str' in raw) ||
          raw.str !== item.text ||
          !/^[\x20-\x7e]+$/u.test(raw.str) ||
          claims.get(key) !== 1 ||
          !owner ||
          !owner.fragments.some(
            (f) =>
              f.pageNumber === pageNumber &&
              f.items.some((i) => i.index === item.index && i.text === raw.str)
          ) ||
          !page.commonObjs?.has(raw.fontName) ||
          page.commonObjs.get(raw.fontName)?.isMonospace !== true ||
          !ink.get(item.index) ||
          !inside(ink.get(item.index)!, region)
        )
          return extraction
        if (fontName && (fontName !== raw.fontName || Math.abs(height - raw.height) > 1e-6))
          return extraction
        fontName = raw.fontName
        height = raw.height
        bodyOwners.add(owner)
        const row = rows.at(-1),
          baseline = raw.transform[5]
        if (row && Math.abs(row.baseline - baseline) < 1e-6) {
          if (raw.transform[4] < row.right - 1e-6) return extraction
          row.right = raw.transform[4] + raw.width
          row.text += raw.str
          row.last = item.index
        } else {
          if (row && baseline >= row.baseline) return extraction
          rows.push({
            baseline,
            text: raw.str,
            first: item.index,
            last: item.index,
            right: raw.transform[4] + raw.width
          })
        }
      }
      if (
        [...bodyOwners].some(
          (u) =>
            keys(u).some((k) => !wanted.some((i) => k === pageNumber + ':' + i.index)) ||
            u.fragments.some((f) => !inside({ page: f.pageNumber, ...f.rect }, region))
        )
      )
        return extraction
      const first = wanted[0].index,
        last = wanted.at(-1)!.index
      if (
        content.items
          .slice(first, last + 1)
          .some((raw, n) => 'str' in raw && raw.str.trim() && !selected.has(first + n))
      )
        return extraction
      let packets = 0,
        plus = false,
        minus = false,
        bodyRows = 0
      for (const row of rows) {
        if (/^@@ [^@]+ @@$/u.test(row.text)) {
          if (packets && (!plus || !minus || bodyRows < 2)) return extraction
          if (row.first !== row.last) return extraction
          packets++
          plus = minus = false
          bodyRows = 0
        } else {
          if (!packets || row.text.includes('@@')) return extraction
          bodyRows++
          if (/^\+\S/u.test(row.text)) plus = true
          if (/^-\S/u.test(row.text)) minus = true
        }
      }
      if (!packets || !plus || !minus || bodyRows < 2) return extraction
      for (const [index, r] of ink) {
        if (overlaps(r, region) && !selected.has(index)) return extraction
        if (
          selected.has(index) &&
          elements.some(
            (e) =>
              e !== element &&
              [...e.regions, ...(e.caption?.regions ?? [])].some((outer) => overlaps(r, outer))
          )
        )
          return extraction
      }
      for (const owner of bodyOwners) retained.add(owner.id)
    }
  } catch {
    signal.throwIfAborted()
    return extraction
  }
  signal.throwIfAborted()
  if (source.fingerprint !== document.fingerprints[0] || source.pages.length !== document.numPages)
    return extraction
  return Object.freeze({
    ...extraction,
    source: createPdfTranslationSource({
      ...source,
      units: source.units.map((u) =>
        retained.has(u.id) && !u.sourceOnly ? { ...u, sourceOnly: true as const } : u
      )
    })
  })
}

export async function retainPdfWholeRegionSources(
  input: Parameters<typeof retainWholeRegionSources>[0]
): Promise<PdfTranslationExtraction> {
  let extraction = input.extraction,
    attempts = 0
  for (const result of input.results)
    for (const element of result.elements) {
      if (element.kind !== 'algorithm' || !element.nativeBody || attempts++ >= 16) continue
      try {
        const split = await splitAlgorithmCaptionOwner({ ...input, extraction }, element)
        if (!split) continue
        // Keep the whole-owner, competing-claim and complete native body checks.
        // A tentative split is committed only when this exact body passes them.
        const proved = await retainWholeRegionSources(
          { ...input, extraction: split.extraction },
          element,
          split.ink
        )
        if (proved !== split.extraction) extraction = proved
      } catch {
        input.signal.throwIfAborted()
      }
    }
  extraction = await retainWholeRegionSources({ ...input, extraction })
  return retainNativeDiffCodeSources({ ...input, extraction })
}
