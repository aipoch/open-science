/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  recoverSegmentedRecordGrid,
  recoverRuledTimeSeriesGrid
} from './literature-pdf-segmented-record-grid.mjs'
import {
  recoverRegressionGrid,
  recoverSectionedCoefficientsGrid
} from './literature-pdf-regression-grid.mjs'
import {
  recoverNativeHeaderGrid,
  recoverClippedHeading,
  recoverCountDistributionGrid,
  recoverRepeatedUnitGrid,
  recoverRepeatedCountSections
} from './literature-pdf-native-header-grid.mjs'
import { recoverNumberedMatrix } from './literature-pdf-numbered-matrix.mjs'
import { recoverWrappedProportionGrid } from './literature-pdf-wrapped-proportion-grid.mjs'
import { recoverRuledNarrativeGrid } from './literature-pdf-ruled-narrative-grid.mjs'
import { recoverRuledEffectGrid } from './literature-pdf-ruled-effect-grid.mjs'
import { recoverDeviationGrid } from './literature-pdf-deviation-grid.mjs'
import { recoverBinaryComparisonGrid } from './literature-pdf-binary-comparison-grid.mjs'
import {
  recoverAlignedNumericGrid,
  recoverPairedDeviationGrid,
  recoverNumberedCaseGrid,
  recoverCodedRecordGrid,
  recoverRuledTimepointGrid,
  recoverAnchoredStubGrid,
  recoverEnrichmentGrid,
  recoverSingleRowContinuation
} from './literature-pdf-aligned-numeric-grid.mjs'
import {
  repairWrappedTableRows,
  repairInlineFragmentRows,
  separateCountedCategoryHeader,
  recoverProjectedSectionRows,
  recoverRepeatedMeasurementSections,
  mergeDuplicateSourceRows,
  removeEmptyOverlappingRows,
  splitRuledParentRow
} from './literature-pdf-table-row-repair.mjs'
import {
  resolveTableCellMerges,
  applySourceHeaderSpans,
  removeOverlappingMergeProposals
} from './literature-pdf-table-cell-merges.mjs'
import { populateTableCellText } from './literature-pdf-table-cell-text.mjs'
import { captionKind } from './literature-pdf-caption-group.mjs'
import { recoverRuledStubGrid, recoverRuledHeaderGrid } from './literature-pdf-ruled-stub-grid.mjs'
import {
  recoverWrappedSummaryGrid,
  recoverRepeatedComparisonGrid,
  recoverCurrencySummaryGrid,
  recoverEstimateIntervalGrid,
  recoverMixedCohortGrid,
  recoverStratifiedIntervalGrid
} from './literature-pdf-wrapped-summary-grid.mjs'
import {
  recoverRecordGrid,
  recoverBaselineComparisonGrid,
  recoverFollowupGrid,
  recoverLongitudinalSummaryGrid,
  recoverResponseScaleGrid,
  recoverThresholdSweepGrid,
  recoverRepeatedIntervalGrid,
  recoverGradedCountGrid,
  recoverTreatmentScheduleGrid,
  recoverCenteredValueGrid
} from './literature-pdf-record-grid.mjs'
import { area, intersection as intersect } from './literature-pdf-page-geometry.mjs'
import { inside, union } from './literature-pdf-table-geometry.mjs'

// Offline table reconstruction. Coordinates are source-page pixels; predictions are crop-relative.
// References: microsoft/table-transformer src/inference.py (cell construction) and postprocess.py.
// This is a bounded implementation, not a port or a production copy-eligibility gate.

export { hasTableEvidence } from './literature-pdf-table-evidence.mjs'

export {
  recoverRuledTable,
  recoverCaptionedRuledTables,
  splitCaptionedTableRegions
} from './literature-pdf-table-regions.mjs'

