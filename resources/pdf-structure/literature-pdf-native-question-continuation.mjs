/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import {
  tableSourceItems,
  groupSourceRowsWithScripts,
  readSourceRow
} from './literature-pdf-source-records.mjs'
import {
  recoverNativeQuestionRecordGrid,
  recoverMixedQuestionSections,
  questionRecordRuleBands
} from './literature-pdf-long-question-record-grid.mjs'

const heightOf = (items) => items.map((i) => i.height).sort((a, b) => a - b)[items.length >> 1]
const questions = (proof, height) => {
  const cuts = [proof.columns[0][0], ...proof.columns.map((c) => c[2])],
    rows = groupSourceRowsWithScripts(
      [...proof.ownedTokens].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]),
      height,
      0.25
    )
  return rows
    ?.map((row) => /^\d+[.)]/.exec(readSourceRow(row, cuts)?.[0] ?? ''))
    .filter(Boolean)
    .map((m) => Number(/^\d+/.exec(m[0])[0]))
}

// Inherit identity only from an adjacent closed mixed-schema table whose
// qualitative questions continue consecutively in the same native leaf lanes.
// Captions remain original PDF geometry; proof-only copies use render units.
export function recoverNativeQuestionContinuationCaption(
  table,
  items,
  rules,
  pageNumber,
  previousItems,
  previousRules,
  captions
) {
  if (
    table.structure.objects.filter((o) => o.label === 'table column').length !== 3 ||
    captions.some((c) => c.page === pageNumber && captionKind(c.lines[0]) === 'table')
  )
    return
  const priorCaptions = captions.filter(
    (c) => c.page === pageNumber - 1 && captionKind(c.lines[0]) === 'table'
  )
  if (priorCaptions.length !== 1) return
  const height = heightOf(tableSourceItems(items, table.cropRect)),
    previousHeight = heightOf(previousItems.filter((i) => i.horizontal))
  if (!(height > 0) || Math.abs(previousHeight - height) > height * 0.1) return
  const priorBands = questionRecordRuleBands(previousRules, 4, height)
  if (priorBands.length !== 3) return
  const priorTable = {
      cropRect: [
        priorBands[0][0][0],
        priorBands[0][0][1],
        priorBands[0].at(-1)[2],
        priorBands.at(-1)[0][1]
      ]
    },
    scaled = priorCaptions.map((c) => ({ ...c, rect: c.rect.map((v) => v * 1.5) })),
    mixed = recoverMixedQuestionSections(
      [priorTable],
      previousItems,
      scaled,
      previousRules,
      pageNumber - 1
    )
  if (!mixed || mixed.tables.length !== 2) return
  const prior = recoverNativeQuestionRecordGrid(
      mixed.tables[1],
      previousItems,
      scaled,
      previousRules
    ),
    current = recoverNativeQuestionRecordGrid(table, items, [], rules)
  if (
    !prior ||
    !current ||
    prior.columns.length !== 3 ||
    current.columns.length !== 3 ||
    prior.columns.some(
      (c, n) =>
        Math.abs(c[0] - current.columns[n][0]) > height * 0.01 ||
        Math.abs(c[2] - current.columns[n][2]) > height * 0.01
    )
  )
    return
  const before = questions(prior, height),
    after = questions(current, height)
  if (
    before?.length !== 1 ||
    before[0] !== 1 ||
    !after ||
    after.length < 2 ||
    after.some((n, k) => n !== k + 2)
  )
    return
  // A paragraph in the narrow schema gap invalidates the original mixed-table
  // ownership rather than being silently treated as a table title or note.
  const upper = mixed.tables[0].cropRect,
    lower = prior.cropRect
  if (
    previousItems.some(
      (i) =>
        i.horizontal &&
        i.text.trim() &&
        i.rect[0] < upper[2] &&
        i.rect[2] > upper[0] &&
        i.rect[1] < lower[1] &&
        i.rect[3] > upper[3]
    )
  )
    return
  return priorCaptions[0]
}
