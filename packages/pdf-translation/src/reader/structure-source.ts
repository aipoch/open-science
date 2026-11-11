import { applyCachedPdfTableSources, isCurrentPdfTableSources } from './table-source.js'
import { applyCachedPdfFigureSources } from './figure-source.js'
import { createPdfTranslationSource } from './source.js'
import { structureRegionContains } from './structure-regions.js'
import { carryNativeCaptionEligibility } from './caption-eligibility.js'
import { retainUnstructuredTablePages } from './unstructured-table-retention.js'
import type { PdfTranslationExtraction } from './extraction.js'

/** Prepare cached structure, or project safe crops onto an existing translation snapshot. */
export async function applyCachedPdfStructureSources(
  args: Parameters<typeof applyCachedPdfTableSources>[0] &
    Pick<Parameters<typeof applyCachedPdfFigureSources>[0], 'nativeDocumentFactory'> & {
      preserveUnitIdentity?: boolean
    }
): Promise<{
  extraction: PdfTranslationExtraction
  retainedUnitIds: readonly string[]
  retainedSourcePageNumbers?: readonly number[]
}> {
  const original = args.extraction
  // Existing heuristic crops are not evidence for suppressing saved translations.
  const input = args.preserveUnitIdentity
    ? {
        ...original,
        source: createPdfTranslationSource({ ...original.source, originalRegions: undefined })
      }
    : original
  const tables = await applyCachedPdfTableSources({ ...args, extraction: input })
  const figures = await applyCachedPdfFigureSources({ ...args, extraction: tables })
  const unstructured = await retainUnstructuredTablePages({ ...args, extraction: figures })
  args.signal.throwIfAborted()
  if (
    original.source.fingerprint !== args.document.fingerprints[0] ||
    original.source.pages.length !== args.document.numPages ||
    !isCurrentPdfTableSources(tables)
  )
    return { extraction: original, retainedUnitIds: [] }
  // Preparation keeps cell replacements, whole-region retention and their diagnostics.
  if (!args.preserveUnitIdentity)
    return {
      extraction: unstructured.extraction,
      retainedUnitIds: [],
      ...(unstructured.retainedSourcePageNumbers.length
        ? { retainedSourcePageNumbers: unstructured.retainedSourcePageNumbers }
        : {})
    }
  const proved = new Map(figures.source.units.map((unit) => [unit.id, unit]))
  const regions = figures.source.originalRegions ?? []
  const originalUnits = new Map(original.source.units.map((unit) => [unit.id, unit]))
  const wholeTableOwners = new Set(
    unstructured.retainedUnitIds.every((id) => {
      const before = originalUnits.get(id),
        after = unstructured.extraction.source.units.find((u) => u.id === id)
      return (
        before &&
        after &&
        before.source === after.source &&
        JSON.stringify(before.fragments) === JSON.stringify(after.fragments)
      )
    })
      ? unstructured.retainedUnitIds
      : []
  )
  const retainedUnitIds = original.source.units
    .filter((unit) => {
      const next = proved.get(unit.id)
      return (
        wholeTableOwners.has(unit.id) ||
        ((!next || next.sourceOnly) &&
          unit.fragments.every((fragment) =>
            regions.some((region) =>
              structureRegionContains(
                { page: region.pageNumber, ...region.rect },
                { page: fragment.pageNumber, ...fragment.rect }
              )
            )
          ))
      )
    })
    .map((unit) => unit.id)
  if (!retainedUnitIds.length) return { extraction: original, retainedUnitIds: [] }
  const retained = new Set(retainedUnitIds)
  const originalRegions = original.source.originalRegions ?? []
  // Rechecking a saved edition must not append an already retained native crop.
  const additionalRegions = regions.filter(
    (region) =>
      !originalRegions.some(
        (existing) =>
          existing.pageNumber === region.pageNumber &&
          (['x', 'y', 'width', 'height'] as const).every(
            (key) => existing.rect[key] === region.rect[key]
          )
      )
  )
  return {
    retainedUnitIds: Object.freeze(retainedUnitIds),
    ...(wholeTableOwners.size && unstructured.retainedSourcePageNumbers.length
      ? { retainedSourcePageNumbers: unstructured.retainedSourcePageNumbers }
      : {}),
    extraction: Object.freeze({
      ...original,
      source: carryNativeCaptionEligibility(
        original.source,
        createPdfTranslationSource({
          ...original.source,
          originalRegions: [...originalRegions, ...additionalRegions],
          units: original.source.units.map((unit) =>
            retained.has(unit.id) ? { ...unit, sourceOnly: true as const } : unit
          )
        })
      )
    })
  }
}
