import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js'
import type { PdfStructureResult } from '@aipoch/pdf-structure/result'
import type { PdfTranslationExtraction } from './extraction.js'
import type { PdfTranslationSourceIdentity } from './table-source.js'
import { createPdfTranslationSource } from './source.js'
import { createAuxiliaryNativeInkReader } from './auxiliary-native-ink.js'
import {
  nativeLabelRegion,
  nativeZeroAdvanceRegions,
  nativeAlgorithmInkRegions
} from './native-source-geometry.js'

type Region = PdfStructureResult['elements'][number]['regions'][number]
type CaptionlessBodyProof = Readonly<{
  element: PdfStructureResult['elements'][number]
  binding: string
  originalRegion: { pageNumber: number; rect: Omit<Region, 'page'> }
}>
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
    document: Pick<PDFDocumentProxy, 'numPages' | 'fingerprints' | 'getPage'> &
      Partial<Pick<PDFDocumentProxy, 'getData' | 'getMetadata'>>
    results: readonly PdfStructureResult[]
    sourceIdentity: PdfTranslationSourceIdentity
    signal: AbortSignal
    nativeDocumentFactory?: typeof import('pdfjs-dist').getDocument
  },
  focus?: PdfStructureResult['elements'][number],
  focusInk?: ReadonlyMap<number, Region>,
  captionlessProof?: CaptionlessBodyProof
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
    bodyRegions: NonNullable<(typeof source)['originalRegions']>[number][] = [],
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
      const captionless = captionlessProof?.element === element
      if (!body || (!element.caption && !captionless) || !body.sourceItems.length) continue
      const math = body.kind === 'math-table'
      if (
        math
          ? !captionless &&
            (element.kind !== 'table' ||
              !!element.table ||
              !!element.tableParts ||
              element.issues.length !== 1 ||
              element.issues[0].code !== 'no-source-cell-grid')
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
            const captionRegions = element.caption?.regions ?? [],
              captionOverlap = captionRegions.some((r) => overlaps(region, r))
            if (!claim && captionOverlap && captionRegions.some((r) => inside(region, r))) continue
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
        if (captionless && JSON.stringify(element) !== captionlessProof.binding) continue
        if (!math) {
          const caption = algorithmCaption(element)
          if (caption) proseCaptions.add(caption)
        }
        for (const owner of bodyOwners) {
          retained.add(owner.id)
          if (math) mathWarnings.add(owner.id)
        }
        if (captionless) bodyRegions.push(captionlessProof.originalRegion)
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
    source: createPdfTranslationSource({
      ...source,
      units,
      ...(bodyRegions.length
        ? {
            originalRegions: [
              ...(source.originalRegions ?? []),
              ...bodyRegions.filter(
                (r) =>
                  !source.originalRegions?.some(
                    (old) =>
                      old.pageNumber === r.pageNumber &&
                      (['x', 'y', 'width', 'height'] as const).every(
                        (k) => old.rect[k] === r.rect[k]
                      )
                  )
              )
            ]
          }
        : {})
    }),
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

// Split only a typed complete algorithm body. A mixed native fragment additionally
// needs loaded glyph ink and an exact source prefix; never reconstruct its text.
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
    owner.fragments.length < 1 ||
    owner.fragments.length > 16 ||
    (owner.fragments.length === 1 && owner.fragments.some((f) => f.unclippedRect)) ||
    source.units.some((u) => u.id === id) ||
    extraction.coverage.warnings.some(
      (w) =>
        w.unitId === owner.id &&
        (owner.fragments.length !== 1 || w.reasons.some((r) => r !== 'possible-continuation'))
    ) ||
    extraction.coverage.pageDiagnostics?.some((d) => d.pageNumber === region.page)
  )
    return
  const singleFragment = owner.fragments.length === 1
  const captionFragments: (typeof owner.fragments)[number][] = [],
    bodyFragments: (typeof owner.fragments)[number][] = [],
    bodyFirst = owner.fragments[0].items.every((i) => wanted.has(`${region.page}:${i.index}`))
  const grammar =
    bodyFirst || singleFragment
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
    else if (singleFragment && !bodyFirst) {
      const first = flags.indexOf(true)
      if (
        first <= 0 ||
        flags.slice(first).some((f) => !f) ||
        fragment.items.some((i, n) => n > 0 && fragment.items[n - 1].index >= i.index)
      )
        return
      captionFragments.push({ ...fragment, items: fragment.items.slice(0, first) })
      bodyFragments.push({ ...fragment, items: fragment.items.slice(first) })
    } else return
  }
  if (!captionFragments.length || !bodyFragments.length) return
  const captionItems = captionFragments.flatMap((f) => f.items),
    bodyItems = bodyFragments.flatMap((f) => f.items),
    bodyText =
      singleFragment && owner.source.startsWith(caption.text + ' ')
        ? owner.source.slice(caption.text.length + 1)
        : bodyItems.map((i) => i.text).join(' ')
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
  if (bodyFirst || singleFragment) {
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
  if (singleFragment) {
    if (
      !ink ||
      !bodyText.trim() ||
      bodyText.startsWith(' ') ||
      owner.source !== caption.text + ' ' + bodyText
    )
      return
    for (const fragments of [captionFragments, bodyFragments]) {
      for (const [offset, fragment] of fragments.entries()) {
        const rs = fragment.items.map((i) => ink!.get(i.index))
        if (rs.some((r) => !r)) return
        const left = Math.min(...rs.map((r) => r!.x)),
          top = Math.min(...rs.map((r) => r!.y))
        fragments[offset] = {
          ...fragment,
          rect: {
            x: left,
            y: top,
            width: Math.max(...rs.map((r) => r!.x + r!.width)) - left,
            height: Math.max(...rs.map((r) => r!.y + r!.height)) - top
          }
        }
      }
    }
  }
  const captionUnit = { ...owner, source: caption.text, fragments: captionFragments },
    bodyUnit = { id, source: bodyText, fragments: bodyFragments }
  const units = source.units.flatMap((u) =>
    u !== owner ? [u] : bodyFirst ? [bodyUnit, captionUnit] : [captionUnit, bodyUnit]
  )
  return {
    extraction: {
      ...extraction,
      source: createPdfTranslationSource({ ...source, units }),
      ...(singleFragment && extraction.coverage.warnings.some((w) => w.unitId === owner.id)
        ? {
            coverage: {
              ...extraction.coverage,
              warnings: [
                ...extraction.coverage.warnings,
                { unitId: id, reasons: ['possible-continuation'] }
              ]
            }
          }
        : {})
    },
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

async function captionlessBodyProof(
  input: Parameters<typeof retainWholeRegionSources>[0],
  result: PdfStructureResult,
  element: PdfStructureResult['elements'][number],
  auxiliary: ReturnType<typeof createAuxiliaryNativeInkReader>
): Promise<{ proof: CaptionlessBodyProof; ink: ReadonlyMap<number, Region> } | undefined> {
  const { document, sourceIdentity, signal } = input,
    body = element.nativeBody,
    boundary = body?.boundary,
    region = element.regions[0],
    before = JSON.stringify(element)
  if (
    !boundary ||
    body.kind !== 'math-table' ||
    element.kind !== 'table' ||
    element.caption ||
    !element.table ||
    element.tableParts ||
    element.tableNotes ||
    element.table.notes?.length ||
    element.regions.length !== 1 ||
    region.page !== boundary.pageNumber ||
    boundary.scale !== 1 ||
    boundary.coordinateSystem !== 'pdfjs-upright-points' ||
    !element.issues.some((i) => i.code === 'native-table-structure-ambiguous') ||
    !element.table.issues.some((i) => i.code === 'native-table-structure-ambiguous') ||
    result.sourceChecksum !== sourceIdentity.sourceChecksum ||
    result.sourceSizeBytes !== sourceIdentity.sourceSizeBytes ||
    result.pageCount !== document.numPages ||
    !document.getData ||
    !globalThis.crypto?.subtle
  )
    return
  const thumbnail = result.thumbnails.find((t) => t.id === element.thumbnailId)
  if (
    !thumbnail ||
    thumbnail.sha256 !== boundary.raster.sha256 ||
    thumbnail.width !== boundary.raster.width ||
    thumbnail.height !== boundary.raster.height
  )
    return
  const bytes = await document.getData()
  signal.throwIfAborted()
  if (bytes.length !== sourceIdentity.sourceSizeBytes || bytes.length > 64 * 1024 ** 2) return
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes.slice().buffer),
    checksum = Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join('')
  if (checksum !== sourceIdentity.sourceChecksum) return
  const page = await document.getPage(boundary.pageNumber),
    viewport = page.getViewport({ scale: 1 }),
    content = await page.getTextContent(),
    selected = new Set(body.sourceItems.map((i) => i.index))
  signal.throwIfAborted()
  if (
    viewport.rotation !== 0 ||
    viewport.scale !== 1 ||
    JSON.stringify(viewport.transform) !== JSON.stringify([1, 0, 0, -1, 0, viewport.height]) ||
    selected.size !== body.sourceItems.length ||
    body.sourceItems.some(
      (i) =>
        i.pageNumber !== boundary.pageNumber ||
        !('str' in (content.items[i.index] ?? {})) ||
        (content.items[i.index] as TextItem).str !== i.text
    )
  )
    return
  const ink =
    (await nativeAlgorithmInkRegions(page, content, viewport, boundary.pageNumber, selected)) ??
    (await auxiliary.read({ page, content, viewport, pageNumber: boundary.pageNumber, selected }))
  signal.throwIfAborted()
  const nonempty = content.items.flatMap((item, index) =>
    'str' in item && item.str.trim() ? [index] : []
  )
  if (!ink || ink.size !== nonempty.length || nonempty.some((i) => !ink.has(i))) return
  for (const [index, r] of ink) {
    if (selected.has(index)) {
      if (
        r.page !== region.page ||
        r.x < region.x ||
        r.y < region.y ||
        r.x + r.width > region.x + region.width ||
        r.y + r.height > region.y + region.height
      )
        return
    } else if (overlaps(r, region)) return
  }
  const { OPS, Util } = await import('pdfjs-dist/legacy/build/pdf.mjs'),
    operators = await page.getOperatorList(),
    finite = (a: unknown, n: number): a is number[] =>
      (Array.isArray(a) || ArrayBuffer.isView(a)) &&
      (a as number[]).length === n &&
      Array.from(a as number[]).every(Number.isFinite),
    same = (a: number[], b: readonly number[]): boolean =>
      a.length === b.length && a.every((n, i) => n === b[i]),
    crop = [
      region.x * viewport.width,
      region.y * viewport.height,
      (region.x + region.width) * viewport.width,
      (region.y + region.height) * viewport.height
    ],
    scale = Math.min(4, 2400 / Math.max(crop[2] - crop[0], crop[3] - crop[1])),
    protection = [
      crop[0] - 1 / scale,
      crop[1] - 1 / scale,
      crop[0] + thumbnail.width / scale + 1 / scale,
      crop[1] + thumbnail.height / scale + 1 / scale
    ],
    wanted = new Map(boundary.rules.map((r) => [r.operatorIndex, r])),
    seen = new Set<number>(),
    strokeModes = [
      OPS.stroke,
      OPS.closeStroke,
      OPS.fillStroke,
      OPS.eoFillStroke,
      OPS.closeFillStroke,
      OPS.closeEOFillStroke
    ]
  if (
    operators.fnArray.length !== operators.argsArray.length ||
    operators.fnArray.length > 100000 ||
    Math.ceil((crop[2] - crop[0]) * scale) !== thumbnail.width ||
    Math.ceil((crop[3] - crop[1]) * scale) !== thumbnail.height ||
    boundary.rules.length !== 3 ||
    boundary.rules.some(
      (r, i) =>
        i > 0 &&
        (r.operatorIndex <= boundary.rules[i - 1].operatorIndex ||
          r.segment[1] <= boundary.rules[i - 1].segment[1])
    )
  )
    return
  let state = {
    matrix: [1, 0, 0, 1, 0, 0],
    width: 1,
    cap: 0,
    solid: true,
    color: '#000000',
    miter: 10
  }
  const stack: (typeof state)[] = []
  for (let i = 0; i < operators.fnArray.length; i++) {
    const op = operators.fnArray[i],
      a = operators.argsArray[i]
    if (op === OPS.save) stack.push({ ...state, matrix: [...state.matrix] })
    else if (op === OPS.restore) {
      if (!stack.length) return
      state = stack.pop()!
    } else if (op === OPS.transform) {
      if (!finite(a, 6)) return
      state.matrix = Util.transform(state.matrix, a)
    } else if (op === OPS.setLineWidth) {
      if (!Number.isFinite(a?.[0]) || a[0] <= 0) return
      state.width = a[0]
    } else if (op === OPS.setLineCap) state.cap = a?.[0]
    else if (op === OPS.setMiterLimit) {
      if (!Number.isFinite(a?.[0]) || a[0] <= 0) return
      state.miter = a[0]
    } else if (op === OPS.setDash) state.solid = finite(a?.[0], 0) && a?.[1] === 0
    else if (op === OPS.setStrokeRGBColor) state.color = a?.[0]
    else if (op === OPS.setGState) {
      if (
        !Array.isArray(a?.[0]) ||
        a[0].some((p: unknown[]) => !['CA', 'ca'].includes(String(p[0])) || p[1] !== 1)
      )
        return
    } else if (
      [
        OPS.clip,
        OPS.eoClip,
        OPS.beginGroup,
        OPS.endGroup,
        OPS.paintFormXObjectBegin,
        OPS.paintFormXObjectEnd,
        OPS.setStrokeColorN,
        OPS.setStrokeColorSpace,
        OPS.setStrokeColor,
        OPS.setStrokeGray,
        OPS.setStrokeCMYKColor
      ].includes(op)
    )
      return
    else if (op === OPS.constructPath) {
      if ([OPS.clip, OPS.eoClip].includes(a?.[0])) return
      if (a?.[0] === OPS.endPath) continue
      const m = Util.transform(viewport.transform, state.matrix),
        witness = wanted.get(i),
        cmd = a?.[1]?.[0]
      if (witness) {
        if (
          a[0] !== OPS.stroke ||
          !finite(cmd, 6) ||
          cmd[0] !== 0 ||
          cmd[3] !== 1 ||
          cmd[2] !== cmd[5] ||
          m[0] <= 0 ||
          m[3] >= 0 ||
          m[1] !== 0 ||
          m[2] !== 0 ||
          state.cap !== 0 ||
          !state.solid ||
          state.color !== '#000000'
        )
          return
        const segment = [
            cmd[1] * m[0] + m[4],
            cmd[2] * m[3] + m[5],
            cmd[4] * m[0] + m[4],
            cmd[5] * m[3] + m[5]
          ],
          width = state.width * Math.max(Math.abs(m[0]), Math.abs(m[3]))
        if (
          !same(segment, witness.segment) ||
          width !== witness.width ||
          !same(witness.clip, [0, 0, viewport.width, viewport.height])
        )
          return
        seen.add(i)
      } else {
        if (!finite(a?.[2], 4)) return
        const pad = strokeModes.includes(a[0]) ? (state.width * Math.max(1, state.miter)) / 2 : 0,
          points = [a[2][0] - pad, a[2][2] + pad].flatMap((x) =>
            [a[2][1] - pad, a[2][3] + pad].map((y) => [
              m[0] * x + m[2] * y + m[4],
              m[1] * x + m[3] * y + m[5]
            ])
          ),
          box = [
            Math.min(...points.map((p) => p[0])),
            Math.min(...points.map((p) => p[1])),
            Math.max(...points.map((p) => p[0])),
            Math.max(...points.map((p) => p[1]))
          ]
        if (
          box[0] < protection[2] &&
          protection[0] < box[2] &&
          box[1] < protection[3] &&
          protection[1] < box[3]
        )
          return
      }
    }
  }
  if (stack.length || seen.size !== 3 || JSON.stringify(element) !== before) return
  const { page: pageNumber, ...rect } = region
  return {
    ink,
    proof: { element, binding: before, originalRegion: { pageNumber, rect: { ...rect } } }
  }
}

export async function retainPdfWholeRegionSources(
  input: Parameters<typeof retainWholeRegionSources>[0]
): Promise<PdfTranslationExtraction> {
  let extraction = input.extraction,
    attempts = 0
  const auxiliary = createAuxiliaryNativeInkReader({
    document: input.document,
    nativeDocumentFactory: input.nativeDocumentFactory,
    sourceIdentity: input.sourceIdentity,
    signal: input.signal
  })
  try {
    for (const result of input.results)
      for (const element of result.elements) {
        if (!element.nativeBody?.boundary || element.caption) continue
        try {
          const verified = await captionlessBodyProof(
            { ...input, extraction },
            result,
            element,
            auxiliary
          )
          if (verified)
            extraction = await retainWholeRegionSources(
              { ...input, extraction },
              element,
              verified.ink,
              verified.proof
            )
        } catch {
          input.signal.throwIfAborted()
        }
      }
  } finally {
    await auxiliary.dispose()
  }
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
