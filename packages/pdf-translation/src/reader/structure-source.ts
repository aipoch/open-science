import { applyCachedPdfTableSources } from './table-source.js'
import { applyCachedPdfFigureSources } from './figure-source.js'
import { createPdfTranslationSource } from './source.js'
import { structureRegionContains } from './structure-regions.js'
import type { PdfTranslationExtraction } from './extraction.js'

/** Prepare cached structure, or project safe crops onto an existing translation snapshot. */
export async function applyCachedPdfStructureSources(
  args: Parameters<typeof applyCachedPdfTableSources>[0] & { preserveUnitIdentity?: boolean }
): Promise<{ extraction: PdfTranslationExtraction; retainedUnitIds: readonly string[] }> {
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
  args.signal.throwIfAborted()
  if (
    original.source.fingerprint !== args.document.fingerprints[0] ||
    original.source.pages.length !== args.document.numPages
  )
    return { extraction: original, retainedUnitIds: [] }
  // Preparation keeps cell replacements, whole-region retention and their diagnostics.
  if (!args.preserveUnitIdentity) return { extraction: figures, retainedUnitIds: [] }
  const proved = new Map(figures.source.units.map((unit) => [unit.id, unit]))
  const regions = figures.source.originalRegions ?? []
  const retainedUnitIds = original.source.units
    .filter((unit) => {
      const next = proved.get(unit.id)
      return (
        (!next || next.sourceOnly) &&
        unit.fragments.every((fragment) =>
          regions.some((region) =>
            structureRegionContains(
              { page: region.pageNumber, ...region.rect },
              { page: fragment.pageNumber, ...fragment.rect }
            )
          )
        )
      )
    })
    .map((unit) => unit.id)
  if (!retainedUnitIds.length) return { extraction: original, retainedUnitIds: [] }
  const retained = new Set(retainedUnitIds)
  return {
    retainedUnitIds: Object.freeze(retainedUnitIds),
    extraction: Object.freeze({
      ...original,
      source: createPdfTranslationSource({
        ...original.source,
        originalRegions: [...(original.source.originalRegions ?? []), ...regions],
        units: original.source.units.map((unit) =>
          retained.has(unit.id) ? { ...unit, sourceOnly: true as const } : unit
        )
      })
    })
  }
}
