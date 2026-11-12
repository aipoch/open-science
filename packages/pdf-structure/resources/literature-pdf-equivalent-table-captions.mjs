/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { associateTableCaptions } from './literature-pdf-association.mjs'

const validRect = (r) =>
  Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
const captionKey = (c) => JSON.stringify([c?.page, c?.rect, c?.lines])

// The caller supplies only original survivors reported by the strict equivalent
// deduplicator. Return metadata plans; never mutate assembly objects or Source.
export function recoverEquivalentTableCaptionPlans(
  page,
  tables,
  equivalentSurvivors,
  candidates,
  rules,
  pages,
  nativeFooter
) {
  if (!page || !(equivalentSurvivors instanceof Set) || !equivalentSurvivors.size) return []
  const current = tables.filter((table) => table.page === page.pageNumber)
  if (
    !current.length ||
    current.some(
      (table) =>
        !validRect(table.cropRect) ||
        table.sourceViewport?.scale !== 1.5 ||
        table.sourceViewport.width !== page.width * 1.5 ||
        table.sourceViewport.height !== page.height * 1.5
    )
  )
    return []
  const associations = associateTableCaptions(
    page,
    current.map((table) => ({ rect: table.cropRect.map((v) => v / 1.5) })),
    candidates,
    rules,
    pages,
    nativeFooter
  )
  const plans = []
  for (const [index, table] of current.entries()) {
    if (
      !equivalentSurvivors.has(table) ||
      table.caption !== undefined ||
      !['shared-table-caption', 'no-adjacent-table-caption'].includes(table.captionIssue)
    )
      continue
    const caption = associations[index]?.caption
    if (
      !caption ||
      !candidates.includes(caption) ||
      caption.page !== page.pageNumber ||
      !validRect(caption.rect) ||
      associations.filter((a) => a.caption && captionKey(a.caption) === captionKey(caption))
        .length !== 1 ||
      current.some(
        (other) =>
          other !== table && other.caption && captionKey(other.caption) === captionKey(caption)
      )
    )
      continue
    plans.push({ table, caption })
  }
  return plans
}
