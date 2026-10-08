import { z } from 'zod'

const item = z
  .object({ index: z.number().int().min(0).max(1000000), text: z.string().max(100000) })
  .strict()
const pageNumber = z.number().int().min(1).max(500)
const count = z.number().int().min(0).max(1000000)

// This version describes stored data, not the currently installed grouping algorithm.
// Old runs keep their original ownership, reading order and coordinates after upgrades.
export const pdfTranslationLayoutSnapshotSchema = z
  .object({
    version: z.literal(1),
    parserVersion: z.string().min(1).max(128),
    fingerprint: z.string().min(1).max(256),
    pages: z
      .array(
        z
          .object({
            width: z.number().positive().max(100000),
            height: z.number().positive().max(100000)
          })
          .strict()
      )
      .min(1)
      .max(500),
    units: z
      .array(
        z
          .object({
            id: z.string().min(1).max(256),
            source: z.string().min(1).max(100000),
            sourceOnly: z.literal(true).optional(),
            fragments: z
              .array(
                z
                  .object({
                    pageNumber,
                    rect: z
                      .object({
                        x: z.number().min(-1e-9).max(1),
                        y: z.number().min(-1e-9).max(1),
                        width: z.number().positive().max(1.000001),
                        height: z.number().positive().max(1.000001)
                      })
                      .strict()
                      .refine((r) => r.x + r.width <= 1.000001 && r.y + r.height <= 1.000001),
                    items: z.array(item).min(1).max(100000)
                  })
                  .strict()
              )
              .min(1)
              .max(10000)
          })
          .strict()
      )
      .min(1)
      .max(100000),
    coverage: z
      .object({
        pageCount: pageNumber,
        textItemCount: count,
        includedItemCount: count,
        excludedItemCount: count,
        pagesWithoutText: z.array(pageNumber).max(500),
        exclusions: z
          .array(
            z
              .object({
                unitId: z.string().max(256).optional(),
                reason: z.enum(['invalid-geometry', 'unsupported-orientation', 'outside-page']),
                items: z.array(item.extend({ pageNumber })).max(100000)
              })
              .strict()
          )
          .max(100000),
        warnings: z
          .array(
            z
              .object({
                unitId: z.string().max(256),
                reasons: z.array(z.string().max(256)).max(100)
              })
              .strict()
          )
          .max(100000)
      })
      .strict()
  })
  .strict()
  .refine(
    (value) => {
      if (
        new TextEncoder().encode(JSON.stringify(value)).byteLength > 32 * 1024 * 1024 ||
        value.coverage.pageCount !== value.pages.length ||
        value.coverage.textItemCount !==
          value.coverage.includedItemCount + value.coverage.excludedItemCount ||
        new Set(value.units.map((unit) => unit.id)).size !== value.units.length
      )
        return false
      const owned = new Set<string>()
      for (const unit of value.units)
        for (const fragment of unit.fragments) {
          if (fragment.pageNumber > value.pages.length) return false
          for (const item of fragment.items) {
            const key = `${fragment.pageNumber}:${item.index}`
            if (owned.has(key)) return false
            owned.add(key)
          }
        }
      if (owned.size !== value.coverage.includedItemCount) return false
      for (const exclusion of value.coverage.exclusions)
        for (const item of exclusion.items) {
          const key = `${item.pageNumber}:${item.index}`
          if (item.pageNumber > value.pages.length || owned.has(key)) return false
          owned.add(key)
        }
      return (
        owned.size === value.coverage.textItemCount &&
        value.coverage.pagesWithoutText.every((page) => page <= value.pages.length)
      )
    },
    { message: 'Invalid PDF layout snapshot ownership or coverage.' }
  )
export type PdfTranslationLayoutSnapshot = z.infer<typeof pdfTranslationLayoutSnapshotSchema>

export function pdfTranslationSnapshotMatchesSources(
  snapshot: PdfTranslationLayoutSnapshot,
  fingerprint: string,
  sources: readonly string[]
): boolean {
  const units = snapshot.units.filter((unit) => !unit.sourceOnly)
  return (
    snapshot.fingerprint === fingerprint &&
    units.length === sources.length &&
    units.every((unit, index) => unit.source === sources[index])
  )
}