export function refineTable(table, pageItems, captions = [], notes = [], rules = []) {
  const originalCrop = table.cropRect
  const sourceRules = rules
  // Several aligned dotted leaders can serve as native group underlines.
  // Require separate, substantial segments near the top of a captioned table.
  const dotted = pageItems.filter(
    (i) =>
      i.horizontal &&
      /^(?:[.·]\s*){20,}$/.test(i.text.trim()) &&
      i.rect[0] >= originalCrop[0] &&
      i.rect[2] <= originalCrop[2] &&
      i.rect[1] >= originalCrop[1] &&
      i.rect[1] - originalCrop[1] < 45 &&
      i.rect[2] - i.rect[0] > i.height * 10
  )
  if (
    captions.some((c) => captionKind(c.lines[0]) === 'table') &&
    dotted.length >= 2 &&
    dotted.every((i, n) => !n || Math.abs(i.baseline - dotted[0].baseline) < 1)
  )
    rules = [...rules, ...dotted.map((i) => [i.rect[0], i.baseline, i.rect[2], i.baseline])]
  // PDF strokes can split one continuous underline at column boundaries.
  // Join only touching collinear pieces, allowing coordinate rounding, not gaps.
  const horizontalRules = []
  for (const rule of rules
    .filter((r) => r[1] === r[3])
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    const previous = horizontalRules.at(-1)
    if (previous && Math.abs(previous[1] - rule[1]) < 0.01 && rule[0] <= previous[2] + 0.01) {
      previous[2] = Math.max(previous[2], rule[2])
    } else horizontalRules.push([...rule])
  }
  rules = [...rules.filter((r) => r[1] !== r[3]), ...horizontalRules]
  // An inset table can have a detector edge in the neighboring prose column,
  // or through its own stub. Matching header/footer rules and a footer caption
  // establish ownership independently of that detector edge.
  const modelColumns = table.structure.objects.filter((o) => o.label === 'table column')
  const border = horizontalRules.find((header) => {
    const width = header[2] - header[0]
    return (
      modelColumns.length >= 2 &&
      header[1] >= originalCrop[1] &&
      header[1] <= originalCrop[1] + (originalCrop[3] - originalCrop[1]) * 0.25 &&
      (originalCrop[2] - originalCrop[0]) / width >= 0.85 &&
      (originalCrop[2] - originalCrop[0]) / width <= 1.2 &&
      modelColumns.every(
        (c) =>
          c.rect[0] + originalCrop[0] >= header[0] - 4 &&
          c.rect[2] + originalCrop[0] <= header[2] + 4
      ) &&
      // Do not trim a genuine text run that straddles a proposed side edge.
      // Prose wholly outside the ruled strip is distinct from an overhanging label.
      !pageItems.some(
        (i) =>
          i.rect[1] >= header[1] &&
          i.rect[3] <= originalCrop[3] &&
          i.rect[2] > header[0] &&
          i.rect[0] < header[2] &&
          (i.rect[0] < header[0] - 2 || i.rect[2] > header[2] + 2)
      ) &&
      horizontalRules.some(
        (footer) =>
          footer[1] > originalCrop[3] &&
          footer[1] - originalCrop[3] <= 120 &&
          Math.abs(footer[0] - header[0]) <= 2 &&
          Math.abs(footer[2] - header[2]) <= 2 &&
          captions.some(
            (c) =>
              captionKind(c.lines[0]) === 'table' &&
              c.rect[1] >= footer[1] &&
              c.rect[1] - footer[1] <= 18 &&
              Math.abs(c.rect[0] - footer[0]) <= 6
          )
      )
    )
  })
  if (
    border &&
    pageItems.some(
      (i) =>
        intersect(i.rect, originalCrop) > 0 &&
        intersect(i.rect, originalCrop) / area(i.rect) < 0.999 &&
        (i.rect[0] < originalCrop[0] || i.rect[1] < originalCrop[1] || i.rect[2] > originalCrop[2])
    )
  ) {
    const headings = pageItems.filter(
      (i) =>
        i.horizontal &&
        i.rect[0] >= border[0] &&
        i.rect[2] <= border[2] &&
        i.rect[3] <= border[1] &&
        i.rect[1] >= originalCrop[1] - (i.rect[3] - i.rect[1])
    )
    const cropRect = [
      border[0] - 2,
      Math.min(originalCrop[1], ...headings.map((i) => i.rect[1] - 2)),
      border[2] + 2,
      originalCrop[3]
    ]
    table = {
      ...table,
      cropRect,
      structure: {
        ...table.structure,
        objects: table.structure.objects.map((o) => ({
          ...o,
          rect: o.rect.map((v, i) => v + originalCrop[i % 2] - cropRect[i % 2])
        }))
      }
    }
  }
  // A continued two-column grid may start above the detector crop. Require
  // a label/value pair enclosed by three vertical borders and a shared bottom
  // rule; nearby prose alone cannot extend the table.
  if (modelColumns.length === 2 && table.cropRect === originalCrop) {
    const above = pageItems.filter(
      (i) =>
        i.horizontal &&
        i.rect[0] >= originalCrop[0] &&
        i.rect[2] <= originalCrop[2] &&
        i.rect[3] < originalCrop[1] &&
        originalCrop[1] - i.rect[1] <= i.height * 2
    )
    const split = originalCrop[0] + (modelColumns[0].rect[2] + modelColumns[1].rect[0]) / 2
    const label = above.filter((i) => i.rect[2] < split)
    const value = above.filter((i) => i.rect[0] > split)
    const bottomRule = horizontalRules.find(
      (r) =>
        r[1] > originalCrop[1] &&
        r[1] - originalCrop[1] < 20 &&
        Math.abs(r[0] - originalCrop[0]) < 2 &&
        Math.abs(r[2] - originalCrop[2]) < 2
    )
    if (
      label.length &&
      value.length &&
      bottomRule &&
      /^\p{L}/u.test(label[0].text) &&
      /^\d+(?:\.\d+)?\s*\([\d.]+%\)$/.test(value.map((i) => i.text).join('')) &&
      Math.max(...above.map((i) => i.baseline)) - Math.min(...above.map((i) => i.baseline)) <
        Math.min(...above.map((i) => i.height)) * 0.4 &&
      [originalCrop[0], null, originalCrop[2]].every((x) =>
        rules.some(
          (r) =>
            r[0] === r[2] &&
            (x === null
              ? r[0] > Math.max(...label.map((i) => i.rect[2])) &&
                r[0] < Math.min(...value.map((i) => i.rect[0]))
              : Math.abs(r[0] - x) < 2) &&
            r[1] <= Math.min(...above.map((i) => i.rect[1])) &&
            r[3] >= bottomRule[1]
        )
      )
    ) {
      const cropRect = [...originalCrop]
      cropRect[1] = Math.min(...above.map((i) => i.rect[1])) - 1
      table = {
        ...table,
        cropRect,
        structure: {
          ...table.structure,
          objects: table.structure.objects.map((o) => ({
            ...o,
            rect: o.rect.map((v, i) => v + originalCrop[i % 2] - cropRect[i % 2])
          }))
        }
      }
    }
  }
  const coefficientGrid = recoverSectionedCoefficientsGrid(table, pageItems, rules)
  if (coefficientGrid) {
    const offset = table.cropRect[1] - coefficientGrid.cropRect[1]
    table = {
      ...table,
      cropRect: coefficientGrid.cropRect,
      structure: {
        ...table.structure,
        objects: table.structure.objects.map((o) => ({
          ...o,
          rect: o.rect.map((v, n) => (n % 2 ? v + offset : v))
        }))
      }
    }
  }
  const [left, top, right, bottom] = table.cropRect
  const recordGrid =
    recoverRuledHeaderGrid(table, pageItems, captions, sourceRules) ??
    recoverRuledTimeSeriesGrid(table, pageItems, captions, sourceRules) ??
    recoverCountDistributionGrid(table, pageItems, captions, sourceRules) ??
    coefficientGrid ??
    table.wrappedCountGrid ??
    recoverSegmentedRecordGrid(table, pageItems, sourceRules) ??
    recoverRepeatedCountSections(table, pageItems, captions, rules) ??
    recoverRepeatedUnitGrid(table, pageItems, captions, sourceRules) ??
    recoverNativeHeaderGrid(table, pageItems, captions, sourceRules) ??
    recoverRuledNarrativeGrid(table, pageItems, captions, rules) ??
    recoverNumberedMatrix(table, pageItems, captions, rules) ??
    recoverWrappedProportionGrid(table, pageItems, captions, rules) ??
    recoverPairedDeviationGrid(table, pageItems, captions, rules) ??
    recoverNumberedCaseGrid(table, pageItems, captions, rules) ??
    recoverSingleRowContinuation(table, pageItems, captions, rules) ??
    recoverEnrichmentGrid(table, pageItems, captions) ??
    recoverDeviationGrid(table, pageItems, captions) ??
    recoverRegressionGrid(table, pageItems, captions) ??
    recoverRuledEffectGrid(table, pageItems, captions, rules) ??
    recoverEstimateIntervalGrid(table, pageItems, captions) ??
    recoverMixedCohortGrid(table, pageItems, captions) ??
    recoverStratifiedIntervalGrid(table, pageItems, captions) ??
    recoverBinaryComparisonGrid(table, pageItems, captions) ??
    recoverCodedRecordGrid(table, pageItems, captions, rules) ??
    recoverRuledTimepointGrid(table, pageItems, captions, rules) ??
    recoverAnchoredStubGrid(table, pageItems, captions) ??
    recoverAlignedNumericGrid(table, pageItems, captions, rules) ??
    recoverRepeatedComparisonGrid(table, pageItems, captions) ??
    recoverCurrencySummaryGrid(table, pageItems, captions) ??
    recoverWrappedSummaryGrid(table, pageItems, captions, rules) ??
    recoverBaselineComparisonGrid(table, pageItems, captions) ??
    recoverResponseScaleGrid(table, pageItems, captions, rules) ??
    recoverLongitudinalSummaryGrid(table, pageItems, captions, rules) ??
    recoverFollowupGrid(table, pageItems, captions, rules) ??
    recoverThresholdSweepGrid(table, pageItems) ??
    recoverRecordGrid(table, pageItems, captions, rules)
  const objects = table.structure.objects.map((o) => ({
    ...o,
    rect: o.rect.map((v, i) => v + (i % 2 ? top : left))
  }))
  const issues = new Set(),
    repairs = table.wrappedCountGrid
      ? ['wrapped-count-grid-recovered']
      : table.recoveredGrid
        ? ['closed-numeric-grid-recovered']
        : []
  if (recordGrid?.repair) repairs.push(recordGrid.repair)
  if (table.cropRect !== originalCrop) repairs.push('captioned-rule-crop-recovered')
  const rows = []
  // Remove duplicate row predictions by containment overlap, preserving the higher score.
  for (const row of objects
    .filter((o) => o.label === 'table row')
    .sort((a, b) => (b.score ?? 1) - (a.score ?? 1))) {
    if (
      rows.some((r) => intersect(row.rect, r.rect) / Math.min(area(row.rect), area(r.rect)) > 0.5)
    ) {
      repairs.push('duplicate-row-removed')
    } else rows.push({ ...row, origin: 'model' })
  }
  rows.sort((a, b) => a.rect[1] - b.rect[1])
  const columns = recordGrid
    ? recordGrid.columns.map((rect) => ({ rect }))
    : objects.filter((o) => o.label === 'table column').sort((a, b) => a.rect[0] - b.rect[0])
  for (let i = columns.length - 1; i > 0; i--) {
    if (
      intersect(columns[i].rect, columns[i - 1].rect) /
        Math.min(area(columns[i].rect), area(columns[i - 1].rect)) >
      0.7
    ) {
      const drop = (columns[i].score ?? 1) > (columns[i - 1].score ?? 1) ? i - 1 : i
      columns.splice(drop, 1)
      repairs.push('duplicate-column-removed')
    }
  }
  // A single source header line ending in P can expose a displaced model
  // column (an empty duplicate plus a merged final data/P column). Require
  // complete repeated numeric records under the independently spaced labels.
  if (
    !recordGrid &&
    columns.length >= 4 &&
    captions.some((c) => captionKind(c.lines[0]) === 'table')
  ) {
    const pHeader = pageItems.find(
      (i) =>
        i.horizontal &&
        /^P(?:[- ]?value)?$/i.test(i.text.trim()) &&
        inside(table.cropRect, i) &&
        i.rect[1] < top + (bottom - top) * 0.15
    )
    if (pHeader) {
      const labels = pageItems
        .filter(
          (i) =>
            i.horizontal &&
            inside(table.cropRect, i) &&
            Math.abs(i.baseline - pHeader.baseline) < pHeader.height * 0.3
        )
        .sort((a, b) => a.rect[0] - b.rect[0])
      if (
        labels.length === columns.length &&
        labels.at(-1) === pHeader &&
        labels.every(
          (i, n) =>
            /\p{L}/u.test(i.text) && (!n || i.rect[0] - labels[n - 1].rect[2] > pHeader.height)
        )
      ) {
        const xs = [
          left,
          ...labels.slice(1).map((i, n) => (labels[n].rect[2] + i.rect[0]) / 2),
          right
        ]
        const sourceColumns = xs.slice(1).map((x, c) => [xs[c], top, x, bottom])
        const body = pageItems.filter(
          (i) => i.horizontal && inside(table.cropRect, i) && i.rect[1] > pHeader.rect[3]
        )
        const anchors = body.filter(
          (i) => inside(sourceColumns[1], i) && /^\d+(?:\.\d+)?\s*\(/.test(i.text)
        )
        if (
          anchors.length >= 3 &&
          anchors.every((anchor) =>
            sourceColumns
              .slice(2, -1)
              .every((col) =>
                body.some(
                  (i) =>
                    inside(col, i) &&
                    Math.abs(i.baseline - anchor.baseline) < anchor.height * 0.3 &&
                    /^\d/.test(i.text)
                )
              )
          ) &&
          !body.some((i) => i.rect[0] >= xs[1] && !sourceColumns.some((col) => inside(col, i))) &&
          labels.some((i, n) => !inside([columns[n].rect[0], top, columns[n].rect[2], bottom], i))
        ) {
          columns.splice(0, columns.length, ...sourceColumns.map((rect) => ({ rect })))
          repairs.push('source-comparison-columns-recovered')
        }
      }
    }
  }
  // Captions must be beyond the predicted row bands; padded crops can contain them.
  // A cell that merely starts with "Table 1:" is not excluded.
  const externalCaptions = captions.filter(
    (c) =>
      captionKind(c.lines[0]) === 'table' &&
      rows.length &&
      (c.rect[1] >= rows.at(-1).rect[3] || c.rect[3] <= rows[0].rect[1])
  )
  const excludedCaptionItems = pageItems.filter((item) =>
    externalCaptions.some((c) => intersect(item.rect, c.rect) / area(item.rect) > 0.8)
  )
  const excluded = new Set(excludedCaptionItems)
  // A split continuation marker below the last source row is navigation text.
  // Keep parentheses elsewhere, including lone zeros and incomplete source values.
  for (const marker of pageItems.filter(
    (i) =>
      rows.length &&
      i.horizontal &&
      /^\(?continued(?: on (?:next|following) page)?\)?$/i.test(i.text.trim()) &&
      i.rect[1] >= (recordGrid?.rows.at(-1)?.[3] ?? rows.at(-1).rect[3]) &&
      inside(table.cropRect, i)
  )) {
    excluded.add(marker)
    for (const part of pageItems) {
      if (
        /^[()]$/.test(part.text) &&
        Math.abs(part.baseline - marker.baseline) < marker.height * 0.2 &&
        Math.min(Math.abs(part.rect[2] - marker.rect[0]), Math.abs(part.rect[0] - marker.rect[2])) <
          marker.height
      )
        excluded.add(part)
    }
  }
  // The caller associates notes against recovered table extents before this second pass.
  // For a grid with proved token ownership, use actual glyph extents rather
  // than the bottom rule that a raised footnote font box may slightly overlap.
  const ownedBottom = recordGrid?.ownedTokens?.size
    ? Math.max(...[...recordGrid.ownedTokens].map((item) => item.rect[3]))
    : undefined
  // Only fully external notes may leave the cell source set; ambiguous in-table text stays.
  const externalNotes = notes.filter(
    (note) =>
      rows.length &&
      (note.rect[1] >= (ownedBottom ?? recordGrid?.rows.at(-1)?.[3] ?? rows.at(-1).rect[3]) ||
        note.rect[3] <= (recordGrid?.rows[0]?.[1] ?? rows[0].rect[1]))
  )
  const sourceItems = pageItems.filter(
    (item) =>
      !excluded.has(item) &&
      // Publication watermarks are not cell content, including when they only
      // intersect a padded crop edge. Keep ordinary upright occurrences.
      !(
        !item.horizontal &&
        /^(?:ACCEPTED (?:MANUSCRIPT|ARTICLE)|JOURNAL PRE[- ]PROOF|PROOF)$/i.test(item.text.trim())
      ) &&
      // Some publishers draw dotted horizontal rules as a wide text run.
      // Literal ellipses and single dots used for missing values remain data.
      !(
        item.horizontal &&
        /^(?:[.·]\s*){20,}$/.test(item.text.trim()) &&
        item.rect[2] - item.rect[0] > item.height * 10
      ) &&
      !externalNotes.some((note) => intersect(item.rect, note.rect) / area(item.rect) > 0.8)
  )
  const clipped = sourceItems.filter(
    (item) =>
      intersect(item.rect, table.cropRect) > 0 &&
      intersect(item.rect, table.cropRect) / area(item.rect) < 0.999
  )
  if (clipped.length) issues.add('text-crosses-crop-boundary')
  const items = sourceItems.filter(
    (i) =>
      inside(table.cropRect, i) &&
      !/^\((?:Table\s+\d+\s+continued on next column|continues)\)$/i.test(i.text.trim())
  )
  if (!items.length) issues.add('no-source-text')
  if (!rows.length || !columns.length) issues.add('missing-row-or-column')
  if (items.some((i) => !i.horizontal)) issues.add('unsupported-text-orientation')
  // Recover a collapsed No./% pair only when another pair establishes the
  // header pattern and every source record supports the same empty gutter.
  if (!recordGrid) {
    const headerItems = items.filter(
      (item) =>
        item.horizontal &&
        objects.some(
          (o) =>
            o.label === 'table column header' && inside([left, o.rect[1], right, o.rect[3]], item)
        )
    )
    const pairs = headerItems
      .filter((item) => /^No\.$/i.test(item.text.trim()))
      .flatMap((count) => {
        const percent = headerItems.find(
          (item) =>
            item.text.trim() === '%' &&
            item.rect[0] > count.rect[2] &&
            Math.abs(item.baseline - count.baseline) < count.height * 0.35 &&
            !headerItems.some(
              (other) =>
                other !== count &&
                other !== item &&
                other.rect[0] > count.rect[2] &&
                other.rect[2] < item.rect[0] &&
                Math.abs(other.baseline - count.baseline) < count.height * 0.35
            )
        )
        return percent ? [{ count, percent }] : []
      })
    const boundaries = [
      left,
      ...columns.slice(1).map((c, i) => (columns[i].rect[2] + c.rect[0]) / 2),
      right
    ]
    const sourceColumn = (item) =>
      boundaries.findIndex(
        (x, i) => i < boundaries.length - 1 && inside([x, top, boundaries[i + 1], bottom], item)
      )
    if (pairs.some(({ count, percent }) => sourceColumn(percent) === sourceColumn(count) + 1)) {
      for (const { count, percent } of pairs
        .slice()
        .sort((a, b) => sourceColumn(b.count) - sourceColumn(a.count))) {
        const column = sourceColumn(count)
        if (column < 0 || sourceColumn(percent) !== column) continue
        const split = (count.rect[2] + percent.rect[0]) / 2
        const records = []
        for (const item of items
          .filter(
            (item) =>
              item.horizontal &&
              sourceColumn(item) === column &&
              item.baseline > count.baseline + count.height &&
              item.rect[1] < rows.at(-1)?.rect[3]
          )
          .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
          const record = records.find(
            (group) => Math.abs(group[0].baseline - item.baseline) < item.height * 0.35
          )
          if (record) record.push(item)
          else records.push([item])
        }
        if (
          records.length < 4 ||
          !records.every((group) => {
            if (group.some((item) => item.rect[0] < split && item.rect[2] > split)) return false
            const texts = [
              group.filter((item) => item.rect[2] <= split),
              group.filter((item) => item.rect[0] >= split)
            ].map((part) =>
              part
                .map((item) => item.text)
                .join(' ')
                .trim()
            )
            return /^\d+$/.test(texts[0]) && /^(?:[<≤]\s*)?\d+(?:\.\d+)?%?$/.test(texts[1])
          })
        )
          continue
        const original = columns[column]
        columns.splice(
          column,
          1,
          { ...original, rect: [original.rect[0], original.rect[1], split, original.rect[3]] },
          { ...original, rect: [split, original.rect[1], original.rect[2], original.rect[3]] }
        )
        repairs.push('count-percent-column-recovered')
      }
    }
  }
  const intervalGrid = recoverRepeatedIntervalGrid(table, items, captions, rules)
  const gradedGrid = recoverGradedCountGrid(table, items, captions)
  const scheduleGrid = recoverTreatmentScheduleGrid(table, items, captions)
  const centeredGrid = recoverCenteredValueGrid(table, items, captions, rules)
  const sourceGrid = intervalGrid ?? gradedGrid ?? scheduleGrid ?? centeredGrid
  if (sourceGrid && !recordGrid?.completeSpans)
    columns.splice(0, columns.length, ...sourceGrid.columns)
  // A detached significance marker can be predicted as a whole extra column.
  // Require an empty child header, repeated percentage records to the left,
  // and a shared group underline; a labelled P/statistic column stays separate.
  for (let c = columns.length - 2; c > 1; c--) {
    const bounds = columns.map((column, i) => [
      i ? (columns[i - 1].rect[2] + column.rect[0]) / 2 : left,
      top,
      i + 1 < columns.length ? (column.rect[2] + columns[i + 1].rect[0]) / 2 : right,
      bottom
    ])
    const header = objects.find((o) => o.label === 'table column header')
    if (!header) continue
    const inHeader = (i) => inside([left, header.rect[1], right, header.rect[3]], i)
    if (items.some((i) => inside(bounds[c], i) && inHeader(i))) continue
    const markers = items.filter((i) => inside(bounds[c], i) && i.rect[1] >= header.rect[3])
    const percentages = items.filter((i) => inside(bounds[c - 1], i) && i.rect[1] >= header.rect[3])
    if (
      !markers.length ||
      markers.some((i) => !/^\*{1,3}$/.test(i.text.trim())) ||
      percentages.length < 4 ||
      percentages.some((i) => !/^\(\d+(?:\.\d+)?\)$/.test(i.text.trim())) ||
      !markers.every((i) =>
        percentages.some((p) => Math.abs(i.baseline - p.baseline) <= p.height * 0.4)
      ) ||
      !rules.some(
        (r) =>
          r[1] === r[3] &&
          r[1] <= header.rect[1] &&
          header.rect[1] - r[1] <= 24 &&
          r[0] <= bounds[c - 1][0] &&
          r[2] >= Math.max(...markers.map((i) => i.rect[2])) &&
          r[2] <= bounds[c + 1][0] + 2
      )
    )
      continue
    columns[c - 1].rect[2] = columns[c].rect[2]
    columns.splice(c, 1)
    repairs.push('footnote-only-column-joined')
  }
  // Large column overlaps remain an error, not a choice based on input order.
  for (let i = 1; i < columns.length; i++) {
    const a = columns[i - 1].rect,
      b = columns[i].rect
    if (a[2] - b[0] > Math.min(a[2] - a[0], b[2] - b[0]) * 0.25)
      issues.add('overlapping-predicted-columns')
  }
  const cuts = columns.slice(1).map((c, i) => (columns[i].rect[2] + c.rect[0]) / 2)
  const columnRects = columns.map((_, i) => [
    i ? cuts[i - 1] : left,
    top,
    i < cuts.length ? cuts[i] : right,
    bottom
  ])
  const columnOf = (item) => columnRects.findIndex((c) => inside(c, item))
  // Compact frequency tables may have only a count heading over the value
  // column. Its wrapped lines sit above the first predicted data row.
  if (columns.length === 2 && rows.length >= 4) {
    const heading = items
      .filter((i) => i.horizontal && columnOf(i) === 1 && i.rect[3] < rows[0].rect[1])
      .sort((a, b) => a.baseline - b.baseline)
    const body = items.filter((i) => columnOf(i) === 1 && i.rect[1] >= rows[0].rect[1])
    if (
      heading.length >= 1 &&
      heading.length <= 3 &&
      /^Number of (?:patients|subjects|cases|participants|studies)$/i.test(
        heading.map((i) => i.text.trim()).join(' ')
      ) &&
      body.length >= 4 &&
      body.every((i) => /^\d+\s*\(\d+(?:\.\d+)?%\)$/.test(i.text.trim())) &&
      rows[0].rect[1] - heading[0].rect[1] <= heading[0].height * 4 &&
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[1] >= heading.at(-1).rect[3] &&
          r[1] <= rows[0].rect[1] &&
          r[0] <= columns[0].rect[0] + 2 &&
          r[2] >= columns[1].rect[2] - 2
      )
    ) {
      rows.unshift({
        rect: [left, heading[0].rect[1], right, heading.at(-1).rect[3]],
        origin: 'source-text'
      })
      repairs.push('count-heading-recovered')
    }
  }
  const groups = []
  for (const item of items
    .filter((i) => i.horizontal)
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const group = groups.find(
      (g) => Math.abs(g[0].baseline - item.baseline) <= Math.max(g[0].height, item.height) * 0.35
    )
    if (group) group.push(item)
    else groups.push([item])
  }
  if (!recordGrid && externalCaptions.length)
    recoverClippedHeading({ rows, objects, groups, columnRects, rules, repairs })
  // A wrapped header can start above every model row. Recover its leading
  // line only when the following header text supplies explicit ownership:
  // a confidence level or a parent title aligned with its sample size.
  if (!recordGrid && rows.length && externalCaptions.length && groups[0]?.length) {
    const leading = groups[0]
    const rect = union(leading)
    const height = Math.max(...leading.map((item) => item.height))
    const next = groups[1] ?? []
    const confidencePrefix =
      leading.length === 1 &&
      /^(?:90|95|99)%$/.test(leading[0].text.trim()) &&
      next.some(
        (item) =>
          /^confidence$/i.test(item.text.trim()) &&
          Math.abs(item.rect[0] - rect[0]) < 1 &&
          item.baseline - leading[0].baseline < height * 1.5
      )
    const parentTitle =
      leading.length === 1 &&
      /\p{L}/u.test(leading[0].text) &&
      objects.some(
        (object) =>
          object.label === 'table spanning cell' &&
          object.rect[0] <= rect[0] &&
          object.rect[2] >= rect[2] &&
          inside(rows[0].rect, { rect: object.rect }) &&
          /^\([Nn]\s*=\s*\d+\)$/.test(
            items
              .filter((item) => inside(object.rect, item))
              .sort((a, b) => a.rect[0] - b.rect[0])
              .map((item) => item.text)
              .join('')
          ) &&
          items.some((item) => inside(object.rect, item) && Math.abs(item.rect[0] - rect[0]) < 1)
      )
    if (
      (confidencePrefix || parentTitle) &&
      rect[3] < rows[0].rect[1] &&
      rows[0].rect[1] - rect[1] < height * 1.6 &&
      objects.some(
        (object) => object.label === 'table column header' && inside(object.rect, next[0])
      ) &&
      !rules.some(
        (rule) =>
          rule[1] === rule[3] &&
          rule[1] > rect[3] &&
          rule[1] < rows[0].rect[1] &&
          rule[0] <= rect[0] &&
          rule[2] >= rect[2]
      )
    ) {
      rows[0].rect[1] = rect[1]
      repairs.push('leading-header-line-recovered')
    }
  }
  const bracketHeaders = []
  // A first-row prediction can start inside the ascenders of a real header.
  // Extend only across one shared text baseline occupying multiple columns.
  if (!recordGrid && rows.length && externalCaptions.length && groups[0]?.length) {
    const heading = groups[0],
      rect = union(heading)
    const height = Math.max(...heading.map((i) => i.height))
    const headerColumns = new Set(heading.map(columnOf).filter((c) => c >= 0))
    if (
      rect[1] < rows[0].rect[1] &&
      rect[3] > rows[0].rect[1] &&
      rows[0].rect[1] - rect[1] < height &&
      headerColumns.size >= 2 &&
      heading.every(
        (i) =>
          /\p{L}/u.test(i.text) &&
          columnRects[columnOf(i)] &&
          i.rect[0] >= columnRects[columnOf(i)][0] - 1 &&
          i.rect[2] <= columnRects[columnOf(i)][2] + 1
      )
    ) {
      rows[0].rect[1] = rect[1]
      repairs.push('clipped-first-header-recovered')
    } else if (
      heading.length === 1 &&
      columnOf(heading[0]) === 0 &&
      /^(?:Characteristic|Characteristics|Variable|Variables|Outcome|Outcomes)$/i.test(
        heading[0].text
      ) &&
      rect[3] < rows[0].rect[1] &&
      rows[0].rect[1] - rect[3] < height * 1.5 &&
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[1] <= rect[1] &&
          rect[1] - r[1] < height &&
          r[0] <= left + 4 &&
          r[2] >= right - 4
      ) &&
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[1] > rect[3] &&
          r[1] < rows[0].rect[1] &&
          r[0] <= rect[0] &&
          r[2] >= rect[2]
      )
    ) {
      rows.unshift({ rect: [left, rect[1], right, rect[3]], origin: 'source-native-header' })
      repairs.push('ruled-stub-header-recovered')
    } else if (
      rect[3] < rows[0].rect[1] &&
      rows[0].rect[1] - rect[3] < height * 2 &&
      heading.some((i) => /(?:\([Nn]|\b\d+-year\b)/.test(i.text)) &&
      (heading.some((i) => /\b\d+-year\b/.test(i.text)) ||
        (heading.some(
          (i) => columnOf(i) === 0 && /^(?:Characteristics?|Variables?|Outcomes?)$/i.test(i.text)
        ) &&
          heading.filter((i) => /\([Nn]/.test(i.text)).length === columns.length - 1) ||
        rules.some(
          (r) =>
            r[1] === r[3] &&
            r[1] >= rect[3] &&
            r[1] <= rows[0].rect[1] + 1 &&
            r[2] - r[0] < (right - left) * 0.8 &&
            heading.some(
              (i) => /\([Nn]/.test(i.text) && r[0] <= i.rect[0] + 1 && r[2] >= i.rect[2] - 1
            )
        )) &&
      heading.every((i) =>
        rules.some(
          (r) =>
            r[1] === r[3] &&
            r[1] >= rect[3] &&
            r[1] <= rows[0].rect[1] + 1 &&
            r[0] <= i.rect[0] + 1 &&
            r[2] >= i.rect[2] - 1
        )
      )
    ) {
      rows.unshift({ rect: [left, rect[1], right, rect[3]], origin: 'source-native-header' })
      repairs.push('ruled-statistical-header-recovered')
      bracketHeaders.push(
        ...rules.filter(
          (r) =>
            r[1] === r[3] &&
            r[1] >= rect[3] &&
            r[1] <= rows[1].rect[1] + 1 &&
            r[2] - r[0] < (right - left) * 0.8 &&
            heading.some((i) => r[0] <= i.rect[0] + 1 && r[2] >= i.rect[2] - 1)
        )
      )
    }
  }
  if (
    !bracketHeaders.length &&
    rows.length &&
    captions.length &&
    groups[0]?.length >= 2 &&
    groups[0].every(
      (i) =>
        /\p{L}/u.test(i.text) &&
        i.rect[3] < rows[0].rect[1] &&
        rows[0].rect[1] - i.rect[3] < i.height * 2
    )
  ) {
    for (const item of groups[0]) {
      const frame = rules.find(
        (r) =>
          r[1] === r[3] &&
          Math.abs(r[1] - item.rect[1]) <= 2 &&
          r[0] < item.rect[0] &&
          r[2] > item.rect[2] &&
          [r[0], r[2]].every((x) =>
            rules.some(
              (v) =>
                v[0] === v[2] &&
                Math.abs(v[0] - x) < 1 &&
                v[1] <= item.rect[1] + 1 &&
                v[3] >= item.rect[1] + item.height * 0.6
            )
          )
      )
      if (frame) bracketHeaders.push(frame)
    }
    if (
      bracketHeaders.length === groups[0].length &&
      bracketHeaders.every((r, i) => !i || r[0] > bracketHeaders[i - 1][2])
    ) {
      rows.unshift({
        rect: [left, union(groups[0])[1], right, union(groups[0])[3]],
        origin: 'source-header'
      })
      repairs.push('bracketed-parent-header-recovered')
    } else bracketHeaders.splice(0)
  }
  // A detected table can have columns but no predicted rows. Recover only a
  // captioned, enclosed header followed by complete labelled numeric records.
  if (!rows.length && columns.length >= 3 && columns.length <= 8) {
    const numericRecord = (group) =>
      group.some((item) => columnOf(item) === 0 && /\p{L}/u.test(item.text)) &&
      columnRects.slice(1).every((_, column) =>
        /^[<>≤≥−+-]?\d[\d\s.,()%±*–−+\-/]*$/.test(
          group
            .filter((item) => columnOf(item) === column + 1)
            .sort((a, b) => a.rect[0] - b.rect[0])
            .map((item) => item.text)
            .join(' ')
            .trim()
        )
      )
    const first = groups.findIndex(numericRecord)
    const header = groups.slice(0, first).flat()
    const records = []
    let complete = first > 0
    for (const group of groups.slice(first)) {
      if (numericRecord(group)) records.push([...group])
      else if (
        records.length &&
        group.every((item) => columnOf(item) === 0 && /^\p{L}/u.test(item.text)) &&
        union(group)[1] >= union(records.at(-1))[3] &&
        group[0].baseline - records.at(-1).at(-1).baseline <= group[0].height * 1.7
      )
        records.at(-1).push(...group)
      else complete = false
    }
    const bounds = union(items)
    const outerRule = (y0, y1) =>
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[1] >= y0 &&
          r[1] <= y1 &&
          Math.min(right, r[2]) - Math.max(left, r[0]) >= (right - left) * 0.9
      )
    if (
      complete &&
      records.length >= 2 &&
      header.length &&
      new Set(header.map(columnOf).filter((column) => column > 0)).size === columns.length - 1 &&
      header.every((item) => /\p{L}/u.test(item.text)) &&
      captions.some(
        (caption) =>
          captionKind(caption.lines[0]) === 'table' &&
          caption.rect[3] <= top &&
          top - caption.rect[3] < 40 &&
          Math.min(right, caption.rect[2]) - Math.max(left, caption.rect[0]) > (right - left) * 0.7
      ) &&
      outerRule(top - 2, bounds[1]) &&
      outerRule(bounds[3], bottom + 2)
    ) {
      const bands = [header, ...records]
      rows.push(
        ...bands.map((band) => ({
          rect: [left, union(band)[1], right, union(band)[3]],
          origin: 'source-text'
        }))
      )
      issues.delete('missing-row-or-column')
      repairs.push('missing-numeric-row-bands-recovered')
    }
  }
  // A model data row may start slightly above the header underline. Without
  // respecting that rule, the preceding text header is absorbed into record one.
  if (
    !recordGrid &&
    rows.length >= 2 &&
    columns.length >= 2 &&
    externalCaptions.length &&
    !objects.some((o) => o.label === 'table column header')
  ) {
    const separator = rules.find((r) => {
      if (
        r[1] !== r[3] ||
        Math.min(right, r[2]) - Math.max(left, r[0]) < (right - left) * 0.9 ||
        r[1] < rows[0].rect[1] ||
        r[1] > rows[0].rect[1] + 3
      )
        return false
      const heading = items.filter((i) => i.horizontal && i.rect[3] <= r[1])
      return (
        heading.length &&
        heading.every((i) => /\p{L}/u.test(i.text)) &&
        new Set(heading.map(columnOf)).size === columns.length &&
        r[1] - Math.min(...heading.map((i) => i.rect[1])) <
          Math.max(...heading.map((i) => i.height)) * 4 &&
        rules.some(
          (above) =>
            above[1] === above[3] &&
            above[1] <= union(heading)[1] &&
            above[1] >= top - 2 &&
            Math.abs(above[0] - r[0]) < 2 &&
            Math.abs(above[2] - r[2]) < 2
        )
      )
    })
    if (separator) {
      const heading = items.filter((i) => i.horizontal && i.rect[3] <= separator[1])
      rows[0].rect[1] = separator[1]
      rows.unshift({ rect: [left, union(heading)[1], right, separator[1]], origin: 'source-text' })
      repairs.push('ruled-text-header-recovered')
    }
  }
  let pairedRows
  let recoveredHeaderCuts
  let recoveredIntervalParent = false
  let recoveredNumericSections = false
  let recoveredComparisonStatistics = false
  if (!recordGrid) {
    // A full-width ruled band before the column headings is a table title.
    // Require its own two borders and an external table caption; a lone stub
    // label or prose above an uncaptioned grid is not sufficient.
    const title = groups.find((group) => {
      if (!rows.length || columns.length < 3 || !externalCaptions.length) return false
      const rect = union(group),
        height = Math.max(...group.map((i) => i.height))
      const fullRule = (from, to) =>
        rules.some(
          (r) =>
            r[1] === r[3] &&
            r[1] >= from &&
            r[1] <= to &&
            Math.min(right, r[2]) - Math.max(left, r[0]) >= (right - left) * 0.9
        )
      return (
        group.every((i) => columnOf(i) === 0 && /^[\p{L}\s–-]+$/u.test(i.text)) &&
        rect[3] < rows[0].rect[1] &&
        rows[0].rect[1] - rect[3] < height * 2 &&
        fullRule(Math.max(top, rect[1] - height), rect[1]) &&
        fullRule(rect[3], rows[0].rect[1]) &&
        new Set(
          items.filter((i) => inside(rows[0].rect, i) && /^\p{L}/u.test(i.text)).map(columnOf)
        ).size >= 3
      )
    })
    if (title) {
      const rect = union(title)
      rows.unshift({ rect: [left, rect[1], right, rect[3]], origin: 'ruled-table-title' })
      repairs.push('ruled-table-title-recovered')
    }
    const numericGroup = (group, minimumValues = 2) => {
      const values = columnRects
        .slice(1)
        .map((_, column) =>
          group
            .filter((item) => columnOf(item) === column + 1)
            .map((item) => item.text)
            .join(' ')
            .trim()
        )
        .filter(Boolean)
      // Counts with percentages and significance/interval entries are records too.
      // Require two populated value columns and at least one actual number.
      return (
        values.length >= minimumValues &&
        values.some((text) => /\d/.test(text)) &&
        values.every((text) =>
          /^(?:NS|[–—−…-]|[<>≤≥−+-]?(?:\d|\.\d)[\d.,]*(?:\s*±\s*\d[\d.,]*)?(?:\s*\([\d.,/\s–−+%-]+\))?)$/i.test(
            text
          )
        )
      )
    }
    const sectionMarker = (item, group) =>
      /^[a-z*†‡]$/.test(item.text) &&
      group.some(
        (anchor) =>
          columnOf(anchor) === 0 &&
          anchor.text.length > 5 &&
          item.height < anchor.height * 0.8 &&
          anchor.baseline - item.baseline > anchor.height * 0.08 &&
          anchor.baseline - item.baseline < anchor.height * 0.5 &&
          Math.abs(item.rect[0] - anchor.rect[2]) <= anchor.height * 0.2
      )
    for (const group of [...groups]) {
      if (group.length !== 1 || !/^[a-z*†‡]$/.test(group[0].text)) continue
      const owner = groups.find(
        (g) =>
          g !== group &&
          sectionMarker(group[0], g) &&
          objects.some(
            (o) =>
              o.label === 'table projected row header' &&
              intersect(o.rect, union(g)) / area(union(g)) > 0.8
          )
      )
      if (owner) {
        owner.push(...group)
        groups.splice(groups.indexOf(group), 1)
      }
    }
    const sectionGroup = (group) =>
      group.every((item) => columnOf(item) === 0 || sectionMarker(item, group)) &&
      /^[\p{L}\s(),]+$/u.test(group.map((item) => item.text).join(' ')) &&
      group
        .map((item) => item.text)
        .join(' ')
        .split(/\s+/).length <= 4
    const groupedNumericTable =
      columns.length >= 4 &&
      groups.filter((group) => numericGroup(group)).length >= 6 &&
      groups.filter(
        (group, index) =>
          sectionGroup(group.filter((item) => columnOf(item) === 0)) &&
          group.every(
            (item) =>
              columnOf(item) === 0 ||
              (columnOf(item) === columns.length - 1 &&
                /^(?:NS|[<>≤≥]?\s*0?\.\d+)$/i.test(item.text.trim()))
          ) &&
          numericGroup(groups[index + 1] ?? [])
      ).length >= 3
    // A blank stub cell is common in treatment-group headers. The detector can
    // start at the first data row; recover the entire ruled header band, including
    // wrapped sample sizes, rather than requiring text in that empty stub.
    const leading = items.filter(
      (item) => item.horizontal && (item.rect[1] + item.rect[3]) / 2 < rows[0]?.rect[1]
    )
    if (leading.length && columns.length >= 3) {
      const bounds = union(leading)
      const runs = []
      for (const i of leading
        .filter((i) => Math.abs(i.baseline - leading[0].baseline) < i.height * 0.4)
        .sort((a, b) => a.rect[0] - b.rect[0])) {
        const last = runs.at(-1)
        if (last && i.rect[0] - last.at(-1).rect[2] < i.height * 0.7) last.push(i)
        else runs.push([i])
      }
      const completeRuns =
        runs.length === columns.length - 1 && runs.every((run) => /^\p{L}/u.test(run[0].text))
      const firstBand = items.filter((i) => inside(rows[0].rect, i))
      // Percentage-prefixed interval labels are headings, not numeric records.
      // Require two populated child columns under the label and model header evidence.
      const intervalParent =
        objects.some(
          (o) =>
            o.label === 'table column header' &&
            (intersect(o.rect, rows[0].rect) > 0 || intersect(o.rect, bounds) > 0)
        ) &&
        runs.every((run) =>
          /^(?:\p{L}|\d+(?:\.\d+)?%\s*CI\b)/u.test(run.map((i) => i.text).join(' '))
        ) &&
        runs.some((run) => {
          if (!/^\d+(?:\.\d+)?%\s*CI\b/.test(run.map((i) => i.text).join(' '))) return false
          const textRect = union(run)
          // A short centered parent can be narrower than both child labels.
          // Its source underline establishes the actual group width.
          const underline = sourceRules.find(
            (r) =>
              r[1] === r[3] &&
              r[1] >= textRect[3] &&
              r[1] <= rows[0].rect[1] &&
              r[0] <= textRect[0] &&
              r[2] >= textRect[2] &&
              r[2] - r[0] < (right - left) * 0.6
          )
          const rect = underline ?? textRect
          return (
            new Set(
              firstBand
                .filter(
                  (i) =>
                    /^\p{L}/u.test(i.text) &&
                    i.rect[0] >= rect[0] - i.height &&
                    i.rect[2] <= rect[2] + i.height
                )
                .map(columnOf)
            ).size >= 2
          )
        })
      // A lone parent or the first line of a wrapped parent can sit above all
      // predicted rows. Its own underline and model header evidence distinguish
      // it from prose or an uncaptured data record.
      const singleRuledHeading =
        runs.length === 1 &&
        /^\p{L}/u.test(runs[0][0].text) &&
        objects.some(
          (o) => o.label === 'table column header' && intersect(o.rect, rows[0].rect) > 0
        ) &&
        sourceRules.find((rule) => {
          if (
            rule[1] !== rule[3] ||
            rule[1] < bounds[3] ||
            rule[1] > rows[0].rect[3] ||
            rule[0] > bounds[0] + 1 ||
            rule[2] < bounds[2] - 1 ||
            rule[2] - rule[0] >= (right - left) * 0.8
          )
            return false
          const children = firstBand.filter(
            (i) => i.rect[0] >= rule[0] - 1 && i.rect[2] <= rule[2] + 1
          )
          return (
            children.length &&
            (new Set(children.map(columnOf)).size >= 2 ||
              (children.some((i) => Math.abs(i.rect[0] - bounds[0]) <= i.height * 0.3) &&
                objects.some(
                  (o) =>
                    o.label === 'table spanning cell' &&
                    inside(o.rect, children[0]) &&
                    columnRects.filter((c) => intersect(c, o.rect) / area(o.rect) > 0.2).length >= 2
                )))
          )
        })
      const separateRuledHeading =
        singleRuledHeading &&
        singleRuledHeading[1] <= Math.min(...firstBand.map((i) => i.rect[1])) + 1
      const sparseParent =
        runs.length >= 2 &&
        runs.every((run) => /^\p{L}/u.test(run[0].text)) &&
        firstBand.length &&
        firstBand.every(
          (i) =>
            !/^\d/.test(i.text.trim()) ||
            /\)/.test(i.text) ||
            (/^\d+%$/.test(i.text.trim()) &&
              firstBand.some(
                (other) =>
                  other.text.trim() === 'CI' &&
                  Math.abs(other.baseline - i.baseline) < i.height * 0.35 &&
                  other.rect[0] >= i.rect[2] &&
                  other.rect[0] - i.rect[2] < i.height * 0.5
              ))
        ) &&
        new Set(firstBand.filter((i) => /\p{L}/u.test(i.text)).map(columnOf)).size >= 2
      const headerColumns = columnRects.filter((_, c) => {
        const first = leading
          .filter((i) => columnOf(i) === c)
          .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])[0]
        return first && /^\p{L}/u.test(first.text)
      })
      const ruled = (y0, y1) =>
        rules
          .filter((r) => r[1] === r[3] && r[1] >= y0 && r[1] <= y1)
          .some(
            (r) =>
              rules
                .filter((s) => s[1] === s[3] && Math.abs(s[1] - r[1]) < 1)
                .reduce(
                  (sum, s) => sum + Math.max(0, Math.min(right, s[2]) - Math.max(left, s[0])),
                  0
                ) >=
              (right - left) * 0.9
          )
      // A displaced header prediction may start below all wrapped header text.
      // Its lower rule can sit inside the empty predicted band, rather than
      // above it. Require every column, model-header support and no owned data.
      const displacedEmptyHeader =
        headerColumns.length === columns.length &&
        firstBand.length === 0 &&
        objects.some(
          (o) =>
            o.label === 'table column header' &&
            intersect(o.rect, rows[0].rect) / area(rows[0].rect) > 0.5
        ) &&
        ruled(bounds[3], rows[0].rect[3])
      // A fully ruled regression header can be absent from all model rows.
      // Its interval heading owns two numeric columns, leaving an empty stub.
      const ruledInterval =
        runs.length >= 3 &&
        runs.length === columns.length - 2 &&
        runs.every((run) => /^(?:\p{L}|\d+%\s*CI\b)/u.test(run.map((i) => i.text).join(' '))) &&
        runs.some((run) => /^\d+%\s*CI\b/.test(run.map((i) => i.text).join(' '))) &&
        columnRects.slice(1).every((_, c) =>
          /^[−-]?\d+(?:\.\d+)?$/.test(
            firstBand
              .filter((i) => columnOf(i) === c + 1)
              .map((i) => i.text)
              .join('')
              .trim()
          )
        ) &&
        new Set(firstBand.map(columnOf)).size === columns.length &&
        ruled(top - 2, bounds[1]) &&
        ruled(bounds[3], rows[0].rect[1] + 2)
      if (
        (headerColumns.length >= columns.length - 1 ||
          ruledInterval ||
          completeRuns ||
          sparseParent ||
          singleRuledHeading ||
          intervalParent) &&
        bounds[3] - bounds[1] <= Math.max(...leading.map((i) => i.height)) * 4 &&
        ((ruled(top - 2, bounds[1]) &&
          (ruled(bounds[3], rows[0].rect[1] + 2) || displacedEmptyHeader)) ||
          (externalCaptions.length > 0 &&
            bounds[1] - top < Math.max(...leading.map((i) => i.height)) * 2 &&
            rows[0].rect[1] - bounds[3] < Math.max(...leading.map((i) => i.height)) * 2))
      ) {
        const firstItems = items.filter((i) => inside(rows[0].rect, i))
        if (
          !intervalParent &&
          !separateRuledHeading &&
          (firstItems.every((i) => columnOf(i) > 0 && /^(?:[()\dnN=¼§\s.,]|Group)/.test(i.text)) ||
            columnRects.filter((_, column) => {
              if (column === 0) return false
              const columnItems = firstItems
                .filter((i) => columnOf(i) === column)
                .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
              const text = columnItems
                .map((i) => i.text)
                .join(' ')
                .trim()
              // Statistical P values are data even though their first token is a letter.
              return (
                columnItems.some((i) => /^\p{L}/u.test(i.text)) &&
                !/^P\s*(?:[<=>≤≥]|ns\b)/i.test(text)
              )
            }).length >= 2) &&
          !rules.some(
            (r) =>
              r[1] === r[3] &&
              r[1] > bounds[3] &&
              r[1] < rows[0].rect[1] + (firstBand.some((i) => /^\d+%$/.test(i.text.trim())) ? 1 : 0)
          )
        )
          rows[0].rect[1] = bounds[1]
        else
          rows.unshift({
            rect: [left, bounds[1], right, bounds[3]],
            origin: ruledInterval ? 'source-ruled-interval-header' : 'source-text'
          })
        recoveredIntervalParent = intervalParent
        repairs.push('treatment-header-recovered')
        if (completeRuns)
          recoveredHeaderCuts = cuts.map((cut, index) => {
            const run = runs.find((r) => r[0].rect[0] < cut && r.at(-1).rect[2] > cut)
            if (!run) return cut
            // There is one run per value column and a blank stub. Boundary i
            // precedes run i; moving it after that run shifts its whole label
            // into the preceding cell and can even invert the next cell.
            return index
              ? (runs[index - 1].at(-1).rect[2] + runs[index][0].rect[0]) / 2
              : Math.min(cut, runs[0][0].rect[0])
          })
      }
    }
    repairInlineFragmentRows({ rows, groups, items, left, right, repairs })
    for (const group of groups) {
      rows.sort((a, b) => a.rect[1] - b.rect[1])
      if (group.every((item) => /^\([−-]?\d.*[–−-].*\)$/.test(item.text.trim()))) continue
      if (
        !rows.length ||
        !columns.length ||
        group.some(
          (item) =>
            !sectionMarker(item, group) &&
            item.height >= Math.max(...group.map((i) => i.height)) * 0.8 &&
            rows.some((r) => inside([left, r.rect[1], right, r.rect[3]], item))
        )
      )
        continue
      const cols = new Set(group.map(columnOf).filter((c) => c >= 0))
      const rect = union(group)
      // Repeated subrow labels plus complete numeric values can establish a
      // final record even when the detector cropped off the closing rule.
      const finalSubrecord =
        rect[1] >= rows[0].rect[3] &&
        !cols.has(0) &&
        cols.has(1) &&
        columns.length >= 4 &&
        columnRects.slice(2).every((_, c) =>
          /^[<>≤≥−+-]?\d[\d\s.,()%±*–−+\-/]*$/.test(
            group
              .filter((i) => columnOf(i) === c + 2)
              .map((i) => i.text)
              .join(' ')
              .trim()
          )
        ) &&
        group
          .filter((i) => columnOf(i) === 1)
          .every(
            (label) =>
              /^\p{L}/u.test(label.text) &&
              items.filter(
                (i) => columnOf(i) === 1 && i.text === label.text && i.baseline < label.baseline
              ).length >= 3
          )
      const parentHeader =
        cols.size >= 1 &&
        group.every((item) => /^\p{L}/u.test(item.text)) &&
        rect[3] < rows[0].rect[1] &&
        rows[0].rect[1] - rect[3] <= Math.max(...group.map((i) => i.height)) * 2 &&
        objects.some(
          (o) => o.label === 'table column header' && intersect(o.rect, rows[0].rect) > 0
        ) &&
        rules.some(
          (r) =>
            r[1] === r[3] &&
            r[1] > rect[3] &&
            r[1] < rows[0].rect[1] &&
            group.some((item) => item.rect[0] >= r[0] - 1 && item.rect[2] <= r[2] + 1)
        )
      const statisticLabel = (g) =>
        /^[A-Z][A-Z\d]{1,6}\s*\([a-z\s]+\)$/.test(
          g
            .filter((i) => columnOf(i) === 0)
            .map((i) => i.text)
            .join(' ')
        )
      const prior = groups[groups.indexOf(group) - 1] ?? []
      const finalStatistic =
        columns.length >= 7 &&
        statisticLabel(group) &&
        statisticLabel(prior) &&
        group.filter((i) => columnOf(i) > 0).length >= 3 &&
        group.filter((i) => columnOf(i) > 0).every((i) => /^\d+\.\d+$/.test(i.text.trim())) &&
        JSON.stringify(group.map(columnOf)) === JSON.stringify(prior.map(columnOf)) &&
        rect[1] >= union(prior)[3] &&
        rect[1] - union(prior)[3] <= group[0].height &&
        rules.some(
          (r) =>
            r[1] === r[3] &&
            r[1] >= rect[3] &&
            r[1] - rect[3] <= group[0].height * 2 &&
            Math.min(right, r[2]) - Math.max(left, r[0]) >= (right - left) * 0.9
        )
      const denseSubrecord =
        columns.length >= 8 &&
        cols.has(2) &&
        group.some((i) => columnOf(i) === 2 && /\p{L}/u.test(i.text)) &&
        new Set(group.filter((i) => columnOf(i) >= 3 && /^\d+$/.test(i.text.trim())).map(columnOf))
          .size ===
          columns.length - 3
      // Lettered sections may repeat the same questionnaire records. Require
      // the preceding letter, aligned stub, and a repeated numeric record below
      // before separating a title from overlapping model row edges.
      const nextGroup =
        groups
          .slice(groups.indexOf(group) + 1)
          .find(
            (g) =>
              !g.every(
                (item) => /^[a-z*†‡]$/.test(item.text) && item.height < group[0].height * 0.8
              )
          ) ?? []
      const stubText = (g) =>
        g
          .filter((item) => columnOf(item) === 0)
          .map((item) => item.text)
          .join(' ')
      const numberedSection =
        columns.length >= 4 &&
        group.length === 1 &&
        nextGroup.length > 0 &&
        nextGroup[0].baseline - group[0].baseline < group[0].height * 2 &&
        columnOf(group[0]) === 0 &&
        /^[b-z]\. [\p{L} -]{3,60}$/u.test(group[0].text) &&
        groups.some(
          (g) =>
            g[0].baseline < group[0].baseline &&
            g.some(
              (item) =>
                item.text.startsWith(String.fromCharCode(group[0].text.charCodeAt(0) - 1) + '. ') &&
                Math.abs(item.rect[0] - group[0].rect[0]) < group[0].height * 0.2
            )
        ) &&
        new Set(
          nextGroup.filter((item) => columnOf(item) > 0 && /^\d/.test(item.text)).map(columnOf)
        ).size >= 2 &&
        nextGroup.some(
          (item) => columnOf(item) === 0 && item.rect[0] - group[0].rect[0] > group[0].height * 0.5
        ) &&
        groups.some((g) => g[0].baseline < group[0].baseline && stubText(g) === stubText(nextGroup))
      // A continued table may end with a category label and its P value.
      // Repeated category rows, a named P column and the closing source rule
      // establish this sparse record without extending into footnotes.
      const terminalSectionStatistic =
        rows.length >= 2 &&
        groupedNumericTable &&
        sectionGroup(group.filter((item) => columnOf(item) === 0)) &&
        group.some(
          (item) => columnOf(item) === columns.length - 1 && /^0?\.\d+$/.test(item.text)
        ) &&
        group.every((item) => columnOf(item) === 0 || columnOf(item) === columns.length - 1) &&
        items.some(
          (item) =>
            columnOf(item) === columns.length - 1 &&
            item.text === 'P' &&
            item.rect[3] < rows[1].rect[1]
        ) &&
        rect[1] >= rows.at(-1).rect[3] &&
        rect[1] - rows.at(-1).rect[3] <= group[0].height * 2 &&
        rules.some(
          (rule) =>
            rule[1] === rule[3] &&
            rule[1] >= rect[3] &&
            rule[1] - rect[3] <= group[0].height * 2 &&
            Math.min(right, rule[2]) - Math.max(left, rule[0]) >= (right - left) * 0.9
        )
      const projectedSection =
        columns.length >= 4 &&
        sectionGroup(group) &&
        objects.some(
          (o) =>
            o.label === 'table projected row header' && intersect(o.rect, rect) / area(rect) > 0.8
        ) &&
        [-1, 1].every((offset) =>
          numericGroup(
            (groups[groups.indexOf(group) + offset] ?? []).filter(
              (i) => columnOf(i) < columns.length - 1
            )
          )
        )
      if (
        (cols.size < Math.max(2, Math.ceil(columns.length / 2)) &&
          !parentHeader &&
          !finalStatistic &&
          !projectedSection &&
          !numberedSection &&
          !terminalSectionStatistic &&
          !(
            groupedNumericTable &&
            sectionGroup(group) &&
            numericGroup(groups[groups.indexOf(group) - 1] ?? [], 1) &&
            numericGroup(groups[groups.indexOf(group) + 1] ?? [])
          )) ||
        (!cols.has(0) &&
          !parentHeader &&
          !finalSubrecord &&
          !denseSubrecord &&
          !(
            rect[1] >= rows.at(-1).rect[1] &&
            rules.some(
              (r) =>
                r[1] === r[3] &&
                r[1] >= rect[3] &&
                r[1] - rect[3] <= Math.max(...group.map((i) => i.height)) * 2
            )
          )) ||
        rect[0] < left ||
        rect[2] > right ||
        rect[1] < top ||
        rect[3] > bottom
      )
        continue
      const overlapping = rows.filter(
        (r) => Math.min(r.rect[3], rect[3]) - Math.max(r.rect[1], rect[1]) > 0
      )
      // A missing record can touch the ink box of both neighboring predicted
      // rows while its text centers lie in their gap. Separate only complete
      // labelled numeric records; wrapped prose/intervals keep their parent row.
      const columnText = columnRects.map((_, c) =>
        group
          .filter((i) => columnOf(i) === c)
          .map((i) => i.text)
          .join(' ')
          .trim()
      )
      // Consecutively numbered records can mix numeric and categorical fields.
      // Both neighboring identifiers and a fully populated source baseline are
      // required; a lone list number does not establish a missing table row.
      const sequentialRecord =
        columns.length >= 5 &&
        /^[1-9]\d*$/.test(columnText[0]) &&
        /^\d+$/.test(columnText[1]) &&
        columnText.every(Boolean) &&
        columnText.slice(2).filter((text) => /\p{L}/u.test(text)).length >= 2 &&
        [-1, 1].every((offset) =>
          groups.some((g) => {
            const stub = g.filter((i) => columnOf(i) === 0)
            return (
              stub.length === 1 &&
              stub[0].text.trim() === String(Number(columnText[0]) + offset) &&
              new Set(g.map(columnOf)).size === columns.length &&
              Math.sign(g[0].baseline - group[0].baseline) === offset
            )
          })
        )
      const compactCountRecord =
        columns.length === 2 &&
        /^\p{L}/u.test(columnText[0]) &&
        /^\d+$/.test(columnText[1]) &&
        [-1, 1].every((offset) => {
          const adjacent = groups[groups.indexOf(group) + offset] ?? []
          const label = adjacent.filter((item) => columnOf(item) === 0)
          const value = adjacent.filter((item) => columnOf(item) === 1)
          const stub = group.filter((item) => columnOf(item) === 0)
          return (
            label.length === 1 &&
            value.length === 1 &&
            stub.length === 1 &&
            /^\p{L}/u.test(label[0].text) &&
            /^\d+$/.test(value[0].text) &&
            Math.abs(label[0].rect[0] - stub[0].rect[0]) < stub[0].height * 0.1 &&
            Math.abs(label[0].baseline - stub[0].baseline) < stub[0].height * 1.8
          )
        })
      // Count tables can explicitly mark the comparison as unavailable. The
      // same marker in repeated count records and a following n-section supply
      // evidence without converting that marker into a numeric value.
      const unavailableCountRecord =
        columns.length === 3 &&
        /^\p{L}/u.test(columnText[0]) &&
        /^\d+$/.test(columnText[1]) &&
        /^(?:NA|NE|NR)$/.test(columnText[2]) &&
        groups.filter(
          (g) =>
            g.some((item) => columnOf(item) === 0 && /^\p{L}/u.test(item.text)) &&
            g.some((item) => columnOf(item) === 1 && /^\d+$/.test(item.text)) &&
            g.some((item) => columnOf(item) === 2 && item.text === columnText[2])
        ).length >= 3
      const emptyOverlapping = overlapping.filter(
        (row) => !items.some((item) => inside([left, row.rect[1], right, row.rect[3]], item))
      )
      // A section label and an indented record with every numeric column filled
      // can resolve an empty neighboring prediction. Empty bands or populated
      // numeric neighbors alone do not supply that section/record boundary.
      const sectionOwner = overlapping.find((row) => !emptyOverlapping.includes(row))
      const sectionText = sectionOwner
        ? items.filter((item) =>
            inside([left, sectionOwner.rect[1], right, sectionOwner.rect[3]], item)
          )
        : []
      const replaceEmptyNeighbor =
        overlapping.length === 2 &&
        emptyOverlapping.length === 1 &&
        sectionText.length === 1 &&
        columnOf(sectionText[0]) === 0 &&
        /^\p{L}/u.test(sectionText[0].text) &&
        group.some(
          (item) =>
            columnOf(item) === 0 && item.rect[0] - sectionText[0].rect[0] >= item.height * 0.5
        ) &&
        columnText.slice(1).every((s) => /^[<>≤≥−+-]?\s*\d[\d\s.,()%±*–−+\-/]*$/.test(s))
      if (
        overlapping.length &&
        (columnText[0] || denseSubrecord) &&
        (sequentialRecord ||
          compactCountRecord ||
          unavailableCountRecord ||
          columnText.slice(1).filter((s) => /^[<>≤≥−+-]?\s*\d[\d\s.,()%±*–−+\-/]*$/.test(s))
            .length >= 2) &&
        overlapping.every((row) => {
          const owned = items.filter(
            (i) => !group.includes(i) && inside([left, row.rect[1], right, row.rect[3]], i)
          )
          return (
            (replaceEmptyNeighbor && emptyOverlapping.includes(row)) ||
            (owned.length &&
              (columns.length >= 4 ||
                new Set(owned.map(columnOf)).size >= 2 ||
                (unavailableCountRecord &&
                  owned.length === 1 &&
                  columnOf(owned[0]) === 0 &&
                  /,\s*n$/.test(owned[0].text) &&
                  owned[0].rect[1] > rect[3])) &&
              owned.every(
                (i) =>
                  Math.abs(i.baseline - group[0].baseline) >
                  Math.max(i.height, group[0].height) * 0.6
              ))
          )
        })
      ) {
        const center = (rect[1] + rect[3]) / 2
        for (const row of emptyOverlapping) rows.splice(rows.indexOf(row), 1)
        for (const row of overlapping) {
          const owned = items.filter(
            (i) => !group.includes(i) && inside([left, row.rect[1], right, row.rect[3]], i)
          )
          if (!owned.length) continue
          if (owned.every((i) => i.baseline < group[0].baseline))
            row.rect[3] = (Math.max(...owned.map((i) => (i.rect[1] + i.rect[3]) / 2)) + center) / 2
          else if (owned.every((i) => i.baseline > group[0].baseline))
            row.rect[1] = (Math.min(...owned.map((i) => (i.rect[1] + i.rect[3]) / 2)) + center) / 2
        }
        rows.push({ rect: [left, rect[1], right, rect[3]], origin: 'source-text' })
        repairs.push('interstitial-record-recovered')
        continue
      }
      if (
        overlapping.length &&
        (numberedSection || ((groupedNumericTable || projectedSection) && sectionGroup(group))) &&
        overlapping.every((row) =>
          items
            .filter((item) => inside(row.rect, item) && !group.includes(item))
            .every((item) => item.rect[3] <= rect[1] || item.rect[1] >= rect[3])
        )
      ) {
        for (const row of overlapping) {
          if (row.rect[1] < rect[1]) row.rect[3] = rect[1]
          else row.rect[1] = rect[3]
        }
        rows.push({
          rect: [left, rect[1], right, rect[3]],
          origin: 'source-text',
          ...(numberedSection ? { section: true } : {})
        })
        repairs.push('text-supported-section-row-recovered')
        continue
      }
      if (
        overlapping.length === 1 &&
        overlapping[0] === rows.at(-1) &&
        rect[3] > overlapping[0].rect[3] &&
        (finalStatistic || cols.size >= Math.max(2, Math.ceil(columns.length / 2))) &&
        items.some((item) => inside(overlapping[0].rect, item)) &&
        items
          .filter((item) => inside(overlapping[0].rect, item))
          .every((item) => item.rect[3] < rect[1]) &&
        rules.some(
          (r) =>
            r[1] === r[3] &&
            r[1] >= rect[3] &&
            r[1] - rect[3] <= Math.max(...group.map((i) => i.height)) * 2
        )
      ) {
        const previousEnd = Math.max(
          ...items.filter((item) => inside(overlapping[0].rect, item)).map((item) => item.rect[3])
        )
        overlapping[0].rect[3] = (previousEnd + rect[1]) / 2
        rows.push({ rect: [left, rect[1], right, rect[3]], origin: 'source-text' })
        repairs.push('final-record-recovered')
        continue
      }
      if (overlapping.length) {
        // An empty predicted band can end just before the actual text centers.
        // Realign only that one intersecting band, never a populated row or an
        // isolated note. The multi-column evidence and crop bounds above still apply.
        if (
          overlapping.length === 1 &&
          !items.some(
            (item) =>
              inside([left, overlapping[0].rect[1], right, overlapping[0].rect[3]], item) &&
              (!group.includes(item) ||
                item.height >= Math.max(...group.map((i) => i.height)) * 0.8)
          )
        ) {
          overlapping[0].rect = [left, rect[1], right, rect[3]]
          repairs.push('text-supported-row-realigned')
        }
        continue
      }
      rows.push({ rect: [left, rect[1], right, rect[3]], origin: 'source-text' })
      repairs.push('text-supported-row-recovered')
    }
    // Complete name/URL pairs establish independent records even when a shifted
    // neighbor band touches their glyphs or multiple bands contain their centers.
    // Only replace bands containing these records; prose, headings and wrapped
    // continuations in the same table must retain their existing row ownership.
    const linkGroups =
      columns.length === 2
        ? groups.filter((group) => {
            const label = group.filter((item) => columnOf(item) === 0)
            const value = group.filter((item) => columnOf(item) === 1)
            return (
              label.length &&
              value.length &&
              /^https?:\/\/\S+$/i.test(
                value
                  .map((item) => item.text)
                  .join(' ')
                  .trim()
              )
            )
          })
        : []
    if (linkGroups.length >= 3) {
      const linkItems = new Set(linkGroups.flat())
      for (const group of linkGroups) {
        const owning = rows.filter((row) => group.some((item) => inside(row.rect, item)))
        if (owning.length === 1 && group.every((item) => inside(owning[0].rect, item))) continue
        const rect = union(group)
        if (rect[0] < left || rect[2] > right || rect[1] < top || rect[3] > bottom) continue
        const affected = rows.filter(
          (row) => Math.min(row.rect[3], rect[3]) > Math.max(row.rect[1], rect[1])
        )
        if (
          affected.some((row) =>
            items.some((item) => inside(row.rect, item) && !linkItems.has(item))
          )
        )
          continue
        const recovered = linkGroups.filter(
          (other) =>
            other === group || other.some((item) => affected.some((row) => inside(row.rect, item)))
        )
        // A source line shared with an unaffected band is still ambiguous.
        if (
          recovered.some((other) =>
            other.some((item) =>
              rows.some((row) => !affected.includes(row) && inside(row.rect, item))
            )
          )
        )
          continue
        for (let i = rows.length - 1; i >= 0; i--) if (affected.includes(rows[i])) rows.splice(i, 1)
        rows.push(
          ...recovered.map((other) => {
            const bounds = union(other)
            return { rect: [left, bounds[1], right, bounds[3]], origin: 'source-text' }
          })
        )
        repairs.push('text-supported-link-records-recovered')
      }
    }
    rows.sort((a, b) => a.rect[1] - b.rect[1])
    // A final confidence interval belongs to the estimate directly above when a
    // closing rule bounds both. Prose notes cannot extend the last record.
    const lastRow = rows.at(-1)
    if (lastRow)
      for (const group of groups.filter((g) => union(g)[1] >= lastRow.rect[3])) {
        const bounds = union(group)
        if (
          !group.every(
            (item) =>
              /^\([−–-]?\d[\d.,]*\s*[–−-]\s*[−–-]?\d[\d.,]*\)$/.test(item.text.trim()) &&
              columnOf(item) > 0 &&
              items.some(
                (prior) =>
                  columnOf(prior) === columnOf(item) &&
                  inside(lastRow.rect, prior) &&
                  /^\d[\d.,]*$/.test(prior.text.trim()) &&
                  item.baseline - prior.baseline > 0 &&
                  item.baseline - prior.baseline <= item.height * 1.5
              )
          ) ||
          !rules.some(
            (r) =>
              r[1] === r[3] &&
              r[1] >= bounds[3] &&
              r[1] - bounds[3] <= Math.max(...group.map((i) => i.height)) * 2 &&
              r[0] <= bounds[0] &&
              r[2] >= bounds[2]
          )
        )
          break
        lastRow.rect[3] = bounds[3]
        repairs.push('final-confidence-interval-included')
      }
    // A recovered row initially contains only its first source line. Include tight
    // continuations in the same columns, bounded by the next supported row. A new
    // first-column label, a text gap or an unpopulated column stops the extension;
    // never extend the final row into potential notes below the table.
    for (let index = 0; index < rows.length - 1; index++) {
      const row = rows[index]
      if (row.origin !== 'source-text') continue
      for (const group of groups.filter((group) => union(group)[1] >= row.rect[3])) {
        if (
          union(group)[3] > rows[index + 1].rect[1] ||
          !group.every((item) => {
            const column = columnOf(item)
            return (
              column > 0 &&
              item.rect[0] >= columnRects[column][0] &&
              item.rect[2] <= columnRects[column][2] &&
              items.some(
                (previous) =>
                  previous.horizontal &&
                  columnOf(previous) === column &&
                  inside(row.rect, previous) &&
                  item.baseline > previous.baseline &&
                  item.baseline - previous.baseline <= Math.max(item.height, previous.height) * 1.5
              )
            )
          })
        )
          break
        row.rect[3] = union(group)[3]
        repairs.push('recovered-row-continuation-included')
      }
    }
    // A wrapped column header can start just above the model's first row. Recover
    // that line only with a model header, multiple populated columns and nearby
    // continuation text in each same column; never absorb an isolated title/note.
    const firstRow = rows[0]
    if (
      firstRow &&
      (externalCaptions.some(
        (c) =>
          c.rect[3] <= firstRow.rect[1] &&
          firstRow.rect[1] - c.rect[3] <= 90 &&
          Math.min(c.rect[2], right) - Math.max(c.rect[0], left) >=
            Math.min(c.rect[2] - c.rect[0], right - left) * 0.5
      ) ||
        objects.some(
          (o) =>
            o.label === 'table column header' &&
            intersect(o.rect, firstRow.rect) / area(firstRow.rect) > 0.5
        ))
    ) {
      for (const group of [...groups].reverse()) {
        if (group.some((item) => item.rect[1] >= firstRow.rect[1])) continue
        const cols = new Set(group.map(columnOf))
        // Full-width rules can enclose a wrapped header containing sample sizes.
        // They distinguish that band from an isolated annotation above the table.
        const headerRules = rules.filter(
          (r) =>
            r[1] === r[3] && Math.min(r[2], right) - Math.max(r[0], left) >= (right - left) * 0.9
        )
        const ruledHeader =
          headerRules.some(
            (r) =>
              r[1] <= union(group)[1] &&
              union(group)[1] - r[1] <= Math.max(...group.map((item) => item.height))
          ) &&
          headerRules.some(
            (r) =>
              r[1] >= firstRow.rect[1] &&
              r[1] <= firstRow.rect[3] + Math.max(...group.map((item) => item.height)) &&
              r[1] >= union(group)[3]
          )
        // One column may wrap while all other headings occupy the lower line.
        // Require a model header and alphabetic labels in every column; a lone
        // title above ordinary data must not be folded into the first record.
        // A repeated treatment phrase in a peer heading corroborates the lone
        // prefix even when this heading wraps over a sample-size line.
        const repeatedHeaderPrefix = group.every((item) => {
          if (!/^\p{L}[\p{L} -]*$/u.test(item.text.trim())) return false
          const next = items
            .filter(
              (candidate) =>
                columnOf(candidate) === columnOf(item) &&
                inside(firstRow.rect, candidate) &&
                candidate.baseline > item.baseline &&
                /^[a-z]/.test(candidate.text)
            )
            .sort((a, b) => a.baseline - b.baseline)[0]
          if (!next) return false
          const phrase = item.text.trim() + ' ' + next.text.trim()
          return items.some(
            (peer) =>
              columnOf(peer) !== columnOf(item) &&
              inside(firstRow.rect, peer) &&
              (peer.text === phrase || peer.text.startsWith(phrase + ' '))
          )
        })
        const singleWrappedHeader =
          cols.size === 1 &&
          (ruledHeader ||
            repeatedHeaderPrefix ||
            groups.filter((line) => line.some((item) => inside(firstRow.rect, item))).length ===
              1 ||
            !items.some(
              (item) =>
                inside(firstRow.rect, item) && cols.has(columnOf(item)) && /\d/.test(item.text)
            )) &&
          (ruledHeader ||
            objects.some(
              (o) =>
                o.label === 'table column header' &&
                intersect(o.rect, firstRow.rect) / area(firstRow.rect) > 0.5
            )) &&
          columnRects.filter((bounds) =>
            items.some(
              (item) =>
                item.horizontal &&
                /^\(?\p{L}/u.test(item.text) &&
                inside([bounds[0], firstRow.rect[1], bounds[2], firstRow.rect[3]], item)
            )
          ).length >= Math.max(2, columnRects.length - 1)
        if ((cols.size < 2 && !singleWrappedHeader) || cols.has(-1)) continue
        const continues = (item) =>
          items.some(
            (next) =>
              next.horizontal &&
              columnOf(next) === columnOf(item) &&
              inside([left, firstRow.rect[1], right, firstRow.rect[3]], next) &&
              next.baseline > item.baseline &&
              next.baseline - item.baseline <= Math.max(item.height, next.height) * 1.6
          )
        // A complete label line can mix one-line and wrapped headings. Require
        // continuation in at least two columns to distinguish it from a data row.
        const completeHeader =
          cols.size === columns.length &&
          [...cols].every((column) =>
            /^\p{L}/u.test(group.find((item) => columnOf(item) === column).text)
          ) &&
          new Set(group.filter(continues).map(columnOf)).size >= 2
        if (
          !group.every((item) => {
            const column = columnOf(item)
            const bounds = columnRects[column]
            return (
              ((item.rect[0] >= bounds[0] - 1 && item.rect[2] <= bounds[2] + 1) ||
                rules.some(
                  (r) =>
                    r[1] === r[3] &&
                    r[1] >= item.rect[3] &&
                    r[1] <= firstRow.rect[3] &&
                    r[0] <= item.rect[0] &&
                    r[2] >= item.rect[2]
                )) &&
              (completeHeader || continues(item))
            )
          })
        )
          continue
        firstRow.rect[1] = Math.min(...group.map((item) => item.rect[1]))
        repairs.push('wrapped-header-recovered')
      }
    }
    // Repeated statistical suffixes can fall in the gap below treatment names.
    // Require multiple matching sample-size headings and a separate next record.
    if (rows.length > 1) {
      const header = rows[0]
      for (const group of groups) {
        const bounds = union(group)
        const cols = new Set(group.map(columnOf))
        if (
          (bounds[1] + bounds[3]) / 2 < header.rect[3] ||
          bounds[3] > rows[1].rect[1] ||
          bounds[1] - header.rect[3] > Math.max(...group.map((i) => i.height)) ||
          cols.size < 2 ||
          cols.has(0) ||
          cols.has(-1) ||
          !group.every((i) => /^mean\s*\(SD\)$/i.test(i.text.trim())) ||
          ![...cols].every((c) =>
            /\bn\s*=\s*\d+\)/i.test(
              items
                .filter((i) => columnOf(i) === c && inside(header.rect, i))
                .map((i) => i.text)
                .join(' ')
            )
          )
        )
          continue
        header.rect[3] = bounds[3]
        repairs.push('statistical-header-continuation-recovered')
      }
    }
    // Split a shifted band only when each source line is a complete labelled
    // numeric record. Wrapped labels with values on just one line stay together.
    for (let index = rows.length - 1; index >= 0; index--) {
      const row = rows[index]
      const lines = groups.filter((group) =>
        group.some((item) => inside([left, row.rect[1], right, row.rect[3]], item))
      )
      if (
        lines.length < 2 ||
        !lines.every((group) => {
          const byColumn = columnRects.map((_, column) =>
            group.filter((item) => columnOf(item) === column)
          )
          return (
            byColumn.every((part) => part.length) &&
            byColumn.slice(1).length >= 2 &&
            byColumn
              .slice(1)
              .every((part) =>
                /^[<>≤≥−+-]?\d[\d\s.,()%–−+\-/]*$/.test(part.map((item) => item.text).join(' '))
              )
          )
        })
      )
        continue
      const bounds = lines.map(union)
      if (
        bounds.some(
          (rect, i) =>
            i &&
            rect[1] - bounds[i - 1][3] < Math.max(...lines[i].map((item) => item.height)) * 0.25
        )
      )
        continue
      rows.splice(
        index,
        1,
        ...bounds.map((rect, i) => ({
          rect: [
            left,
            i ? (bounds[i - 1][3] + rect[1]) / 2 : Math.min(row.rect[1], rect[1]),
            right,
            i < bounds.length - 1
              ? (rect[3] + bounds[i + 1][1]) / 2
              : Math.max(row.rect[3], rect[3])
          ],
          origin: 'source-text'
        }))
      )
      repairs.push('text-supported-records-separated')
    }
    // Long review tables often have top-aligned records, a repeated model/category
    // column, and citations. Their wrapped descriptions confuse predicted row bands.
    // Use that repeated source column or a labelled numbered-reference column to
    // establish record starts. Model alignment is still required for ordinary tables.
    const sourceLines = groups.map((group) => {
      const parts = columnRects.map((_, column) =>
        group.filter((item) => columnOf(item) === column).sort((a, b) => a.rect[0] - b.rect[0])
      )
      return {
        group,
        parts,
        texts: parts.map((part) =>
          part
            .map((item) => item.text)
            .join(' ')
            .trim()
        )
      }
    })
    // Paired treatment columns may share P values and risk intervals. Require
    // repeated centered statistics between complete arm records; blank cells
    // alone do not establish which treatments a value compares.
    if (
      columns.length >= 5 &&
      columns.length % 2 === 1 &&
      externalCaptions.length &&
      objects.some((o) => o.label === 'table column header')
    ) {
      const numeric = (text) => /^[<>≤≥]?[−-]?\d[\d\s.,()%[\]–−±/+-]*$/.test(text)
      const complete = (line) =>
        line.texts[0] &&
        line.parts.slice(1).every((part) => part.length === 1 && numeric(part[0].text))
      const shared = (line) => {
        const values = line.group
          .filter((item) => columnOf(item) !== 0)
          .sort((a, b) => a.rect[0] - b.rect[0])
        return (
          line.texts[0] &&
          values.length === (columns.length - 1) / 2 &&
          values.every((item, i) => {
            const a = columnRects[1 + i * 2][0],
              b = columnRects[2 + i * 2][2]
            return (
              numeric(item.text) &&
              item.rect[0] >= a &&
              item.rect[2] <= b &&
              Math.abs((item.rect[0] + item.rect[2] - a - b) / 2) <= (b - a) * 0.16
            )
          })
        )
      }
      const first = sourceLines.findIndex(complete)
      const body = []
      let valid = first > 0
      for (const line of sourceLines.slice(first)) {
        if (complete(line) || shared(line))
          body.push({ ...line, group: [...line.group], comparisonPairs: !complete(line) })
        else {
          const previous = body.at(-1)
          if (
            !previous ||
            !line.texts[0] ||
            line.group.some((item) => columnOf(item) !== 0) ||
            !/^(?:[a-z(]|[—–]\s*\p{L})/u.test(line.texts[0]) ||
            line.group[0].baseline - previous.group.at(-1).baseline > line.group[0].height * 1.7 ||
            line.group[0].rect[0] < previous.group[0].rect[0] + line.group[0].height * 0.5
          ) {
            valid = false
            break
          }
          previous.group.push(...line.group)
        }
      }
      if (
        valid &&
        body.filter(complete).length >= 3 &&
        body.filter((line) => line.comparisonPairs && /^P\s+value$/i.test(line.texts[0])).length >=
          2 &&
        body.every((line, i) => !i || union(line.group)[1] >= union(body[i - 1].group)[3])
      ) {
        const firstTop = union(body[0].group)[1]
        rows.splice(
          0,
          rows.length,
          ...rows.filter((row) => row.rect[3] <= firstTop),
          ...body.map((line) => ({
            rect: [left, union(line.group)[1], right, union(line.group)[3]],
            origin: 'source-comparison',
            comparisonPairs: line.comparisonPairs
          }))
        )
        recoveredComparisonStatistics = true
        repairs.push('paired-comparison-statistics-recovered')
      }
    }
    // Repeated count/percentage pairs establish physical rows even when the
    // model drops a percentage line or shifts a category into the next record.
    // Every intervening body line must participate; never bridge prose or notes.
    const pairs = sourceLines.flatMap((line, index) => {
      const count = sourceLines[index - 1]
      const valueColumns = line.texts.flatMap((text, column) => (text ? [column] : []))
      if (
        !count ||
        valueColumns.length < 2 ||
        valueColumns[0] < 1 ||
        valueColumns.some(
          (column, i) =>
            (i && column !== valueColumns[i - 1] + 1) ||
            !/^\d+(?:\.\d+)?%$/.test(line.texts[column]) ||
            !/^\d+$/.test(count.texts[column])
        ) ||
        !count.texts.slice(0, valueColumns[0]).some((text) => /\p{L}/u.test(text)) ||
        count.texts
          .slice(valueColumns.at(-1) + 1)
          .some((text) => text && !/^[<>≤≥]?\s*\d+(?:\.\d+)?$/.test(text)) ||
        union(line.group)[1] - union(count.group)[3] >
          Math.max(...line.group.map((i) => i.height)) ||
        line.group[0].baseline - count.group[0].baseline >
          Math.max(...line.group.map((i) => i.height)) * 1.7
      )
        return []
      return [{ index, valueColumns }]
    })
    if (
      pairs.length >= 6 &&
      pairs.every(
        (pair, i) =>
          (!i || pair.index === pairs[i - 1].index + 2) &&
          JSON.stringify(pair.valueColumns) === JSON.stringify(pairs[0].valueColumns)
      )
    ) {
      const first = pairs[0].index - 1,
        last = pairs.at(-1).index
      const headingLines = sourceLines.slice(0, first)
      const modelHeader = objects.find((o) => o.label === 'table column header')
      const recoverHeaders =
        externalCaptions.length &&
        headingLines.length === 2 &&
        modelHeader &&
        headingLines.every(
          (line) =>
            line.texts.filter(Boolean).length >= 2 &&
            line.texts.filter(Boolean).every((text) => /\p{L}/u.test(text))
        ) &&
        intersect(modelHeader.rect, union(headingLines[1].group)) > 0
      const headers = recoverHeaders
        ? headingLines.map((line) => ({
            rect: [left, union(line.group)[1], right, union(line.group)[3]],
            origin: 'source-text'
          }))
        : rows.filter((row) => row.rect[3] <= union(sourceLines[first].group)[1])
      pairedRows = { first: headers.length, valueColumns: pairs[0].valueColumns }
      rows.splice(
        0,
        rows.length,
        ...headers,
        ...sourceLines.slice(first, last + 1).map((line) => ({
          rect: [left, union(line.group)[1], right, union(line.group)[3]],
          origin: 'source-paired'
        }))
      )
      repairs.push('text-supported-count-percentage-rows-recovered')
    }
    // A population followed by two comparison arms can share right-hand summary
    // statistics. Require the same complete/partial record pattern throughout;
    // an isolated blank cell does not establish a rowspan.
    if (!pairedRows && columns.length >= 6) {
      const numeric = (text) =>
        /^[<>≤≥]?\s*[−-]?(?:\d+(?:\.\d+)?|\.\d+)(?:\s+to\s+[−-]?\d+(?:\.\d+)?)?$/.test(text)
      const complete = (line) =>
        line.texts.slice(0, 2).every((text) => /\p{L}/u.test(text)) &&
        line.texts.slice(2).every(numeric)
      const first = sourceLines.findIndex(complete)
      const body = first >= 0 ? sourceLines.slice(first) : []
      const values =
        body[1]?.texts.flatMap((text, column) => (text && column >= 2 ? [column] : [])) ?? []
      const sharedStart = (values.at(-1) ?? columns.length) + 1
      const headers = rows.filter((row) => body.length && row.rect[3] <= union(body[0].group)[1])
      if (
        headers.length &&
        objects.some((o) => o.label === 'table column header') &&
        body.length >= 6 &&
        body.length % 2 === 0 &&
        values.length >= 2 &&
        sharedStart <= columns.length - 2 &&
        values.every((c, i) => c === i + 2) &&
        body.every((line, index) =>
          index % 2 === 0
            ? complete(line)
            : !line.texts[0] &&
              /\p{L}/u.test(line.texts[1]) &&
              values.every((c) => numeric(line.texts[c])) &&
              line.texts.slice(sharedStart).every((text) => !text)
        ) &&
        body.every(
          (line, index) =>
            !index ||
            (union(line.group)[1] >= union(body[index - 1].group)[3] &&
              line.group[0].baseline - body[index - 1].group[0].baseline <=
                line.group[0].height * 2)
        )
      ) {
        pairedRows = { first: headers.length, valueColumns: values }
        rows.splice(
          0,
          rows.length,
          ...headers,
          ...body.map((line) => ({
            rect: [left, union(line.group)[1], right, union(line.group)[3]],
            origin: 'source-paired'
          }))
        )
        repairs.push('text-supported-comparison-rows-recovered')
      }
    }
    // Dense one-line numeric tables provide stronger row boundaries than overlapping
    // model bands. Require complete numeric records plus single-line section labels;
    // wrapped prose or partial value rows make this reconstruction ineligible.
    // Separate mean/SD and count/% columns are intentionally sparse: each
    // variable uses one unit per arm. Repeated unit pairs distinguish these
    // records from an incomplete extraction or a wrapped description.
    const statisticHeader =
      columns.length >= 6 &&
      externalCaptions.length > 0 &&
      sourceLines
        .slice(0, 6)
        .find(
          ({ texts }) =>
            /p[- ]?value/i.test(texts.at(-1)) &&
            (texts.length - 2) % 2 === 0 &&
            texts
              .slice(1, -1)
              .every((text, index) =>
                index % 2 === 0
                  ? /^Mean\s*\(SD\)$/i.test(text)
                  : /^(?:Number|n)\s*\((?:valid\s*)?%\)$/i.test(text)
              )
        )
    const sparseNumericTable =
      !!statisticHeader ||
      (columns.length >= 6 &&
        sourceLines
          .slice(0, 6)
          .some(({ texts }) => texts.filter((text) => text === 'P').length >= 2))
    const intervalValue = (text) =>
      /^\d+(?:\.\d+)?\s*\((?:[−-]?\d+(?:\.\d+)?\s+to\s+[−-]?\d+(?:\.\d+)?|referent)\)$/i.test(text)
    const fullRules = rules.filter(
      (r) => r[1] === r[3] && Math.min(right, r[2]) - Math.max(left, r[0]) >= (right - left) * 0.9
    )
    const twoColumnIntervals =
      columns.length === 2 &&
      externalCaptions.length > 0 &&
      fullRules.length >= 3 &&
      sourceLines.slice(0, 4).some((line) => /\bCI\b/.test(line.texts[1]))
    const ruledNumericTable =
      captions.some((c) => captionKind(c.lines.join(' ')) === 'table') && fullRules.length >= 3
    const sparseDashTable =
      ruledNumericTable &&
      columns.length >= 6 &&
      sourceLines.filter(
        (line) => line.texts.slice(1).filter((text) => /^[–—−-]$/.test(text)).length >= 2
      ).length >= 8
    if (sparseDashTable)
      for (const line of sourceLines) {
        if (
          /\p{L}/u.test(line.texts[0]) &&
          /^(?:n\s*)?\(%\)$/.test(line.texts[1]) &&
          line.texts.slice(2).every((text) => !text)
        ) {
          line.texts[0] += ' ' + line.texts[1]
          line.texts[1] = ''
          line.sectionSuffix = true
        }
      }
    const numericRecord = ({ texts }) =>
      texts[0] &&
      (!statisticHeader ||
        texts
          .slice(1, -1)
          .every(
            (text, index, values) =>
              index % 2 !== 0 || Number(!!text) + Number(!!values[index + 1]) === 1
          )) &&
      (!twoColumnIntervals || intervalValue(texts[1])) &&
      (texts.length >= 3 || twoColumnIntervals) &&
      texts.slice(1).filter(Boolean).length >= (twoColumnIntervals ? 1 : 2) &&
      texts
        .slice(1)
        .every(
          (text) =>
            ((sparseNumericTable || sparseDashTable) && !text) ||
            (ruledNumericTable && /^[–—−-]$/.test(text)) ||
            /^(?:\/|(?:N\s*=\s*)?[<>≤≥−+-]?\s*(?:\d|\.\d)[\d\s.,()%–−+±\-/]*)$/i.test(text) ||
            /^\d+\s*\([<>≤≥]\s*\d+(?:\.\d+)?\)$/.test(text) ||
            intervalValue(text)
        )
    const completeHeader = ruledNumericTable && sourceLines[0]?.texts.every(Boolean)
    const numericLines = sourceLines.filter(numericRecord)
    let firstNumeric = sourceLines.findIndex(numericRecord)
    const stubHeader = sourceLines.slice(0, firstNumeric).find((line) => line.texts[0])?.texts[0]
    const repeatedHeader = (line) => {
      const rect = union(line.group),
        height = Math.max(...line.group.map((item) => item.height))
      return (
        stubHeader &&
        line.texts[0].replace(/[*†‡]+$/u, '') === stubHeader.replace(/[*†‡]+$/u, '') &&
        line.texts.slice(1).every((text) => /\bCI\b/.test(text)) &&
        fullRules.some((r) => r[1] <= rect[1] && rect[1] - r[1] <= height * 1.5) &&
        fullRules.some((r) => r[1] >= rect[3] && r[1] - rect[3] <= height * 1.5)
      )
    }
    while (
      firstNumeric > 0 &&
      sourceLines[firstNumeric - 1].texts[0] &&
      sourceLines[firstNumeric - 1].texts.slice(1).every((text) => !text)
    )
      firstNumeric--
    const numericBody = sourceLines
      .slice(firstNumeric)
      .map((line) => ({ ...line, group: [...line.group] }))
    const sectionLine = (line) => line.texts[0] && line.texts.slice(1).every((text) => !text)
    const markedDefinition = (line) =>
      sectionLine(line) && /^[*†‡]\s*[A-Za-z][A-Za-z0-9-]*,\s*\p{L}/u.test(line.texts[0])
    const footerIndex = numericBody.findIndex(markedDefinition)
    if (
      footerIndex > 0 &&
      numericRecord(numericBody[footerIndex - 1]) &&
      numericBody.slice(footerIndex).every(markedDefinition) &&
      fullRules.some(
        (r) =>
          r[1] >= union(numericBody[footerIndex - 1].group)[3] &&
          r[1] <= union(numericBody[footerIndex].group)[1]
      )
    )
      numericBody.splice(footerIndex)
    // A detached small footnote or raised inline sign can form its own baseline group. Keep its
    // original token with the adjacent stub before checking record completeness.
    for (let i = numericBody.length - 1; i >= 0; i--) {
      const line = numericBody[i]
      if (
        !line.group.every(
          (item) =>
            /^[a-z*†‡¹²³123]$/.test(item.text) || (item.inlineSymbol && /^[−+]$/.test(item.text))
        )
      )
        continue
      const owners = numericBody.filter(
        (other, index) =>
          Math.abs(index - i) === 1 &&
          line.group.every((item) =>
            other.group.some(
              (anchor) =>
                columnOf(item) === 0 &&
                columnOf(anchor) === 0 &&
                item.height < anchor.height * 0.8 &&
                anchor.baseline - item.baseline > anchor.height * 0.08 &&
                anchor.baseline - item.baseline < anchor.height * 0.5 &&
                item.rect[0] - anchor.rect[2] >= -anchor.height * 0.1 &&
                item.rect[0] - anchor.rect[2] <= anchor.height * 0.35
            )
          )
      )
      if (owners.length !== 1) continue
      owners[0].group.push(...line.group)
      numericBody.splice(i, 1)
    }
    // A lower-case stub continuation (e.g. "resection") may wrap below an
    // otherwise complete numeric record. Preserve it in that same record.
    for (let i = 1; i < numericBody.length; i++) {
      const line = numericBody[i],
        previous = numericBody[i - 1]
      if (
        sectionLine(line) &&
        (/^[a-z][a-z\s—–-]{1,60}$/.test(line.texts[0]) ||
          (/^(?:[a-z]|[—–]\s*\p{L})/u.test(line.texts[0]) &&
            line.group[0].rect[0] >= previous.group[0].rect[0] + line.group[0].height * 0.5) ||
          (twoColumnIntervals && /^\([a-z][^()]{1,60}\)\s*[*†‡]*$/u.test(line.texts[0])) ||
          (numericRecord(previous) &&
            line.group[0].rect[0] >= previous.group[0].rect[0] + line.group[0].height * 0.5 &&
            (/^\([a-z][^()]{1,60}\)\s*[*†‡]*$/u.test(line.texts[0]) ||
              /^[<>≤≥]\s*\d+(?:\.\d+)?\s*\/\p{L}{1,6}$/u.test(line.texts[0]))) ||
          (ruledNumericTable && /^\([\d.]+[–−-][\d.]+\)$/.test(line.texts[0]))) &&
        (numericRecord(previous) ||
          (sectionLine(previous) &&
            (line.group[0].rect[0] >= previous.group[0].rect[0] + line.group[0].height * 0.5 ||
              (ruledNumericTable && /[-,]$/.test(previous.texts[0]))))) &&
        line.group[0].baseline - Math.max(...previous.group.map((item) => item.baseline)) <=
          line.group[0].height * 1.7 &&
        line.group[0].rect[0] >= previous.group[0].rect[0] - 1
      ) {
        previous.group.push(...line.group)
        previous.texts[0] += ' ' + line.texts[0]
        numericBody.splice(i, 1)
        i--
      }
    }
    if (
      (numericLines.length >= 10 ||
        (numericLines.length >= 6 &&
          externalCaptions.length > 0 &&
          firstNumeric > 0 &&
          numericBody.every(numericRecord) &&
          fullRules.some(
            (r) =>
              r[1] >= union(sourceLines[firstNumeric - 1].group)[3] &&
              r[1] <= union(numericBody[0].group)[1]
          ) &&
          fullRules.some(
            (r) =>
              r[1] >= union(numericBody.at(-1).group)[3] &&
              r[1] - union(numericBody.at(-1).group)[3] <= numericBody.at(-1).group[0].height * 2
          ))) &&
      numericLines.length >=
        (numericBody.length + (completeHeader ? 0 : firstNumeric)) *
          (sparseNumericTable ? 0.5 : 0.6) &&
      sourceLines
        .slice(0, firstNumeric)
        .every(
          (line) =>
            completeHeader ||
            line.texts[0] ||
            line.texts.filter(Boolean).length >= 2 ||
            line.group.every((item) => inside(rows[0].rect, item)) ||
            (externalCaptions.length > 0 &&
              line.group.length === 1 &&
              line.group[0].rect[2] - line.group[0].rect[0] >= (right - left) * 0.25 &&
              rows.some(
                (row) =>
                  row.rect[1] < union(numericBody[0].group)[1] &&
                  line.group.every((item) => inside(row.rect, item))
              ))
        ) &&
      numericBody.every(
        (line, index) =>
          numericRecord(line) ||
          repeatedHeader(line) ||
          (sectionLine(line) &&
            (sparseNumericTable ||
              ruledNumericTable ||
              !index ||
              !sectionLine(numericBody[index - 1])))
      ) &&
      numericBody.every(
        (line, index) => !index || union(line.group)[1] >= union(numericBody[index - 1].group)[3]
      )
    ) {
      const statisticParents =
        statisticHeader &&
        firstNumeric === 2 &&
        sourceLines[1] === statisticHeader &&
        sourceLines[0].group.length === (columns.length - 2) / 2 &&
        sourceLines[0].group.every((parent) =>
          sourceRules.some(
            (rule) =>
              rule[1] === rule[3] &&
              rule[1] >= parent.rect[3] &&
              rule[1] <= union(statisticHeader.group)[1] &&
              rule[0] <= parent.rect[0] &&
              rule[2] >= parent.rect[2] &&
              statisticHeader.group.filter(
                (child) => child.rect[0] >= rule[0] && child.rect[2] <= rule[2]
              ).length === 2
          )
        )
      rows.splice(
        0,
        rows.length,
        ...(statisticParents
          ? sourceLines.slice(0, firstNumeric).map(({ group }) => ({
              rect: [left, union(group)[1], right, union(group)[3]],
              origin: 'source-statistic-header'
            }))
          : completeHeader
            ? [
                {
                  rect: [
                    left,
                    union(sourceLines[0].group)[1],
                    right,
                    union(sourceLines[firstNumeric - 1].group)[3]
                  ],
                  origin: rows.some((row) => row.origin === 'source-native-header')
                    ? 'source-native-header'
                    : 'source-header'
                }
              ]
            : rows
                .filter(
                  (row) =>
                    row.rect[1] < union(numericBody[0].group)[1] &&
                    sourceLines
                      .slice(0, firstNumeric)
                      .some((line) => line.group.some((item) => inside(row.rect, item)))
                )
                .map((row) => ({
                  ...row,
                  rect: [
                    row.rect[0],
                    row.rect[1],
                    row.rect[2],
                    Math.min(row.rect[3], union(numericBody[0].group)[1])
                  ]
                }))),
        ...numericBody.map((line, index) => {
          const { group } = line
          const rect = union(group)
          const next = numericBody[index + 1]
          const section =
            sectionLine(line) &&
            /\p{L}/u.test(line.texts[0]) &&
            next &&
            numericRecord(next) &&
            Math.min(
              ...next.group.filter((item) => columnOf(item) === 0).map((item) => item.rect[0])
            ) -
              rect[0] >=
              Math.max(...group.map((item) => item.height)) * 0.5
          return {
            rect: [left, rect[1], right, rect[3]],
            origin: repeatedHeader(line) ? 'source-repeated-header' : 'source-text',
            section,
            sectionSuffix: line.sectionSuffix,
            statisticRecord: !!statisticHeader && !!numericRecord(line),
            numericRecord: !!numericRecord(line)
          }
        })
      )
      repairs.push('text-supported-numeric-rows-recovered')
      recoveredNumericSections = numericBody.some(sectionLine)
    }
    // Repeated sample-size rows followed by the same number of interval rows
    // establish top-aligned records even when the stub wraps over several lines.
    const sampleLine = ({ texts }) =>
      texts[0] &&
      texts.slice(1).length >= 3 &&
      texts.slice(1).every((text) => /^\(\s*n\s*=\s*\d+\s*\)$/i.test(text))
    const intervalLine = ({ texts }) =>
      texts[0] &&
      texts.slice(1).length >= 3 &&
      texts
        .slice(1)
        .every((text) =>
          /^\d+(?:\.\d+)?\s*\([−-]?\d+(?:\.\d+)?\s*[–−-]\s*[−-]?\d+(?:\.\d+)?\)$/.test(text)
        )
    const sampleStart = sourceLines.findIndex(sampleLine)
    const intervalBody = sourceLines.slice(sampleStart)
    const records = []
    for (const line of intervalBody) {
      if (sampleLine(line) || intervalLine(line)) records.push({ ...line, group: [...line.group] })
      else if (sectionLine(line) && records.length) records.at(-1).group.push(...line.group)
      else break
    }
    const samples = records.flatMap((line, index) => (sampleLine(line) ? [index] : []))
    const stride = samples[1] - samples[0]
    if (
      sampleStart >= 0 &&
      samples.length >= 3 &&
      stride >= 3 &&
      samples.every((index, i) => index === i * stride) &&
      records.length === samples.length * stride &&
      records.flatMap((record) => record.group).length ===
        intervalBody.flatMap((line) => line.group).length &&
      objects.some((o) => o.label === 'table column header') &&
      records.every((record, i) => !i || union(record.group)[1] >= union(records[i - 1].group)[3])
    ) {
      rows.splice(
        0,
        rows.length,
        ...rows.filter((row) => row.rect[3] <= union(records[0].group)[1]),
        ...records.map(({ group }) => ({
          rect: [left, union(group)[1], right, union(group)[3]],
          origin: 'source-text'
        }))
      )
      repairs.push('sample-interval-records-recovered')
    }
    // A repeated model may end in a comma when another model follows on the next
    // line. Ignore that list separator only for matching; retain all original text
    // when constructing cells (including the comma and the continuation).
    const recordKey = (text) => text.replace(/[,，]\s*$/u, '').trim()
    const referenceHeader = sourceLines.find(({ texts }) =>
      /^(?:references?|\(?refs?\.?\)?)$/i.test(texts.at(-1))
    )
    const numberedReferences = externalCaptions.length > 0 && referenceHeader
    const continuedReview =
      externalCaptions.some(
        (caption) =>
          /\bcontinued\b/i.test(caption.lines.join(' ')) &&
          Math.min(caption.rect[2], right) - Math.max(caption.rect[0], left) > 0
      ) && !!referenceHeader
    const minimumRecords = continuedReview ? 3 : 6
    const repeated = columnRects.map((_, column) => {
      const counts = new Map()
      if (column > 0 && column < columns.length - 1) {
        for (const line of sourceLines) {
          const text = recordKey(line.texts[column])
          // Count complete record starts, not the second line of a wrapped model
          // name (which can repeat just as often as its first line).
          if (
            line.parts[0].length &&
            /^\(\s*\p{L}/u.test(line.texts.at(-1)) &&
            /[a-z]{2}/i.test(text)
          )
            counts.set(text, (counts.get(text) ?? 0) + 1)
        }
      }
      return new Set(
        [...counts].filter(([, count]) => count >= minimumRecords).map(([text]) => text)
      )
    })
    const recordStarts = sourceLines.filter(
      ({ parts, texts }) =>
        parts[0]?.length &&
        parts.filter((part) => part.length).length >= 3 &&
        ((numberedReferences &&
          parts[0][0].rect[1] > union(referenceHeader.group)[3] &&
          /^(?:\[\s*\d+(?:\s*[,–−-]\s*\d+)*\s*\]|\(\s*\d+(?:\s*[,–−-]\s*\d+)*\s*\))$/u.test(
            texts.at(-1)
          )) ||
          repeated.some(
            (values, column) =>
              values.size &&
              texts[column] &&
              (values.has(recordKey(texts[column])) || /^\(\s*\p{L}/u.test(texts.at(-1)))
          ))
    )
    const topAligned = recordStarts.filter(({ group }) =>
      rows.some(
        (row) =>
          Math.abs(row.rect[1] - union(group)[1]) <=
          Math.max(...group.map((item) => item.height)) * 1.25
      )
    )
    // Short continued sections can have every model band shifted upward into the
    // preceding wrapped description. Require a citation for every new record and
    // agreement with the model's record count before using these source starts.
    const citationAlignedContinuation =
      continuedReview &&
      recordStarts.length === rows.length - 1 &&
      recordStarts.every(({ texts }) => /^\(\s*\p{L}/u.test(texts.at(-1)))
    if (
      recordStarts.length >= minimumRecords &&
      recordStarts.length >= rows.length * 0.6 &&
      (topAligned.length >= recordStarts.length * 0.6 || citationAlignedContinuation)
    ) {
      const starts = recordStarts.map(({ group }) => union(group)[1])
      const lineBounds = groups.map(union)
      const boundaries = starts.map((start) => {
        const preceding = lineBounds.filter((rect) => rect[3] <= start)
        return preceding.length
          ? (Math.max(...preceding.map((rect) => rect[3])) + start) / 2
          : start
      })
      const headers = rows.filter((row) => row.rect[3] <= starts[0])
      // A continued section may begin with the end of the preceding column's last
      // record. Keep it as an unlabeled row rather than inventing a new owner.
      const carryOver =
        continuedReview && headers.length
          ? groups
              .flat()
              .filter(
                (item) => item.rect[1] >= headers.at(-1).rect[3] && item.rect[3] <= boundaries[0]
              )
          : []
      rows.splice(
        0,
        rows.length,
        ...headers,
        ...(carryOver.length
          ? [{ rect: [left, union(carryOver)[1], right, boundaries[0]], origin: 'source-text' }]
          : []),
        ...boundaries.map((start, index) => ({
          rect: [left, start, right, boundaries[index + 1] ?? bottom],
          origin: 'source-text'
        }))
      )
      repairs.push('text-supported-wrapped-records-recovered')
    }
  } else {
    rows.splice(
      0,
      rows.length,
      ...recordGrid.rows.map((rect) => ({ rect, origin: 'source-record' }))
    )
    repairs.push('text-supported-study-records-recovered')
  }
  const finalRow = rows.at(-1)
  if (finalRow && !recordGrid?.completeSpans) {
    for (const group of groups.filter((g) =>
      g.every((i) => (i.rect[1] + i.rect[3]) / 2 >= finalRow.rect[3])
    )) {
      const bounds = union(group),
        height = Math.max(...group.map((i) => i.height))
      if (
        bounds[1] - finalRow.rect[3] > height * 1.6 ||
        rules.some((r) => r[1] === r[3] && r[1] > finalRow.rect[3] && r[1] < bounds[1]) ||
        !rules.some((r) => r[1] === r[3] && r[1] >= bounds[3] && r[1] - bounds[3] <= height * 2) ||
        !group.every((i) =>
          items.some(
            (previous) =>
              columnOf(previous) === columnOf(i) &&
              inside(finalRow.rect, previous) &&
              i.baseline - previous.baseline <= height * 1.6
          )
        )
      )
        break
      finalRow.rect[3] = bounds[3]
      repairs.push('ruled-final-continuation-recovered')
    }
  }
  // Primer sequences and numeric estimates paired with confidence intervals
  // supply explicit record boundaries even when the first column is merged.
  const sequenceGroups = groups.filter((g) =>
    g.some((i) => /^(?:[FR]:\s*)?[ACGT]{10,}$/i.test(i.text.trim()))
  )
  const intervalGroups = groups.filter(
    (g) =>
      g.every((i) => /^\(\s*[−-]?\d[\d.]*\s*[–−-]\s*[−-]?\d[\d.]*\s*\)$/.test(i.text.trim())) ||
      columnRects.filter((_, c) =>
        /^\(\s*[−-]?\d[\d.]*\s*[–−-]\s*[−-]?\d[\d.]*\s*\)$/.test(
          g
            .filter((i) => columnOf(i) === c)
            .map((i) => i.text)
            .join(' ')
        )
      ).length >= 2
  )
  const pairs = []
  if (columns.length <= 4 && sequenceGroups.length >= 4 && sequenceGroups.length % 2 === 0) {
    for (let i = 0; i < sequenceGroups.length; i += 2) {
      const a = sequenceGroups[i],
        b = sequenceGroups[i + 1]
      if (union(b)[1] - union(a)[3] > Math.max(...a.map((t) => t.height)) * 2) {
        pairs.length = 0
        break
      }
      pairs.push([union(a)[1], union(b)[3]])
    }
  } else if (columns.length >= 3 && columns.length <= 7 && intervalGroups.length >= 4) {
    for (const interval of intervalGroups) {
      const index = groups.indexOf(interval),
        previous = groups[index - 1]
      if (
        !previous ||
        new Set(previous.map(columnOf)).size < 2 ||
        union(interval)[1] - union(previous)[3] > Math.max(...previous.map((i) => i.height)) * 1.5
      ) {
        pairs.length = 0
        break
      }
      pairs.push([union(previous)[1], union(interval)[3]])
    }
  }
  if (
    !recordGrid?.completeSpans &&
    pairs.length >= 2 &&
    pairs.every((r, i) => !i || r[0] >= pairs[i - 1][1])
  ) {
    const headerRows = rows.filter((r) => r.rect[3] < pairs[0][0])
    rows.splice(
      0,
      rows.length,
      ...headerRows,
      ...pairs.map((r, i) => ({
        rect: [
          left,
          i ? (pairs[i - 1][1] + r[0]) / 2 : r[0],
          right,
          i < pairs.length - 1 ? (r[1] + pairs[i + 1][0]) / 2 : r[1]
        ],
        origin: 'source-text'
      }))
    )
    repairs.push('paired-source-records-recovered')
  }
  if (sourceGrid && !recordGrid?.completeSpans) {
    rows.splice(
      0,
      rows.length,
      ...(sourceGrid.header
        ? [sourceGrid.header]
        : rows.filter((row) => row.rect[3] <= sourceGrid.start)),
      ...sourceGrid.records
    )
    recoveredNumericSections = true
    repairs.push(
      intervalGrid
        ? 'repeated-interval-grid-recovered'
        : gradedGrid
          ? 'graded-count-grid-recovered'
          : centeredGrid
            ? 'centered-value-grid-recovered'
            : 'treatment-schedule-grid-recovered'
    )
  }
  // Wide statistical tables have many complete numeric lines, interspersed with
  // sparse P-value lines. Use those baselines instead of shifted model row bands.
  const numeric = (g) =>
    g.filter((i) => /^[<>≤≥−+-]?\d[\d.,]*$/.test(i.text.trim()) && columnOf(i) >= 2)
  const fullNumeric = groups.filter(
    (g) => new Set(numeric(g).map(columnOf)).size >= columns.length - 3
  )
  // Complete source recovery already preserves standalone section labels. The
  // numeric-only fallback would otherwise fold those labels into adjacent data.
  if (
    !recordGrid?.completeSpans &&
    !recoveredNumericSections &&
    columns.length >= 8 &&
    fullNumeric.length >= 10
  ) {
    const first = groups.indexOf(fullNumeric[0])
    const body = groups.slice(first)
    if (body.every((g) => numeric(g).length >= 3 || g.every((i) => columnOf(i) === 0))) {
      const numericRows = body.filter((g) => numeric(g).length >= 3)
      const headers = rows.filter((r) => r.rect[3] < union(numericRows[0])[1])
      rows.splice(
        0,
        rows.length,
        ...headers,
        ...numericRows.map((g, i) => ({
          rect: [
            left,
            i ? (union(numericRows[i - 1])[3] + union(g)[1]) / 2 : union(g)[1],
            right,
            i < numericRows.length - 1
              ? (union(g)[3] + union(numericRows[i + 1])[1]) / 2
              : union(g)[3]
          ],
          origin: 'source-text'
        }))
      )
      repairs.push('dense-statistical-rows-recovered')
    }
  }
  // Overlapping header predictions may describe the very same source line.
  // Collapse only that duplicate band, preserving real multi-line headers.
  for (let index = rows.length - 1; index > 0; index--) {
    const row = rows[index],
      previous = rows[index - 1]
    if (!objects.some((o) => o.label === 'table column header' && intersect(o.rect, row.rect) > 0))
      continue
    const owned = items.filter((item) => inside(row.rect, item))
    if (row.rect[1] < previous.rect[3] && owned.every((item) => inside(previous.rect, item))) {
      previous.rect[3] = Math.max(
        previous.rect[3],
        ...items.filter((item) => inside(previous.rect, item)).map((item) => item.rect[3])
      )
      rows.splice(index, 1)
      repairs.push('duplicate-header-band-removed')
    }
  }
  separateCountedCategoryHeader({
    rows,
    groups,
    columnRects,
    headers: objects.filter((object) => object.label === 'table column header'),
    repairs
  })
  // Small capitals share a baseline but have different top edges. A model cut
  // through that baseline can strand half a heading in the next row. Require
  // two spanning parent labels above column-contained leaf labels and data.
  const numericStart = groups.findIndex((group) => {
    const values = columnRects.slice(1).map((_, c) =>
      group
        .filter((item) => columnOf(item) === c + 1)
        .map((item) => item.text)
        .join(' ')
        .trim()
    )
    return (
      values.filter((value) => /^[<>≤≥−+-]?\d[\d\s.,()%–−+±\-/]*$/.test(value)).length >= 2 &&
      group.some((item) => columnOf(item) === 0 && item.text.trim())
    )
  })
  const modelHeaderTop = Math.min(
    ...objects.filter((o) => o.label === 'table column header').map((o) => o.rect[1])
  )
  const headerGroups =
    numericStart < 0
      ? []
      : groups.slice(0, numericStart).filter((group) => union(group)[3] >= modelHeaderTop)
  // Numeric-row recovery can leave parent names and sample sizes in the same
  // band as their leaf labels. Parallel source underlines establish the split.
  const leafHeader = groups[numericStart - 1]
  let mixedHeaderColumns = []
  let mixedHeaderGroups = []
  if (numericStart >= 2 && leafHeader && columns.length >= 5 && externalCaptions.length) {
    const leafRect = union(leafHeader)
    const parentItems = groups.slice(0, numericStart - 1).flat()
    const parentRect = union(parentItems)
    const underlines = rules
      .filter(
        (r) =>
          r[1] === r[3] &&
          r[1] >= Math.min(...parentItems.map((i) => i.rect[3])) &&
          r[1] <= leafRect[1] + 1 &&
          r[2] - r[0] < (right - left) * 0.8
      )
      .sort((a, b) => a[0] - b[0])
    const children = underlines.map((r) =>
      leafHeader.filter((i) => i.rect[0] >= r[0] - 2 && i.rect[2] <= r[2] + 2)
    )
    const groupedParents = parentItems.filter((i) =>
      underlines.some((r) => i.rect[0] >= r[0] - 1 && i.rect[2] <= r[2] + 1)
    )
    const independentParents = parentItems.filter((i) => !groupedParents.includes(i))
    const independentColumns = [...new Set(independentParents.map(columnOf))]
    // Statistical comparison headings can occupy both header lines beside
    // underlined treatment groups. Require a complete P-value label in each
    // independent column; never infer a group from proximity alone.
    const mixed =
      groupedParents.length > 0 &&
      independentColumns.length > 0 &&
      independentColumns.every((column) => {
        const parent = independentParents.filter((i) => columnOf(i) === column)
        const child = leafHeader.filter((i) => columnOf(i) === column)
        return (
          column > 0 &&
          parent.some((i) => /\p{L}/u.test(i.text)) &&
          /^\(p\s*value\)$/i.test(
            child
              .map((i) => i.text)
              .join(' ')
              .trim()
          ) &&
          [...parent, ...child].every(
            (i) =>
              i.rect[0] >= columnRects[column][0] - 1 && i.rect[2] <= columnRects[column][2] + 1
          ) &&
          !children.some((g) => g.some((i) => columnOf(i) === column))
        )
      })
    const groupRect = mixed ? union(groupedParents) : parentRect
    const oldHeader = rows.filter((r) => r.rect[1] < leafRect[3])
    if (
      underlines.length >= 2 &&
      groupRect[3] < leafRect[1] &&
      leafRect[3] - parentRect[1] <= Math.max(...leafHeader.map((i) => i.height)) * 5 &&
      objects.some((o) => o.label === 'table column header' && intersect(o.rect, leafRect) > 0) &&
      underlines.every(
        (r, n) =>
          (!n || (r[0] > underlines[n - 1][2] && Math.abs(r[1] - underlines[0][1]) < 1)) &&
          r[1] >= groupRect[3] &&
          parentItems.some(
            (i) => /\p{L}/u.test(i.text) && i.rect[0] >= r[0] && i.rect[2] <= r[2]
          ) &&
          new Set(children[n].map(columnOf)).size >= 2
      ) &&
      (mixed || independentParents.length === 0) &&
      leafHeader.every(
        (i) =>
          columnOf(i) === 0 ||
          children.some((g) => g.includes(i)) ||
          (mixed && independentColumns.includes(columnOf(i)))
      ) &&
      oldHeader.length === 1 &&
      oldHeader.every((r) => r.rect[3] < union(groups[numericStart])[1])
    ) {
      const split = (groupRect[3] + leafRect[1]) / 2
      rows.splice(
        0,
        oldHeader.length,
        { rect: [left, parentRect[1], right, split], origin: 'source-underlined-parent' },
        { rect: [left, split, right, leafRect[3]], origin: 'source-underlined-parent' }
      )
      repairs.push('underlined-parent-band-recovered')
      if (mixed) {
        mixedHeaderColumns = independentColumns
        mixedHeaderGroups = children.map((g) => [...new Set(g.map(columnOf))])
      }
    }
  }
  const smallCaps = headerGroups.some((group) =>
    group.some(
      (item) =>
        /^[A-Z]+$/.test(item.text) &&
        group.some(
          (other) =>
            other !== item &&
            /^[A-Z]+$/.test(other.text) &&
            Math.abs(other.baseline - item.baseline) < 0.01 &&
            other.height >= item.height * 1.2 &&
            Math.abs(item.rect[0] - other.rect[2]) < item.height * 0.1
        )
    )
  )
  const parentIndex = smallCaps
    ? headerGroups.findIndex((group) => {
        const runs = []
        for (const item of [...group].sort((a, b) => a.rect[0] - b.rect[0])) {
          const last = runs.at(-1)
          if (last && item.rect[0] - last.rect[2] <= item.height * 0.5)
            last.rect = union([last, item])
          else runs.push({ rect: [...item.rect] })
        }
        return (
          runs.filter(
            (run) =>
              columnRects.filter(
                (bounds) =>
                  intersect([bounds[0], run.rect[1], bounds[2], run.rect[3]], run.rect) /
                    area(run.rect) >
                  0.05
              ).length >= 2
          ).length >= 2
        )
      })
    : -1
  if (
    parentIndex >= 0 &&
    parentIndex < headerGroups.length - 1 &&
    objects.some((o) => o.label === 'table column header') &&
    headerGroups
      .slice(parentIndex + 1)
      .every((group) => group.every((item) => columnOf(item) >= 0)) &&
    headerGroups
      .slice(parentIndex + 1)
      .flat()
      .some((item) => /\p{L}/u.test(item.text))
  ) {
    const parent = union(headerGroups.slice(0, parentIndex + 1).flat())
    const leaf = union(headerGroups.slice(parentIndex + 1).flat())
    if (parent[3] < leaf[1]) {
      const split = (parent[3] + leaf[1]) / 2
      rows.splice(
        0,
        rows.length,
        { rect: [left, parent[1], right, split], origin: 'small-caps-header' },
        { rect: [left, split, right, leaf[3]], origin: 'small-caps-header' },
        ...rows.filter((row) => row.rect[3] >= union(groups[numericStart])[3])
      )
      repairs.push('small-caps-header-recovered')
    }
  }
  if (table.splitCaptionedRegion) {
    // Discard empty bands left where the detector crossed the second caption.
    for (let r = rows.length - 1; r >= 0; r--)
      if (!items.some((i) => inside(rows[r].rect, i))) rows.splice(r, 1)
    // A dangling conjunction belongs to the next lowercase stub when the
    // continuation carries a complete numeric record on the same baseline.
    for (const prefix of items.filter(
      (i) => columnOf(i) === 0 && /\b(?:and|or)$/.test(i.text.trim())
    )) {
      const tail = items
        .filter(
          (i) =>
            columnOf(i) === 0 &&
            /^[a-z]/.test(i.text) &&
            i.baseline > prefix.baseline &&
            i.baseline - prefix.baseline < prefix.height * 1.8 &&
            Math.abs(i.rect[0] - prefix.rect[0]) < prefix.height
        )
        .sort((a, b) => a.baseline - b.baseline)[0]
      if (
        !tail ||
        columnRects
          .slice(1)
          .some(
            (_, c) =>
              !items.some(
                (i) =>
                  columnOf(i) === c + 1 &&
                  Math.abs(i.baseline - tail.baseline) < tail.height * 0.35 &&
                  /^\d+$/.test(i.text.trim())
              )
          )
      )
        continue
      const nearest = (item) =>
        rows.reduce(
          (best, row, r) =>
            Math.abs((row.rect[1] + row.rect[3]) / 2 - item.baseline + item.height / 2) <
            Math.abs(
              (rows[best].rect[1] + rows[best].rect[3]) / 2 - item.baseline + item.height / 2
            )
              ? r
              : best,
          0
        )
      const r = nearest(prefix),
        next = nearest(tail)
      if (next !== r + 1) continue
      rows[next].rect[1] = prefix.rect[1]
      rows.splice(r, 1)
      repairs.push('split-table-wrapped-label-recovered')
    }
  }
  repairWrappedTableRows({ rows, items, groups, columnRects, rules, right, repairs })
  const ruledStubGrid = externalCaptions.length
    ? recoverRuledStubGrid(table.cropRect, columns, items, rules)
    : undefined
  if (ruledStubGrid) {
    const { xs, ys } = ruledStubGrid
    rows.splice(
      0,
      rows.length,
      ...ys.slice(1).map((y, r) => ({
        rect: [xs[0], ys[r], xs.at(-1), y],
        origin: 'source-ruled-stub'
      }))
    )
    columnRects.splice(
      0,
      columnRects.length,
      ...xs.slice(1).map((x, c) => [xs[c], ys[0], x, ys.at(-1)])
    )
    cuts.splice(0, cuts.length, ...xs.slice(1, -1))
    recoveredHeaderCuts = undefined
    repairs.push('closed-stub-grid-recovered')
  }
  // A run of complete, single-line numeric records can straddle shifted model
  // boundaries. Realign only rows containing exclusively those source records;
  // wrapped descriptions and shared statistics keep their existing ownership.
  if (
    externalCaptions.length &&
    columns.length >= 3 &&
    (!repairs.includes('text-supported-section-row-recovered') ||
      items.some((i) => i.text.trim() === '…'))
  ) {
    // An explicit missing-statistic marker provides a complete source record
    // even after a projected section was recovered. Other section tables keep
    // their existing row ownership, including raised note markers.
    // A section/criterion table has two textual stubs followed by complete
    // counts. Establish this from several independently labelled sections;
    // a numeric category or time-point column is not a second textual stub.
    const twoStubs =
      columns.length >= 5 &&
      groups.filter(
        (g) =>
          [0, 1].every((c) =>
            g.some((i) => columnOf(i) === c && /^[A-Za-z][A-Za-z -]{7,}$/.test(i.text))
          ) &&
          columnRects
            .slice(2)
            .every((_, c) =>
              g.some((i) => columnOf(i) === c + 2 && /^\d+\s*\(\d+%\)$/.test(i.text))
            )
      ).length >= 3
    const records = groups.filter((group) => {
      const parts = columnRects.map((_, c) => group.filter((i) => columnOf(i) === c))
      return (
        parts[twoStubs ? 1 : 0].some((i) => /\p{L}/u.test(i.text)) &&
        parts.slice(twoStubs ? 2 : 1).every((part, offset) => {
          const text = part.map((i) => i.text).join(' ')
          const column = offset + (twoStubs ? 2 : 1)
          // Standalone stars are complete values only in a source-labelled
          // P column. An absent value or prose marker cannot complete a row.
          const significance =
            /^\*{1,3}$/.test(text) &&
            groups.some((g) =>
              g.some((i) => columnOf(i) === column && /^P(?:[ -]value)?$/i.test(i.text))
            )
          return (
            part.length &&
            (significance || /^(?:[–−—…-]|[<>≤≥−+-]?\s*\d[\d\s.,()%±*–−+\-/]*)$/.test(text))
          )
        })
      )
    })
    if (twoStubs) {
      for (const record of records) {
        const tail = groups[groups.indexOf(record) + 1]
        if (
          tail?.length &&
          tail.every((i) => columnOf(i) === 1) &&
          /^[a-z]/.test(tail[0].text) &&
          union(tail)[1] - union(record)[3] >= 0 &&
          union(tail)[1] - union(record)[3] < tail[0].height &&
          Math.abs(tail[0].rect[0] - record.find((i) => columnOf(i) === 1).rect[0]) < 2
        ) {
          records[records.indexOf(record)] = [...record, ...tail]
        }
      }
    }
    if (records.length >= 3) {
      const members = new Set(records.flat())
      const eligible = rows.filter((row) => {
        const owned = items.filter((i) => intersect(row.rect, i.rect) / area(i.rect) > 0.5)
        return (
          owned.every((i) => members.has(i)) &&
          records.some((g) => intersect(row.rect, union(g)) > 0)
        )
      })
      const supportedRecords = records.filter((g) =>
        rows
          .filter((r) => g.some((i) => intersect(r.rect, i.rect) / area(i.rect) > 0.5))
          .every((r) => eligible.includes(r))
      )
      const selected = supportedRecords.filter(
        (g) =>
          (twoStubs && union(g)[3] - union(g)[1] > g[0].height * 1.5) ||
          g.some((i) => {
            const overlaps = rows
              .map((r) => intersect(r.rect, i.rect) / area(i.rect))
              .filter((v) => v > 0.5)
              .sort((a, b) => b - a)
            return !overlaps.length || (overlaps.length > 1 && overlaps[0] - overlaps[1] < 0.1)
          })
      )
      // Keep complete neighboring records when they share the same bad row.
      for (const g of selected)
        for (const row of eligible.filter((r) =>
          g.some((i) => intersect(r.rect, i.rect) / area(i.rect) > 0.5)
        )) {
          for (const other of supportedRecords)
            if (
              !selected.includes(other) &&
              other.some((i) => intersect(row.rect, i.rect) / area(i.rect) > 0.5)
            )
              selected.push(other)
        }
      const replaced = eligible.filter(
        (row) =>
          selected.some((g) => intersect(row.rect, union(g)) > 0) &&
          items
            .filter((i) => intersect(row.rect, i.rect) / area(i.rect) > 0.5)
            .every((i) => selected.some((g) => g.includes(i)))
      )
      if (
        selected.length >= 1 &&
        replaced.length &&
        selected.every((g) => union(g)[1] >= top && union(g)[3] <= bottom)
      ) {
        rows.splice(
          0,
          rows.length,
          ...rows.filter((r) => !replaced.includes(r)),
          ...selected.map((g) => ({
            rect: [left, union(g)[1], right, union(g)[3]],
            origin: 'source-text',
            numericRecord: true
          }))
        )
        rows.sort((a, b) => a.rect[1] - b.rect[1])
        repairs.push('complete-numeric-records-aligned')
      }
    }
  }
  // A missing terminal categorical record can have deliberately empty statistic
  // columns. Append it only when the same label and occupied count columns occur
  // in several earlier source lines; never shift existing row or span indices.
  if (externalCaptions.length && columns.length >= 4 && rows.length) {
    const lastBottom = Math.max(...rows.map((row) => row.rect[3]))
    const categorical = groups.flatMap((group) => {
      const parts = columnRects.map((_, c) => group.filter((i) => columnOf(i) === c))
      const stub = parts[0]
        .map((i) => i.text)
        .join(' ')
        .trim()
      const counts = parts.slice(1)
      if (
        !/^[A-Za-z][A-Za-z -]+$/.test(stub) ||
        counts.filter((part) => part.length).length < 2 ||
        counts.every((part) => part.length) ||
        counts.some((part) => part.length && !/^\d+$/.test(part.map((i) => i.text).join(''))) ||
        group.some((i) => columnOf(i) < 0 || !inside(columnRects[columnOf(i)], i))
      )
        return []
      return [
        { group, stub, signature: counts.map((part) => Number(Boolean(part.length))).join('') }
      ]
    })
    for (const candidate of categorical) {
      const bounds = union(candidate.group)
      if (
        bounds[1] < lastBottom ||
        bounds[3] > bottom ||
        bounds[1] - lastBottom > candidate.group[0].height * 2 ||
        categorical.filter(
          (other) =>
            other.stub === candidate.stub &&
            other.signature === candidate.signature &&
            union(other.group)[3] <= lastBottom
        ).length < 2 ||
        items.some(
          (i) => i.rect[1] >= lastBottom && i.rect[3] <= bounds[3] && !candidate.group.includes(i)
        )
      )
        continue
      rows.push({
        rect: [left, bounds[1], right, bounds[3]],
        origin: 'source-text',
        numericRecord: true
      })
      repairs.push('terminal-categorical-record-recovered')
      break
    }
  }
  // Nested population and treatment underlines establish three header tiers,
  // even when PDF text runs cross the boundaries between grade labels.
  let ruledTierSpans
  if (
    !recordGrid &&
    externalCaptions.length &&
    columns.length >= 9 &&
    (columns.length - 1) % 4 === 0 &&
    rows.length >= 3
  ) {
    const firstData = groups.find((g) =>
      columnRects
        .slice(1)
        .every((_, c) => g.some((i) => columnOf(i) === c + 1 && /^\d/.test(i.text)))
    )
    if (firstData) {
      const dataTop = union(firstData)[1] - 2
      const headerRules = rules.filter(
        (r) => r[1] === r[3] && r[1] > top && r[1] < dataTop && r[0] > columnRects[0][2] - 24
      )
      const levels = [...Map.groupBy(headerRules, (r) => Math.round(r[1])).values()].sort(
        (a, b) => a[0][1] - b[0][1]
      )
      if (
        levels.length === 2 &&
        levels[0].length === (columns.length - 1) / 4 &&
        levels[1].length === (columns.length - 1) / 2
      ) {
        const parents = levels[0].sort((a, b) => a[0] - b[0]),
          children = levels[1].sort((a, b) => a[0] - b[0])
        let leaf =
          groups
            .find(
              (g) =>
                g.some((i) => columnOf(i) > 0) &&
                g.every((i) => i.rect[1] >= children[0][1] && i.rect[3] < dataTop)
            )
            ?.filter((i) => columnOf(i) > 0)
            .sort((a, b) => a.rect[0] - b.rect[0]) ?? []
        const compact = leaf
          .map((i) => i.text)
          .join('')
          .replace(/\s/g, '')
        const repeatedGrades = compact === 'Anygrade≥Grade3'.repeat(children.length)
        const headerEnd = repeatedGrades ? union(leaf)[3] + 2 : dataTop
        if (!repeatedGrades)
          leaf = items.filter((i) => i.rect[1] >= children[0][1] && i.rect[3] < dataTop)
        const labels = columnRects.slice(1).map((_, c) =>
          leaf
            .filter((i) => columnOf(i) === c + 1)
            .map((i) => i.text)
            .join(' ')
            .replace(/\s/g, '')
        )
        const supported =
          (repeatedGrades ||
            labels.every((t, c) => (c % 2 ? /^Grade3\/4$/i.test(t) : /^Allgrades$/i.test(t)))) &&
          parents.every((p, n) =>
            children.slice(n * 2, n * 2 + 2).every((c) => c[0] >= p[0] - 1 && c[2] <= p[2] + 1)
          )
        const head = items.filter(
          (i) => i.rect[3] <= parents[0][1] && i.rect[1] >= top && columnOf(i) !== 0
        )
        if (
          supported &&
          head.length === parents.length &&
          parents.every((p) => head.some((i) => i.rect[0] >= p[0] - 1 && i.rect[2] <= p[2] + 1))
        ) {
          const start = Math.min(...head.map((i) => i.rect[1]))
          const bands = [start, parents[0][1], children[0][1], headerEnd]
          const oldHeader = rows.filter((r) => (r.rect[1] + r.rect[3]) / 2 < headerEnd)
          if (oldHeader.every((r) => r.rect[3] <= union(firstData)[1])) {
            rows.splice(
              0,
              rows.length,
              ...bands
                .slice(1)
                .map((y, n) => ({ rect: [left, bands[n], right, y], origin: 'source-text' })),
              ...rows.filter((r) => !oldHeader.includes(r))
            )
            ruledTierSpans = [
              ...parents.map((_, n) => ({ row: 0, column: 1 + n * 4, rowSpan: 1, colSpan: 4 })),
              ...children.map((_, n) => ({ row: 1, column: 1 + n * 2, rowSpan: 1, colSpan: 2 })),
              { row: 0, column: 0, rowSpan: 3, colSpan: 1 }
            ]
            if (repeatedGrades) {
              // Exact repeated source wording and the nested underlines establish
              // each pair. Do not split arbitrary words using estimated glyph widths.
              const rect = union(leaf)
              for (let i = items.length - 1; i >= 0; i--)
                if (leaf.includes(items[i])) items.splice(i, 1)
              items.push(
                ...columnRects.slice(1).map((c, n) => ({
                  ...leaf[0],
                  text: n % 2 ? '≥ Grade 3' : 'Any grade',
                  rect: [c[0] + 1, rect[1], c[2] - 1, rect[3]]
                }))
              )
            }
            repairs.push('ruled-header-tiers-recovered')
          }
        }
      }
    }
  }
  // Short comparison rows share one centered statistic under each ruled
  // treatment pair. Recover these rows without changing neighboring arm data.
  const ruledComparisonRows = []
  const independentArmGroups = []
  if (!recordGrid && externalCaptions.length && columns.length >= 5 && columns.length % 2 === 1) {
    const pairs = (columns.length - 1) / 2
    const levels = [
      ...Map.groupBy(
        rules.filter(
          (r) =>
            r[1] === r[3] &&
            r[1] < top + (bottom - top) * 0.25 &&
            r[1] > top &&
            r[0] > columnRects[0][2] - 24
        ),
        (r) => Math.round(r[1])
      ).values()
    ]
    const underlines = levels.find(
      (level) =>
        level.length === pairs &&
        level
          .sort((a, b) => a[0] - b[0])
          .every(
            (r, n) =>
              Math.abs(r[0] - columnRects[1 + n * 2][0]) < 24 &&
              Math.abs(r[2] - columnRects[2 + n * 2][2]) < 24
          )
    )
    const numeric = (text) =>
      /^[<>≤≥]?\s*[–−+-]?(?:\d|\.)[\d.,()%±–−+\s/-]*(?:to\s*[–−+-]?\d[\d.]*)?\)?$/.test(text.trim())
    if (underlines) {
      const complete = groups.filter(
        (g) =>
          g[0].rect[1] > underlines[0][1] &&
          columnRects.slice(1).every((_, c) => {
            const parts = g.filter((i) => columnOf(i) === c + 1)
            return (
              parts.length === 1 &&
              (numeric(parts[0].text) || /^\([\d.]+ to [\d.]+\)$/.test(parts[0].text))
            )
          })
      )
      const shared = groups.filter((g) => {
        const label = g
          .filter((i) => columnOf(i) === 0)
          .sort((a, b) => a.rect[0] - b.rect[0])
          .map((i) => i.text)
          .join(' ')
        const values = g.filter((i) => columnOf(i) !== 0).sort((a, b) => a.rect[0] - b.rect[0])
        return (
          /^(?:Difference between groups|95%\s*(?:CI|Confidence interval)|Ratio over|p[- ]value)/i.test(
            label
          ) &&
          values.length === pairs &&
          values.every(
            (i, n) =>
              numeric(i.text) &&
              i.rect[0] >= underlines[n][0] - 4 &&
              i.rect[2] <= underlines[n][2] + 4 &&
              Math.abs((i.rect[0] + i.rect[2] - underlines[n][0] - underlines[n][2]) / 2) <
                (underlines[n][2] - underlines[n][0]) * 0.16
          )
        )
      })
      if (complete.length >= 3 && shared.length >= 2) {
        independentArmGroups.push(...complete)
        const sharedRecords = shared.map((g) => [
          ...g,
          ...items.filter(
            (i) =>
              !g.includes(i) &&
              /^[a-z]\)$/.test(i.text) &&
              columnOf(i) === 0 &&
              i.height < Math.max(...g.map((part) => part.height)) * 0.8 &&
              intersect(union(g), i.rect) / area(i.rect) > 0.5
          )
        ])
        const records = [...sharedRecords, ...complete]
        const members = new Set(records.flat())
        const replaced = rows.filter(
          (r) =>
            records.some((g) => intersect(r.rect, union(g)) > 0) &&
            items
              .filter((i) => intersect(r.rect, i.rect) / area(i.rect) > 0.5)
              .every((i) => members.has(i))
        )
        const recoveredMembers = new Set()
        for (const g of records) {
          if (
            rows.some(
              (r) =>
                !replaced.includes(r) &&
                g.some((i) => intersect(r.rect, i.rect) / area(i.rect) > 0.5)
            )
          )
            continue
          for (const item of g) recoveredMembers.add(item)
          ruledComparisonRows.push({
            rect: [left, union(g)[1], right, union(g)[3]],
            origin: 'source-comparison',
            comparisonPairs: sharedRecords.includes(g)
          })
        }
        if (ruledComparisonRows.length) {
          rows.splice(
            0,
            rows.length,
            ...rows.filter(
              (r) =>
                !replaced.includes(r) ||
                !ruledComparisonRows.some((n) => intersect(r.rect, n.rect) > 0) ||
                items.some(
                  (i) => intersect(r.rect, i.rect) / area(i.rect) > 0.5 && !recoveredMembers.has(i)
                )
            ),
            ...ruledComparisonRows
          )
          rows.sort((a, b) => a.rect[1] - b.rect[1])
          repairs.push('ruled-pair-statistics-recovered')
        }
      }
    }
  }
  // An explicit Median (range) label binds a complete row of parenthesized
  // ranges to the preceding per-column estimates, even for a single record.
  for (let r = 1; columnRects.length >= 3 && r < rows.length; r++) {
    const previous = rows[r - 1],
      current = rows[r]
    const prior = items.filter((i) => inside(previous.rect, i))
    const tail = items.filter((i) => inside(current.rect, i))
    const label = prior.filter((i) => columnOf(i) === 0)
    if (
      label.length !== 1 ||
      !/^Median\s*\(range\)$/i.test(label[0].text.trim()) ||
      !tail.length ||
      tail.some((i) => columnOf(i) <= 0) ||
      columnRects.slice(1).some((_, c) => {
        const a = prior.filter((i) => columnOf(i) === c + 1),
          b = tail.filter((i) => columnOf(i) === c + 1)
        return (
          a.length !== 1 ||
          b.length !== 1 ||
          !/^[−-]?\d+(?:\.\d+)?$/.test(a[0].text.trim()) ||
          !/^\([−-]?\d+(?:\.\d+)?\s*(?:to|[–−-])\s*[−-]?\d+(?:\.\d+)?\)$/.test(b[0].text.trim()) ||
          b[0].baseline - a[0].baseline <= a[0].height ||
          b[0].baseline - a[0].baseline > a[0].height * 1.7
        )
      }) ||
      rules.some(
        (rule) =>
          rule[1] === rule[3] &&
          rule[1] > union(prior)[3] &&
          rule[1] < union(tail)[1] &&
          rule[0] <= left + 2 &&
          rule[2] >= right - 2
      )
    )
      continue
    previous.rect[3] = current.rect[3]
    rows.splice(r--, 1)
    repairs.push('median-range-continuation-recovered')
  }
  if (!recordGrid && externalCaptions.length)
    mergeDuplicateSourceRows({ rows, groups, items, columnRects, repairs })
  recoverProjectedSectionRows({
    rows,
    items,
    groups,
    columnRects,
    headers: objects.filter((o) => o.label === 'table projected row header'),
    repairs
  })
  if (!recordGrid?.completeSpans)
    recoverRepeatedMeasurementSections({ rows, groups, items, columnRects, repairs })
  const parentRowSpans =
    !recordGrid && !ruledTierSpans && externalCaptions.length
      ? splitRuledParentRow({ rows, items, columnRects, rules, repairs })
      : undefined
  const baseCells = rows.flatMap((r, row) =>
    columnRects.map((c, column) => ({
      row,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect: [
        row === 0 && recoveredHeaderCuts && column ? recoveredHeaderCuts[column - 1] : c[0],
        r.rect[1],
        row === 0 && recoveredHeaderCuts && column < cuts.length
          ? recoveredHeaderCuts[column]
          : c[2],
        r.rect[3]
      ],
      origin: 'model-grid'
    }))
  )
  const proposals = []
  for (const frame of bracketHeaders) {
    const slots = baseCells.filter(
      (cell) =>
        cell.row === 0 &&
        (cell.rect[0] + cell.rect[2]) / 2 >= frame[0] &&
        (cell.rect[0] + cell.rect[2]) / 2 <= frame[2]
    )
    if (slots.length >= 2) proposals.push({ slots, origin: 'source-bracket-header' })
  }
  rows.forEach((row, index) => {
    if (row.sectionSuffix)
      proposals.push({
        slots: baseCells.filter((cell) => cell.row === index),
        origin: 'source-section'
      })
  })
  for (const span of centeredGrid?.spans ?? []) {
    proposals.push({
      slots: baseCells.filter(
        (cell) =>
          cell.row === span.row &&
          cell.column >= span.column &&
          cell.column < span.column + span.colSpan
      ),
      origin: 'source-centered-values'
    })
  }
  // A ruled header may contain a group name, sample size and n (%) on three
  // baselines. These are one leaf label per column, not parent/child columns.
  let unitHeaderRect
  if (rows.length >= 3 && columns.length >= 3 && externalCaptions.length) {
    const head = items.filter((i) => inside([left, rows[0].rect[1], right, rows[1].rect[3]], i))
    const tails = columnRects.map((_, c) =>
      head
        .filter((i) => columnOf(i) === c && inside(rows[1].rect, i))
        .map((i) => i.text)
        .join(' ')
        .trim()
    )
    if (
      head.length &&
      tails.filter(Boolean).length >= 2 &&
      tails.every((t) => !t || /^n\s*\(\s*%\s*\)$/i.test(t)) &&
      columnRects.every((_, c) =>
        head.some((i) => columnOf(i) === c && inside(rows[0].rect, i) && /\p{L}/u.test(i.text))
      ) &&
      objects.filter(
        (o) =>
          o.label === 'table spanning cell' &&
          intersect(o.rect, rows[0].rect) > 0 &&
          intersect(o.rect, rows[1].rect) > 0
      ).length >= 2
    ) {
      const ink = union(head),
        height = Math.max(...head.map((i) => i.height))
      const borders = rules.filter(
        (r) => r[1] === r[3] && Math.min(right, r[2]) - Math.max(left, r[0]) >= (right - left) * 0.9
      )
      if (
        borders.some((r) => r[1] <= ink[1] && ink[1] - r[1] <= height) &&
        borders.some((r) => r[1] >= ink[3] && r[1] - ink[3] <= height) &&
        !borders.some((r) => r[1] > ink[1] && r[1] < ink[3])
      ) {
        unitHeaderRect = [left, rows[0].rect[1], right, rows[1].rect[3]]
        for (let column = 0; column < columns.length; column++)
          proposals.push({
            slots: baseCells.filter((c) => c.column === column && c.row <= 1),
            origin: 'source-unit-header'
          })
        repairs.push('ruled-unit-header-recovered')
      }
    }
  }
  for (const [row, band] of rows.entries())
    if (band.origin === 'ruled-table-title')
      proposals.push({ slots: baseCells.filter((c) => c.row === row), origin: 'ruled-table-title' })
  for (const span of objects.filter(
    (o) => !recordGrid && /spanning cell|projected row header/.test(o.label)
  )) {
    if (
      unitHeaderRect &&
      span.label === 'table spanning cell' &&
      span.rect[1] >= unitHeaderRect[1] - 2 &&
      span.rect[3] <= unitHeaderRect[3] + 2
    )
      continue
    const slots = baseCells.filter((c) => intersect(c.rect, span.rect) / area(c.rect) > 0.5)
    const spanSource = items.filter(
      (item) => intersect(item.rect, span.rect) / area(item.rect) > 0.5
    )
    if (
      spanSource.length &&
      baseCells.some(
        (cell) =>
          cell.column === 0 &&
          rows[cell.row].recoveredWrappedStub &&
          spanSource.every((item) => intersect(cell.rect, item.rect) / area(item.rect) > 0.8)
      )
    )
      continue
    if (
      (scheduleGrid || centeredGrid) &&
      spanSource.length &&
      spanSource.every((item) =>
        rows.some((row) => (row.numericRecord || row.section) && inside(row.rect, item))
      )
    )
      continue
    if (
      recoveredComparisonStatistics &&
      spanSource.length &&
      spanSource.every((item) =>
        rows.some((row) => row.origin === 'source-comparison' && inside(row.rect, item))
      )
    )
      continue
    // Recovered source records/header bands supersede fragments of a model span.
    // Only ignore it when all of its text is now accounted for in the recovered area.
    if (
      spanSource.length &&
      ((repairs.includes('sample-interval-records-recovered') &&
        spanSource.every((item) =>
          baseCells.some(
            (cell) => rows[cell.row].origin === 'source-text' && inside(cell.rect, item)
          )
        )) ||
        (slots.some((cell) => rows[cell.row].numericRecord) &&
          spanSource.every((item) =>
            baseCells.some(
              (cell) =>
                (rows[cell.row].numericRecord || rows[cell.row].section) && inside(cell.rect, item)
            )
          )) ||
        spanSource.every((item) =>
          rows.some((row) => row.origin === 'small-caps-header' && inside(row.rect, item))
        ))
    )
      continue
    if (
      slots.length > 1 &&
      new Set(slots.map((s) => s.row)).size === 1 &&
      spanSource.length &&
      objects.some((o) => o.label === 'table column header' && intersect(o.rect, span.rect) > 0) &&
      slots.some(
        (cell) =>
          spanSource.every((item) => inside(cell.rect, item)) &&
          rules.some(
            (r) =>
              r[1] === r[3] &&
              r[1] >= Math.max(...spanSource.map((i) => i.rect[3])) &&
              r[1] <= cell.rect[3] + 3 &&
              r[0] >= cell.rect[0] &&
              r[2] <= cell.rect[2] &&
              r[0] <= Math.min(...spanSource.map((i) => i.rect[0])) + 1 &&
              r[2] >= Math.max(...spanSource.map((i) => i.rect[2])) - 1
          )
      )
    )
      continue
    if (pairedRows && slots.some((s) => s.row >= pairedRows.first)) continue
    if (slots.length < 2) {
      // A model span over an already reconstructed single cell needs no merge.
      // Empty or genuinely cross-cell predictions remain unresolved.
      const spanItems = items.filter(
        (item) => intersect(item.rect, span.rect) / area(item.rect) > 0.5
      )
      if (
        !slots.length ||
        !spanItems.length ||
        spanItems.some((item) => intersect(item.rect, slots[0].rect) / area(item.rect) <= 0.8)
      )
        issues.add('unresolved-spanning-cells')
      continue
    }
    proposals.push({
      slots,
      origin: 'model-span',
      sectionHeader: span.label === 'table projected row header'
    })
  }
  for (const span of recordGrid?.spans ?? []) {
    proposals.push({
      slots: baseCells.filter(
        (cell) =>
          cell.column >= span.column &&
          cell.column < span.column + (span.colSpan ?? 1) &&
          cell.row >= span.row &&
          cell.row < span.row + span.rowSpan
      ),
      origin: 'text-supported-study-span'
    })
  }
  // An outdented standalone label followed by a complete numeric record is a
  // section heading. Replace partial model merges confined to that same row.
  for (const [row, band] of rows.entries()) {
    if (band.comparisonPairs) {
      if (ruledComparisonRows.includes(band)) {
        for (let i = proposals.length - 1; i >= 0; i--)
          if (proposals[i].slots.some((s) => s.row === row)) proposals.splice(i, 1)
      }
      for (let column = 1; column < columns.length; column += 2)
        proposals.push({
          slots: baseCells.filter(
            (cell) => cell.row === row && cell.column >= column && cell.column < column + 2
          ),
          origin: 'source-comparison-pair'
        })
    }
    if (!band.section) continue
    for (let index = proposals.length - 1; index >= 0; index--) {
      if (
        proposals[index].slots.every((slot) => slot.row === row) ||
        (band.centeredSection && proposals[index].slots.some((slot) => slot.row === row))
      )
        proposals.splice(index, 1)
    }
    proposals.push({
      slots: baseCells.filter((cell) => cell.row === row),
      origin: band.scheduleNote ? 'source-schedule-note' : 'source-section'
    })
  }
  // A ruled category block with one P value shares it across its category
  // records. Stop at the source border, never carry it into another variable.
  const categoryStatisticColumn = columns.length - 1
  for (let row = 1; row < rows.length; row++) {
    if (!rows[row - 1].section || !rows[row].statisticRecord) continue
    const border = rules
      .filter(
        (rule) =>
          rule[1] === rule[3] &&
          rule[1] >= rows[row].rect[3] &&
          rule[0] <= columnRects[categoryStatisticColumn][0] + 4 &&
          rule[2] >= columnRects[categoryStatisticColumn][2] - 4
      )
      .sort((a, b) => a[1] - b[1])[0]
    if (!border) continue
    let end = row
    while (end < rows.length && rows[end].statisticRecord && rows[end].rect[3] <= border[1]) end++
    if (
      end - row < 2 ||
      border[1] - rows[end - 1].rect[3] > rows[end - 1].rect[3] - rows[end - 1].rect[1]
    )
      continue
    const slots = baseCells.filter(
      (cell) => cell.column === categoryStatisticColumn && cell.row >= row && cell.row < end
    )
    const values = items.filter((item) => slots.some((slot) => inside(slot.rect, item)))
    if (values.length !== 1 || !/^[<>≤≥]?\s*(?:\d+(?:\.\d+)?|\.\d+)$/.test(values[0].text.trim()))
      continue
    if (proposals.some((p) => p.slots.some((slot) => slots.includes(slot)))) continue
    proposals.push({ slots, origin: 'source-category-statistic' })
  }
  if (pairedRows) {
    for (let column = 0; column < columns.length; column++) {
      if (pairedRows.valueColumns.includes(column)) continue
      const starts = rows.flatMap((row, index) =>
        index >= pairedRows.first &&
        items.some((item) => columnOf(item) === column && inside(row.rect, item))
          ? [index]
          : []
      )
      for (const [i, row] of starts.entries()) {
        const nextGroup =
          column > 0
            ? rows.findIndex(
                (candidate, index) =>
                  index > row &&
                  items.some((item) => columnOf(item) === 0 && inside(candidate.rect, item))
              )
            : -1
        const end = Math.min(starts[i + 1] ?? rows.length, nextGroup < 0 ? rows.length : nextGroup)
        if (end - row < 2) continue
        proposals.push({
          slots: baseCells.filter(
            (cell) => cell.column === column && cell.row >= row && cell.row < end
          ),
          origin: 'text-supported-paired-span'
        })
      }
    }
  }
  // A missing horizontal header span needs model header evidence plus populated child columns.
  const headers = objects.filter((o) => o.label === 'table column header')
  for (const column of mixedHeaderColumns) {
    const slots = baseCells.filter((c) => c.column === column && c.row <= 1)
    removeOverlappingMergeProposals(proposals, slots)
    proposals.push({ slots, origin: 'wrapped-interval-header' })
  }
  const headerRows = rows.flatMap((r, i) =>
    r.origin === 'source-native-header' ||
    r.origin === 'source-statistic-header' ||
    r.origin === 'source-underlined-parent' ||
    r.origin === 'small-caps-header' ||
    r.origin === 'source-repeated-header' ||
    r.origin === 'source-ruled-interval-header' ||
    headers.some(
      (h) =>
        intersect([left, r.rect[1], right, r.rect[3]], h.rect) /
          area([left, r.rect[1], right, r.rect[3]]) >
        0.5
    )
      ? [i]
      : []
  )
  const preceding = headerRows[0] - 1
  if (
    preceding >= 0 &&
    rows[preceding].origin === 'source-text' &&
    rows[preceding + 1].rect[1] - rows[preceding].rect[3] <=
      (rows[preceding].rect[3] - rows[preceding].rect[1]) * 2
  )
    headerRows.unshift(preceding)

  // PDF text operators split a single label (e.g. N, =, 125) into fragments.
  // Join only tightly adjacent fragments on the same baseline, not separate columns.
  const headerRuns = new Map(
    headerRows.map((row) => {
      const runs = []
      for (const group of groups) {
        let run
        for (const item of group
          .filter((i) => inside([left, rows[row].rect[1], right, rows[row].rect[3]], i))
          .sort((a, b) => a.rect[0] - b.rect[0])) {
          if (run && item.rect[0] - run.rect[2] <= item.height * 0.4) {
            run.rect = union([run, item])
          } else {
            run = { rect: [...item.rect], horizontal: true }
            runs.push(run)
          }
        }
      }
      // A raised note marker belongs to the adjacent heading, not to a second
      // parent label. Keep its source token intact for superscript rendering.
      for (let i = runs.length - 1; i >= 0; i--) {
        const marker = runs[i]
        const source = items.filter((item) => inside(marker.rect, item))
        if (source.length !== 1 || !/^[a-z\d*†‡]$/.test(source[0].text)) continue
        const owners = runs.filter(
          (run) =>
            run !== marker &&
            marker.rect[3] - marker.rect[1] < (run.rect[3] - run.rect[1]) * 0.8 &&
            marker.rect[0] - run.rect[2] >= -1 &&
            marker.rect[0] - run.rect[2] <= (run.rect[3] - run.rect[1]) * 0.35 &&
            marker.rect[3] < run.rect[3] &&
            marker.rect[3] > run.rect[1]
        )
        if (owners.length === 1) {
          owners[0].rect = union([owners[0], marker])
          rows[row].rect[1] = Math.min(rows[row].rect[1], marker.rect[1])
          for (const cell of baseCells.filter((c) => c.row === row))
            cell.rect[1] = rows[row].rect[1]
          runs.splice(i, 1)
        }
      }
      return [row, runs]
    })
  )
  const center = (r) => (r.rect[0] + r.rect[2]) / 2
  const populatedColumns = (row) =>
    columnRects.flatMap((c, column) =>
      headerRuns
        .get(row)
        ?.some(
          (run) =>
            intersect([c[0], rows[row].rect[1], c[2], rows[row].rect[3]], run.rect) /
              area(run.rect) >
            0.8
        )
        ? [column]
        : []
    )
  for (const row of [...headerRows].reverse()) {
    const runs = headerRuns.get(row)
    const childSpans = proposals.filter(
      (p) => p.origin === 'text-supported-header-span' && p.slots.every((s) => s.row === row + 1)
    )
    const childGroups = [
      ...childSpans.map((p) => p.slots.map((s) => s.column)),
      ...(headerRuns.has(row + 1) ? populatedColumns(row + 1) : [])
        .filter((column) => !childSpans.some((p) => p.slots.some((s) => s.column === column)))
        .map((column) => [column])
    ]
    for (const run of runs) {
      let columnsForRun = childGroups
        .filter((columns) => {
          const x = (columnRects[columns[0]][0] + columnRects[columns.at(-1)][2]) / 2
          const distances = runs
            .map((other) => ({ other, distance: Math.abs(center(other) - x) }))
            .sort((a, b) => a.distance - b.distance)
          return (
            distances[0].other === run &&
            (!distances[1] || distances[1].distance - distances[0].distance > 2)
          )
        })
        .flat()
        .sort((a, b) => a - b)
      // A shared units line needs both an adjacent populated header row and a
      // model span covering that full range; text width alone cannot imply it.
      if (runs.length === 1 && headerRuns.has(row - 1)) {
        const above = populatedColumns(row - 1)
        if (
          above.length > 1 &&
          proposals.some((p) =>
            above.every((column) => p.slots.some((s) => s.row === row && s.column === column))
          )
        )
          columnsForRun = above
      }
      if (
        columnsForRun.length < 2 ||
        columnsForRun.at(-1) - columnsForRun[0] + 1 !== columnsForRun.length
      )
        continue
      const slots = baseCells.filter((c) => c.row === row && columnsForRun.includes(c.column))
      const rect = union(slots)
      if (
        intersect(rect, run.rect) / area(run.rect) < 0.95 ||
        slots.filter((c) => intersect(c.rect, run.rect) / area(run.rect) > 0.05).length < 2 ||
        Math.abs(center(run) - center({ rect })) > (rect[2] - rect[0]) * 0.25 ||
        runs.some((other) => other !== run && intersect(rect, other.rect) > 0)
      )
        continue
      // This source-supported partition replaces overlapping model alternatives
      // only inside the recognized header. Body spans keep the conflict guards.
      removeOverlappingMergeProposals(proposals, slots, headerRows)
      proposals.push({ slots, origin: 'text-supported-header-span' })
    }
  }
  // A recovered ruled CI heading spans the two endpoints in its data row.
  for (const row of headerRows.filter((r) => rows[r].origin === 'source-ruled-interval-header')) {
    const interval = items.find((i) => inside(rows[row].rect, i) && /^\d+%\s*CI\b/.test(i.text))
    if (!interval) continue
    const slots = baseCells.filter((c) => c.row === row && c.column >= columns.length - 2)
    if (
      slots.length === 2 &&
      intersect(union(slots), interval.rect) / area(interval.rect) > 0.95 &&
      !items.some((i) => i !== interval && inside(union(slots), i))
    )
      proposals.push({ slots, origin: 'text-supported-header-span' })
  }
  // Beside a recovered interval span, single-column labels may wrap over both
  // header lines. Keep those words together without merging any data row.
  if (
    recoveredIntervalParent &&
    headerRows[0] === 0 &&
    headerRows.includes(1) &&
    proposals.some(
      (p) => p.origin === 'text-supported-header-span' && p.slots.every((s) => s.row === 0)
    )
  ) {
    for (const column of populatedColumns(0)) {
      const slots = baseCells.filter((c) => c.column === column && c.row <= 1)
      const label = items
        .filter((i) => inside(union(slots), i))
        .sort((a, b) => a.baseline - b.baseline)
      if (
        slots.length === 2 &&
        label.length > 0 &&
        label.every(
          (i, index) =>
            /\p{L}/u.test(i.text) &&
            (!index ||
              Math.abs(i.baseline - label[0].baseline) < i.height * 0.35 ||
              (i.baseline - label[index - 1].baseline <= i.height * 1.5 &&
                Math.abs((i.rect[0] + i.rect[2]) / 2 - (label[0].rect[0] + label[0].rect[2]) / 2) <=
                  i.height))
        ) &&
        !proposals.some((p) => p.slots.some((s) => slots.includes(s)))
      )
        proposals.push({ slots, origin: 'wrapped-interval-header' })
    }
  }
  // Ruled headers supply stronger evidence than text-centre proximity, especially
  // for left-aligned group labels. Require a closed box and populated child columns.
  for (const row of [...headerRows].reverse()) {
    if (!headerRuns.has(row + 1)) continue
    // An underline can delimit an unboxed parent header. Require its endpoints
    // to follow the populated child labels and exclude every other parent label.
    for (const rule of rules.filter(
      (r) =>
        r[3] - r[1] <= 1 &&
        r[1] >= rows[row].rect[3] - 1 &&
        r[3] <= Math.min(...headerRuns.get(row + 1).map((run) => run.rect[1])) + 1
    )) {
      // A left-aligned ancestor may cover multiple merged treatment headers.
      // Their validated spans and a matching underline define the full range,
      // even when another sample-size row intervenes before the leaf labels.
      const mergedChildren = proposals.filter(
        (p) =>
          p.slots.length >= 2 &&
          p.slots.every((cell) => cell.row === row + 1) &&
          union(p.slots)[0] >= rule[0] - 16 &&
          union(p.slots)[2] <= rule[2] + 16
      )
      const parentRuns = headerRuns
        .get(row)
        .filter((run) => run.rect[0] >= rule[0] - 1 && run.rect[2] <= rule[2] + 1)
      const childColumnsFromSpans = [
        ...new Set(mergedChildren.flatMap((p) => p.slots.map((cell) => cell.column)))
      ].sort((a, b) => a - b)
      if (
        mergedChildren.length >= 2 &&
        parentRuns.length === 1 &&
        childColumnsFromSpans.at(-1) - childColumnsFromSpans[0] + 1 ===
          childColumnsFromSpans.length &&
        Math.abs(columnRects[childColumnsFromSpans[0]][0] - rule[0]) <= 16 &&
        Math.abs(columnRects[childColumnsFromSpans.at(-1)][2] - rule[2]) <= 16
      ) {
        const slots = baseCells.filter(
          (cell) => cell.row === row && childColumnsFromSpans.includes(cell.column)
        )
        if (intersect(union(slots), parentRuns[0].rect) / area(parentRuns[0].rect) > 0.95) {
          removeOverlappingMergeProposals(proposals, slots, headerRows)
          proposals.push({ slots, origin: 'ruled-header-span' })
          continue
        }
      }
      const children = headerRuns
        .get(row + 1)
        .filter((run) => run.rect[0] >= rule[0] - 2 && run.rect[2] <= rule[2] + 2)
      const parents = headerRuns
        .get(row)
        .filter((run) => run.rect[0] < rule[2] && run.rect[2] > rule[0])
      const stacked = parents.slice().sort((a, b) => a.rect[1] - b.rect[1])
      const wrappedLabel =
        stacked.length > 1 &&
        stacked.every(
          (run, index) =>
            !index ||
            (run.rect[1] >= stacked[index - 1].rect[3] &&
              run.rect[1] - stacked[index - 1].rect[3] <= run.rect[3] - run.rect[1] &&
              (Math.abs(center(run) - center(stacked[0])) <= (run.rect[3] - run.rect[1]) * 0.5 ||
                (Math.abs(run.rect[0] - stacked[0].rect[0]) <= 1 &&
                  /^\([Nn]\s*=\s*\d+\)$/.test(
                    items
                      .filter((item) => inside(run.rect, item))
                      .sort((a, b) => a.rect[0] - b.rect[0])
                      .map((item) => item.text)
                      .join('')
                  ))))
        )
      if (wrappedLabel) parents.splice(0, parents.length, { rect: union(parents) })
      // A trial heading may cover several already merged treatment headings.
      // Its underline follows the leaf labels, not the inset treatment text.
      const leaves = (headerRuns.get(row + 2) ?? []).filter(
        (run) => run.rect[0] >= rule[0] - 2 && run.rect[2] <= rule[2] + 2
      )
      const leafColumns = populatedColumns(row + 2).filter((column) =>
        leaves.some(
          (run) => run.rect[0] >= columnRects[column][0] && run.rect[2] <= columnRects[column][2]
        )
      )
      const childSpans = proposals.filter(
        (p) =>
          p.slots.length >= 2 &&
          p.slots.every((s) => s.row === row + 1 && leafColumns.includes(s.column))
      )
      const covered = childSpans.flatMap((p) => p.slots.map((s) => s.column))
      const leafTexts = leafColumns.map((column) => {
        const text = items
          .filter((item) =>
            inside(baseCells.find((s) => s.row === row + 2 && s.column === column).rect, item)
          )
          .sort((a, b) => a.rect[0] - b.rect[0])
          .map((item) => item.text)
          .join('')
          .replace(/\s/g, '')
        return text
      })
      const sampleLeaves =
        leaves.length >= 3 &&
        leafTexts.every((text) => /^\(n=\d+\)$|^P$/i.test(text)) &&
        leafTexts.filter((text) => /^\(n=\d+\)$/i.test(text)).length >= 2 &&
        leafTexts.includes('P')
      const stackedBand =
        children.length === 1 &&
        childSpans.length === 1 &&
        rules.some(
          (r) =>
            r[1] === r[3] &&
            r[1] > rule[1] + 1 &&
            r[1] < Math.min(...leaves.map((l) => l.rect[1])) &&
            Math.abs(r[0] - rule[0]) <= 2 &&
            Math.abs(r[2] - rule[2]) <= 2
        )
      const nested =
        sampleLeaves ||
        ((childSpans.length >= 2 || stackedBand) &&
          covered.length === leafColumns.length &&
          new Set(covered).size === leafColumns.length &&
          leafColumns.every((c) => covered.includes(c)))
      const edgeLabels = nested ? leaves : children
      // Some underlines end at the wider first data record rather than the
      // header text (e.g. a percentage followed by a status marker).
      const bodyEdge =
        !nested && rows[row + 2]
          ? items.filter(
              (i) =>
                inside([left, rows[row + 2].rect[1], right, rows[row + 2].rect[3]], i) &&
                i.rect[0] >= rule[0] - 2 &&
                i.rect[2] <= rule[2] + 2
            )
          : []
      const parallelGroup =
        children.length >= 2 &&
        rules.some(
          (other) =>
            other !== rule &&
            other[1] === other[3] &&
            Math.abs(other[1] - rule[1]) < 1 &&
            (other[2] < rule[0] || other[0] > rule[2]) &&
            Math.abs((other[2] - other[0]) / (rule[2] - rule[0]) - 1) < 0.2 &&
            headerRuns
              .get(row + 1)
              .filter((run) => run.rect[0] >= other[0] - 2 && run.rect[2] <= other[2] + 2)
              .length === children.length
        )
      const followsBodyEdge =
        bodyEdge.some((i) => /\d/.test(i.text)) &&
        Math.abs(Math.max(...bodyEdge.map((i) => i.rect[2])) - rule[2]) <= 2
      // Wrapped sample-size headings may be inset from the underline. In that
      // case, require the rule to follow both outer child-column boundaries.
      // The same evidence applies to an ancestor of already validated groups.
      const sampleLine = wrappedLabel
        ? items
            .filter((i) => inside(stacked.at(-1).rect, i))
            .sort((a, b) => a.rect[0] - b.rect[0])
            .map((i) => i.text)
            .join('')
            .replace(/\s/g, '')
        : ''
      const edgeColumns = columnRects.flatMap((c, column) =>
        edgeLabels.some((run) => run.rect[0] >= c[0] && run.rect[2] <= c[2]) ? [column] : []
      )
      const edgeHeight = Math.max(...edgeLabels.map((run) => run.rect[3] - run.rect[1]))
      const countParent =
        parents.length === 1 &&
        /^[\p{L} ]{2,50}\([Nn]\)$/u.test(
          items
            .filter((i) => inside(parents[0].rect, i))
            .sort((a, b) => a.rect[0] - b.rect[0])
            .map((i) => i.text)
            .join('')
        ) &&
        Math.abs(center(parents[0]) - (rule[0] + rule[2]) / 2) < 1
      const followsChildBorders =
        (nested ||
          countParent ||
          /^\(n=\d+\)$/i.test(sampleLine) ||
          (parents.length === 1 &&
            edgeColumns.length >= 3 &&
            Math.abs(center(parents[0]) - (rule[0] + rule[2]) / 2) <= edgeHeight * 2)) &&
        edgeColumns.length >= 2 &&
        edgeColumns.at(-1) - edgeColumns[0] + 1 === edgeColumns.length &&
        Math.abs(columnRects[edgeColumns[0]][0] - rule[0]) <= edgeHeight + 1 &&
        Math.abs(columnRects[edgeColumns.at(-1)][2] - rule[2]) <= edgeHeight + 1
      if (
        (!nested && children.length < 2) ||
        parents.length !== 1 ||
        (!followsChildBorders &&
          Math.abs(Math.min(...edgeLabels.map((c) => c.rect[0])) - rule[0]) >
            (nested ? Math.max(2, (rows[row].rect[3] - rows[row].rect[1]) * 1.5) : 2)) ||
        (!followsChildBorders &&
          !(nested && stackedBand) &&
          !followsBodyEdge &&
          Math.abs(Math.max(...edgeLabels.map((c) => c.rect[2])) - rule[2]) >
            Math.max(2, (rows[row].rect[3] - rows[row].rect[1]) * (parallelGroup ? 2.5 : 1.5))) ||
        parents[0].rect[0] < rule[0] - 1 ||
        parents[0].rect[2] > rule[2] + 1
      )
        continue
      const childColumns = nested
        ? leafColumns
        : populatedColumns(row + 1).filter((column) =>
            children.some(
              (run) =>
                run.rect[0] >= columnRects[column][0] - 2 &&
                run.rect[2] <= columnRects[column][2] + 2
            )
          )
      if (
        childColumns.length < 2 ||
        childColumns.at(-1) - childColumns[0] + 1 !== childColumns.length
      )
        continue
      const slots = baseCells.filter(
        (cell) => cell.row === row && childColumns.includes(cell.column)
      )
      if (intersect(union(slots), parents[0].rect) / area(parents[0].rect) < 0.95) continue
      removeOverlappingMergeProposals(proposals, slots, headerRows)
      proposals.push({ slots, origin: 'ruled-header-span', wrappedLabel })
      // With a confirmed two-tier header, labels without child labels occupy
      // both header rows; do not carry them into the first data record.
      for (const column of populatedColumns(row).filter(
        (column) => !childColumns.includes(column) && !populatedColumns(row + 1).includes(column)
      )) {
        const vertical = baseCells.filter(
          (cell) => cell.column === column && [row, row + 1].includes(cell.row)
        )
        if (!proposals.some((p) => p.slots.some((s) => vertical.includes(s))))
          proposals.push({ slots: vertical, origin: 'ruled-header-span' })
      }
    }
    for (const run of headerRuns.get(row)) {
      const verticals = sourceRules.filter(
        (r) => r[2] - r[0] <= 1 && r[1] <= run.rect[1] && r[3] >= run.rect[3]
      )
      const l = verticals.filter((r) => r[0] <= run.rect[0]).sort((a, b) => b[0] - a[0])[0]
      const r = verticals.filter((r) => r[2] >= run.rect[2]).sort((a, b) => a[2] - b[2])[0]
      if (!l || !r || verticals.some((v) => v[0] > l[0] + 1 && v[2] < r[2] - 1)) continue
      const top = Math.max(l[1], r[1]),
        bottom = Math.min(l[3], r[3])
      const closed = [top, bottom].every((y) => {
        let end = l[0]
        for (const h of sourceRules
          .filter((h) => h[3] - h[1] <= 1 && Math.abs(h[1] - y) <= 1)
          .sort((a, b) => a[0] - b[0])) {
          if (h[0] <= end + 1) end = Math.max(end, h[2])
        }
        return end >= r[2] - 1
      })
      const headerPadding =
        (recoveredIntervalParent && row === 0) ||
        ['source-statistic-header', 'source-text'].includes(rows[row].origin)
          ? rows[row].rect[3] - rows[row].rect[1]
          : 4
      if (
        !closed ||
        top < rows[row].rect[1] - headerPadding ||
        bottom > Math.min(rows[row].rect[3] + headerPadding, rows[row + 1].rect[1])
      )
        continue
      const slots = baseCells.filter(
        (s) => s.row === row && s.rect[0] >= l[0] - 4 && s.rect[2] <= r[2] + 4
      )
      if (
        slots.length < 2 ||
        Math.abs(slots[0].rect[0] - l[0]) > 4 ||
        Math.abs(slots.at(-1).rect[2] - r[2]) > 4 ||
        !slots.every((s) => populatedColumns(row + 1).includes(s.column)) ||
        headerRuns
          .get(row)
          .some((other) => other !== run && other.rect[0] < r[2] && other.rect[2] > l[0])
      )
        continue
      removeOverlappingMergeProposals(proposals, slots, [row])
      proposals.push({ slots, origin: 'ruled-header-span' })
    }
  }
  // Repeated metric sequences identify sibling groups when a printed underline
  // is shorter than its group. Require each group's left divider through the
  // parent band and no interior divider, rather than extending an underline.
  for (const row of headerRows) {
    if (!headerRuns.has(row + 1)) continue
    const childSpans = proposals.filter(
      (p) =>
        p.slots.every((s) => s.row === row + 1) &&
        ['text-supported-header-span', 'ruled-header-span'].includes(p.origin)
    )
    const children = [
      ...new Set([
        ...populatedColumns(row + 1),
        ...childSpans.flatMap((p) => p.slots.map((s) => s.column))
      ])
    ]
      .filter((c) => c > 0)
      .sort((a, b) => a - b)
    if (children.length < 6 || children[0] !== 1 || children.some((c, i) => c !== i + 1)) continue
    const labels = children.map((column) =>
      items
        .filter((i) =>
          inside(baseCells.find((s) => s.row === row + 1 && s.column === column).rect, i)
        )
        .sort((a, b) => a.rect[0] - b.rect[0])
        .map((i) => i.text)
        .join('')
        .replace(/\s/g, '')
        .toLowerCase()
    )
    const size = labels.indexOf(labels[0], 1)
    if (
      size < 3 ||
      labels.length % size ||
      new Set(labels.slice(0, size)).size !== size ||
      labels.some(
        (label, i) =>
          label !== labels[i % size] ||
          (!/\p{L}/u.test(label) &&
            !(
              label === '' && childSpans.some((p) => p.slots.some((s) => s.column === children[i]))
            ))
      )
    )
      continue
    const spans = []
    for (let start = 0; start < children.length; start += size) {
      const slots = baseCells.filter(
        (s) => s.row === row && children.slice(start, start + size).includes(s.column)
      )
      const bounds = union(slots)
      const parents = headerRuns.get(row).filter((run) => inside(bounds, run))
      if (parents.length !== 1) break
      const parent = parents[0].rect
      const dividers = sourceRules.filter(
        (r) => r[2] - r[0] <= 1 && r[1] <= parent[1] + 1 && r[3] >= parent[3] - 1
      )
      if (
        !dividers.some((r) => Math.abs(r[0] - bounds[0]) <= 4) ||
        dividers.some((r) => r[0] > bounds[0] + 4 && r[0] < bounds[2] - 4) ||
        !rules.some(
          (r) =>
            r[1] === r[3] &&
            r[1] >= parent[3] &&
            r[1] <= rows[row + 1].rect[3] &&
            r[0] <= parent[0] &&
            r[2] >= parent[2]
        )
      )
        break
      spans.push(slots)
    }
    if (spans.length !== children.length / size) continue
    for (const slots of spans) {
      removeOverlappingMergeProposals(proposals, slots)
      proposals.push({ slots, origin: 'ruled-header-span', joinedLabel: true })
    }
  }
  for (const group of mixedHeaderGroups) {
    const slots = baseCells.filter((c) => c.row === 0 && group.includes(c.column))
    removeOverlappingMergeProposals(proposals, slots)
    proposals.push({ slots, origin: 'ruled-header-span', joinedLabel: true })
  }
  // A recovered parent row can leave a centered stub stranded in the lower
  // header. Extend it only across consecutive header rows, with no dividing
  // rule or second label, and alongside a source-supported group heading.
  if (
    preceding === 0 &&
    headerRows.length >= 2 &&
    headerRows.length <= 3 &&
    headerRows.every((row, index) => row === index) &&
    proposals.some(
      (p) =>
        ['ruled-header-span', 'text-supported-header-span'].includes(p.origin) &&
        p.slots.length >= 2 &&
        p.slots.every((s) => s.row === 0 && s.column > 0)
    )
  ) {
    const slots = baseCells.filter((c) => c.column === 0 && headerRows.includes(c.row))
    const rect = union(slots)
    const label = items.filter((i) => i.horizontal && inside(rect, i))
    const height = Math.max(...label.map((i) => i.height))
    const textRect = label.length ? union(label) : undefined
    if (
      textRect &&
      label.some((i) => /\p{L}/u.test(i.text)) &&
      label.every((i) => Math.abs(i.baseline - label[0].baseline) <= height * 0.35) &&
      Math.abs(textRect[1] + textRect[3] - rect[1] - rect[3]) <= height &&
      !items.some((i) => i.horizontal && inside(slots[0].rect, i)) &&
      !rules.some(
        (r) =>
          Math.abs(r[3] - r[1]) < 1 &&
          r[1] > rect[1] &&
          r[1] < rect[3] &&
          r[0] < textRect[2] &&
          r[2] > textRect[0]
      ) &&
      !proposals.some(
        (p) => p.slots.some((s) => slots.includes(s)) && p.slots.some((s) => !slots.includes(s))
      )
    ) {
      for (let i = proposals.length - 1; i >= 0; i--)
        if (proposals[i].slots.every((s) => slots.includes(s))) proposals.splice(i, 1)
      proposals.push({ slots, origin: 'ruled-header-span' })
      repairs.push('centered-stub-header-recovered')
    }
  }
  // A sparse statistic can span a group's child rows, but never its following
  // section title. Trim an edge overlap with a proven stub-only section;
  // retain conflicts when there is source text on both sides of that boundary.
  for (const p of proposals) {
    if (
      new Set(p.slots.map((s) => s.column)).size !== 1 ||
      p.slots[0]?.column === 0 ||
      p.slots.length < 2
    )
      continue
    const section = proposals
      .filter(
        (q) =>
          q !== p &&
          (q.sectionHeader || q.origin === 'source-section') &&
          new Set(q.slots.map((s) => s.row)).size === 1 &&
          q.slots.length === columns.length &&
          q.slots[0].row >= p.slots[0].row &&
          q.slots.some((s) => p.slots.includes(s))
      )
      .sort((a, b) => a.slots[0].row - b.slots[0].row)[0]
    if (!section) continue
    const sectionItems = items.filter((i) => inside(union(section.slots), i))
    const spanItems = items.filter((i) => inside(union(p.slots), i))
    const end = section.slots[0].row
    const retained = p.slots.filter((s) => (end === p.slots[0].row ? s.row > end : s.row < end))
    if (
      !sectionItems.length ||
      !sectionItems.every((i) => columnOf(i) === 0 && /\p{L}/u.test(i.text)) ||
      !spanItems.length ||
      !spanItems.every(
        (i) =>
          /^(?:NS|[–—−-]|[<>≤≥]?\s*0?\.\d+)$/i.test(i.text.trim()) && inside(union(retained), i)
      )
    )
      continue
    p.slots = retained
    repairs.push('statistic-span-section-boundary-recovered')
  }
  // Repeated grade distributions have one comparison P value for the entire
  // section. Extend an existing partial model span only when every source row
  // has a consecutive grade and complete values in the other data columns.
  const statisticColumn = columns.length - 1
  const gradeHeader = items.some(
    (i) => headerRows.some((r) => inside(rows[r].rect, i)) && /\bgrade\b/i.test(i.text)
  )
  const pHeader = items.some(
    (i) =>
      headerRows.some((r) => inside(rows[r].rect, i)) &&
      columnOf(i) === statisticColumn &&
      /^P(?:\s|$|\()/i.test(i.text.trim())
  )
  if (gradeHeader && pHeader) {
    const sections = [
      ...new Set(
        proposals
          .filter(
            (p) =>
              (p.sectionHeader || p.origin === 'source-section') &&
              p.slots.length === columns.length &&
              new Set(p.slots.map((s) => s.row)).size === 1
          )
          .map((p) => p.slots[0].row)
      )
    ].sort((a, b) => a - b)
    const distributions = sections.map((section, index) => {
      const end = sections[index + 1] ?? rows.length
      const body = baseCells.filter((c) => c.row > section && c.row < end)
      const values = body.map((cell) => ({
        cell,
        text: items
          .filter((i) => inside(cell.rect, i))
          .map((i) => i.text)
          .join(' ')
          .trim()
      }))
      const statistics = values.filter((v) => v.cell.column === statisticColumn && v.text)
      const valid =
        end - section >= 4 &&
        statistics.length === 1 &&
        /^[<>≤≥]?\s*0?\.\d+$/.test(statistics[0].text) &&
        values
          .filter((v) => v.cell.column < statisticColumn)
          .every((v) =>
            v.cell.column === 0
              ? v.text === String(v.cell.row - section - 1)
              : /^\(?\d+(?:\.\d+)?\)?$/.test(v.text)
          )
      return valid ? body.filter((c) => c.column === statisticColumn) : undefined
    })
    if (distributions.filter(Boolean).length >= 2)
      for (const slots of distributions) {
        if (!slots) continue
        const partial = proposals.find(
          (p) =>
            p.origin === 'model-span' &&
            p.slots.length > 1 &&
            p.slots.length < slots.length &&
            p.slots.every((s) => slots.includes(s))
        )
        if (!partial) continue
        if (
          rules.some(
            (r) =>
              r[1] === r[3] &&
              r[0] <= slots[0].rect[0] &&
              r[2] >= slots[0].rect[2] &&
              r[1] > slots[0].rect[1] + 1 &&
              r[1] < slots.at(-1).rect[3] - 1
          )
        )
          continue
        partial.slots = slots
        repairs.push('grade-statistic-span-recovered')
      }
  }
  // A shared comparison P value can establish the extent of a graded group.
  // Recover only a wrapped grade/time stub beside consecutive complete counts.
  for (const comparison of [...proposals]) {
    if (
      comparison.origin !== 'model-span' ||
      columns.length < 5 ||
      comparison.slots.length < 3 ||
      !comparison.slots.every((s) => s.column === columns.length - 1)
    )
      continue
    const groupRows = [...new Set(comparison.slots.map((s) => s.row))].sort((a, b) => a - b)
    if (groupRows[0] > 1) groupRows.unshift(groupRows[0] - 1)
    if (groupRows.some((r, i) => headerRows.includes(r) || (i && r !== groupRows[i - 1] + 1)))
      continue
    const textAt = (row, column) =>
      items
        .filter((i) => inside(baseCells.find((c) => c.row === row && c.column === column).rect, i))
        .map((i) => i.text)
        .join(' ')
        .trim()
    if (
      !groupRows.every(
        (r, i) =>
          (i ? textAt(r, 1) === String(i) : /^(?:None|0)$/i.test(textAt(r, 1))) &&
          columnRects.slice(2, -1).every((_, c) => /^\d+$/.test(textAt(r, c + 2)))
      )
    )
      continue
    const pValues = groupRows.map((r) => textAt(r, columns.length - 1)).filter(Boolean)
    if (pValues.length !== 1 || !/^0?\.\d+$/.test(pValues[0])) continue
    const slots = baseCells.filter((c) => c.column === 0 && groupRows.includes(c.row))
    const label = items
      .filter((i) => inside(union(slots), i))
      .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
    if (!label.length) continue
    const height = label[0].height
    const lines = groups.map((g) => g.filter((i) => label.includes(i))).filter((g) => g.length)
    const text = lines.map((g) => g.map((i) => i.text).join(' '))
    if (
      lines.length < 2 ||
      lines.length > 3 ||
      !/\bgrade\s+at$/i.test(text[0]) ||
      !/^\d+\s+(?:days?|weeks?|months?)\b/i.test(text[1]) ||
      (text[2] && !/^[a-z]/.test(text[2])) ||
      lines.some(
        (g, i) =>
          Math.abs(g[0].rect[0] - lines[0][0].rect[0]) > height * 0.5 ||
          (i && g[0].baseline - lines[i - 1][0].baseline > height * 1.6)
      )
    )
      continue
    removeOverlappingMergeProposals(proposals, slots)
    comparison.slots = baseCells.filter(
      (c) => c.column === columns.length - 1 && groupRows.includes(c.row)
    )
    proposals.push({ slots, origin: 'source-graded-stub' })
    repairs.push('graded-stub-span-recovered')
  }
  if (ruledStubGrid) {
    proposals.splice(
      0,
      proposals.length,
      ...ruledStubGrid.cells
        .filter((c) => c.rowSpan > 1 || c.colSpan > 1)
        .map((c) => ({
          origin: 'source-ruled-stub',
          slots: baseCells.filter(
            (slot) =>
              slot.row >= c.row &&
              slot.row < c.row + c.rowSpan &&
              slot.column >= c.column &&
              slot.column < c.column + c.colSpan
          )
        }))
    )
  }
  for (const g of independentArmGroups) {
    for (let i = proposals.length - 1; i >= 0; i--) {
      const slots = proposals[i].slots
      if (
        new Set(slots.map((s) => s.column)).size > 1 &&
        slots.some((s) => s.column > 0 && intersect(s.rect, union(g)) > 0) &&
        g.filter((item) => columnOf(item) > 0 && slots.some((slot) => inside(slot.rect, item)))
          .length >= 2
      )
        proposals.splice(i, 1)
    }
  }
  if (parentRowSpans) applySourceHeaderSpans(proposals, baseCells, parentRowSpans, 2)
  if (ruledTierSpans) applySourceHeaderSpans(proposals, baseCells, ruledTierSpans, 3)
  if (recordGrid?.completeSpans) {
    proposals.splice(
      0,
      proposals.length,
      ...recordGrid.spans.map((span) => ({
        origin: 'text-supported-study-span',
        slots: baseCells.filter(
          (cell) =>
            cell.row >= span.row &&
            cell.row < span.row + span.rowSpan &&
            cell.column >= span.column &&
            cell.column < span.column + (span.colSpan ?? 1)
        )
      }))
    )
  }
  // Underlined parents can leave a two-line stub in the gap between header
  // bands. Its source text and the empty parent stub establish one vertical
  // header cell; keep the treatment underlines and child columns unchanged.
  if (rows[0]?.origin === 'source-native-header' && bracketHeaders.length >= 2 && rows[1]) {
    const stubSlots = baseCells.filter((cell) => cell.column === 0 && cell.row <= 1)
    const gap = items.filter((item) => {
      const center = (item.rect[1] + item.rect[3]) / 2
      return center > rows[0].rect[3] && center < rows[1].rect[1]
    })
    if (
      stubSlots.length === 2 &&
      gap.length &&
      gap.every((item) => columnOf(item) === 0 && /\p{L}/u.test(item.text)) &&
      !items.some((item) => inside(stubSlots[0].rect, item)) &&
      items.some((item) => inside(stubSlots[1].rect, item) && /\p{L}/u.test(item.text)) &&
      bracketHeaders.every((frame) => frame[0] > stubSlots[0].rect[2] - 2)
    ) {
      removeOverlappingMergeProposals(proposals, stubSlots)
      proposals.push({ slots: stubSlots, origin: 'source-wrapped-header-stub' })
    }
  }
  const cells = resolveTableCellMerges({
    proposals,
    baseCells,
    items,
    rows,
    headerRows,
    headerRuns,
    rules,
    recordGrid,
    populatedColumns,
    issues,
    repairs
  })
  const unassigned = populateTableCellText({
    cells,
    items,
    pageItems,
    rows,
    columnRects,
    headerRows,
    rules,
    bottom,
    recordGrid,
    scheduleGrid,
    issues,
    repairs
  })
  removeEmptyOverlappingRows({ rows, cells, items, rules, repairs })
  const grid = rows.map(() => columns.map(() => ''))
  for (const cell of cells) grid[cell.row][cell.column] = cell.text
  return {
    id: table.id,
    cropRect: table.cropRect,
    grid,
    cells,
    rows: rows.map(({ rect, origin }) => ({ rect, origin })),
    unassigned,
    clipped: clipped.map((i) => ({ text: i.text, rect: i.rect })),
    excludedCaptionItems: excludedCaptionItems.map((i) => i.text),
    issues: [...issues],
    repairs,
    reviewCandidate: issues.size === 0,
    selectedTextItems: items.length
  }
}
