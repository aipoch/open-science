/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { reconcileNativeFinalCellBounds } from './literature-pdf-native-final-cell-bounds.mjs'
import { recoverNativeHeaderOwnershipGrid } from './literature-pdf-native-header-ownership.mjs'
import { recoverNativeMeasuredGutterTokens } from './literature-pdf-native-measured-gutters.mjs'
import { recoverNativeScalarRecordPlan } from './literature-pdf-native-scalar-record-grid.mjs'
import { recoverNativeTextRecordGrid } from './literature-pdf-native-text-record-grid.mjs'
import { recoverNativeSegmentedStubRecords } from './literature-pdf-native-shared-stub-record-grid.mjs'
import {
  recoverNativeMathFieldRecords,
  recoverNativeWrappedMathRecords
} from './literature-pdf-native-math-field-record-grid.mjs'
import {
  recoverNativePairedTextRecordGrid,
  recoverNativeOrdinalWrappedRecordGrid,
  recoverNativeIndexedDirectoryGrid,
  recoverNativeProseLaneRecords
} from './literature-pdf-native-bounded-text-record-grid.mjs'
import { recoverNativeSingleMathRecordGrid } from './literature-pdf-native-single-math-record-grid.mjs'
import { recoverNativeRepeatedTuplePlan } from './literature-pdf-native-repeated-tuple-grid.mjs'
import { recoverNativeSharedPairRecordGrid } from './literature-pdf-native-shared-pair-record-grid.mjs'
import { recoverNativePairedParentRecordGrid } from './literature-pdf-native-paired-parent-record-grid.mjs'
import { recoverNativeStackedRecordGrid } from './literature-pdf-native-stacked-records.mjs'
import {
  recoverNativeSegmentedScientificGrid,
  recoverNativeWrappedCountNarrativeGrid,
  recoverNativeSymbolDefinitionGrid,
  recoverNativeConfigurationGrid,
  recoverNativeCitedMeasurementGrid
} from './literature-pdf-native-lined-record-grid.mjs'
import {
  recoverNativeMeasuredRecordGrid,
  recoverNativeGroupedParameterGrid,
  recoverNativeRuledFormulaGrid
} from './literature-pdf-native-measured-record-grid.mjs'
import { proveNativeCaptionRaisedGlyphOwnership } from './literature-pdf-native-caption-raised-glyphs.mjs'
import { recoverNativeCoefficientRecordGrid } from './literature-pdf-native-coefficient-record-grid.mjs'
import {
  recoverNativePairedRecordGrid,
  recoverNativeGroupedFlagRecordGrid,
  recoverCompleteNativeLeafRecords,
  recoverNativeIndicatorRecordPlan,
  recoverSmallCompleteRecordGrid
} from './literature-pdf-native-complete-record-grid.mjs'
import { proveNativeClosedMathOrder } from './literature-pdf-native-closed-math-order.mjs'
import { recoverNativeEqualFontStackRecordGrid } from './literature-pdf-native-stacked-uncertainty.mjs'
import {
  proveNativeScientificLeafGutters,
  recoverNativeScientificLeafRecordGrid
} from './literature-pdf-native-scientific-leaf-gutters.mjs'
import {
  readSourceRow,
  recoverTwoCohortSectionGrid,
  recoverSampleQualifiedSparseCohortGrid
} from './literature-pdf-source-records.mjs'
import {
  recoverRuledComparisonPanel,
  recoverNestedMeasureRecords,
  recoverIdentifierRecords,
  recoverSectionLocalColumns,
  recoverAdditiveCohortRecords,
  recoverRepeatedLeafSections,
  recoverWrappedRepeatedMeasures,
  recoverNestedCountRecords,
  recoverNumberedModelSections,
  recoverClinicalCountSections,
  recoverParenthesizedStubUnitCut,
  recoverCountHeaderFrameCrop,
  recoverResourceCohortRecords,
  recoverWrappedCohortStatistics,
  recoverMixedCohortSummaries,
  recoverPairedOutcomeRecords,
  recoverRuledCategoricalRecords,
  separateAdjacentNumericPanel
} from './literature-pdf-sectional-records.mjs'
import {
  hasHorizontalTableRuleBetween,
  joinHorizontalTableRules
} from './literature-pdf-table-rules.mjs'
import {
  recoverRuledColumnGrid,
  recoverClosedCellGrid,
  recoverVerticalRuleGrid,
  recoverHeaderlessRuledRecords
} from './literature-pdf-ruled-column-grid.mjs'
import {
  recoverSegmentedRecordGrid,
  recoverRuledTimeSeriesGrid
} from './literature-pdf-segmented-record-grid.mjs'
import {
  recoverRegressionGrid,
  recoverRepeatedRegressionGrid,
  recoverSectionedCoefficientsGrid
} from './literature-pdf-regression-grid.mjs'
import {
  recoverNativeHeaderGrid,
  recoverClosedNumericFrameCrop,
  recoverCaptionSeparatedHeaderCrop,
  recoverClippedUnnumberedTitleCrop,
  recoverWrappedSampleHeaderBand,
  recoverCompactNumericHeader,
  recoverCohortSummaryRows,
  recoverCohortDistributionRecords,
  recoverPairedCountGrid,
  recoverRuledComparisonRecords,
  recoverAlleleDistributionGrid,
  recoverRuledIntervalRecords,
  recoverClippedHeading,
  recoverClippedColumnHeader,
  recoverCountDistributionGrid,
  recoverCountedCategoryGrid,
  recoverRuledCategoryGrid,
  recoverRepeatedUnitGrid,
  recoverRepeatedHeaderGrid,
  recoverRepeatedCountSections
} from './literature-pdf-native-header-grid.mjs'
import { recoverNumberedMatrix } from './literature-pdf-numbered-matrix.mjs'
import {
  recoverWrappedProportionGrid,
  recoverWrappedCountPairsGrid
} from './literature-pdf-wrapped-proportion-grid.mjs'
import {
  recoverRuledNarrativeGrid,
  recoverQuestionnaireGrid,
  recoverStudyParagraphGrid,
  recoverParallelCountLists,
  recoverSharedScoreTimepointGrid
} from './literature-pdf-ruled-narrative-grid.mjs'
import { recoverRuledEffectGrid } from './literature-pdf-ruled-effect-grid.mjs'
import { recoverDeviationGrid, recoverSingleValueGrid } from './literature-pdf-deviation-grid.mjs'
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
  recoverUnownedSourceRows,
  recoverCitedRecordTails,
  mergeWrappedStubTails,
  remapSourceRowSpans,
  repairWrappedTableRows,
  repairInlineFragmentRows,
  coalesceSampleSizeHeader,
  separateCountedCategoryHeader,
  recoverProjectedSectionRows,
  recoverRepeatedMeasurementSections,
  mergeDuplicateSourceRows,
  removeEmptyOverlappingRows,
  reconcileRepeatedSectionHeadings,
  splitRuledParentRow,
  reconcileStatisticStubStarts
} from './literature-pdf-table-row-repair.mjs'
import {
  resolveTableCellMerges,
  reconcileUnresolvedTableSpans,
  reconcileSummaryRecordColumns,
  reconcileRuledLeafHeaderSpans,
  reconcileSharedReferenceFields,
  reconcileCategoricalComparisons,
  applySourceHeaderSpans,
  removeOverlappingMergeProposals
} from './literature-pdf-table-cell-merges.mjs'
import {
  populateTableCellText,
  reconcileFragmentedCountHeaders
} from './literature-pdf-table-cell-text.mjs'
import { captionKind } from './literature-pdf-caption-group.mjs'
import { recoverSegmentedLeafHeaderBand } from './literature-pdf-segmented-header-band.mjs'
import { recoverRuledProgramGrid } from './literature-pdf-program-grid.mjs'
import { recoverRuledScaleCohortGrid } from './literature-pdf-scale-cohort-grid.mjs'
import { recoverRuledSurveyRecordGrid } from './literature-pdf-survey-record-grid.mjs'
import {
  recoverNativeQuestionRecordGrid,
  recoverNativeSparseModelRecordGrid,
  recoverNativeCohortRecordGrid
} from './literature-pdf-long-question-record-grid.mjs'
import { recoverRepeatedVisitGrid } from './literature-pdf-repeated-visit-grid.mjs'
import { recoverRuledStubGrid, recoverRuledHeaderGrid } from './literature-pdf-ruled-stub-grid.mjs'
import {
  recoverWrappedSummaryGrid,
  recoverPairedIntervalGrid,
  recoverRepeatedComparisonGrid,
  recoverCurrencySummaryGrid,
  recoverEstimateIntervalGrid,
  recoverMixedCohortGrid,
  recoverStratifiedIntervalGrid
} from './literature-pdf-wrapped-summary-grid.mjs'
import {
  recoverRecordGrid,
  recoverRuledSparseSummaryRecords,
  recoverDemographicRecords,
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
import {
  inside,
  union,
  rebaseTableCrop,
  isAdjacentTableScript
} from './literature-pdf-table-geometry.mjs'
import {
  groupSourceRowsWithScripts,
  recoverRuledHeaderBands,
  recoverUnderlinedCohortPairHeaderBands,
  recoverClosedNativeHeaderBands,
  recoverNativeHeaderHierarchy,
  recoverSiblingHeaderBands,
  recoverSampleQualifiedHeaderCuts,
  recoverSegmentedParentBands,
  recoverSplitBorderHeaderBands,
  recoverSegmentedCohortHeaderBands,
  recoverRepeatedHeaderHierarchy
} from './literature-pdf-source-records.mjs'

function recoverSourceHeaderTree(source, cuts, rules, top, bottom) {
  const cohortPair = recoverUnderlinedCohortPairHeaderBands(source, cuts, rules, top, bottom)
  if (cohortPair) return cohortPair
  const height = Math.max(...source.map((item) => item.height))
  const sourceTop = Math.min(...source.map((item) => item.rect[1]))
  const nativeTops = [
    ...new Set(
      joinHorizontalTableRules(rules)
        .filter(
          (rule) =>
            Math.abs(rule[1] - top) < height &&
            rule[1] < sourceTop &&
            rule[0] <= cuts[0] + height &&
            rule[2] >= cuts.at(-1) - height
        )
        .map((rule) => rule[1])
    )
  ]
  const headerTop = nativeTops.length === 1 ? nativeTops[0] : top
  const partitioned = recoverRuledHeaderBands(source, cuts, rules, headerTop, bottom)
  const parents = partitioned?.spans.filter((s) => s.row === 0 && s.colSpan >= 2) ?? []
  if (
    partitioned?.rows.length === 2 &&
    parents.length >= 2 &&
    parents.every((p) =>
      rules.some(
        (r) =>
          r[0] === r[2] &&
          Math.abs(r[0] - cuts[p.column]) < height &&
          r[1] < sourceTop &&
          r[3] >= partitioned.rows[0][3]
      )
    )
  )
    return partitioned
  const hierarchy = recoverNativeHeaderHierarchy(source, cuts, rules, headerTop, bottom)
  if (
    hierarchy?.rows.length >= 3 &&
    hierarchy.spans.filter((span) => span.row === 0 && span.colSpan >= 2).length >= 2 &&
    hasNativeNestedHeader(hierarchy, cuts, rules, height, source) &&
    joinHorizontalTableRules(rules).some(
      (rule) =>
        Math.abs(rule[1] - top) < height &&
        rule[1] < Math.min(...source.map((item) => item.rect[1])) &&
        rule[0] <= cuts[0] + height &&
        rule[2] >= cuts.at(-1) - height
    )
  )
    return hierarchy
  const siblings = recoverSiblingHeaderBands(source, cuts, rules, top, bottom)
  if (siblings?.spans.some((span) => span.row === 1 && span.colSpan >= 2)) return siblings
}

// Native underlines must partition a parent into independently ruled children.
// Keep the same bounded alignment witness with a continuous bottom border or
// a source-separated header whose bottom border is interrupted.
function hasNativeNestedHeader(header, cuts, rules, height, source = []) {
  const parents = header?.spans.filter((s) => s.row === 0 && s.colSpan >= 3) ?? []
  const partitions = parents.map((parent) => ({
    parent,
    children: header.spans
      .filter(
        (s) =>
          s.row === 1 &&
          s.colSpan >= 2 &&
          s.column >= parent.column &&
          s.column + s.colSpan <= parent.column + parent.colSpan
      )
      .sort((a, b) => a.column - b.column)
  }))
  return (
    header?.rows.length >= 3 &&
    // Replacing the header replaces every parent. A partial native tree must
    // not discard a correctly merged model child beside a complete peer.
    partitions.every(({ parent, children }) => {
      if (children.length < 2) return false
      const occupied = new Set(
        children.flatMap((child) =>
          Array.from({ length: child.colSpan }, (_, n) => child.column + n)
        )
      )
      for (let c = parent.column; c < parent.column + parent.colSpan; c++) {
        if (occupied.has(c)) continue
        // A final independent probability leaf need not share the sibling
        // count-pair underline. Its source label and adjacent scripts own
        // the singleton column, with no competing descendant text.
        const glyphs = source.filter(
          (item) => item.rect[0] >= cuts[c] && item.rect[2] <= cuts[c + 1]
        )
        const label = glyphs.filter((item) => /^p$/i.test(item.text))
        if (
          label.length !== 1 ||
          glyphs.some(
            (item) =>
              item !== label[0] &&
              (!/^[a-z](?:,[a-z])*$/i.test(item.text) || !isAdjacentTableScript(item, label[0]))
          ) ||
          label[0].rect[1] < header.rows[1][1] ||
          label[0].rect[3] > header.rows.at(-1)[3]
        )
          return false
      }
      return children.every(
        (child, n) => !n || child.column >= children[n - 1].column + children[n - 1].colSpan
      )
    }) &&
    partitions[source.length ? 'every' : 'some'](({ parent, children }) =>
      [parent, ...children].every((s) =>
        rules.some(
          (r) =>
            r[1] === r[3] &&
            Math.abs(r[1] - header.rows[s.row][3]) < 0.1 &&
            // With all native header ink owned, a model midpoint can sit
            // inside the gutter beyond an inset population underline.
            Math.abs(r[0] - cuts[s.column]) < height * (source.length ? 1.5 : 1) &&
            Math.abs(r[2] - cuts[s.column + s.colSpan]) < height * (source.length ? 1.5 : 1)
        )
      )
    )
  )
}

// Offline table reconstruction. Coordinates are source-page pixels; predictions are crop-relative.
// References: microsoft/table-transformer src/inference.py (cell construction) and postprocess.py.
// This is a bounded implementation, not a port or a production copy-eligibility gate.

export { hasTableEvidence } from './literature-pdf-table-evidence.mjs'

export {
  recoverRuledTable,
  recoverCaptionedRuledTables,
  splitCaptionedTableRegions
} from './literature-pdf-table-regions.mjs'

// A merge proposal can conflict with source rows/columns before later
// evidence-based repairs settle the logical grid.  Reconcile only when the
// final cells cover every slot exactly once and a repair recorded trusted
// header/section evidence; unresolved text or ambiguous source geometry must
// remain a review signal.
export function reconcileResolvedSpanDiagnostics({
  cells,
  rows,
  columns,
  unassigned,
  issues,
  repairs
}) {
  const repairSet = new Set(repairs)
  const trustedRepair =
    repairSet.has('source-section-span-recovered') ||
    repairSet.has('statistical-section-span-recovered') ||
    (repairSet.has('wrapped-header-recovered') &&
      repairSet.has('ruled-final-continuation-recovered')) ||
    (repairSet.has('header-span-inferred') &&
      [
        'text-supported-row-recovered',
        'leading-header-line-recovered',
        'ruled-final-continuation-recovered'
      ].some((repair) => repairSet.has(repair)))
  if (
    unassigned.length ||
    issues.has('unresolved-spanning-cells') ||
    rows.length === 0 ||
    columns.length === 0 ||
    !trustedRepair
  )
    return false
  const occupied = new Set()
  for (const cell of cells) {
    const rowSpan = cell.rowSpan ?? 1
    const colSpan = cell.colSpan ?? 1
    if (
      !Number.isInteger(cell.row) ||
      !Number.isInteger(cell.column) ||
      rowSpan < 1 ||
      colSpan < 1 ||
      cell.row < 0 ||
      cell.column < 0 ||
      cell.row + rowSpan > rows.length ||
      cell.column + colSpan > columns.length
    )
      return false
    for (let row = cell.row; row < cell.row + rowSpan; row++)
      for (let column = cell.column; column < cell.column + colSpan; column++) {
        const slot = `${row}:${column}`
        if (occupied.has(slot)) return false
        occupied.add(slot)
      }
  }
  if (occupied.size !== rows.length * columns.length) return false
  const staleIssues = [
    'overlapping-predicted-columns',
    'span-conflicts-with-source-columns',
    'span-conflicts-with-source-rows',
    'conflicting-spanning-cells',
    'nonrectangular-spanning-cell'
  ]
  const cleared = staleIssues.filter((issue) => issues.delete(issue))
  if (!cleared.length) return false
  repairs.push('resolved-span-conflicts-discarded')
  return true
}

export function constrainCaptionLaneCrop(table, detectorCrop, captions = []) {
  if (!table?.cropRect || !Array.isArray(detectorCrop) || !Array.isArray(captions)) return table
  const candidates = captions
    .filter((caption) => captionKind(caption.lines?.[0] ?? '') === 'table' && caption.rect)
    .map((caption) => {
      const overlap = Math.max(
        0,
        Math.min(caption.rect[2], detectorCrop[2]) - Math.max(caption.rect[0], detectorCrop[0])
      )
      const width = Math.min(caption.rect[2] - caption.rect[0], detectorCrop[2] - detectorCrop[0])
      const verticalGap =
        detectorCrop[3] < caption.rect[1]
          ? caption.rect[1] - detectorCrop[3]
          : caption.rect[3] < detectorCrop[1]
            ? detectorCrop[1] - caption.rect[3]
            : 0
      return { caption, score: width > 0 ? overlap / width : 0, verticalGap }
    })
    .filter(({ score, verticalGap }) => score >= 0.5 && verticalGap <= 60)
    .sort((a, b) => b.score - a.score || a.verticalGap - b.verticalGap)
  const selected = candidates[0]?.caption
  if (!selected) return table
  const next = [...table.cropRect]
  if (detectorCrop[0] >= selected.rect[0] - 8 && next[0] < selected.rect[0] - 8)
    next[0] = selected.rect[0] - 4
  if (detectorCrop[2] <= selected.rect[2] + 8 && next[2] > selected.rect[2] + 8)
    next[2] = selected.rect[2] + 4
  return next.some((value, index) => value !== table.cropRect[index])
    ? rebaseTableCrop(table, next)
    : table
}

// Wide native tables can lose their last record when the detector closes at
// the second-to-last baseline. A complete numeric source row followed by one
// full-width native closing rule is sufficient to extend the crop. Requiring
// many columns and rejecting prose keeps this from absorbing the next block.
export function recoverWideTableBottomCrop(table, pageItems, rules) {
  const crop = table?.cropRect
  const columns = table?.structure?.objects
    ?.filter((object) => object.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (!crop || !columns || columns.length < 8) return
  const widths = crop[2] - crop[0]
  const heights = pageItems
    .map((item) => item.height)
    .filter((height) => Number.isFinite(height) && height > 0)
    .sort((a, b) => a - b)
  const height = heights[Math.floor(heights.length / 2)]
  if (!(height > 0) || widths <= 0) return
  const candidates = pageItems.filter(
    (item) =>
      item.horizontal &&
      item.rect[0] < crop[2] + height &&
      item.rect[2] > crop[0] - height &&
      item.rect[1] >= crop[3] - height * 0.35 &&
      item.rect[1] <= crop[3] + height * 4 &&
      item.rect[3] > crop[3] - height * 0.1
  )
  const groups = []
  for (const item of candidates.sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const group = groups.at(-1)
    if (group && Math.abs(group[0].baseline - item.baseline) <= height * 0.3) group.push(item)
    else groups.push([item])
  }
  const complete = groups
    .map((group) => ({
      group,
      numeric: group.filter((item) => /\d/u.test(item.text)).length,
      left: Math.min(...group.map((item) => item.rect[0])),
      right: Math.max(...group.map((item) => item.rect[2])),
      bottom: Math.max(...group.map((item) => item.rect[3]))
    }))
    .filter(
      ({ group, numeric, left, right }) =>
        numeric >= Math.max(4, Math.ceil(columns.length * 0.5)) &&
        right - left >= widths * 0.7 &&
        group.length >= Math.max(5, Math.ceil(columns.length * 0.6))
    )
  if (!complete.length) return
  const last = complete.at(-1)
  const closing = joinHorizontalTableRules(rules)
    .filter(
      (rule) =>
        rule[1] > last.bottom &&
        rule[1] - last.bottom <= height * 1.8 &&
        rule[0] <= crop[0] + height &&
        rule[2] >= crop[2] - height &&
        rule[2] - rule[0] >= widths * 0.8
    )
    .sort((a, b) => a[1] - b[1])[0]
  // Some PDFs place the closing rule after the detector crop, so the rule
  // never reaches the source-rule list.  A complete, numeric terminal row
  // immediately below the crop is still safe to include: require a wide
  // table, coverage across most columns, and a short record-like line so a
  // neighboring prose paragraph cannot expand the table.
  if (!closing) {
    const extension = last.bottom - crop[3]
    const text = last.group.map((item) => item.text).join(' ')
    const letters = (text.match(/\p{L}/gu) ?? []).length
    if (
      extension > 0 &&
      extension <= height * 1.6 &&
      last.group.length >= Math.max(6, Math.ceil(columns.length * 0.7)) &&
      last.numeric >= Math.max(4, Math.ceil(columns.length * 0.5)) &&
      letters <= 60
    )
      return [crop[0], crop[1], crop[2], last.bottom + Math.min(1.5, height * 0.2)]
    return
  }
  const between = pageItems.filter(
    (item) =>
      item.horizontal &&
      item.rect[1] >= crop[3] - height * 0.2 &&
      item.rect[3] <= closing[1] + height * 0.1 &&
      item.rect[0] < crop[2] &&
      item.rect[2] > crop[0] &&
      !last.group.includes(item)
  )
  if (
    between.some((item) => /\p{L}{4}/u.test(item.text) && !/^[A-Za-z]+[-/]?\d*$/u.test(item.text))
  )
    return
  const bottom = Math.min(closing[1] + 1.5, Math.max(crop[3], closing[1] + height * 0.35))
  return bottom > crop[3] ? [crop[0], crop[1], crop[2], bottom] : undefined
}

// A narrow source-text table can lose only the bottom of its final row when
// the detector closes a few pixels early.  Extend the crop only when the
// terminal row is explicitly represented in every predicted column; this
// preserves the grid and cell semantics while recovering the missing ink.
export function recoverCompleteTerminalSourceRowCrop(table, pageItems) {
  const crop = table?.cropRect
  const rows = table?.rows
  const cells = table?.cells
  const columns = table?.structure?.objects?.filter((object) => object.label === 'table column')
  if (!crop || !columns?.length) return
  if (!Array.isArray(rows) || !Array.isArray(cells)) {
    const width = crop[2] - crop[0]
    const height = crop[3] - crop[1]
    if (!(width > 0 && height > 0)) return
    const absoluteColumns = columns.map((column) => [
      column.rect[0] + crop[0],
      column.rect[1] + crop[1],
      column.rect[2] + crop[0],
      column.rect[3] + crop[1]
    ])
    const heights = (pageItems ?? [])
      .map((item) => item.height)
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((a, b) => a - b)
    const lineHeight = heights[Math.floor(heights.length / 2)]
    if (!(lineHeight > 0)) return
    const source = (pageItems ?? []).filter(
      (item) =>
        item.horizontal &&
        item.rect[1] < crop[3] + lineHeight * 1.6 &&
        item.rect[3] > crop[3] - lineHeight * 0.4 &&
        item.rect[0] < crop[2] &&
        item.rect[2] > crop[0] &&
        item.text.trim()
    )
    const groups = []
    const baselineOf = (item) => (Number.isFinite(item.baseline) ? item.baseline : item.rect[3])
    for (const item of source.sort(
      (a, b) => baselineOf(a) - baselineOf(b) || a.rect[0] - b.rect[0]
    )) {
      const group = groups.at(-1)
      if (group && Math.abs(baselineOf(group[0]) - baselineOf(item)) <= lineHeight * 0.35)
        group.push(item)
      else groups.push([item])
    }
    const terminal = groups
      .filter((group) => group.some((item) => item.rect[3] > crop[3] + 0.5))
      .at(-1)
    if (!terminal || terminal.length < Math.max(5, Math.ceil(absoluteColumns.length * 0.7))) return
    const numeric = terminal.filter((item) => /\d/.test(item.text)).length
    if (numeric < Math.max(4, Math.ceil(absoluteColumns.length * 0.5))) return
    if (
      absoluteColumns.some(
        (column) => !terminal.some((item) => item.rect[0] < column[2] && item.rect[2] > column[0])
      )
    )
      return
    const bottom = Math.max(...terminal.map((item) => item.rect[3]))
    if (bottom - crop[3] > lineHeight * 1.4) return
    return [crop[0], crop[1], crop[2], bottom + Math.min(1.5, lineHeight * 0.2)]
  }
  const lastRow = rows.at(-1)
  const rowIndex = (table.grid?.length ?? 0) - 1
  if (!lastRow || lastRow.origin !== 'source-text' || rowIndex < 0) return
  if (!(lastRow.rect?.[3] > crop[3] + 0.5) || lastRow.rect[1] >= crop[3]) return
  const terminalCells = cells.filter((cell) => cell.row === rowIndex)
  if (
    terminalCells.length < columns.length ||
    terminalCells.some((cell) => !cell.sourceRects?.length)
  )
    return
  const rowItems = (pageItems ?? []).filter(
    (item) =>
      item.horizontal &&
      item.rect[1] < lastRow.rect[3] + 0.5 &&
      item.rect[3] > lastRow.rect[1] - 0.5 &&
      item.rect[0] < crop[2] &&
      item.rect[2] > crop[0]
  )
  if (!rowItems.length) return
  const coveredColumns = columns.filter((column) =>
    rowItems.some((item) => item.rect[0] < column.rect[2] && item.rect[2] > column.rect[0])
  )
  if (coveredColumns.length < columns.length) return
  const heights = rowItems
    .map((item) => item.height)
    .filter((height) => Number.isFinite(height) && height > 0)
  heights.sort((a, b) => a - b)
  const height = heights[Math.floor(heights.length / 2)]
  if (!(height > 0) || lastRow.rect[3] - crop[3] > height * 1.4) return
  return [crop[0], crop[1], crop[2], lastRow.rect[3] + Math.min(1.5, height * 0.2)]
}

// A detector crop can include the first line of the paragraph following a
// ruled table.  Trim only when the final full-width horizontal rule is an
// explicit native boundary and there is source ink for at least two complete
// baselines above it.  The last rule is selected so an interior separator
// cannot shorten a table; no prose heuristics are used to extend the crop.
export function recoverRuledBottomBoundaryCrop(table, pageItems, rules) {
  const crop = table?.cropRect
  if (!crop || !Array.isArray(pageItems) || !Array.isArray(rules)) return
  const width = crop[2] - crop[0]
  if (!(width > 0)) return
  const horizontal = joinHorizontalTableRules(rules)
    .filter(
      (rule) =>
        rule[1] === rule[3] &&
        rule[1] > crop[1] &&
        rule[1] <= crop[3] &&
        rule[0] <= crop[0] + 10 &&
        rule[2] >= crop[2] - 10 &&
        rule[2] - rule[0] >= width * 0.9
    )
    .sort((a, b) => b[1] - a[1])
  if (!horizontal.length) return
  const heights = pageItems
    .map((item) => item.height)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b)
  const height = heights[Math.floor(heights.length / 2)]
  if (!(height > 0)) return
  const columnRects = (table.structure?.objects ?? [])
    .filter((object) => object.label === 'table column' && Array.isArray(object.rect))
    .map((object) => [
      object.rect[0] + crop[0],
      object.rect[1] + crop[1],
      object.rect[2] + crop[0],
      object.rect[3] + crop[1]
    ])
  for (const boundary of horizontal) {
    if (crop[3] - boundary[1] > height * 2.2) continue
    if (
      pageItems.some(
        (item) =>
          item.horizontal &&
          item.rect[1] < boundary[1] &&
          item.rect[3] > crop[3] &&
          item.rect[0] < crop[2] &&
          item.rect[2] > crop[0]
      )
    )
      continue
    const following = pageItems.filter(
      (item) =>
        item.horizontal &&
        item.rect[1] >= boundary[1] - height * 0.05 &&
        item.rect[3] <= crop[3] + height * 0.1 &&
        item.rect[0] >= crop[0] - height &&
        item.rect[2] <= crop[2] + height
    )
    const proseLines = []
    for (const item of following.sort((a, b) => a.baseline - b.baseline)) {
      const line = proseLines.at(-1)
      if (line && Math.abs(line.baseline - item.baseline) <= height * 0.4) line.items.push(item)
      else proseLines.push({ baseline: item.baseline, items: [item] })
    }
    const followingProse = proseLines.some(({ items: line }) => {
      const text = line.map((item) => item.text).join(' ')
      const letters = (text.match(/\p{L}/gu) ?? []).length
      return (
        line.length >= 6 &&
        letters >= 20 &&
        /\p{L}{4}/u.test(text) &&
        !/^[-+−]?\d[\d.,()%\s-]*$/u.test(text)
      )
    })
    if (!followingProse) continue
    const alignedDataRow =
      columnRects.length >= 3 &&
      proseLines.some(({ items: line }) => {
        const occupied = new Set(
          line
            .map((item) =>
              columnRects.findIndex(
                (column) =>
                  item.rect[0] >= column[0] - height * 0.25 &&
                  item.rect[2] <= column[2] + height * 0.25
              )
            )
            .filter((column) => column >= 0)
        )
        return occupied.size >= Math.max(3, columnRects.length - 1)
      })
    if (alignedDataRow) continue
    const body = pageItems.filter(
      (item) =>
        item.horizontal &&
        item.rect[0] >= crop[0] - height &&
        item.rect[2] <= crop[2] + height &&
        item.rect[3] <= boundary[1] + height * 0.15
    )
    const baselines = []
    for (const item of body.sort((a, b) => a.baseline - b.baseline)) {
      const prior = baselines.at(-1)
      if (!prior || Math.abs(prior - item.baseline) > height * 0.4) baselines.push(item.baseline)
    }
    if (baselines.length < 2) continue
    const bottom = boundary[1] + Math.min(2, height * 0.2)
    if (bottom >= crop[3] - height * 0.2) return
    return [crop[0], crop[1], crop[2], bottom]
  }
}

// A grouped text table can emit the first line of a multi-line stub as a
// standalone source baseline while the detector starts at the following line.
// Recover that missing row only when the baseline contains a label plus one
// value in every non-stub lane and a model row immediately follows it.  This
// keeps ordinary paragraph text and isolated labels out of the table grid.
export function recoverGroupedStubSourceRow(table, pageItems) {
  const crop = table?.cropRect
  const objects = table?.structure?.objects
  if (!crop || !Array.isArray(objects) || !Array.isArray(pageItems)) return false
  const columns = objects
    .filter((object) => object.label === 'table column')
    .map((object) => [
      object.rect[0] + crop[0],
      object.rect[1] + crop[1],
      object.rect[2] + crop[0],
      object.rect[3] + crop[1]
    ])
    .sort((a, b) => a[0] - b[0])
  if (columns.length < 3) return false
  const heights = pageItems
    .map((item) => item.height)
    .filter((height) => Number.isFinite(height) && height > 0)
    .sort((a, b) => a - b)
  const height = heights[Math.floor(heights.length / 2)]
  if (!(height > 0)) return false
  const source = pageItems.filter(
    (item) => item.horizontal && item.rect[0] < crop[2] && item.rect[2] > crop[0]
  )
  const grouped = []
  for (const item of source.sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const group = grouped.at(-1)
    if (group && Math.abs(group.baseline - item.baseline) <= height * 0.3) {
      group.items.push(item)
      group.baseline = (group.baseline + item.baseline) / 2
    } else grouped.push({ baseline: item.baseline, items: [item] })
  }
  const columnOf = (item) =>
    columns.findIndex((column) => {
      const center = (item.rect[0] + item.rect[2]) / 2
      return center >= column[0] - height * 0.2 && center <= column[2] + height * 0.2
    })
  for (const group of grouped) {
    if (group.items.length !== columns.length) continue
    const label = group.items.find(
      (item) =>
        /\p{Lu}/u.test(item.text.trim()) &&
        !/^Tables:\s*\d[\d,.]*$/u.test(item.text.trim()) &&
        columnOf(item) === 0
    )
    const values = group.items.filter((item) => /^Tables:\s*\d[\d,.]*$/u.test(item.text.trim()))
    if (!label || values.length !== columns.length - 1) continue
    const lanes = new Set(values.map(columnOf))
    if (lanes.size !== values.length || [...lanes].some((column) => column < 1)) continue
    const nextRows = objects
      .filter((object) => object.label === 'table row')
      .map((object) => ({
        top: object.rect[1] + crop[1],
        bottom: object.rect[3] + crop[1]
      }))
      .filter(({ top }) => top > group.baseline - height * 0.25)
      .sort((a, b) => a.top - b.top)
    const next = nextRows[0]
    if (!next || next.top - group.baseline > height * 2.2) continue
    if (next.top <= Math.min(...group.items.map((item) => item.rect[3]))) continue
    const previous = nextRows
      .filter(({ bottom }) => bottom < group.baseline)
      .sort((a, b) => b.bottom - a.bottom)[0]
    if (previous && group.baseline - previous.bottom > height * 2.4) continue
    const followingSource = source
      .filter((item) => columnOf(item) === 0 && item.baseline > group.baseline + height * 0.25)
      .sort((a, b) => a.rect[1] - b.rect[1])[0]
    const rowTop = Math.max(
      crop[1],
      Math.min(...group.items.map((item) => item.rect[1])) - height * 0.2
    )
    const rowBottom = Math.min(
      next.top,
      followingSource?.rect[1] ?? next.top,
      Math.max(...group.items.map((item) => item.rect[3])) + height * 0.2
    )
    if (rowBottom <= rowTop) continue
    objects.push({
      label: 'table row',
      score: 1,
      rect: [0, rowTop - crop[1], crop[2] - crop[0], rowBottom - crop[1]],
      origin: 'source-grouped-stub-row'
    })
    return true
  }
  return false
}

// A side-by-side native table can be detected from only its right panel, while
// the source text for the left labels and the terminal highlighted row extends
// just beyond both crop edges. Expand only when both clipped sides contain
// short, row-aligned runs across several existing baselines.
export function recoverClippedSideBySideCrop(table, pageItems) {
  const crop = table?.cropRect
  const objects = table?.structure?.objects
  if (!crop || !Array.isArray(objects) || !Array.isArray(pageItems)) return
  const rows = objects
    .filter((object) => object.label === 'table row')
    .map((object) => [object.rect[1] + crop[1], object.rect[3] + crop[1]])
  if (rows.length < 4) return
  const heights = pageItems
    .map((item) => item.height)
    .filter((height) => Number.isFinite(height) && height > 0)
    .sort((a, b) => a - b)
  const height = heights[Math.floor(heights.length / 2)]
  if (!(height > 0)) return
  const clipped = pageItems.filter(
    (item) =>
      item.horizontal &&
      item.text.trim().length > 0 &&
      item.text.trim().length < 40 &&
      item.rect[3] >= crop[1] - height &&
      item.rect[1] <= crop[3] + height &&
      (item.rect[0] < crop[0] || item.rect[2] > crop[2])
  )
  const left = clipped.filter((item) => item.rect[0] < crop[0] && item.rect[2] > crop[0] - 90)
  const right = clipped.filter((item) => item.rect[2] > crop[2] && item.rect[0] < crop[2] + 90)
  if (left.length < 4 || right.length < 4) return
  const rowOf = (item) => {
    const center = (item.rect[1] + item.rect[3]) / 2
    return rows.findIndex(
      ([top, bottom]) => center >= top - height * 0.45 && center <= bottom + height * 0.45
    )
  }
  const leftRows = new Set(left.map(rowOf).filter((row) => row >= 0))
  const rightRows = new Set(right.map(rowOf).filter((row) => row >= 0))
  if (leftRows.size < 4 || rightRows.size < 4) return
  const interiorRows = new Set(
    pageItems
      .filter(
        (item) =>
          item.rect[0] >= crop[0] &&
          item.rect[2] <= crop[2] &&
          item.rect[1] >= crop[1] &&
          item.rect[3] <= crop[3]
      )
      .map(rowOf)
      .filter((row) => row >= 0)
  )
  const sharedRows = [...leftRows].filter((row) => rightRows.has(row) && interiorRows.has(row))
  if (sharedRows.length < 4) return
  const leftLabels = left.filter(
    (item) => /\p{L}/u.test(item.text.trim()) && !/^[-+]?\d[\d.,%]*$/u.test(item.text.trim())
  )
  if (leftLabels.length < Math.max(2, Math.ceil(leftRows.size / 2))) return
  const cropRect = [
    Math.max(0, Math.min(crop[0], ...left.map((item) => item.rect[0])) - height * 0.2),
    Math.max(0, Math.min(crop[1], ...clipped.map((item) => item.rect[1])) - height * 0.2),
    Math.max(crop[2], ...right.map((item) => item.rect[2])) + height * 0.2,
    Math.max(crop[3], ...clipped.map((item) => item.rect[3])) + height * 0.2
  ]
  if (cropRect[0] === crop[0] && cropRect[2] === crop[2] && cropRect[3] === crop[3]) return
  return cropRect
}

// A detector may start a table at the first visible glyph while a short
// multiline stub label begins just outside that edge.  Expand only when at
// least two letter runs cross the left edge and each one aligns with a
// predicted row; a single nearby prose line must not pull a crop sideways.
export function recoverClippedLeftLabelCrop(table, pageItems) {
  const crop = table?.cropRect
  const objects = table?.structure?.objects
  if (!crop || !Array.isArray(objects) || !Array.isArray(pageItems)) return
  const rows = objects
    .filter((object) => object.label === 'table row')
    .map((object) => [object.rect[1] + crop[1], object.rect[3] + crop[1]])
  if (rows.length < 3) return
  const heights = pageItems
    .map((item) => item.height)
    .filter((height) => Number.isFinite(height) && height > 0)
    .sort((a, b) => a - b)
  const height = heights[Math.floor(heights.length / 2)]
  if (!(height > 0)) return
  const rowOf = (item) => {
    const center = (item.rect[1] + item.rect[3]) / 2
    return rows.findIndex(
      ([top, bottom]) => center >= top - height * 0.45 && center <= bottom + height * 0.45
    )
  }
  const clipped = pageItems.filter(
    (item) =>
      item.horizontal &&
      /\p{L}/u.test(item.text.trim()) &&
      item.text.trim().length <= 40 &&
      item.text.trim().split(/\s+/u).length <= 4 &&
      item.rect[0] < crop[0] &&
      item.rect[2] > crop[0] &&
      item.rect[1] >= crop[1] - height &&
      item.rect[3] <= crop[3] + height
  )
  const aligned = clipped.filter((item) => rowOf(item) >= 0)
  const rowSet = new Set(aligned.map(rowOf))
  if (aligned.length < 2 || rowSet.size < 2) return
  const numericRows = new Set(
    pageItems
      .filter(
        (item) =>
          item.horizontal &&
          item.rect[0] >= crop[0] &&
          item.rect[2] <= crop[2] &&
          rowOf(item) >= 0 &&
          /^[<>≤≥−+-]?\d[\d.,%()±–—+/<>=-]*$/u.test(item.text.trim())
      )
      .map(rowOf)
  )
  // The clipped run must share rows with owned table values. Two short prose
  // lines at the crop edge can otherwise look like a truncated stub lane.
  if ([...rowSet].some((row) => !numericRows.has(row))) return
  // A neighboring prose line can cross the crop edge, but it will not form
  // a compact left-stub run across several predicted rows.
  if (rowSet.size < Math.min(3, rows.length - 1)) return
  const left = Math.min(...aligned.map((item) => item.rect[0]))
  if (!(left < crop[0] - height * 0.4)) return
  return [Math.max(0, left - height * 0.15), crop[1], crop[2], crop[3]]
}

// A narrow table at the page or column edge can retain its model grid while
// clipping the terminal glyphs of a right-hand header/value column. Expand
// only when several short horizontal items cross the same right edge on
// distinct table rows; a single adjacent prose line must not pull the crop.
export function recoverClippedRightLabelCrop(table, pageItems, rules) {
  const crop = table?.cropRect
  if (!crop || !Array.isArray(pageItems)) return
  const heights = pageItems
    .map((item) => item.height)
    .filter((height) => Number.isFinite(height) && height > 0)
    .sort((a, b) => a - b)
  const height = heights[Math.floor(heights.length / 2)]
  if (!(height > 0)) return
  const clipped = pageItems.filter(
    (item) =>
      item.horizontal &&
      typeof item.text === 'string' &&
      item.text.trim().length > 0 &&
      item.text.trim().length <= 24 &&
      item.rect[2] > crop[2] + 0.1 &&
      item.rect[0] >= crop[2] - height * 3.5 &&
      item.rect[1] >= crop[1] - height &&
      item.rect[3] <= crop[3] + height
  )
  if (clipped.length < 3) return
  const rows = new Set(
    clipped.map((item) => Math.round(((item.rect[1] + item.rect[3]) / 2 - crop[1]) / height))
  )
  if (rows.size < 3) return
  const numericOrHeader = clipped.filter(
    (item) =>
      /[\p{L}\p{N}]/u.test(item.text.trim()) &&
      (/[\p{L}]/u.test(item.text.trim()) ||
        /^[<>≤≥−+-]?\d[\d.,%()±–—+/<>=-]*$/u.test(item.text.trim()))
  )
  const numeric = clipped.filter((item) =>
    /^[<>≤≥−+-]?\d[\d.,%()±–—+/<>=-]*$/u.test(item.text.trim())
  )
  if (numericOrHeader.length < 2 || numeric.length < 2) return
  const columns = (table.structure?.objects ?? [])
    .filter((object) => object.label === 'table column')
    .sort((a, b) => b.rect[2] - a.rect[2])
  const terminalColumn = columns[0]
  if (
    terminalColumn &&
    clipped.some(
      (item) =>
        item.rect[0] < crop[2] - height * 3.5 ||
        item.rect[0] > crop[2] + height * 0.25 ||
        item.rect[0] < crop[0] + terminalColumn.rect[0] - height * 0.5
    )
  )
    return
  const modelRows = (table.structure?.objects ?? []).filter(
    (object) => object.label === 'table row'
  )
  if (modelRows.length) {
    const matchedRows = clipped.map((item) =>
      modelRows.findIndex(
        (row) =>
          item.rect[1] < crop[1] + row.rect[3] + height * 0.35 &&
          item.rect[3] > crop[1] + row.rect[1] - height * 0.35
      )
    )
    const covered = matchedRows.filter((index) => index >= 0)
    if (
      covered.length >= 2 &&
      (covered.length !== clipped.length || new Set(covered).size !== covered.length)
    )
      return
  }
  const right = Math.max(...clipped.map((item) => item.rect[2])) + height * 0.2
  if (!(right > crop[2]) || right - crop[2] > height * 1.5) return
  // A right-edge expansion is safe only when a native horizontal stroke closes
  // the same table below the clipped values. Without that boundary, adjacent
  // prose or a following panel can be mistaken for a missing terminal column.
  const lastClippedBottom = Math.max(...clipped.map((item) => item.rect[3]))
  const closingRule =
    Array.isArray(rules) &&
    rules.some(
      (rule) =>
        rule[1] === rule[3] &&
        rule[1] >= lastClippedBottom &&
        rule[1] - lastClippedBottom <= height * 2 &&
        crop[3] - rule[1] <= height * 2 &&
        rule[0] <= crop[0] + height &&
        rule[2] >= right - height * 0.2
    )
  if (rules !== undefined && !closingRule) return
  return [crop[0], crop[1], right, crop[3]]
}

// A compact captioned table can lose every body row when the detector keeps
// only its header band.  Recover this shape only when two or more clipped
// labels each have the same number of numeric lanes below the header.  The
// repeated label/value proof is deliberately stricter than the general row
// recovery paths so prose beside a one-row table cannot become a grid.
export function recoverClippedSimpleBodyCrop(table, pageItems, captions = []) {
  const crop = table?.cropRect
  const objects = table?.structure?.objects
  if (!crop || !Array.isArray(objects) || !Array.isArray(pageItems)) return
  const rows = objects.filter((object) => object.label === 'table row')
  if (rows.length !== 1 || !captions.some((caption) => /^table\b/i.test(caption?.lines?.[0] ?? '')))
    return
  const heights = pageItems
    .map((item) => item.height)
    .filter((height) => Number.isFinite(height) && height > 0)
    .sort((a, b) => a - b)
  const height = heights[Math.floor(heights.length / 2)]
  if (!(height > 0)) return
  const headerBottom = rows[0].rect[3] + crop[1]
  const numeric = (text) => /^[<>≤≥−+-]?\d[\d.,%()±–—+/<>=-]*$/u.test(text.trim())
  const labels = pageItems.filter(
    (item) =>
      item.horizontal &&
      /\p{L}/u.test(item.text.trim()) &&
      item.text.trim().length <= 40 &&
      item.text.trim().split(/\s+/u).length <= 4 &&
      item.rect[0] < crop[0] &&
      item.rect[2] > crop[0] &&
      item.rect[1] >= headerBottom - height * 0.2 &&
      item.rect[3] <= crop[3] + height
  )
  if (labels.length < 2) return
  const groups = []
  for (const item of pageItems
    .filter((candidate) => candidate.horizontal && candidate.rect[1] >= headerBottom - height * 0.2)
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const group = groups.at(-1)
    if (group && Math.abs(group[0].baseline - item.baseline) <= height * 0.35) group.push(item)
    else groups.push([item])
  }
  const body = groups.filter((group) => {
    const label = group.find((item) => labels.includes(item))
    const values = group.filter(
      (item) => item !== label && item.rect[0] >= crop[0] && item.rect[2] <= crop[2] + height
    )
    return (
      label &&
      values.length >= 2 &&
      group.length === values.length + 1 &&
      values.every((item) => numeric(item.text))
    )
  })
  if (
    body.length < 2 ||
    body.length !== labels.filter((label) => body.some((group) => group.includes(label))).length
  )
    return
  const laneCounts = body.map(
    (group) => group.filter((item) => item.rect[0] >= crop[0] && numeric(item.text)).length
  )
  if (new Set(laneCounts).size !== 1 || laneCounts[0] < 2) return
  const lanes = body.map((group) =>
    group
      .filter((item) => numeric(item.text))
      .sort((a, b) => a.rect[0] - b.rect[0])
      .map((item) => (item.rect[0] + item.rect[2]) / 2)
  )
  if (
    lanes[0].some(
      (_, lane) =>
        Math.max(...lanes.map((positions) => positions[lane])) -
          Math.min(...lanes.map((positions) => positions[lane])) >
        height
    )
  )
    return
  const left = Math.min(...body.flatMap((group) => group.map((item) => item.rect[0])))
  if (!(left < crop[0] - height * 0.15)) return
  return { cropRect: [Math.max(0, left - height * 0.15), crop[1], crop[2], crop[3]], left }
}

const isSupportedRotatedStubLabel = (item) =>
  !item.horizontal &&
  /^(?:SNR|PSNR|SSIM)\s+(?:0|5|10|15|20|25)$/i.test(item.text.trim()) &&
  item.rect[3] - item.rect[1] >= (item.rect[2] - item.rect[0]) * 1.4

export function refineTable(
  table,
  pageItems,
  captions = [],
  notes = [],
  rules = [],
  observedRuns = [],
  adjacent
) {
  pageItems = recoverNativeMeasuredGutterTokens(table, pageItems, captions, rules, observedRuns)
  const indicatorRecordPlan = recoverNativeIndicatorRecordPlan(
    table,
    pageItems,
    captions,
    rules,
    observedRuns
  )
  if (indicatorRecordPlan) pageItems = indicatorRecordPlan.pageItems
  const scalarRecordPlan = recoverNativeScalarRecordPlan(
    table,
    pageItems,
    captions,
    rules,
    observedRuns
  )
  if (scalarRecordPlan) pageItems = scalarRecordPlan.pageItems
  const repeatedTuplePlan = recoverNativeRepeatedTuplePlan(
    table,
    pageItems,
    captions,
    rules,
    observedRuns
  )
  if (repeatedTuplePlan) pageItems = repeatedTuplePlan.pageItems
  const independentTextRecords = recoverNativeTextRecordGrid(table, pageItems, captions, rules)
  if (independentTextRecords?.cropRect)
    table = rebaseTableCrop(table, independentTextRecords.cropRect)
  table = separateAdjacentNumericPanel(table, pageItems, rules)
  const originalCrop = table.cropRect
  const wideBottomCrop = recoverWideTableBottomCrop(table, pageItems, rules)
  if (wideBottomCrop) table = rebaseTableCrop(table, wideBottomCrop, true)
  const completeTerminalSourceRowCrop = recoverCompleteTerminalSourceRowCrop(table, pageItems)
  if (completeTerminalSourceRowCrop)
    table = rebaseTableCrop(table, completeTerminalSourceRowCrop, true)
  const ruledBottomBoundaryCrop = recoverRuledBottomBoundaryCrop(table, pageItems, rules)
  if (ruledBottomBoundaryCrop) table = rebaseTableCrop(table, ruledBottomBoundaryCrop, true)
  const sourceRules = rules
  const unnumberedTitleCrop = recoverClippedUnnumberedTitleCrop(table, pageItems, sourceRules)
  if (unnumberedTitleCrop) table = rebaseTableCrop(table, unnumberedTitleCrop)
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
  const horizontalRules = joinHorizontalTableRules(rules)
  rules = [...rules.filter((r) => r[1] !== r[3]), ...horizontalRules]
  // An inset table can have a detector edge in the neighboring prose column,
  // or through its own stub. Matching header/footer rules and a nearby caption
  // establish ownership independently of that detector edge.
  const captionSeparatedCrop = recoverCaptionSeparatedHeaderCrop(
    table,
    pageItems,
    captions,
    sourceRules
  )
  if (captionSeparatedCrop) table = rebaseTableCrop(table, captionSeparatedCrop)
  const modelColumns = table.structure.objects.filter((o) => o.label === 'table column')
  const closedNumericCrop = recoverClosedNumericFrameCrop(table, pageItems, captions, sourceRules)
  if (closedNumericCrop) table = rebaseTableCrop(table, closedNumericCrop)
  const countHeaderFrameCrop = recoverCountHeaderFrameCrop(table, pageItems, sourceRules)
  if (countHeaderFrameCrop) table = rebaseTableCrop(table, countHeaderFrameCrop)
  // A page can end with a ruled category heading whose measurements continue
  // on the next page. Matching native column ends bound its clipped label and
  // probability even though there is no closing horizontal stroke.
  const ends = sourceRules.filter(
    (r) =>
      r[0] === r[2] &&
      r[1] < originalCrop[3] &&
      r[3] > originalCrop[3] &&
      r[3] - originalCrop[3] < 16
  )
  const tailTop = horizontalRules.find(
    (r) =>
      r[1] < originalCrop[3] &&
      originalCrop[3] - r[1] < 20 &&
      Math.abs(r[0] - originalCrop[0]) < 12 &&
      Math.abs(r[2] - originalCrop[2]) < 12
  )
  if (
    tailTop &&
    ends.length >= 4 &&
    ends.every((r) => Math.abs(r[3] - ends[0][3]) < 0.1) &&
    [tailTop[0], tailTop[2]].every((x) => ends.some((r) => Math.abs(r[0] - x) < 1)) &&
    captions.some((c) => captionKind(c.lines[0]) === 'table')
  ) {
    const tail = pageItems
      .filter(
        (i) =>
          i.horizontal &&
          i.rect[0] >= tailTop[0] &&
          i.rect[2] <= tailTop[2] &&
          i.rect[1] > tailTop[1] &&
          i.rect[3] < ends[0][3]
      )
      .sort((a, b) => a.rect[0] - b.rect[0])
    if (
      tail.length === 2 &&
      /^\p{Lu}[^.;]{4,100}\([^)]*\)$/u.test(tail[0].text) &&
      /^(?:0?\.\d+|1(?:\.0+)?)$/.test(tail[1].text) &&
      tail[1].rect[0] > originalCrop[0] + (originalCrop[2] - originalCrop[0]) * 0.8 &&
      Math.abs(tail[0].baseline - tail[1].baseline) < tail[0].height * 0.2 &&
      tail.every((i) => i.rect[3] > originalCrop[3])
    ) {
      table = rebaseTableCrop(table, [
        originalCrop[0],
        originalCrop[1],
        originalCrop[2],
        ends[0][3]
      ])
      table.structure.objects.push({
        label: 'table row',
        score: 1,
        rect: [
          0,
          tailTop[1] - originalCrop[1],
          originalCrop[2] - originalCrop[0],
          ends[0][3] - originalCrop[1]
        ]
      })
    }
  }
  // A final summary can straddle the detector's bottom edge after the last
  // ruled record. Recover only that native baseline, not a following note.
  const tailLabel = pageItems.find(
    (i) =>
      i.horizontal &&
      /^(?:Mean|Median)(?:\s*\((?:range|IQR|SD)\))?$/i.test(i.text.trim()) &&
      i.rect[0] >= originalCrop[0] &&
      i.rect[0] - originalCrop[0] < i.height * 2 &&
      i.rect[1] < originalCrop[3] &&
      i.rect[3] > originalCrop[3]
  )
  if (
    tailLabel &&
    modelColumns.length >= 3 &&
    captions.some(
      (c) => captionKind(c.lines[0]) === 'table' && c.rect[3] <= originalCrop[1] + 24
    ) &&
    horizontalRules.some(
      (r) =>
        Math.abs(r[0] - originalCrop[0]) < 16 &&
        Math.abs(r[2] - originalCrop[2]) < 16 &&
        r[1] <= tailLabel.rect[1] &&
        tailLabel.rect[1] - r[1] < tailLabel.height
    )
  ) {
    const line = pageItems.filter(
      (i) =>
        i.horizontal &&
        i.rect[2] > originalCrop[0] &&
        i.rect[0] < originalCrop[2] &&
        Math.abs(i.baseline - tailLabel.baseline) < tailLabel.height * 0.3
    )
    if (
      line.length >= 3 &&
      line.every(
        (i) =>
          i.rect[0] >= originalCrop[0] &&
          i.rect[2] <= originalCrop[2] &&
          Math.abs(i.height - tailLabel.height) < tailLabel.height * 0.2 &&
          (i === tailLabel ||
            (i.rect[0] > tailLabel.rect[2] + tailLabel.height &&
              /^[-+−]?\d+(?:\.\d+)?(?:\s*\([−–+\d., -]+\))?$/.test(i.text.trim())))
      )
    )
      table = rebaseTableCrop(table, [
        originalCrop[0],
        originalCrop[1],
        originalCrop[2],
        // Native token bounds end at the baseline; retain glyph descenders too.
        Math.max(...line.map((i) => i.rect[3])) + tailLabel.height * 0.35
      ])
  }
  // A continued numeric table can start halfway through its wrapped first
  // stub. Matching outer side rules establish the opening band; only recover
  // text crossing the detector edge, never a whole preceding paragraph.
  if (modelColumns.length >= 3) {
    const sorted = [...modelColumns].sort((a, b) => a.rect[0] - b.rect[0])
    const stubEnd = originalCrop[0] + (sorted[0].rect[2] + sorted[1].rect[0]) / 2
    const leading = pageItems.filter(
      (i) =>
        i.horizontal &&
        i.rect[0] >= originalCrop[0] &&
        i.rect[2] <= stubEnd &&
        i.rect[1] < originalCrop[1] &&
        i.rect[3] > originalCrop[1] &&
        originalCrop[1] - i.rect[1] < i.height * 0.3 &&
        /\p{L}/u.test(i.text)
    )
    const sides = sourceRules.filter(
      (r) => r[0] === r[2] && Math.abs(r[1] - originalCrop[1]) < 2 && r[3] > originalCrop[1] + 15
    )
    if (
      leading.length &&
      sides.some(
        (r) =>
          Math.abs(r[0] - originalCrop[0]) < 24 &&
          sides.some(
            (s) =>
              Math.abs(s[0] - originalCrop[2]) < 24 &&
              Math.abs(s[1] - r[1]) < 1 &&
              Math.abs(s[3] - r[3]) < 1
          )
      ) &&
      pageItems.filter(
        (i) =>
          inside(originalCrop, i) &&
          i.rect[0] > stubEnd &&
          i.baseline < Math.min(...sides.map((r) => r[3])) &&
          /^\d+(?:\.\d+)?%?$/.test(i.text)
      ).length >= 4
    ) {
      table = rebaseTableCrop(table, [
        originalCrop[0],
        Math.min(...leading.map((i) => i.rect[1])) - 1,
        originalCrop[2],
        originalCrop[3]
      ])
      const firstRow = table.structure.objects
        .filter((o) => o.label === 'table row')
        .sort((a, b) => a.rect[1] - b.rect[1])[0]
      if (firstRow) firstRow.rect[1] = 0
    }
  }
  // A continued table may have only its top/header rules on this page.
  // Preserve a small side overhang when those rules and an otherwise complete
  // numeric record independently own the clipped value.
  const continuedCountTable =
    pageItems.some(
      (i) =>
        inside(originalCrop, i) &&
        /^\(Table\s+\d+\s+continues on (?:the )?next page\)$/i.test(i.text.trim())
    ) ||
    captions.some(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[1] >= originalCrop[3] &&
        c.rect[1] - originalCrop[3] < 80
    )
  const sideRule = horizontalRules.find(
    (r) =>
      modelColumns.length >= 3 &&
      r[1] >= originalCrop[1] &&
      r[1] - originalCrop[1] < 45 &&
      Math.abs(r[0] - originalCrop[0]) < 16 &&
      r[2] > originalCrop[2] &&
      r[2] - originalCrop[2] <
        (continuedCountTable ? (originalCrop[2] - originalCrop[0]) * 0.1 : 16) &&
      (continuedCountTable ||
        captions.some(
          (c) => captionKind(c.lines[0]) === 'table' && c.rect[3] <= r[1] && r[1] - c.rect[3] < 30
        ))
  )
  if (sideRule) {
    const clippedValues = pageItems.filter(
      (i) =>
        i.horizontal &&
        i.rect[0] < originalCrop[2] &&
        i.rect[2] > originalCrop[2] &&
        i.rect[2] <= sideRule[2] + 1 &&
        i.rect[1] > sideRule[1] &&
        i.rect[3] <= originalCrop[3] &&
        /^[-+−<>≤≥]?\d[\d.,·–−+%()\s/-]*$/.test(i.text) &&
        pageItems.filter(
          (a) =>
            inside(originalCrop, a) &&
            a.rect[2] < i.rect[0] &&
            Math.abs(a.baseline - i.baseline) < i.height * 0.25 &&
            /\d/.test(a.text)
        ).length >= 2
    )
    if (clippedValues.length >= (continuedCountTable ? 3 : 1))
      table = rebaseTableCrop(table, [
        originalCrop[0],
        originalCrop[1],
        sideRule[2] + 1,
        originalCrop[3]
      ])
  }
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
          Math.abs(footer[0] - header[0]) <= 2 &&
          Math.abs(footer[2] - header[2]) <= 2 &&
          ((footer[1] > originalCrop[3] &&
            footer[1] - originalCrop[3] <= 120 &&
            captions.some(
              (c) =>
                captionKind(c.lines[0]) === 'table' &&
                c.rect[1] >= footer[1] &&
                c.rect[1] - footer[1] <= 18 &&
                Math.abs(c.rect[0] - footer[0]) <= 6
            )) ||
            (footer[1] > header[1] + (originalCrop[3] - originalCrop[1]) * 0.7 &&
              footer[1] <= originalCrop[3] &&
              originalCrop[3] - footer[1] <= 16 &&
              pageItems.some(
                (i) =>
                  i.horizontal &&
                  i.rect[1] >= header[1] &&
                  i.rect[3] <= footer[1] &&
                  ((inside(originalCrop, i) &&
                    i.rect[0] >= header[0] &&
                    i.rect[2] <= header[2] &&
                    (i.rect[0] < originalCrop[0] || i.rect[2] > originalCrop[2])) ||
                    (intersect(i.rect, originalCrop) > 0 &&
                      intersect(i.rect, originalCrop) / area(i.rect) < 0.1 &&
                      (i.rect[0] >= header[2] + i.height || i.rect[2] <= header[0] - i.height)))
              ) &&
              captions.some(
                (c) =>
                  captionKind(c.lines[0]) === 'table' &&
                  ((c.rect[3] <= header[1] && header[1] - c.rect[3] <= 24) ||
                    (c.rect[1] >= header[1] && c.rect[3] - header[1] <= 24)) &&
                  Math.abs(c.rect[0] - header[0]) <= 6
              )))
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
        !captions.some((c) => intersect(i.rect, c.rect) / area(i.rect) > 0.8) &&
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
    table = rebaseTableCrop(table, cropRect)
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
      table = rebaseTableCrop(table, cropRect)
    }
  }
  const segmentedLeafHeader = recoverSegmentedLeafHeaderBand(
    table,
    pageItems,
    captions,
    sourceRules
  )
  if (segmentedLeafHeader) {
    table = rebaseTableCrop(table, segmentedLeafHeader.cropRect)
    table.structure.objects = table.structure.objects.filter(
      (o) =>
        !['table column', 'table column header'].includes(o.label) &&
        !(
          o.label === 'table row' &&
          (o.rect[1] + o.rect[3]) / 2 + table.cropRect[1] < segmentedLeafHeader.headerRect[3]
        )
    )
    const headerRect = segmentedLeafHeader.headerRect.map((v, n) => v - table.cropRect[n % 2])
    table.structure.objects.push(
      { label: 'table row', score: 1, rect: headerRect },
      { label: 'table column header', score: 1, rect: headerRect },
      ...segmentedLeafHeader.columnRects.map((rect) => ({
        label: 'table column',
        score: 1,
        rect: rect.map((v, n) => v - table.cropRect[n % 2])
      }))
    )
  }
  const demographicRecords = recoverDemographicRecords(table, pageItems, captions, rules)
  if (demographicRecords?.cropRect) table = rebaseTableCrop(table, demographicRecords.cropRect)
  const coefficientGrid = recoverSectionedCoefficientsGrid(table, pageItems, rules)
  if (coefficientGrid) table = rebaseTableCrop(table, coefficientGrid.cropRect)
  const ruledColumnGrid = recoverRuledColumnGrid(table, pageItems, captions, sourceRules)
  if (ruledColumnGrid) table = rebaseTableCrop(table, ruledColumnGrid.cropRect)
  const ruledHeaderGrid = recoverRuledHeaderGrid(table, pageItems, captions, sourceRules)
  if (ruledHeaderGrid?.cropRect) table = rebaseTableCrop(table, ruledHeaderGrid.cropRect)
  const clippedHeader = recoverClippedColumnHeader(table, pageItems, rules, captions)
  if (clippedHeader) {
    table = rebaseTableCrop(table, clippedHeader.cropRect)
    const rect = clippedHeader.rect.map((v, i) => v - table.cropRect[i % 2])
    table.structure.objects.push(
      { label: 'table row', rect, score: 1 },
      { label: 'table column header', rect, score: 1 },
      ...(clippedHeader.spans ?? []).map((span) => ({
        label: 'table spanning cell',
        rect: span.map((v, i) => v - table.cropRect[i % 2]),
        score: 1
      }))
    )
  }
  const headerlessRecords = recoverHeaderlessRuledRecords(table, pageItems, captions, rules)
  if (headerlessRecords) table = rebaseTableCrop(table, headerlessRecords.cropRect)
  const intervalRecords = recoverRuledIntervalRecords(table, pageItems, captions, rules)
  if (intervalRecords) table = rebaseTableCrop(table, intervalRecords.cropRect)
  const alleleGrid = recoverAlleleDistributionGrid(table, pageItems, captions, rules)
  if (alleleGrid) table = rebaseTableCrop(table, alleleGrid.cropRect)
  const regressionBlocks = recoverRepeatedRegressionGrid(table, pageItems, captions, rules)
  if (regressionBlocks) table = rebaseTableCrop(table, regressionBlocks.cropRect)
  const wrappedSummaryGrid = recoverWrappedSummaryGrid(table, pageItems, captions, rules)
  const comparisonRecords =
    wrappedSummaryGrid ||
    (ruledColumnGrid?.headerRows?.length === 1 && ruledColumnGrid.spans?.length === 0)
      ? undefined
      : recoverRuledComparisonRecords(table, pageItems, captions, rules)
  if (comparisonRecords) table = rebaseTableCrop(table, comparisonRecords.cropRect)
  const recordCandidate = recoverRecordGrid(table, pageItems, captions, rules)
  if (recordCandidate?.cropRect) table = rebaseTableCrop(table, recordCandidate.cropRect)
  const cohortRecords = recoverCohortDistributionRecords(table, pageItems, sourceRules)
  if (cohortRecords) table = rebaseTableCrop(table, cohortRecords.cropRect)
  const longQuestionGrid = recoverNativeQuestionRecordGrid(table, pageItems, captions, sourceRules)
  if (longQuestionGrid?.cropRect) table = rebaseTableCrop(table, longQuestionGrid.cropRect)
  const sparseModelGrid = recoverNativeSparseModelRecordGrid(
    table,
    pageItems,
    captions,
    sourceRules
  )
  if (sparseModelGrid?.cropRect) table = rebaseTableCrop(table, sparseModelGrid.cropRect)
  const nativeCohortGrid = recoverNativeCohortRecordGrid(table, pageItems, captions, sourceRules)
  if (nativeCohortGrid?.cropRect) table = rebaseTableCrop(table, nativeCohortGrid.cropRect)
  const questionnaireGrid = recoverQuestionnaireGrid(table, pageItems, captions, sourceRules)
  if (questionnaireGrid) table = rebaseTableCrop(table, questionnaireGrid.cropRect)
  const studyParagraphGrid = recoverStudyParagraphGrid(table, pageItems, captions, sourceRules)
  if (studyParagraphGrid) table = rebaseTableCrop(table, studyParagraphGrid.cropRect)
  const parallelCountLists = recoverParallelCountLists(table, pageItems, captions, sourceRules)
  if (parallelCountLists) table = rebaseTableCrop(table, parallelCountLists.cropRect)
  const cohortSummaryRows = recoverCohortSummaryRows(table, pageItems, captions, sourceRules)
  if (cohortSummaryRows) table = rebaseTableCrop(table, cohortSummaryRows.cropRect)
  const pairedIntervalGrid = recoverPairedIntervalGrid(table, pageItems, captions, sourceRules)
  if (pairedIntervalGrid) table = rebaseTableCrop(table, pairedIntervalGrid.cropRect)
  const closedCellGrid = recoverClosedCellGrid(table, pageItems, captions, sourceRules)
  const twoCohortSections = recoverTwoCohortSectionGrid(table, pageItems, captions, sourceRules)
  if (twoCohortSections?.cropRect) table = rebaseTableCrop(table, twoCohortSections.cropRect)
  const programGrid = recoverRuledProgramGrid(table, pageItems, captions, sourceRules)
  if (programGrid?.cropRect) table = rebaseTableCrop(table, programGrid.cropRect)
  const scaleCohortGrid = recoverRuledScaleCohortGrid(table, pageItems, captions, sourceRules)
  const surveyRecordGrid = recoverRuledSurveyRecordGrid(table, pageItems, captions, sourceRules)
  const resourceCohortGrid = recoverResourceCohortRecords(table, pageItems, captions, sourceRules)
  if (resourceCohortGrid?.cropRect) table = rebaseTableCrop(table, resourceCohortGrid.cropRect)
  const wrappedCohortStatistics = recoverWrappedCohortStatistics(
    table,
    pageItems,
    captions,
    sourceRules
  )
  const sharedScoreGrid = recoverSharedScoreTimepointGrid(table, pageItems, captions, sourceRules)
  if (sharedScoreGrid) table = rebaseTableCrop(table, sharedScoreGrid.cropRect)
  const equalFontStackGrid = recoverNativeEqualFontStackRecordGrid(
    table,
    pageItems,
    captions,
    sourceRules
  )
  if (equalFontStackGrid?.cropRect) table = rebaseTableCrop(table, equalFontStackGrid.cropRect)
  const scientificLeafProof = proveNativeScientificLeafGutters(
    table,
    pageItems,
    captions,
    sourceRules
  )
  const scientificLeafGrid = recoverNativeScientificLeafRecordGrid(
    table,
    pageItems,
    captions,
    sourceRules,
    scientificLeafProof
  )
  let [left, top, right, bottom] = table.cropRect
  const coefficientRecordGrid = recoverNativeCoefficientRecordGrid(
    table,
    pageItems,
    captions,
    sourceRules
  )
  const recordGrid =
    indicatorRecordPlan?.grid ??
    recoverNativeProseLaneRecords(table, pageItems, captions, sourceRules) ??
    recoverNativeIndexedDirectoryGrid(table, pageItems, sourceRules) ??
    recoverCompleteNativeLeafRecords(table, pageItems, captions, sourceRules) ??
    recoverNativeSegmentedStubRecords(table, pageItems, captions, sourceRules) ??
    recoverNativeWrappedMathRecords(table, pageItems, captions, sourceRules) ??
    recoverNativeMathFieldRecords(table, pageItems, captions, sourceRules) ??
    scalarRecordPlan?.grid ??
    repeatedTuplePlan?.grid ??
    independentTextRecords ??
    recoverNativePairedParentRecordGrid(table, pageItems, captions, sourceRules) ??
    recoverNativeStackedRecordGrid(table, pageItems, captions, sourceRules) ??
    recoverNativeSharedPairRecordGrid(table, pageItems, captions, sourceRules) ??
    recoverNativePairedTextRecordGrid(table, pageItems, captions, sourceRules, adjacent) ??
    recoverNativeOrdinalWrappedRecordGrid(table, pageItems, captions, sourceRules) ??
    recoverNativeSingleMathRecordGrid(table, pageItems, captions, sourceRules) ??
    recoverNativeCitedMeasurementGrid(table, pageItems, captions, sourceRules) ??
    recoverNativeConfigurationGrid(table, pageItems, captions, sourceRules) ??
    recoverNativeSymbolDefinitionGrid(table, pageItems, captions, sourceRules) ??
    recoverNativeWrappedCountNarrativeGrid(table, pageItems, captions, sourceRules) ??
    recoverNativeSegmentedScientificGrid(table, pageItems, captions, sourceRules) ??
    recoverNativeRuledFormulaGrid(table, pageItems, captions, sourceRules) ??
    recoverNativeGroupedParameterGrid(table, pageItems, captions, sourceRules) ??
    recoverNativeMeasuredRecordGrid(table, pageItems, captions, sourceRules) ??
    recoverNativeHeaderOwnershipGrid(table, pageItems, captions, sourceRules) ??
    recoverSmallCompleteRecordGrid(table, pageItems, captions, sourceRules) ??
    scientificLeafGrid ??
    equalFontStackGrid ??
    coefficientRecordGrid ??
    recoverNativePairedRecordGrid(table, pageItems, captions, sourceRules) ??
    recoverNativeGroupedFlagRecordGrid(table, pageItems, captions, sourceRules) ??
    (ruledColumnGrid?.repair === 'native-body-records-recovered' ? ruledColumnGrid : undefined) ??
    recoverRuledSparseSummaryRecords(table, pageItems, captions, sourceRules) ??
    longQuestionGrid ??
    sparseModelGrid ??
    nativeCohortGrid ??
    (closedCellGrid?.repair === 'native-body-records-recovered' ? closedCellGrid : undefined) ??
    recoverWrappedCountPairsGrid(table, pageItems, captions, sourceRules) ??
    recoverSampleQualifiedSparseCohortGrid(table, pageItems, captions, sourceRules) ??
    twoCohortSections ??
    programGrid ??
    scaleCohortGrid ??
    surveyRecordGrid ??
    resourceCohortGrid ??
    wrappedCohortStatistics ??
    sharedScoreGrid ??
    parallelCountLists ??
    questionnaireGrid ??
    studyParagraphGrid ??
    cohortSummaryRows ??
    pairedIntervalGrid ??
    (closedCellGrid?.headerRows.some((r) => r > 1) ? closedCellGrid : undefined) ??
    recoverCompactNumericHeader(table, pageItems) ??
    recoverSingleValueGrid(table, pageItems, captions, sourceRules) ??
    recoverMixedCohortSummaries(table, pageItems) ??
    recoverClinicalCountSections(table, pageItems, sourceRules) ??
    recoverNumberedModelSections(table, pageItems, sourceRules) ??
    recoverNestedCountRecords(table, pageItems) ??
    recoverWrappedRepeatedMeasures(table, pageItems, sourceRules) ??
    recoverRepeatedLeafSections(table, pageItems, sourceRules) ??
    recoverAdditiveCohortRecords(table, pageItems, sourceRules) ??
    recoverSectionLocalColumns(table, pageItems, sourceRules) ??
    recoverRuledComparisonPanel(table, pageItems, rules) ??
    recoverRuledCategoricalRecords(table, pageItems, sourceRules) ??
    recoverNestedMeasureRecords(table, pageItems, sourceRules) ??
    recoverIdentifierRecords(table, pageItems, sourceRules) ??
    recoverPairedOutcomeRecords(table, pageItems, sourceRules) ??
    cohortRecords ??
    recoverRepeatedVisitGrid(table, pageItems, captions, sourceRules) ??
    headerlessRecords ??
    intervalRecords ??
    alleleGrid ??
    regressionBlocks ??
    comparisonRecords ??
    ruledColumnGrid ??
    ruledHeaderGrid ??
    recoverVerticalRuleGrid(table, pageItems, captions, sourceRules) ??
    recoverRuledTimeSeriesGrid(table, pageItems, captions, sourceRules) ??
    recoverCountDistributionGrid(table, pageItems, captions, sourceRules) ??
    recoverCountedCategoryGrid(table, pageItems, captions, sourceRules) ??
    recoverRuledCategoryGrid(table, pageItems, captions, sourceRules) ??
    coefficientGrid ??
    table.wrappedCountGrid ??
    recoverSegmentedRecordGrid(table, pageItems, sourceRules) ??
    recoverRepeatedCountSections(table, pageItems, captions, rules) ??
    recoverRepeatedUnitGrid(table, pageItems, captions, sourceRules) ??
    recoverRepeatedHeaderGrid(table, pageItems, captions, sourceRules) ??
    recoverPairedCountGrid(table, pageItems, captions) ??
    recoverNativeHeaderGrid(table, pageItems, captions, sourceRules) ??
    recoverRuledNarrativeGrid(table, pageItems, captions, rules, sourceRules) ??
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
    recoverAnchoredStubGrid(table, pageItems, captions, rules) ??
    recoverAlignedNumericGrid(table, pageItems, captions, rules) ??
    recoverRepeatedComparisonGrid(table, pageItems, captions) ??
    recoverCurrencySummaryGrid(table, pageItems, captions) ??
    wrappedSummaryGrid ??
    demographicRecords ??
    recoverBaselineComparisonGrid(table, pageItems, captions) ??
    recoverResponseScaleGrid(table, pageItems, captions, rules) ??
    recoverLongitudinalSummaryGrid(table, pageItems, captions, rules) ??
    recoverFollowupGrid(table, pageItems, captions, rules) ??
    recoverThresholdSweepGrid(table, pageItems) ??
    recordCandidate ??
    closedCellGrid
  if (
    (recordGrid === closedCellGrid ||
      recordGrid?.repair === 'native-body-records-recovered' ||
      recordGrid?.repair === 'native-count-footer-crop-recovered') &&
    recordGrid?.cropRect &&
    recordGrid.cropRect.some((v, n) => v !== table.cropRect[n])
  ) {
    table = rebaseTableCrop(table, recordGrid.cropRect, true)
    ;[left, top, right, bottom] = table.cropRect
  }
  const sideBySideCrop = recoverClippedSideBySideCrop(table, pageItems)
  if (sideBySideCrop) {
    table = rebaseTableCrop(table, sideBySideCrop, true)
    ;[left, top, right, bottom] = table.cropRect
  }
  const clippedLeftLabelCrop = recoverClippedLeftLabelCrop(table, pageItems)
  if (clippedLeftLabelCrop) {
    table = rebaseTableCrop(table, clippedLeftLabelCrop, true)
    ;[left, top, right, bottom] = table.cropRect
  }
  const clippedRightLabelCrop = recoverClippedRightLabelCrop(table, pageItems, sourceRules)
  if (clippedRightLabelCrop) {
    table = rebaseTableCrop(table, clippedRightLabelCrop, true)
    ;[left, top, right, bottom] = table.cropRect
  }
  const clippedSimpleBody = recoverClippedSimpleBodyCrop(table, pageItems, captions)
  if (clippedSimpleBody) {
    table = rebaseTableCrop(table, clippedSimpleBody.cropRect, true)
    const firstColumn = table.structure.objects
      .filter((object) => object.label === 'table column')
      .sort((a, b) => a.rect[0] - b.rect[0])[0]
    if (firstColumn)
      firstColumn.rect[0] = Math.min(
        firstColumn.rect[0],
        clippedSimpleBody.left - table.cropRect[0]
      )
    ;[left, top, right, bottom] = table.cropRect
  }
  const groupedStubRowRecovered = recoverGroupedStubSourceRow(table, pageItems)
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
  if (wideBottomCrop) repairs.push('wide-bottom-crop-recovered')
  if (ruledBottomBoundaryCrop) repairs.push('ruled-bottom-boundary-crop-recovered')
  if (sideBySideCrop) repairs.push('side-by-side-crop-expanded')
  if (clippedLeftLabelCrop) repairs.push('clipped-left-label-crop-recovered')
  if (clippedRightLabelCrop) repairs.push('clipped-right-label-crop-recovered')
  if (clippedSimpleBody) repairs.push('clipped-simple-body-crop-recovered')
  if (groupedStubRowRecovered) repairs.push('grouped-stub-row-recovered')
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
  // Rotated continuations occasionally lose one narrow data column in the
  // structure prediction. A populated source cluster in a large model gap is
  // stronger evidence than the empty prediction on either side; insert one
  // source-bounded column and let the normal cell resolver handle its text.
  if (table.readingRotation === 90 || table.readingRotation === 270) {
    const source = pageItems.filter((item) => item.horizontal && inside(table.cropRect, item))
    for (let index = 0; index < columns.length - 1; index++) {
      const gapStart = columns[index].rect[2]
      const gapEnd = columns[index + 1].rect[0]
      if (gapEnd - gapStart < 1.8 * Math.max(...source.map((item) => item.height), 1)) continue
      const cluster = source.filter((item) => {
        const center = (item.rect[0] + item.rect[2]) / 2
        return center > gapStart && center < gapEnd && /\d/.test(item.text)
      })
      const baselines = new Set(cluster.map((item) => Math.round(item.baseline * 10) / 10))
      if (cluster.length < 4 || baselines.size < 3) continue
      const leftEdge = Math.min(...cluster.map((item) => item.rect[0])) - 1
      const rightEdge = Math.max(...cluster.map((item) => item.rect[2])) + 1
      if (leftEdge <= gapStart || rightEdge >= gapEnd) continue
      columns.splice(index + 1, 0, {
        rect: [leftEdge, top, rightEdge, bottom],
        score: 1,
        origin: 'source-rotated-continuation'
      })
      repairs.push('rotated-continuation-column-recovered')
      break
    }
  }
  // A captionless continuation may be the only rotated table on a page that
  // also contains upright prose. The detector sees the table after the page
  // is normalized, but its row predictions can merge adjacent source lines.
  // Rebuild row bands from repeated source baselines only for this explicit
  // rotated, dense, unmerged shape; ordinary tables retain model rows.
  if (
    (table.readingRotation === 90 || table.readingRotation === 270) &&
    !captions.some((c) => captionKind(c.lines[0]) === 'table') &&
    columns.length >= 6
  ) {
    const sourceLines = pageItems
      .filter(
        (item) =>
          item.horizontal &&
          inside(table.cropRect, item) &&
          item.rect[3] <= bottom + item.height * 0.1
      )
      .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
    const groups = []
    for (const item of sourceLines) {
      const group = groups.at(-1)
      if (group && Math.abs(group[0].baseline - item.baseline) <= item.height * 0.35)
        group.push(item)
      else groups.push([item])
    }
    const numericGroups = groups.filter(
      (group) => group.filter((item) => /\d/.test(item.text)).length >= 2
    )
    if (
      groups.length >= 8 &&
      numericGroups.length >= 5 &&
      groups.every((group) => group.every((item) => item.rect[0] >= left && item.rect[2] <= right))
    ) {
      const centers = groups.map(
        (group) => group.reduce((sum, item) => sum + item.baseline, 0) / group.length
      )
      const boundaries = [
        Math.max(top, groups[0][0].rect[1] - groups[0][0].height * 0.35),
        ...centers.slice(1).map((center, index) => (centers[index] + center) / 2),
        Math.min(bottom, groups.at(-1).at(-1).rect[3] + groups.at(-1).at(-1).height * 0.35)
      ]
      rows.splice(
        0,
        rows.length,
        ...groups.map((_, index) => ({
          rect: [left, boundaries[index], right, boundaries[index + 1]],
          origin: 'source-rotated-continuation'
        }))
      )
      repairs.push('rotated-continuation-rows-recovered')
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
  // A detector can include the first line of a compact lettered note block.
  // Multiple raised markers below a closing native rule establish the boundary
  // independently of the prose wording; ordinary table rows do not qualify.
  let letteredNoteBoundary
  if (
    !recordGrid &&
    rows.length >= 4 &&
    captions.some((c) => captionKind(c.lines[0]) === 'table')
  ) {
    letteredNoteBoundary = horizontalRules.find((rule) => {
      if (
        Math.abs(rule[0] - table.cropRect[0]) > 18 ||
        Math.abs(rule[2] - table.cropRect[2]) > 18 ||
        rule[1] > table.cropRect[3] ||
        table.cropRect[3] - rule[1] > 30
      )
        return false
      const below = pageItems.filter(
        (i) =>
          i.horizontal &&
          i.rect[0] >= rule[0] - 2 &&
          i.rect[2] <= rule[2] + 2 &&
          i.rect[1] > rule[1] &&
          i.rect[1] - rule[1] < 18
      )
      const prose = below.filter((i) => i.text.trim().split(/\s+/).length >= 4)
      const markers = below.filter(
        (i) =>
          /^[a-z]$/.test(i.text) &&
          prose.some(
            (p) =>
              p.height > i.height * 1.3 &&
              p.rect[0] > i.rect[2] &&
              p.rect[0] - i.rect[2] < p.height &&
              i.baseline < p.baseline &&
              p.baseline - i.baseline < p.height
          )
      )
      return (
        markers.length >= 2 &&
        markers.every((i) => Math.abs(i.baseline - markers[0].baseline) < 1) &&
        pageItems.filter(
          (i) =>
            i.horizontal &&
            /^[-−]?\d/.test(i.text) &&
            i.rect[0] >= rule[0] &&
            i.rect[2] <= rule[2] &&
            i.rect[3] <= rule[1] &&
            rule[1] - i.rect[3] < 24
        ).length >= 2
      )
    })?.[1]
    if (letteredNoteBoundary !== undefined) {
      const retained = rows
        .filter((row) => row.rect[1] < letteredNoteBoundary)
        .map((row) => ({
          ...row,
          rect: [...row.rect.slice(0, 3), Math.min(row.rect[3], letteredNoteBoundary)]
        }))
      rows.splice(0, rows.length, ...retained)
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
  const raisedCaptionGlyphs = proveNativeCaptionRaisedGlyphOwnership(
    table,
    pageItems,
    externalCaptions,
    sourceRules
  )
  if (raisedCaptionGlyphs) for (const item of raisedCaptionGlyphs.tokens) excluded.add(item)
  // A split continuation marker below the last source row is navigation text.
  // Allow a small model-boundary overlap, not a marker within the row body.
  // Keep parentheses elsewhere, including lone zeros and incomplete source values.
  for (const marker of pageItems.filter(
    (i) =>
      rows.length &&
      i.horizontal &&
      /^\(?continu(?:ed|es)(?: on (?:next|following) page)?\)?$/i.test(i.text.trim()) &&
      i.rect[1] >= (recordGrid?.rows.at(-1)?.[3] ?? rows.at(-1).rect[3]) - i.height * 0.1 &&
      i.rect[0] >= table.cropRect[0] &&
      i.rect[2] <= table.cropRect[2] &&
      intersect(table.cropRect, i.rect) > 0
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
  // Long vertical publisher marks can sit across a padded crop edge without
  // belonging to any source row. Treat that shape as page furniture only
  // when the glyph run is clearly taller than it is wide and has no material
  // overlap with a recovered row; short vertical labels remain diagnostic.
  const isExternalVerticalFurniture = (item) =>
    !item.horizontal &&
    item.text.trim().length >= 18 &&
    item.rect[3] - item.rect[1] >= (item.rect[2] - item.rect[0]) * 4 &&
    !rows.some((row) => intersect(row.rect, item.rect) / area(item.rect) > 0.35)
  const isExternalDefinitionNote = (item) => {
    if (!item.horizontal) return false
    const text = item.text.trim()
    const explicitNote = /^(?:Derived from\b|Note:|Notes:|Abbreviations?:)/i.test(text)
    const acronymDefinition = /^(?:[A-Z]{2,}|[A-Z][A-Za-z0-9/-]{1,12})\s*=\s*\p{L}/u.test(text)
    if (!explicitNote && !acronymDefinition) return false
    if (rows.some((row) => inside(row.rect, item))) return false
    if (explicitNote) return true
    const lastRow = rows.at(-1)
    return Boolean(
      lastRow &&
      item.rect[1] >= lastRow.rect[3] - item.height * 0.25 &&
      !rows.some((row) => intersect(row.rect, item.rect) / area(item.rect) > 0.5)
    )
  }
  const sourceItems = pageItems.filter(
    (item) =>
      !excluded.has(item) &&
      !(letteredNoteBoundary !== undefined && item.rect[1] > letteredNoteBoundary) &&
      // Publication watermarks are not cell content, including when they only
      // intersect a padded crop edge. Keep ordinary upright occurrences.
      !(
        !item.horizontal &&
        /^(?:ACCEPTED (?:MANUSCRIPT|ARTICLE)|JOURNAL PRE[- ]PROOF|PROOF)$/i.test(item.text.trim())
      ) &&
      !isExternalVerticalFurniture(item) &&
      !isExternalDefinitionNote(item) &&
      // Some publishers draw dotted horizontal rules as a wide text run.
      // Literal ellipses and single dots used for missing values remain data.
      !(
        item.horizontal &&
        /^(?:[.·]\s*){20,}$/.test(item.text.trim()) &&
        item.rect[2] - item.rect[0] > item.height * 10
      ) &&
      !externalNotes.some((note) => intersect(item.rect, note.rect) / area(item.rect) > 0.8)
  )
  const boundaryClipped = sourceItems.filter(
    (item) =>
      intersect(item.rect, table.cropRect) > 0 &&
      intersect(item.rect, table.cropRect) / area(item.rect) < 0.999
  )
  // A continuation-page crop can graze a two-part running header by less than
  // one glyph height. When the clipped line is a journal masthead paired with
  // an author `et al.` marker on one baseline, it is page furniture rather
  // than table text. Keep ordinary single clipped labels diagnostic.
  const topRunningHeaderItems = boundaryClipped.filter(
    (item) =>
      item.rect[1] < table.cropRect[1] &&
      table.cropRect[1] - item.rect[3] <= Math.max(1, item.height * 0.25) &&
      item.rect[0] >= table.cropRect[0] - 2 &&
      item.rect[2] <= table.cropRect[2] + 2
  )
  const topRunningHeader =
    topRunningHeaderItems.length >= 2 &&
    topRunningHeaderItems.every(
      (item) => Math.abs(item.baseline - topRunningHeaderItems[0].baseline) <= item.height * 0.25
    ) &&
    topRunningHeaderItems.some((item) => /\bet al\.?\b/i.test(item.text.trim())) &&
    topRunningHeaderItems.some((item) => /^[A-Z][A-Z .&'’-]{10,}$/u.test(item.text.trim()))
  const bottomFootnoteMarker =
    boundaryClipped.length === 1 &&
    /^[a-z]$/i.test(boundaryClipped[0].text.trim()) &&
    boundaryClipped[0].rect[3] > table.cropRect[3] &&
    boundaryClipped[0].rect[1] >= table.cropRect[3] - boundaryClipped[0].height * 0.25 &&
    !rows.some((row) => inside(row.rect, boundaryClipped[0])) &&
    rows.some((row) => boundaryClipped[0].height < (row.rect[3] - row.rect[1]) * 0.75)
  const clipped = bottomFootnoteMarker
    ? []
    : topRunningHeader
      ? boundaryClipped.filter((item) => !topRunningHeaderItems.includes(item))
      : boundaryClipped
  if (topRunningHeader) repairs.push('top-running-header-excluded')
  if (bottomFootnoteMarker) repairs.push('bottom-footnote-marker-excluded')
  if (clipped.length) issues.add('text-crosses-crop-boundary')
  const items = sourceItems.filter(
    (i) =>
      inside(table.cropRect, i) &&
      !/^\(Table\s+\d+\s+continued on next column\)$/i.test(i.text.trim())
  )
  if (!items.length) issues.add('no-source-text')
  if (!rows.length || !columns.length) issues.add('missing-row-or-column')
  if (items.some((i) => !i.horizontal && !isSupportedRotatedStubLabel(i)))
    issues.add('unsupported-text-orientation')
  // Recover a collapsed repeated header pair only when another pair establishes the
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
      .filter((item) => /^No\.$/i.test(item.text.trim()) || /^[1-9]\d*$/.test(item.text.trim()))
      .flatMap((first) => {
        const second = headerItems.find(
          (item) =>
            (/^No\.$/i.test(first.text.trim())
              ? item.text.trim() === '%'
              : /^[1-9]\d*$/.test(item.text.trim()) &&
                Number(item.text) === Number(first.text) + 1) &&
            item.rect[0] > first.rect[2] &&
            Math.abs(item.baseline - first.baseline) < first.height * 0.35 &&
            !headerItems.some(
              (other) =>
                other !== first &&
                other !== item &&
                other.rect[0] > first.rect[2] &&
                other.rect[2] < item.rect[0] &&
                Math.abs(other.baseline - first.baseline) < first.height * 0.35
            )
        )
        return second ? [{ first, second, ordinal: second.text.trim() !== '%' }] : []
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
    for (const { first, second, ordinal } of pairs
      .slice()
      .sort((a, b) => sourceColumn(b.first) - sourceColumn(a.first))) {
      const column = sourceColumn(first)
      if (
        column < 0 ||
        sourceColumn(second) !== column ||
        (ordinal &&
          headerItems.filter(
            (item) =>
              sourceColumn(item) === column &&
              Math.abs(item.baseline - first.baseline) < first.height * 0.35
          ).length !== 2) ||
        !pairs.some(
          (pair) =>
            pair.first.text.trim() === first.text.trim() &&
            pair.second.text.trim() === second.text.trim() &&
            Math.abs(pair.first.baseline - first.baseline) < first.height * 0.35 &&
            sourceColumn(pair.first) >= 0 &&
            sourceColumn(pair.second) === sourceColumn(pair.first) + 1
        )
      )
        continue
      const split = (first.rect[2] + second.rect[0]) / 2
      const records = []
      for (const item of items
        .filter(
          (item) =>
            item.horizontal &&
            sourceColumn(item) === column &&
            item.baseline > first.baseline + first.height &&
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
          return ordinal
            ? texts.every((text) => /^(?:\d+(?:\.\d+)?|[–—−-])$/.test(text))
            : /^\d+$/.test(texts[0]) && /^(?:[<≤]\s*)?\d+(?:\.\d+)?%?$/.test(texts[1])
        })
      )
        continue
      const original = columns[column]
      columns.splice(
        column,
        1,
        { ...original, rect: [boundaries[column], original.rect[1], split, original.rect[3]] },
        { ...original, rect: [split, original.rect[1], boundaries[column + 1], original.rect[3]] }
      )
      repairs.push(ordinal ? 'repeated-ordinal-column-recovered' : 'count-percent-column-recovered')
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
  const unitStubCut =
    externalCaptions.length &&
    recoverParenthesizedStubUnitCut(
      items,
      [left, ...columns.slice(1).map((c, i) => (columns[i].rect[2] + c.rect[0]) / 2), right],
      sourceRules,
      table.cropRect
    )
  if (unitStubCut) {
    columns[0].rect[2] = unitStubCut
    columns[1].rect[0] = unitStubCut
    repairs.push('source-comparison-columns-recovered')
  }
  const cuts = columns.slice(1).map((c, i) => (columns[i].rect[2] + c.rect[0]) / 2)
  // Some parallel benchmark tables contain a complete numeric row as one
  // source run while the detector predicts fewer leaf columns than the
  // repeated metric sequence. Rebuild only a small deficit from repeated
  // numeric evidence, preserving the measured stub and crop boundaries.
  if (!recordGrid && externalCaptions.length && columns.length >= 8) {
    const numericToken = (value) => /^[<>≤≥−+-]?\d+(?:[.,]\d+)?%?$/.test(value)
    const counts = items
      .filter((item) => item.horizontal && item.rect[0] >= columns[0].rect[2] - 2)
      .map((item) => item.text.trim().split(/\s+/u).filter(numericToken).length)
      .filter((count) => count >= columns.length - 2)
    const frequencies = new Map(
      counts.map((count) => [count, counts.filter((n) => n === count).length])
    )
    const expected = [...frequencies.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0]
    if (
      expected &&
      expected > columns.length &&
      expected <= columns.length + 4 &&
      frequencies.get(expected) >= 3
    ) {
      const stubRight = columns[0].rect[2]
      const width = (right - stubRight) / expected
      columns.splice(
        0,
        columns.length,
        columns[0],
        ...Array.from({ length: expected }, (_, index) => ({
          rect: [stubRight + index * width, top, stubRight + (index + 1) * width, bottom],
          score: 1,
          origin: 'source-wide-numeric-column'
        }))
      )
      cuts.splice(0, cuts.length, ...columns.slice(1).map((column) => column.rect[0]))
      repairs.push('wide-numeric-columns-recovered')
      const firstRow = rows[0]
      const parentHeaders = items.filter(
        (item) =>
          item.horizontal &&
          firstRow &&
          item.rect[3] <= firstRow.rect[1] + 1 &&
          /(?:CLAP\s*\/\s*CLIP|IMAGEBIND)/iu.test(item.text)
      )
      if (firstRow && parentHeaders.length >= 2) {
        rows.unshift({
          rect: [
            left,
            Math.min(...parentHeaders.map((item) => item.rect[1])),
            right,
            Math.max(...parentHeaders.map((item) => item.rect[3]))
          ],
          origin: 'source-native-header'
        })
        firstRow.origin = 'source-native-header'
        const repeatedHeader = rows[2]
        if (
          repeatedHeader &&
          items.some((item) => /R@\d+/u.test(item.text) && inside(repeatedHeader.rect, item))
        )
          repeatedHeader.origin = 'source-native-header'
        repairs.push('wide-multilevel-header-recovered')
      }
    }
  }
  const columnRects = columns.map((_, i) => [
    i ? cuts[i - 1] : left,
    top,
    i < cuts.length ? cuts[i] : right,
    bottom
  ])
  const sampleHeaderBottom = Math.max(
    ...objects
      .filter((object) => object.label === 'table column header')
      .map((object) => object.rect[3])
  )
  const qualifiedCuts =
    externalCaptions.length &&
    recoverSampleQualifiedHeaderCuts(
      items,
      [left, ...cuts, right],
      top,
      Number.isFinite(sampleHeaderBottom) ? sampleHeaderBottom : rows[0]?.rect[1]
    )
  if (qualifiedCuts) {
    cuts.splice(0, cuts.length, ...qualifiedCuts.slice(1, -1))
    columnRects.forEach((rect, column) => {
      rect[0] = qualifiedCuts[column]
      rect[2] = qualifiedCuts[column + 1]
    })
    repairs.push('sample-qualified-header-cut-recovered')
  }
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
      /^(?:Number of (?:patients|subjects|cases|participants|studies)|n\s*\(%\))$/i.test(
        heading.map((i) => i.text.trim()).join(' ')
      ) &&
      body.length >= 4 &&
      body.every((i) => /^\d+(?:\s*\(\d+(?:\.\d+)?%\)|%)$/.test(i.text.trim())) &&
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
  if (clippedSimpleBody && rows.length === 1 && columns.length >= 3) {
    const numeric = (text) => /^[<>≤≥−+-]?\d[\d.,%()±–—+/<>=-]*$/u.test(text.trim())
    const bodyGroups = groups.filter((group) => {
      const parts = columns.map((_, column) => group.filter((item) => columnOf(item) === column))
      const values = parts.slice(1)
      return (
        parts[0].length === 1 &&
        /\p{L}/u.test(parts[0][0].text.trim()) &&
        values.filter((part) => part.length === 1 && numeric(part[0].text)).length >= 2 &&
        values.every((part) => part.length === 0 || (part.length === 1 && numeric(part[0].text))) &&
        group[0].rect[1] > rows[0].rect[3]
      )
    })
    if (bodyGroups.length >= 2) {
      rows[0].rect[3] =
        (rows[0].rect[3] + Math.min(...bodyGroups.map((group) => group[0].rect[1]))) / 2
      rows.push(
        ...bodyGroups.map((group) => ({
          rect: [
            left,
            Math.min(...group.map((item) => item.rect[1])),
            right,
            Math.max(...group.map((item) => item.rect[3]))
          ],
          origin: 'source-text'
        }))
      )
      rows.sort((a, b) => a.rect[1] - b.rect[1])
      repairs.push('clipped-simple-body-rows-recovered')
    }
  }
  // Wide benchmark tables can place two complete records inside one broad model
  // row. The model then serializes every value pair into one cell, even though
  // the source has two independent baselines. Recover those physical rows before
  // cell ownership is resolved. Require near-complete numeric lanes in every
  // baseline and no full-width rule between them; wrapped prose and ordinary
  // multiline cells therefore remain on their original model row.
  if (!recordGrid && externalCaptions.length && columns.length >= 8 && rows.length >= 2) {
    const numericValue = (text) => /^[<>≤≥−+-]?\d[\d.,%()±–—+/<>=-]*$/.test(text.trim())
    const lane = (group) => {
      const byColumn = new Map()
      for (const item of group) {
        const column = columnOf(item)
        if (column >= 0) {
          if (!byColumn.has(column)) byColumn.set(column, [])
          byColumn.get(column).push(item)
        }
      }
      const values = [...byColumn.entries()].filter(
        ([column, parts]) => column > 0 && parts.length === 1 && numericValue(parts[0].text)
      )
      return { byColumn, values }
    }
    let recovered = false
    for (let index = rows.length - 1; index >= 0; index--) {
      const row = rows[index]
      const candidates = groups
        .filter((group) => group.every((item) => intersect(row.rect, item.rect) > 0))
        .sort((a, b) => a[0].baseline - b[0].baseline)
      if (candidates.length < 2) continue
      const height = Math.max(...candidates.flat().map((item) => item.height))
      if (
        candidates.some(
          (group, n) =>
            !group.length ||
            (n && group[0].baseline - candidates[n - 1].at(-1).baseline < height * 0.7) ||
            (n && group[0].baseline - candidates[n - 1].at(-1).baseline > height * 2.5)
        )
      )
        continue
      const lanes = candidates.map(lane)
      if (
        lanes.some(
          ({ byColumn, values }) =>
            byColumn.size < columns.length - 1 ||
            values.length < columns.length - 3 ||
            !byColumn.get(0)?.some((item) => /\p{L}/u.test(item.text))
        )
      )
        continue
      if (
        candidates.slice(1).some((group, n) => {
          const top = Math.max(...candidates[n].map((item) => item.rect[3]))
          const bottom = Math.min(...group.map((item) => item.rect[1]))
          return rules.some(
            (rule) =>
              rule[1] === rule[3] &&
              rule[1] > top &&
              rule[1] < bottom &&
              rule[0] <= left + height &&
              rule[2] >= right - height
          )
        })
      )
        continue
      const bounds = [row.rect[1]]
      for (let n = 1; n < candidates.length; n++) {
        const above = Math.max(...candidates[n - 1].map((item) => item.rect[3]))
        const below = Math.min(...candidates[n].map((item) => item.rect[1]))
        bounds.push((above + below) / 2)
      }
      bounds.push(row.rect[3])
      const replacement = candidates.map((group, n) => ({
        rect: [left, bounds[n], right, bounds[n + 1]],
        origin: 'source-text'
      }))
      rows.splice(index, 1, ...replacement)
      recovered = true
      repairs.push('stacked-wide-record-rows-recovered')
    }
    if (recovered) rows.sort((a, b) => a.rect[1] - b.rect[1])
  }
  // A single ruled sample header can wrap only its cohort labels above the
  // detector row. Native band ownership keeps all four titles in one row.
  const wrappedSampleBand =
    !recordGrid && rows.length
      ? recoverWrappedSampleHeaderBand(table, pageItems, captions, sourceRules)
      : undefined
  if (wrappedSampleBand) {
    rows[0].rect[1] = Math.min(rows[0].rect[1], wrappedSampleBand[1])
    repairs.push('leading-header-line-recovered')
  }
  const clippedWrappedHeader = !recordGrid
    ? recoverClippedHeading({
        rows,
        objects,
        groups,
        columnRects,
        rules,
        repairs,
        captioned: externalCaptions.length > 0
      })
    : undefined
  // A continued narrative table can start with the tail of the previous
  // page's record, with every stub column blank. A ruled repeated header and
  // the next complete record bound that tail; do not invent values for blanks
  // or let a shifted model row absorb the final line of the earlier record.
  if (
    !recordGrid &&
    columns.length >= 4 &&
    externalCaptions.some((c) => /\bcontinued\b/i.test(c.lines.join(' ')))
  ) {
    const header = objects.find((o) => o.label === 'table column header')
    const headerBottom =
      header &&
      rules
        .filter(
          (r) =>
            r[1] === r[3] &&
            r[1] >= header.rect[3] - 4 &&
            r[1] <= header.rect[3] + 20 &&
            r[2] - r[0] >= (right - left) * 0.9
        )
        .sort((a, b) => a[1] - b[1])[0]?.[1]
    const next =
      headerBottom &&
      groups.find(
        (g) =>
          union(g)[1] > headerBottom &&
          g.some((i) => columnOf(i) === 0) &&
          new Set(g.map(columnOf)).size >= Math.ceil(columns.length / 2)
      )
    if (next) {
      const start = union(next)[1]
      const tail = groups.filter((g) => union(g)[1] >= headerBottom && union(g)[3] < start)
      const tailItems = tail.flat()
      const nextRow = rows.find((row) => next.every((i) => inside(row.rect, i)))
      if (
        nextRow &&
        tail.length >= 3 &&
        new Set(tailItems.map(columnOf)).size >= 2 &&
        tailItems.every((i) => columnOf(i) > 0) &&
        tail.every(
          (g, n) =>
            !n ||
            g[0].baseline - tail[n - 1][0].baseline <=
              Math.max(g[0].height, tail[n - 1][0].height) * 1.6
        ) &&
        !rows.some((row) => row !== nextRow && tailItems.some((i) => inside(row.rect, i))) &&
        !rules.some((r) => r[1] === r[3] && r[1] > headerBottom && r[1] < start)
      ) {
        const split = (union(tailItems)[3] + start) / 2
        rows.push({ rect: [left, headerBottom, right, split], origin: 'source-text' })
        nextRow.rect[1] = split
        repairs.push('text-supported-row-recovered')
        // A tight final wrap within the same populated column is still part
        // of the last record, provided it remains inside the detector crop.
        for (const g of groups.filter((g) => (union(g)[1] + union(g)[3]) / 2 > nextRow.rect[3])) {
          if (
            union(g)[3] > bottom ||
            !g.every(
              (i) =>
                columnOf(i) > 0 &&
                !rows.some((row) => row !== nextRow && inside(row.rect, i)) &&
                items.some(
                  (p) =>
                    inside(nextRow.rect, p) &&
                    columnOf(p) === columnOf(i) &&
                    i.baseline > p.baseline &&
                    i.baseline - p.baseline <= i.height * 1.6
                )
            ) ||
            rules.some((r) => r[1] === r[3] && r[1] >= nextRow.rect[3] && r[1] <= union(g)[1])
          )
            break
          nextRow.rect[3] = union(g)[3]
          repairs.push('recovered-row-continuation-included')
        }
      }
    }
  }
  // A wrapped header can start above every model row. Recover its leading
  // line only when the following header text supplies explicit ownership:
  // a confidence level or a parent title aligned with its sample size.
  let stackedHeaderCellRect
  if (!recordGrid && rows.length && externalCaptions.length && groups[0]?.length) {
    const leading = groups[0]
    const rect = union(leading)
    const height = Math.max(...leading.map((item) => item.height))
    const next = groups[1] ?? []
    // A single parent label can sit on its own line above the final leaf
    // heading (for example, “Three-Way” above “Interaction”). The model may
    // detect only the lower line. Require the same column, a full-width top
    // rule, and the native column-header band before extending that cell.
    const stackedHeaderColumn =
      leading.length === 1 &&
      next.find(
        (item) =>
          columnOf(item) >= 0 &&
          columnOf(item) === columnOf(leading[0]) &&
          /^[A-Z]/.test(item.text.trim()) &&
          item.rect[1] > leading[0].rect[3] &&
          item.rect[1] - leading[0].rect[3] <= height * 1.5
      )
    const headerBand = objects.find(
      (object) =>
        object.label === 'table column header' && next.some((item) => inside(object.rect, item))
    )
    const fullWidthRule = (rule) =>
      rule[1] === rule[3] &&
      rule[0] <= (headerBand?.rect[0] ?? left) + 2 &&
      rule[2] >= (headerBand?.rect[2] ?? right) - 2
    const stackedHeader =
      stackedHeaderColumn &&
      /\p{L}/u.test(leading[0].text) &&
      headerBand &&
      rules.some(
        (rule) => fullWidthRule(rule) && rule[1] <= rect[1] && rect[1] - rule[1] <= height * 1.5
      ) &&
      rules.some(
        (rule) =>
          fullWidthRule(rule) &&
          rule[1] >= headerBand.rect[3] - height &&
          rule[1] <= headerBand.rect[3] + height
      )
    const confidencePrefix =
      leading.length === 1 &&
      /^(?:90|95|99)%$/.test(leading[0].text.trim()) &&
      next.some(
        (item) =>
          /^confidence$/i.test(item.text.trim()) &&
          Math.abs(item.rect[0] - rect[0]) < 1 &&
          item.baseline - leading[0].baseline < height * 1.5
      )
    // A centered population title above its sample-size line is one wrapped
    // header. Matching native rules bound both, independently of model cuts.
    const sampleChild =
      leading.length === 1 &&
      /^[\p{L}][\p{L}\s()/-]*$/u.test(leading[0].text.trim()) &&
      objects.some((o) => o.label === 'table column header') &&
      items.find(
        (i) =>
          /^N\s*=\s*\d+\s*\(%\)$/i.test(i.text.trim()) &&
          i.baseline - leading[0].baseline > height * 0.8 &&
          i.baseline - leading[0].baseline < height * 1.6 &&
          Math.abs(i.rect[0] + i.rect[2] - rect[0] - rect[2]) < height * 0.5 &&
          objects.some((o) => o.label === 'table column header' && inside(o.rect, i))
      )
    const ruledSample =
      sampleChild &&
      rules.some(
        (a) =>
          a[1] === a[3] &&
          a[1] <= rect[1] &&
          rect[1] - a[1] < height &&
          a[0] <= rect[0] &&
          a[2] >= rect[2] &&
          rules.some(
            (b) =>
              b[1] === b[3] &&
              b[1] >= sampleChild.rect[3] &&
              b[1] - sampleChild.rect[3] < height &&
              Math.abs(a[0] - b[0]) < 0.1 &&
              Math.abs(a[2] - b[2]) < 0.1
          )
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
      (stackedHeader || confidencePrefix || parentTitle || ruledSample) &&
      rect[3] < rows[0].rect[1] &&
      rows[0].rect[1] - rect[1] < height * 2 &&
      (ruledSample ||
        objects.some(
          (object) => object.label === 'table column header' && inside(object.rect, next[0])
        )) &&
      !rules.some(
        (rule) =>
          rule[1] === rule[3] &&
          rule[1] > rect[3] &&
          rule[1] < rows[0].rect[1] &&
          rule[0] <= rect[0] &&
          rule[2] >= rect[2]
      )
    ) {
      if (stackedHeader) stackedHeaderCellRect = rect
      else rows[0].rect[1] = rect[1]
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
  let recoveredGroupColumns
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
    // A model row can straddle a longer section title and the first record
    // below it. Keep this recovery narrow: the title must occupy the stub,
    // be followed by several populated records, and use table-like copy.
    // This covers small two/three-column grids without treating a prose note
    // beneath a table as a section.
    const sourceSectionGroup = (group) => {
      if (
        !group.length ||
        columns.length < 2 ||
        columns.length > 3 ||
        !group.every((item) => columnOf(item) === 0) ||
        !/^[\p{L}\d][\p{L}\d\s(),:/+–−-]*$/u.test(
          group
            .map((item) => item.text)
            .join(' ')
            .trim()
        )
      )
        return false
      const text = group
        .map((item) => item.text)
        .join(' ')
        .trim()
      if (
        text.split(/\s+/).length > 8 ||
        /^(?:table|figure|note)\b/i.test(text) ||
        /[.!?]$/.test(text)
      )
        return false
      const index = groups.indexOf(group)
      const populated = (candidate) => {
        const occupied = new Set(candidate.map(columnOf).filter((column) => column >= 0))
        return occupied.has(0) && occupied.size >= 2
      }
      const following = groups
        .slice(index + 1, index + 6)
        .filter(
          (candidate) =>
            candidate[0] && candidate[0].baseline - group.at(-1).baseline <= group[0].height * 7
        )
      if (following.filter(populated).length < 2) return false
      const preceding = groups.slice(Math.max(0, index - 3), index)
      return (
        preceding.some(populated) ||
        rows.some((row) => group.some((item) => inside(row.rect, item)))
      )
    }
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
      (item) =>
        item.horizontal &&
        (item.rect[1] + item.rect[3]) / 2 < rows[0]?.rect[1] &&
        item.rect[2] > left &&
        item.rect[0] < right &&
        item.rect[3] >= top - item.height
    )
    const headingRun = (run) => /^(?:\p{L}|\d+\s*[-–]\s*\p{L})/u.test(run[0]?.text ?? '')
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
      const parentBounds = runs[0]?.length ? union(runs[0]) : bounds
      const parentColumns = columnRects.flatMap((r, n) =>
        Math.min(r[2], parentBounds[2]) - Math.max(r[0], parentBounds[0]) >
        parentBounds[3] - parentBounds[1]
          ? [n]
          : []
      )
      const parentChildren = parentColumns.map(
        (c) =>
          firstBand
            .filter((i) => columnOf(i) === c && /^[\p{L}][\p{L}\s-]*$/u.test(i.text))
            .sort((a, b) => a.baseline - b.baseline)[0]
      )
      const centeredGroupParent =
        runs.length === 1 &&
        runs[0].length === 1 &&
        /\bgroups?$/i.test(leading[0].text.trim()) &&
        parentColumns.length === 2 &&
        parentColumns[0] > 0 &&
        parentColumns[1] === parentColumns[0] + 1 &&
        parentChildren.every(Boolean) &&
        Math.abs(parentChildren[0].baseline - parentChildren[1].baseline) <
          leading[0].height * 0.2 &&
        parentChildren.every(
          (i) =>
            i.baseline > parentBounds[3] && i.baseline - parentBounds[3] < leading[0].height * 4
        ) &&
        Math.abs(
          union(parentChildren)[0] + union(parentChildren)[2] - parentBounds[0] - parentBounds[2]
        ) < leading[0].height &&
        objects.some(
          (o) => o.label === 'table column header' && parentChildren.every((i) => inside(o.rect, i))
        )
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
        runs.every(headingRun) &&
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
        centeredGroupParent &&
        leading.every(
          (i) =>
            runs[0].includes(i) ||
            (columnOf(i) >= 0 &&
              !parentColumns.includes(columnOf(i)) &&
              i.rect[1] >= parentBounds[3] &&
              rows[0].rect[1] - i.rect[1] < i.height)
        )
      ) {
        const peers = leading.filter((i) => !runs[0].includes(i))
        rows[0].rect[1] = Math.min(rows[0].rect[1], ...peers.map((i) => i.rect[1]))
        rows.unshift({
          rect: [left, parentBounds[1], right, parentBounds[3]],
          origin: 'source-text'
        })
        recoveredGroupColumns = parentColumns
        repairs.push('treatment-header-recovered')
      } else if (
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
      const sourceSection = sourceSectionGroup(group)
      if (
        !rows.length ||
        !columns.length ||
        group.some(
          (item) =>
            !sectionMarker(item, group) &&
            item.height >= Math.max(...group.map((i) => i.height)) * 0.8 &&
            rows.some((r) => inside([left, r.rect[1], right, r.rect[3]], item)) &&
            !sourceSection
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
      // Sparse categorical sections can place one count cell in the center of
      // each treatment group. Their three occupied columns are intentional even
      // though the remaining table columns are empty.
      const sparseCategoryRecord =
        columns.length >= 8 &&
        cols.size === 3 &&
        cols.has(0) &&
        group.some((item) => columnOf(item) === 0 && /^\p{L}/u.test(item.text.trim())) &&
        group
          .filter((item) => columnOf(item) > 0)
          .every((item) => /^[<>≤≥−+-]?\s*\d[\d.,()%±*–−+\-/\s]*$/.test(item.text.trim())) &&
        groups.filter((candidate) => {
          const candidateColumns = new Set(candidate.map(columnOf).filter((column) => column >= 0))
          return (
            candidateColumns.size === 3 &&
            candidateColumns.has(0) &&
            candidate.some((item) => columnOf(item) === 0 && /^\p{L}/u.test(item.text.trim())) &&
            candidate
              .filter((item) => columnOf(item) > 0)
              .every((item) => /^[<>≤≥−+-]?\s*\d[\d.,()%±*–−+\-/\s]*$/.test(item.text.trim()))
          )
        }).length >= 3
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
          !sparseCategoryRecord &&
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
          !sparseCategoryRecord &&
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
      if (
        sourceSection &&
        overlapping.length &&
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
        rows.push({ rect: [left, rect[1], right, rect[3]], origin: 'source-text', section: true })
        repairs.push('text-supported-section-row-recovered')
        continue
      }
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
    // A model row can begin before the second baseline of the preceding
    // record. Reassign that baseline to the preceding row only when the next
    // row has no other source text in the overlap and every parenthesized
    // value follows a numeric estimate in the preceding row.
    if (columns.length >= 8) {
      const intermediateParenthesized = (text) => /^\([−-]?\d[\d.,]*\)$/.test(text)
      for (let index = 0; index < rows.length - 1; index++) {
        const row = rows[index]
        const next = rows[index + 1]
        const continuation = groups.find((group) => {
          const bounds = union(group)
          const height = Math.max(...group.map((item) => item.height))
          const values = group.filter((item) => intermediateParenthesized(item.text.trim()))
          if (
            bounds[1] < row.rect[3] - height * 0.5 ||
            bounds[1] > next.rect[1] + height * 0.5 ||
            bounds[3] > bottom ||
            values.length < 2 ||
            values.length !== group.length ||
            hasHorizontalTableRuleBetween(rules, row.rect[3], bounds[1])
          )
            return false
          if (
            items.some(
              (item) => !group.includes(item) && inside(next.rect, item) && item.rect[1] < bounds[3]
            )
          )
            return false
          return values.every((item) => {
            const column = columnOf(item)
            return (
              column > 0 &&
              /^[−-]?\d[\d.,]*$/.test(
                items
                  .filter((previous) => columnOf(previous) === column && inside(row.rect, previous))
                  .map((previous) => previous.text)
                  .join('')
                  .replace(/\s/g, '')
              )
            )
          })
        })
        if (continuation) {
          const bounds = union(continuation)
          row.rect[3] = bounds[3]
          next.rect[1] = bounds[3]
          repairs.push('intermediate-parenthesized-continuation-recovered')
        }
      }
    }
    // A wrapped text cell can similarly straddle the next predicted row. Only
    // join a short closing fragment when the prior cell has an unmatched
    // opening delimiter and the next row has no source ink in the overlap.
    for (let index = 0; index < rows.length - 1; index++) {
      const row = rows[index]
      const next = rows[index + 1]
      const continuation = groups.find((group) => {
        const bounds = union(group)
        const height = Math.max(...group.map((item) => item.height))
        const columnsInGroup = new Set(group.map(columnOf))
        const text = group.map((item) => item.text.trim()).join(' ')
        if (
          columnsInGroup.size !== 1 ||
          [...columnsInGroup][0] <= 0 ||
          text.length > 80 ||
          !/[)\]}]$/.test(text) ||
          bounds[1] < row.rect[3] - height * 0.5 ||
          bounds[1] > next.rect[1] + height * 0.5 ||
          bounds[3] > bottom ||
          hasHorizontalTableRuleBetween(rules, row.rect[3], bounds[1])
        )
          return false
        if (
          items.some(
            (item) => !group.includes(item) && inside(next.rect, item) && item.rect[1] < bounds[3]
          )
        )
          return false
        const column = [...columnsInGroup][0]
        const prior = items
          .filter((item) => columnOf(item) === column && inside(row.rect, item))
          .sort((a, b) => a.baseline - b.baseline)
          .map((item) => item.text.trim())
          .join(' ')
        const open = (prior.match(/[([{]/g) ?? []).length
        const close = (prior.match(/[)\]}]/g) ?? []).length
        return open > close
      })
      if (continuation) {
        const bounds = union(continuation)
        row.rect[3] = bounds[3]
        next.rect[1] = bounds[3]
        repairs.push('intermediate-text-continuation-recovered')
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
        const parallelHeaderTail = group.every((item) => {
          const tail = items.filter(
            (i) =>
              columnOf(i) === columnOf(item) &&
              inside(firstRow.rect, i) &&
              i.baseline > item.baseline &&
              /^\p{L}[\p{L} -]*$/u.test(i.text)
          )
          return (
            tail.filter((i) =>
              items.some(
                (peer) =>
                  columnOf(peer) !== columnOf(i) &&
                  inside(firstRow.rect, peer) &&
                  peer.text === i.text &&
                  Math.abs(peer.baseline - i.baseline) < i.height * 0.2
              )
            ).length >= 2
          )
        })
        const singleWrappedHeader =
          cols.size === 1 &&
          (ruledHeader ||
            repeatedHeaderPrefix ||
            parallelHeaderTail ||
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
            !/^\d[\d,]*$/.test(count.texts[column])
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
        /^[<>≤≥]?\s*[−-]?\s*(?:\d+(?:\.\d+)?|\.\d+)(?:\s*\(\d+(?:\.\d+)?\)|\s*(?:to|[–−-])\s*[−-]?\s*\d+(?:\.\d+)?)?$/.test(
          text
        )
      const complete = (line) =>
        line.texts.slice(0, 2).every((text) => /\p{L}/u.test(text)) &&
        line.texts.slice(2).every(numeric)
      const first = sourceLines.findIndex(complete)
      const sourceBody = first >= 0 ? sourceLines.slice(first).flatMap((line) => line.group) : []
      const heights = sourceBody.map((i) => i.height).sort((a, b) => a - b)
      const pairedGroups = groupSourceRowsWithScripts(
        sourceBody.sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]),
        heights[Math.floor(heights.length / 2)],
        0.3
      )
      const body = (pairedGroups ?? []).map((group) => ({
        group,
        texts: columnRects.map((_, c) =>
          group
            .filter((i) => columnOf(i) === c)
            .sort((a, b) => a.rect[0] - b.rect[0])
            .map((i) => i.text)
            .join(' ')
        )
      }))
      const values =
        body[1]?.texts.flatMap((text, column) => (text && column >= 2 ? [column] : [])) ?? []
      const sharedStart = (values.at(-1) ?? columns.length) + 1
      const headers = rows.filter((row) => body.length && row.rect[3] <= union(body[0].group)[1])
      // Repeated Mean / SE / t-value groups share one statistic between the
      // same two arms at each time point. Preserve separate N, mean and SE
      // cells; use the existing paired-row/span owner for interleaved values.
      const shared = columnRects.flatMap((_, c) => (c >= 2 && !values.includes(c) ? [c] : []))
      const bodyBounds = body.length ? union(body.flatMap((line) => line.group)) : undefined
      const headerText = (c) =>
        items
          .filter((i) => columnOf(i) === c && headers.length && inside(headers.at(-1).rect, i))
          .map((i) => i.text)
          .join('')
          .replace(/\s/g, '')
      const pairedSummary =
        columns.length === 6 &&
        externalCaptions.length &&
        /^Mean\(SD\)$/i.test(headerText(2)) &&
        /^Median$/i.test(headerText(3)) &&
        /^Range$/i.test(headerText(4)) &&
        /^P$/i.test(headerText(5)) &&
        body[0]?.texts[1] !== body[1]?.texts[1] &&
        body.every((line, n) => line.texts[1] === body[n % 2].texts[1])
      const repeatedStatistics =
        bodyBounds &&
        externalCaptions.length > 0 &&
        columns.length >= 12 &&
        (columns.length - 3) % 3 === 0 &&
        shared.length === (columns.length - 3) / 3 &&
        shared.every(
          (c, n) =>
            c === 5 + n * 3 &&
            /^tvalue[a-z]?$/.test(headerText(c)) &&
            /^SE$/.test(headerText(c - 1)) &&
            /^Mean[a-z]?$/.test(headerText(c - 2))
        ) &&
        body.every((line, n) => line.texts[1] === body[n % 2].texts[1]) &&
        body[0]?.texts[1] !== body[1]?.texts[1] &&
        [false, true].every((bottom) =>
          rules.some(
            (r) =>
              r[1] === r[3] &&
              r[0] <= bodyBounds[0] + 1 &&
              r[2] >= bodyBounds[2] - 1 &&
              (bottom
                ? r[1] > union(body.at(-1).group)[3] &&
                  r[1] - union(body.at(-1).group)[3] < body[0].group[0].height
                : r[1] < union(body[0].group)[1] &&
                  union(body[0].group)[1] - r[1] < body[0].group[0].height)
          )
        ) &&
        !rules.some(
          (r) =>
            r[1] === r[3] &&
            r[0] < right &&
            r[2] > left &&
            body.some(
              (line, n) =>
                n % 2 === 0 &&
                body[n + 1] &&
                r[1] > union(line.group)[3] &&
                r[1] < union(body[n + 1].group)[1]
            )
        )
      if (
        headers.length &&
        (objects.some((o) => o.label === 'table column header') || pairedSummary) &&
        body.length >= (repeatedStatistics ? 4 : 6) &&
        body.length % 2 === 0 &&
        values.length >= 2 &&
        (repeatedStatistics ||
          pairedSummary ||
          (sharedStart <= columns.length - 2 && values.every((c, i) => c === i + 2))) &&
        body.every((line, index) =>
          index % 2 === 0
            ? complete(line)
            : !line.texts[0] &&
              /\p{L}/u.test(line.texts[1]) &&
              values.every((c) => numeric(line.texts[c])) &&
              shared.every((c) => !line.texts[c])
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
            /^n\.?s\.?$/i.test(text) ||
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
          : completeHeader && firstNumeric > 0
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
  // In a two-column code directory a shifted band can retain only the
  // indented second line of a name. A complete label/code pair immediately
  // above that line establishes the start of the same record.
  if (!recordGrid && externalCaptions.length && columns.length === 2) {
    const coded = groups.filter((group) => {
      const label = group.filter((item) => columnOf(item) === 0)
      const value = group.filter((item) => columnOf(item) === 1)
      return (
        label.length &&
        value.length &&
        label.every((item) => /\p{L}/u.test(item.text)) &&
        value.every((item) => /^\d[\d,\s–-]*$/.test(item.text.trim()))
      )
    })
    if (coded.length >= 3)
      for (const group of coded) {
        if (group.some((item) => rows.some((row) => inside(row.rect, item)))) continue
        const bounds = union(group)
        const row = rows.find((candidate) => candidate.rect[1] > bounds[1])
        if (!row) continue
        const continuation = items.filter((item) => inside(row.rect, item))
        const label = group.find((item) => columnOf(item) === 0)
        if (
          continuation.length !== 1 ||
          columnOf(continuation[0]) !== 0 ||
          !/^[a-z]/.test(continuation[0].text) ||
          continuation[0].rect[0] < label.rect[0] ||
          continuation[0].rect[0] - label.rect[0] > label.height * 1.5 ||
          continuation[0].baseline - label.baseline > label.height * 1.3 ||
          continuation[0].rect[1] < bounds[3] ||
          Math.abs(continuation[0].height - label.height) > label.height * 0.1 ||
          rows.some(
            (other) => other !== row && other.rect[3] > bounds[1] && other.rect[1] < row.rect[1]
          ) ||
          hasHorizontalTableRuleBetween(rules, bounds[1], continuation[0].rect[3])
        )
          continue
        row.rect[1] = bounds[1]
        repairs.push('text-supported-row-realigned')
      }
  }
  const trustedRowExtentRecovery = repairs.some((repair) =>
    new Set([
      'text-supported-row-realigned',
      'text-supported-row-recovered',
      'text-supported-study-records-recovered',
      'text-supported-wrapped-records-recovered',
      'source-record-boundary-comparison-recovered'
    ]).has(repair)
  )
  if (
    trustedRowExtentRecovery &&
    clipped.length &&
    clipped.every((item) => rows.some((row) => inside(row.rect, item)))
  )
    issues.delete('text-crosses-crop-boundary')
  const finalRow = rows.at(-1)
  if (finalRow && !recordGrid?.completeSpans) {
    // An unruled narrative table can end with a wrapped line just outside
    // the final model band. Require a continuous three-line source chain
    // in one non-stub column, still inside the captioned table's crop.
    if (externalCaptions.length && columns.length >= 4) {
      for (const group of groups) {
        const bounds = union(group)
        const column = columnOf(group[0])
        if (
          column <= 0 ||
          group.some((item) => !item.horizontal || columnOf(item) !== column) ||
          bounds[3] <= finalRow.rect[3] ||
          bounds[1] < finalRow.rect[3] - group[0].height * 0.25 ||
          bounds[3] > bottom ||
          hasHorizontalTableRuleBetween(rules, finalRow.rect[3], bounds[3])
        )
          continue
        const preceding = groups
          .filter((g) => g.some((item) => columnOf(item) === column && inside(finalRow.rect, item)))
          .map((g) => g.filter((item) => columnOf(item) === column))
          .slice(-3)
        const chain = [...preceding, group]
        if (
          preceding.length !== 3 ||
          !chain.every((g, index) => {
            const rect = union(g)
            const height = Math.max(...g.map((item) => item.height))
            return (
              Math.abs(rect[0] - bounds[0]) < height * 0.3 &&
              g.every((item) => Math.abs(item.height - group[0].height) < height * 0.15) &&
              (!index ||
                (rect[1] >= union(chain[index - 1])[3] &&
                  rect[1] - union(chain[index - 1])[1] <= height * 1.5))
            )
          })
        )
          continue
        finalRow.rect[3] = bounds[3]
        repairs.push('recovered-row-continuation-included')
      }
    }
    // A continued page can end without a closing rule. Complete parenthesized
    // ranges on the immediately following baseline belong to bare estimates
    // above, provided several earlier records demonstrate the same layout.
    const tail = groups.find(
      (g) =>
        union(g)[1] > finalRow.rect[3] &&
        union(g)[1] - finalRow.rect[3] < Math.max(...g.map((i) => i.height))
    )
    if (tail && !hasHorizontalTableRuleBetween(rules, finalRow.rect[3], union(tail)[1])) {
      const values = columnRects.map((_, c) =>
        tail
          .filter((i) => columnOf(i) === c)
          .map((i) => i.text)
          .join('')
          .replace(/\s/g, '')
      )
      const range = /^\([−-]?\d[\d.]*[–−-][−-]?\d[\d.]*\)$/
      if (
        !values[0] &&
        values.filter(Boolean).length >= 2 &&
        values.every((v) => !v || range.test(v)) &&
        values.every(
          (v, c) =>
            !v ||
            /^[−-]?\d[\d.]*$/.test(
              items
                .filter((i) => columnOf(i) === c && inside(finalRow.rect, i))
                .map((i) => i.text)
                .join('')
                .replace(/\s/g, '')
            )
        ) &&
        groups.filter(
          (g) =>
            columnRects.filter(
              (_, c) =>
                c > 0 &&
                range.test(
                  g
                    .filter((i) => columnOf(i) === c)
                    .map((i) => i.text)
                    .join('')
                    .replace(/\s/g, '')
                )
            ).length >= 2
        ).length >= 3
      ) {
        finalRow.rect[3] = union(tail)[3]
        repairs.push('ruled-final-continuation-recovered')
      }
    }
    // Some unruled follow-up tables split the final record across two source
    // baselines. When the second baseline contains only parenthesized values,
    // extend the final row only if each value follows a bare estimate in the
    // same column and earlier records repeat continuations in those columns.
    const parenthesized = (text) => /^\([−-]?\d[\d.,]*\)$/.test(text)
    const parenthesizedTail = groups.find((group) => {
      const bounds = union(group)
      const height = Math.max(...group.map((item) => item.height))
      const values = group.filter((item) => parenthesized(item.text.trim()))
      return (
        bounds[1] >= finalRow.rect[3] - height * 0.5 &&
        bounds[1] - finalRow.rect[3] <= height * 1.2 &&
        bounds[3] <= bottom &&
        values.length >= 3 &&
        values.length === group.length &&
        values.every((item) => {
          const column = columnOf(item)
          return (
            column > 0 &&
            /^[−-]?\d[\d.,]*$/.test(
              items
                .filter(
                  (previous) => columnOf(previous) === column && inside(finalRow.rect, previous)
                )
                .map((previous) => previous.text)
                .join('')
                .replace(/\s/g, '')
            )
          )
        })
      )
    })
    if (
      parenthesizedTail &&
      !hasHorizontalTableRuleBetween(rules, finalRow.rect[3], union(parenthesizedTail)[1])
    ) {
      const continuationColumns = new Set(
        parenthesizedTail.map((item) => columnOf(item)).filter((column) => column > 0)
      )
      const priorContinuations = groups.filter((group) => {
        if (group === parenthesizedTail || union(group)[3] > finalRow.rect[3]) return false
        return group.some(
          (item) => parenthesized(item.text.trim()) && continuationColumns.has(columnOf(item))
        )
      })
      const priorColumns = new Set(
        priorContinuations.flatMap((group) =>
          group.filter((item) => parenthesized(item.text.trim())).map((item) => columnOf(item))
        )
      )
      if (
        priorContinuations.length >= 3 &&
        [...continuationColumns].every((column) => priorColumns.has(column))
      ) {
        finalRow.rect[3] = union(parenthesizedTail)[3]
        repairs.push('terminal-parenthesized-continuation-recovered')
      }
    }
    for (const group of groups.filter((g) =>
      g.every((i) => (i.rect[1] + i.rect[3]) / 2 >= finalRow.rect[3])
    )) {
      const bounds = union(group),
        height = Math.max(...group.map((i) => i.height))
      if (
        bounds[1] - finalRow.rect[3] > height * 1.6 ||
        hasHorizontalTableRuleBetween(rules, finalRow.rect[3], bounds[1]) ||
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
  // Record-grid recoveries bypass the source-row pass above. A displaced
  // section title can therefore remain between two model rows even though
  // adjacent source records prove that it owns a full table band. Limit this
  // repair to compact two/three-column grids; larger survey spans need their
  // projected-header evidence and are intentionally left unresolved.
  const recoverableSourceSection = (group) => {
    if (
      !group.length ||
      columns.length < 2 ||
      (columns.length > 3 &&
        group
          .map((item) => item.text)
          .join(' ')
          .trim()
          .split(/\s+/).length > 4) ||
      !group.every((item) => columnOf(item) === 0)
    )
      return false
    const text = group
      .map((item) => item.text.split(String.fromCharCode(8)).join(' '))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (
      !/^[\p{L}\d][\p{L}\d\s%(),:/+–−-]*$/u.test(text) ||
      text.split(/\s+/).length > 8 ||
      /^(?:table|figure|note)\b/i.test(text) ||
      /^(?:characteristic|characteristics|variable|variables|outcome|outcomes|description|parameter|measure|grade)$/i.test(
        text
      ) ||
      /[.!?]$/.test(text)
    )
      return false
    const index = groups.indexOf(group)
    const numericSectionValue = (text) =>
      /^(?:[<>≤≥−+–—-]?\s*(?:\d|\.\d)[\d\s.,()%±*–—−+/<>=-]*|(?:Referent|Reference|NS|NA|NE|NR|ND|N\/A|±|-))$/i.test(
        text.trim().replace(/(?<=\d)\s+to\s+(?=[−–+-]?\d)/g, '–')
      )
    const populated = (candidate) => {
      const occupied = new Set(candidate.map(columnOf).filter((column) => column >= 0))
      const values = candidate.filter(
        (item) => columnOf(item) > 0 && item.text.replace(/[\p{Cc}\s]/gu, '')
      )
      return (
        occupied.has(0) &&
        occupied.size >= 2 &&
        values.length > 0 &&
        values.every((item) => numericSectionValue(item.text))
      )
    }
    const following = groups
      .slice(index + 1, index + 6)
      .filter(
        (candidate) =>
          candidate[0] && candidate[0].baseline - group.at(-1).baseline <= group[0].height * 7
      )
    const countHeading =
      /,\s*n\s*\(%\)$/i.test(text) &&
      groups.filter(
        (g) =>
          g.every((i) => columnOf(i) === 0) &&
          /,\s*n\s*\(%\)$/i.test(g.map((i) => i.text).join(' ')) &&
          Math.abs(union(g)[0] - union(group)[0]) < group[0].height * 0.25
      ).length >= 3
    if (following.filter(populated).length < (countHeading ? 1 : 2)) return false
    return (
      groups.slice(Math.max(0, index - 3), index).some(populated) ||
      rows.some((row) => group.some((item) => inside(row.rect, item))) ||
      (index === 0 && externalCaptions.length > 0)
    )
  }
  for (const group of groups) {
    if (!recoverableSourceSection(group)) continue
    const rect = union(group)
    if (rows.some((row) => group.every((item) => inside(row.rect, item)))) continue
    const index = groups.indexOf(group)
    const topSection = index === 0 && externalCaptions.length > 0
    const overlapping = rows.filter(
      (row) => Math.min(row.rect[3], rect[3]) - Math.max(row.rect[1], rect[1]) > 0
    )
    if (!overlapping.length && topSection) {
      const next = rows.find((row) => row.rect[1] >= rect[3])
      if (next && next.rect[1] - rect[3] <= Math.max(...group.map((item) => item.height)) * 3) {
        next.rect[1] = (rect[3] + next.rect[1]) / 2
        rows.push({ rect: [left, rect[1], right, rect[3]], origin: 'source-text', section: true })
        repairs.push('text-supported-section-row-recovered')
      }
      continue
    }
    if (!overlapping.length) {
      const before = rows.filter((r) => r.rect[3] <= rect[1]).at(-1)
      const after = rows.find((r) => r.rect[1] >= rect[3])
      const height = Math.max(...group.map((i) => i.height))
      if (
        before &&
        after &&
        rect[1] - before.rect[3] < height * 2 &&
        after.rect[1] - rect[3] < height * 2
      ) {
        rows.push({ rect: [left, rect[1], right, rect[3]], origin: 'source-text', section: true })
        rows.sort((a, b) => a.rect[1] - b.rect[1])
        repairs.push('text-supported-section-row-recovered')
      }
      continue
    }
    if (
      !overlapping.length ||
      !overlapping.every((row) =>
        items
          .filter((item) => inside(row.rect, item) && !group.includes(item))
          .every((item) => item.rect[3] <= rect[1] || item.rect[1] >= rect[3])
      )
    )
      continue
    for (const row of overlapping) {
      if (row.rect[1] < rect[1]) row.rect[3] = rect[1]
      else row.rect[1] = rect[3]
    }
    rows.push({ rect: [left, rect[1], right, rect[3]], origin: 'source-text', section: true })
    repairs.push('text-supported-section-row-recovered')
  }
  rows.sort((a, b) => a.rect[1] - b.rect[1])
  // A detector can skip one complete numeric record when a section label and
  // its values share a narrow baseline. Recover only a full source row with
  // one item in every column, numeric values in every non-stub column, and
  // model rows immediately before and after it.
  if (!recordGrid && externalCaptions.length && columns.length >= 3) {
    const numericCell = (text) => /^[<>≤≥−+-]?(?:\d|\.\d)[\d\s.,()%±–—+/<>=-]*$/.test(text.trim())
    for (const group of groups) {
      const occupied = group.map(columnOf)
      const label = group.find((item) => columnOf(item) === 0)
      const values = group.filter((item) => columnOf(item) > 0)
      if (
        !label ||
        values.length !== columns.length - 1 ||
        new Set(occupied).size !== columns.length ||
        !values.every((item) => numericCell(item.text)) ||
        !/^[\p{L}][\p{L}\s()/-]{1,32}$/u.test(label.text.trim()) ||
        group.some((item) => rows.some((row) => inside(row.rect, item)))
      )
        continue
      const center = (union(group)[1] + union(group)[3]) / 2
      const previous = rows.filter((row) => (row.rect[1] + row.rect[3]) / 2 < center).at(-1)
      const next = rows.find((row) => (row.rect[1] + row.rect[3]) / 2 > center)
      if (!previous || !next || previous === next) continue
      const rowRect = union(group)
      const previousIndex = rows.indexOf(previous)
      previous.rect[3] = Math.min(previous.rect[3], (previous.rect[3] + rowRect[1]) / 2)
      next.rect[1] = Math.max(next.rect[1], (rowRect[3] + next.rect[1]) / 2)
      rows.splice(previousIndex + 1, 0, {
        rect: [left, rowRect[1], right, rowRect[3]],
        origin: 'source-text',
        numericRecord: true
      })
      repairs.push('text-supported-row-recovered')
    }
  }
  // Some statistical values wrap only their trailing number onto a second
  // baseline. Extend the owning row when at least two such tails align with
  // cells whose source text ends in a plus/minus marker; a following model
  // row bounds the continuation and prevents prose absorption.
  if (!recordGrid && rows.length > 1) {
    const numericContinuation = (text) =>
      /^[<>≤≥−+-]?(?:\d|\.\d)[\d\s.,()%±–—+/<>=-]*$/.test(text.trim())
    for (let index = 0; index < rows.length - 1; index++) {
      const row = rows[index],
        next = rows[index + 1]
      const continuation = items.filter(
        (item) =>
          item.rect[1] >= row.rect[3] - 1 &&
          item.rect[3] < next.rect[1] &&
          columnOf(item) > 0 &&
          numericContinuation(item.text)
      )
      if (continuation.length < 2) continue
      const baselines = continuation.map((item) => item.baseline)
      const height = Math.max(...continuation.map((item) => item.height))
      const anchored = continuation.filter((item) =>
        items.some(
          (anchor) =>
            columnOf(anchor) === columnOf(item) &&
            inside(row.rect, anchor) &&
            /±\s*$/.test(anchor.text.trim())
        )
      )
      if (
        anchored.length < 2 ||
        Math.max(...baselines) - Math.min(...baselines) > height * 0.4 ||
        next.rect[1] - row.rect[3] > height * 2.5
      )
        continue
      row.rect[3] = Math.min(
        next.rect[1] - 1,
        Math.max(...continuation.map((item) => item.rect[3])) + 1
      )
      repairs.push('wrapped-numeric-tail-recovered')
    }
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
      let numericRows = body.filter((g) => numeric(g).length >= 3)
      // Native standalone headings must not be swallowed by the numeric-only
      // fallback. Require matching label alignment, complete neighboring values,
      // and repeated projected-header evidence before retaining section bands.
      const divider = rules
        .filter(
          (r) =>
            r[1] === r[3] &&
            r[0] <= left + 16 &&
            r[2] >= right - 16 &&
            r[1] < union(numericRows[0])[1]
        )
        .sort((a, b) => b[1] - a[1])[0]
      const candidateBody = divider ? groups.filter((g) => union(g)[1] > divider[1]) : body
      const sectionGroups = candidateBody.filter((g, n) => {
        const next = candidateBody[n + 1]
        const stubs = g.filter((i) => columnOf(i) === 0)
        const words = stubs
          .map((i) => i.text)
          .join(' ')
          .trim()
        const nextStub = next?.find((i) => columnOf(i) === 0)
        return (
          stubs.length === g.length &&
          /^[A-Z][A-Za-z ,*-]{1,60}$/.test(words) &&
          nextStub &&
          numeric(next).length >= columns.length - 3 &&
          Math.abs(stubs[0].rect[0] - nextStub.rect[0]) < 1 &&
          union(g)[3] < union(next)[1]
        )
      })
      // Repeated outdented labels followed by complete M/SD records provide
      // source evidence even when the model missed every projected heading.
      // Keep the whole cycle; numeric-only recovery would drop its labels.
      const summarySections = []
      const cuts = [columnRects[0][0], ...columnRects.map((c) => c[2])]
      if (divider && candidateBody.length >= 9 && candidateBody.length % 3 === 0) {
        for (let n = 0; n < candidateBody.length; n += 3) {
          const [section, mean, deviation] = candidateBody.slice(n, n + 3)
          const values = [section, mean, deviation].map((g) => readSourceRow(g, cuts))
          const label = section[0],
            m = mean.find((i) => columnOf(i) === 0),
            sd = deviation.find((i) => columnOf(i) === 0)
          if (
            !values.every(Boolean) ||
            !/^[A-Z][A-Za-z0-9 -]+$/.test(values[0][0]) ||
            values[0].slice(1).some(Boolean) ||
            !/^(?:M|Mean)$/.test(values[1][0]) ||
            values[2][0] !== 'SD' ||
            !values
              .slice(1)
              .every((v) => v.slice(1).every((s) => /^[−+-]?\d+(?:\.\d+)?$/.test(s))) ||
            !m ||
            !sd ||
            m.rect[0] - label.rect[0] < label.height * 0.5 ||
            m.rect[0] - label.rect[0] > label.height * 2 ||
            Math.abs(m.rect[0] - sd.rect[0]) > label.height * 0.1 ||
            Math.abs(label.rect[0] - candidateBody[0][0].rect[0]) > label.height * 0.1 ||
            union(section)[3] >= union(mean)[1] ||
            union(mean)[3] >= union(deviation)[1] ||
            m.baseline - label.baseline > label.height * 1.8 ||
            sd.baseline - m.baseline > label.height * 1.8
          ) {
            summarySections.length = 0
            break
          }
          summarySections.push(section)
        }
      }
      for (const section of summarySections)
        if (!sectionGroups.includes(section)) sectionGroups.push(section)
      const projected = sectionGroups.filter((g) =>
        objects.some(
          (o) =>
            o.label === 'table projected row header' &&
            intersect(o.rect, union(g)) / area(union(g)) > 0.4
        )
      )
      const preserveSections =
        sectionGroups.length >= 2 &&
        (projected.length >= 2 || summarySections.length >= 3) &&
        candidateBody.every((g) => numeric(g).length >= 3 || sectionGroups.includes(g))
      if (preserveSections) numericRows = candidateBody
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
          origin: 'source-text',
          ...(preserveSections && sectionGroups.includes(g) ? { section: true } : {})
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
  if (
    !recordGrid ||
    ![comparisonRecords, regressionBlocks, alleleGrid, intervalRecords, headerlessRecords].includes(
      recordGrid
    )
  ) {
    const priorRows = [...rows]
    repairWrappedTableRows({
      rows,
      items,
      groups,
      columnRects,
      rules,
      right,
      repairs,
      captioned: externalCaptions.length > 0,
      headers: objects.filter((o) => o.label === 'table column header')
    })
    // Source spans use row indices. Merging a wrapped row must not shift a
    // later section's span onto the next populated numeric record.
    remapSourceRowSpans(recordGrid, priorRows, rows)
  }
  // A wrapped stub label may sit one baseline above a complete numeric row
  // while the model starts the row at the lower line. Extend that owner's band
  // upward only when the label is unowned and the following line has the same
  // stub plus at least two numeric value columns.
  if (externalCaptions.length) {
    for (let index = 0; index + 1 < groups.length; index++) {
      const head = groups[index],
        tail = groups[index + 1]
      const headColumns = new Set(head.map(columnOf)),
        tailColumns = new Set(tail.map(columnOf))
      const owner = rows.find((row) => tail.every((item) => inside(row.rect, item)))
      const values = tail.filter(
        (item) => columnOf(item) > 0 && /^[<>≤≥−+-]?\d[\d.,%()±–−+\-/]*$/.test(item.text.trim())
      )
      if (
        !owner ||
        headColumns.size !== 1 ||
        !headColumns.has(0) ||
        !tailColumns.has(0) ||
        head.some((item) => rows.some((row) => inside(row.rect, item))) ||
        head.length !== 1 ||
        !/^[A-Z][\p{L}\s-]*$/u.test(head[0].text.trim()) ||
        values.length < 2 ||
        head[0].baseline - tail[0].baseline > 0 ||
        tail[0].baseline - head[0].baseline > head[0].height * 1.6 ||
        hasHorizontalTableRuleBetween(rules, head[0].rect[3], tail[0].rect[1])
      )
        continue
      owner.rect[1] = Math.min(owner.rect[1], head[0].rect[1])
      repairs.push('wrapped-source-label-recovered')
    }
  }
  // A ruled face can contain several source records with shared statistics.
  // Do not collapse an already verified grid back into physical rule bands.
  const ruledStubGrid =
    externalCaptions.length && !recordGrid?.completeSpans
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
  // A triangular correlation matrix can end with a final label and the lone
  // diagonal `1` outside the last predicted band. Recover that terminal row
  // only when the label is repeated in the header and earlier rows already
  // show the same sparse, right-growing matrix pattern.
  if (externalCaptions.length && columns.length >= 6 && rows.length) {
    const lastBottom = Math.max(...rows.map((row) => row.rect[3]))
    const numeric = (text) => /^(?:1|1\.0|[<>≤≥−+-]?\d+(?:\.\d+)?)$/.test(text.trim())
    const firstData = groups.find((group) => {
      const numericParts = group.filter((item) => columnOf(item) > 0 && numeric(item.text))
      return (
        numericParts.length >= Math.min(2, columns.length - 1) &&
        group.some((item) => columnOf(item) === 0 && /\p{L}/u.test(item.text))
      )
    })
    const headerLimit = firstData ? union(firstData)[1] : rows[0].rect[1]
    const candidates = groups.flatMap((group) => {
      const parts = columnRects.map((_, column) =>
        group.filter((item) => columnOf(item) === column)
      )
      const labels = parts.flatMap((part, column) =>
        part.length === 1 && column > 0 && /^[A-Za-z]{2,8}$/.test(part[0].text.trim())
          ? [{ column, text: part[0].text.trim(), item: part[0] }]
          : []
      )
      const values = parts.flatMap((part, column) =>
        part.length === 1 && numeric(part[0].text)
          ? [{ column, text: part[0].text.trim(), item: part[0] }]
          : []
      )
      if (labels.length !== 1 || values.length !== 1 || values[0].column !== columns.length - 1)
        return []
      const label = labels[0]
      const bounds = union(group)
      if (
        bounds[1] < lastBottom ||
        bounds[3] > bottom ||
        bounds[1] - lastBottom > label.item.height * 2 ||
        rows.some((row) => group.every((item) => inside(row.rect, item)))
      )
        return []
      const headerLabel = groups.some(
        (other) =>
          other !== group &&
          other.some(
            (item) =>
              item.text.trim() === label.text &&
              item.rect[3] <= headerLimit &&
              columnOf(item) === values[0].column
          )
      )
      if (!headerLabel) return []
      const earlier = groups.filter(
        (other) =>
          other !== group &&
          union(other)[3] <= lastBottom &&
          other.some(
            (item) => columnOf(item) === label.column && /^[A-Za-z]{2,8}$/.test(item.text)
          ) &&
          other.some((item) => columnOf(item) > label.column && numeric(item.text))
      )
      return earlier.length >= 2 ? [{ group, bounds }] : []
    })
    if (candidates.length === 1) {
      const candidate = candidates[0]
      rows.push({
        rect: [left, candidate.bounds[1], right, candidate.bounds[3]],
        origin: 'source-text',
        numericRecord: true
      })
      repairs.push('terminal-triangular-record-recovered')
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
    rules,
    repairs
  })
  if (!recordGrid?.completeSpans)
    recoverRepeatedMeasurementSections({ rows, groups, items, columnRects, repairs })
  // Some table-transformer rows cover only the first arm of a repeated
  // treatment record. Recover the missing subrows from source baselines when
  // the same label and all value columns repeat; this also gives span cells
  // the correct row band instead of leaving the second arm unassigned.
  if (!recordGrid && externalCaptions.length && columns.length >= 4 && rows.length >= 3) {
    const numeric = (text) => /^[<>≤≥−+-]?\d[\d.,%()±–−+\-/]*$/.test(text.trim())
    let repeatedSubrowRecovered = false
    const candidateGroups = groups.filter((group) => {
      const byColumn = columns.map((_, column) => group.filter((item) => columnOf(item) === column))
      return (
        byColumn[1].length === 1 &&
        byColumn.slice(2).every((parts) => parts.length === 1 && numeric(parts[0].text)) &&
        /\p{L}/u.test(byColumn[1][0].text)
      )
    })
    const labels = new Map()
    for (const group of candidateGroups) {
      const label = group.find((item) => columnOf(item) === 1)?.text.trim()
      if (label) labels.set(label, (labels.get(label) ?? 0) + 1)
    }
    const repeatedLabels = new Set(
      [...labels].filter(([, count]) => count >= 2).map(([label]) => label)
    )
    for (const group of candidateGroups) {
      const label = group.find((item) => columnOf(item) === 1)?.text.trim()
      if (!repeatedLabels.has(label)) continue
      const rect = union(group)
      if (rows.some((row) => group.every((item) => inside(row.rect, item)))) continue
      const overlap = rows
        .map((row, index) => ({ row, index, amount: intersect(row.rect, rect) }))
        .filter(({ amount }) => amount > 0)
        .sort((a, b) => b.amount - a.amount)[0]
      const occupied = overlap && items.some((item) => inside(overlap.row.rect, item))
      if (overlap && !occupied && overlap.amount >= (rect[3] - rect[1]) * 0.25) {
        overlap.row.rect = [left, rect[1], right, rect[3]]
        repairs.push('repeated-subrow-recovered')
        repeatedSubrowRecovered = true
        continue
      }
      const nextRow = rows.findIndex((row) => row.rect[1] > rect[1])
      const insertAt = nextRow < 0 ? rows.length : nextRow
      const previous = rows[insertAt - 1]
      if (
        previous &&
        previous.rect[3] > rect[1] &&
        items.some((item) => inside(previous.rect, item))
      )
        previous.rect[3] = rect[1]
      rows.splice(insertAt, 0, { rect: [left, rect[1], right, rect[3]], origin: 'source-text' })
      repairs.push('repeated-subrow-recovered')
      repeatedSubrowRecovered = true
    }
    if (repeatedSubrowRecovered)
      for (let index = rows.length - 1; index > 0; index--)
        if (!items.some((item) => inside(rows[index].rect, item))) rows.splice(index, 1)
    if (repeatedSubrowRecovered)
      for (let index = rows.length - 1; index > 0; index--) {
        const current = rows[index],
          previous = rows[index - 1]
        const currentItems = items.filter((item) => inside(current.rect, item))
        const previousItems = items.filter((item) => inside(previous.rect, item))
        if (
          current.origin === 'model' &&
          currentItems.length &&
          currentItems.every((item) => previousItems.includes(item)) &&
          intersect(current.rect, previous.rect) > 0
        )
          rows.splice(index, 1)
      }
    rows.sort((a, b) => a.rect[1] - b.rect[1])
  }
  const parentRowSpans =
    (!recordGrid || ([5, 7, 9].includes(columns.length) && !recordGrid.headerRows)) &&
    !ruledTierSpans &&
    externalCaptions.length
      ? splitRuledParentRow({ rows, items, columnRects, rules, repairs })
      : undefined
  // A native table can place a wrapped parent tier above the model's first
  // header band. Recover that tier from the partial rules and the complete
  // leaf-label row instead of leaving its text outside the grid.
  let nativeParentSpans
  if (!recordGrid && externalCaptions.length && columns.length >= 7 && columns.length % 2 === 1) {
    const numeric = (text) => /^[<>≤≥−+-]?\d[\d.,%()±–−+\-/]*$/.test(text.trim())
    const firstData = groups.findIndex((group) => {
      const values = columnRects
        .slice(1)
        .map((_, c) => group.filter((item) => columnOf(item) === c + 1))
      return (
        values.length >= columns.length - 1 &&
        values.every((parts) => parts.length === 1 && numeric(parts[0].text)) &&
        group.some((item) => columnOf(item) === 0 && /\p{L}/u.test(item.text))
      )
    })
    const headerGroups = firstData < 0 ? [] : groups.slice(0, firstData)
    const leafIndex = headerGroups.findIndex((group) => {
      const columnsWithLabels = new Set(
        group.filter((item) => columnOf(item) > 0 && /\p{L}/u.test(item.text)).map(columnOf)
      )
      return columnsWithLabels.size >= columns.length - 2
    })
    const upper = leafIndex > 0 ? headerGroups.slice(0, leafIndex) : []
    const leaf = leafIndex >= 0 ? headerGroups.slice(leafIndex).flat() : []
    const parentBottom = upper.length ? Math.max(...upper.flat().map((item) => item.rect[3])) : 0
    const leafTop = leaf.length ? Math.min(...leaf.map((item) => item.rect[1])) : 0
    const splitLevels = rules
      .filter(
        (rule) =>
          rule[1] === rule[3] &&
          rule[1] > parentBottom &&
          rule[1] < leafTop &&
          rule[2] - rule[0] > (right - left) * 0.2
      )
      .sort((a, b) => a[1] - b[1])
    const split = splitLevels[0]?.[1]
    const parentRules = split ? splitLevels.filter((rule) => Math.abs(rule[1] - split) < 1) : []
    const parentColumns = parentRules
      .map((rule) => ({
        rule,
        columns: columnRects.flatMap((column, index) => {
          const center = (column[0] + column[2]) / 2
          return index > 0 && center >= rule[0] - 1 && center <= rule[2] + 1 ? [index] : []
        })
      }))
      .filter(({ columns: covered }) => covered.length >= 2)
      .sort((a, b) => a.rule[0] - b.rule[0])
    const upperItems = upper.flat()
    const stub = upperItems.filter((item) => columnOf(item) === 0)
    const assigned = upperItems.filter((item) =>
      parentColumns.some(({ rule }) => item.rect[0] >= rule[0] - 1 && item.rect[2] <= rule[2] + 1)
    )
    const topRule = rules.some(
      (rule) =>
        rule[1] === rule[3] &&
        rule[1] <= Math.min(...upperItems.map((item) => item.rect[1])) &&
        rule[0] <= left + 12 &&
        rule[2] >= right - 12
    )
    const lowerRule = rules.some(
      (rule) =>
        rule[1] === rule[3] &&
        rule[1] >= leaf.at(-1)?.rect[3] &&
        rule[1] <= union(leaf)[3] + Math.max(...leaf.map((item) => item.height)) * 2 &&
        rule[0] <= left + 12 &&
        rule[2] >= right - 12
    )
    if (
      rows.length >= 2 &&
      upperItems.length >= 2 &&
      leaf.length >= columns.length - 2 &&
      parentColumns.length >= 2 &&
      stub.length === 1 &&
      assigned.length + stub.length === upperItems.length &&
      parentColumns.every(({ columns: covered }) =>
        covered.every((column) =>
          leaf.some((item) => columnOf(item) === column && /\p{L}/u.test(item.text))
        )
      ) &&
      topRule &&
      lowerRule &&
      rows[0].rect[3] >= split - 2 &&
      rows[1].rect[1] <= leafTop + Math.max(...leaf.map((item) => item.height))
    ) {
      rows[0].rect[1] = Math.min(rows[0].rect[1], ...upperItems.map((item) => item.rect[1]))
      rows[0].rect[3] = split
      rows[1].rect[1] = split
      rows[1].rect[3] = Math.max(rows[1].rect[3], ...leaf.map((item) => item.rect[3]))
      nativeParentSpans = [
        { row: 0, column: 0, rowSpan: 2, colSpan: 1 },
        ...parentColumns.map(({ columns: covered }) => ({
          row: 0,
          column: covered[0],
          rowSpan: 1,
          colSpan: covered.length
        }))
      ]
      repairs.push('native-parent-header-recovered')
    }
  }
  // A short parent such as `95% CI` can sit one baseline above its two leaf
  // headings while the detector starts the first row at the leaf baseline.
  // Recover a separate parent row only when the children are adjacent,
  // column-contained and the model supplies header evidence. This preserves
  // the leaf labels and avoids absorbing ordinary prose above a table.
  let detachedParentSpan
  if (!recordGrid && columns.length >= 3) {
    const parent = items.find(
      (item) =>
        /^\d+(?:\.\d+)?%\s*CI$/i.test(item.text.trim()) &&
        !rows.some((row) => inside(row.rect, item))
    )
    if (parent) {
      const children = items
        .filter((item) => /^(?:Lower|Upper)$/i.test(item.text.trim()))
        .sort((a, b) => a.rect[0] - b.rect[0])
      const childColumns = children.map(columnOf)
      const childRow = rows.findIndex((row) => children.every((item) => inside(row.rect, item)))
      const childBounds = children.length ? union(children) : undefined
      const parentCenter = (parent.rect[0] + parent.rect[2]) / 2
      const childCenter = childBounds ? (childBounds[0] + childBounds[2]) / 2 : 0
      if (
        children.length === 2 &&
        (externalCaptions.length ||
          sourceRules.some(
            (rule) =>
              rule[1] === rule[3] &&
              rule[1] >= parent.rect[3] &&
              rule[1] <= childBounds[1] &&
              rule[0] <= childBounds[0] + 2 &&
              rule[2] >= childBounds[2] - 2 &&
              rule[0] >= columns[childColumns[0]]?.rect[0] - 2 &&
              rule[2] <= columns[childColumns[1]]?.rect[2] + 2
          )) &&
        childRow === 0 &&
        childColumns[0] > 0 &&
        childColumns[1] === childColumns[0] + 1 &&
        childBounds &&
        parent.rect[3] <= childBounds[1] &&
        childBounds[1] - parent.rect[3] <= Math.max(parent.height, children[0].height) * 3 &&
        Math.abs(parentCenter - childCenter) <= (childBounds[2] - childBounds[0]) * 0.4 &&
        objects.some(
          (object) =>
            object.label === 'table column header' &&
            intersect(object.rect, [left, parent.rect[1], right, childBounds[3]]) > 0
        )
      ) {
        rows.unshift({
          rect: [left, parent.rect[1], right, parent.rect[3]],
          origin: 'source-detached-parent-header'
        })
        detachedParentSpan = { row: 0, column: childColumns[0], colSpan: 2 }
        repairs.push('detached-parent-header-recovered')
      }
    }
  }
  if (recordGrid && parentRowSpans) {
    for (const span of recordGrid.spans ?? []) if (span.row > 0) span.row++
    recordGrid.spans.push(...parentRowSpans)
    recordGrid.headerRows = [0, 1]
  }
  // A frequency/% table may use a paired mean/SD record. Its wrapped
  // measurement label and values share one record, including a raised P value.
  if (
    !recordGrid &&
    columns.length === 6 &&
    externalCaptions.length &&
    groups.some(
      (g) =>
        g.filter((i) => i.text === 'frequency').length === 2 &&
        g.filter((i) => i.text === '%').length === 2
    )
  ) {
    for (let r = 1; r < rows.length; r++) {
      const members = items.filter((i) => inside(rows[r].rect, i))
      const label = members
        .filter((i) => columnOf(i) === 0)
        .map((i) => i.text)
        .join('')
        .replace(/\s/g, '')
      const prior = items.filter((i) => inside(rows[r - 1].rect, i))
      if (
        label === 'Mean(SD)' &&
        prior.some((i) => columnOf(i) === 0 && /\p{L}/u.test(i.text)) &&
        prior.every((i) => columnOf(i) === 0 || columnOf(i) === 5) &&
        members.filter((i) => columnOf(i) > 0 && /\d+(?:\.\d+)?\s*\([\d.]+\)/.test(i.text))
          .length === 2
      ) {
        rows[r - 1].rect[3] = rows[r].rect[3]
        rows.splice(r--, 1)
      }
    }
  }
  // A complete source record can fall across two adjacent model bands. This
  // is especially common in ruled demographic tables where one age row is
  // omitted and every glyph is consequently ambiguous. Rebuild only records
  // with a textual stub and at least four numeric value columns; prose and
  // sparse statistic rows remain on the model bands.
  if (externalCaptions.length && columns.length >= 4) {
    const numeric = (text) => /^[<>≤≥−+-]?\d[\d.,%()±–−+\-/]*$/.test(text.trim())
    const records = groups.filter((group) => {
      const parts = columns.map((_, column) => group.filter((item) => columnOf(item) === column))
      return (
        parts[0].length === 1 &&
        /^\d+\s*[–—-]\s*\d+$/u.test(parts[0][0].text.trim()) &&
        /^[\p{L}\d][\p{L}\d\s–—()/'-]{1,40}$/u.test(parts[0][0].text.trim()) &&
        parts.slice(1).filter((part) => part.length === 1 && numeric(part[0].text)).length >=
          Math.min(4, columns.length - 2)
      )
    })
    for (const record of records) {
      // A duplicated center owner is the signature of a source row crossing a
      // model boundary. A single center owner usually means the row is already
      // stable even when glyph padding touches a neighboring band.
      const centerOwners = rows.filter((row) => record.every((item) => inside(row.rect, item)))
      if (centerOwners.length < 2) continue
      const rect = union(record)
      if (rect[1] < top || rect[3] > bottom) continue
      const affected = rows.filter((row) => intersect(row.rect, rect) > 0)
      if (!affected.length) continue
      for (const row of affected) {
        const center = (row.rect[1] + row.rect[3]) / 2
        if (center < (rect[1] + rect[3]) / 2) row.rect[3] = rect[1] - 0.01
        else row.rect[1] = rect[3] + 0.01
      }
      for (let index = rows.length - 1; index >= 0; index--)
        if (
          rows[index].rect[3] <= rows[index].rect[1] ||
          (affected.includes(rows[index]) && !items.some((item) => inside(rows[index].rect, item)))
        )
          rows.splice(index, 1)
      const insertAt = rows.findIndex((row) => row.rect[1] > rect[1])
      rows.splice(insertAt < 0 ? rows.length : insertAt, 0, {
        rect: [left, rect[1], right, rect[3]],
        origin: 'source-text'
      })
      repairs.push('complete-source-record-recovered')
    }
  }
  // Standalone category labels are real header rows when they sit between two
  // complete records. Split a model row that incorrectly joins the preceding
  // record and keep the header as its own row so the following category rows
  // retain their column alignment.
  if (externalCaptions.length && columns.length >= 4) {
    const numeric = (text) => /^[<>≤≥−+-]?\d[\d.,%()±–−+\-/]*$/.test(text.trim())
    const complete = (group) => {
      const parts = columns.map((_, column) => group.filter((item) => columnOf(item) === column))
      return (
        parts[0].length === 1 &&
        parts.slice(1).filter((part) => part.length === 1 && numeric(part[0].text)).length >=
          Math.min(4, columns.length - 2)
      )
    }
    for (const [index, group] of groups.entries()) {
      const parts = columns.map((_, column) => group.filter((item) => columnOf(item) === column))
      if (
        parts[0].length !== 1 ||
        parts.slice(1).some((part) => part.length) ||
        !/^[A-Z][\p{L}\s()/'-]{2,40}$/u.test(parts[0][0].text.trim())
      )
        continue
      const previous = groups[index - 1],
        next = groups[index + 1]
      if (
        !previous ||
        !next ||
        !/^\d+\s*[–—-]\s*\d+$/u.test(previous[0]?.text.trim() ?? '') ||
        !complete(previous) ||
        !complete(next)
      )
        continue
      const sectionRect = union(group),
        previousRect = union(previous)
      const rowIndex = rows.findIndex(
        (row) =>
          previous.some((item) => intersect(row.rect, item.rect) > 0) &&
          group.some((item) => intersect(row.rect, item.rect) > 0)
      )
      if (rowIndex < 0) continue
      const row = rows[rowIndex],
        split = (previousRect[3] + sectionRect[1]) / 2
      row.rect[3] = Math.min(row.rect[3], split)
      rows.splice(rowIndex + 1, 0, {
        rect: [left, split, right, sectionRect[3]],
        origin: 'source-text'
      })
      repairs.push('standalone-section-row-recovered')
    }
  }
  if (repairs.includes('complete-source-record-recovered')) {
    for (let index = rows.length - 1; index >= 0; index--)
      if (rows[index].origin === 'model' && !items.some((item) => inside(rows[index].rect, item))) {
        rows.splice(index, 1)
        repairs.push('empty-model-row-removed')
      }
  }
  // A ruled table can contain a complete source record in a gap between model
  // rows. Recover only labelled records with several numeric values; prose,
  // pairwise comparison lines and partial rows remain on their model bands.
  if (externalCaptions.length && columns.length >= 4) {
    const numericValue = (text) =>
      /^n\.?s\.?$/i.test(text.trim()) ||
      /^(?:[<>≤≥−+-]?\s*(?:\d|\.\d)[\d\s.,%()*†‡–−+\-/]*)$/u.test(text.trim())
    for (const group of groups) {
      const parts = columnRects.map((_, column) =>
        group.filter((item) => columnOf(item) === column).sort((a, b) => a.rect[0] - b.rect[0])
      )
      const label = parts[0].filter((part) => /\p{L}/u.test(part.text))
      const values = parts.slice(1).flatMap((part) => part)
      const numericValues = values.filter((item) => numericValue(item.text))
      if (
        label.length !== 1 ||
        values.some((item) => !numericValue(item.text)) ||
        numericValues.length < Math.min(4, columns.length - 2)
      )
        continue
      const rect = union(group)
      if (rows.some((row) => group.every((item) => inside(row.rect, item)))) continue
      const height = Math.max(...group.map((item) => item.height))
      const before = rows
        .filter((row) => row.rect[3] <= rect[1] + height * 0.4)
        .sort((a, b) => b.rect[3] - a.rect[3])[0]
      const after = rows
        .filter((row) => row.rect[1] >= rect[3] - height * 0.4)
        .sort((a, b) => a.rect[1] - b.rect[1])[0]
      if (
        !before ||
        !after ||
        rect[1] - before.rect[3] > height * 2.5 ||
        after.rect[1] - rect[3] > height * 2.5 ||
        hasHorizontalTableRuleBetween(rules, before.rect[3], after.rect[1])
      )
        continue
      const intersecting = rows.filter((row) => intersect(row.rect, rect) > 0)
      if (
        intersecting.some(
          (row) =>
            Math.max(0, Math.min(row.rect[3], rect[3]) - Math.max(row.rect[1], rect[1])) /
              (rect[3] - rect[1]) >
              0.5 &&
            items.some(
              (item) => inside(row.rect, item) && !group.includes(item) && /\d/.test(item.text)
            )
        )
      )
        continue
      before.rect[3] = Math.min(before.rect[3], (before.rect[3] + rect[1]) / 2)
      after.rect[1] = Math.max(after.rect[1], (rect[3] + after.rect[1]) / 2)
      const insertAt = rows.findIndex((row) => row.rect[1] > rect[1])
      rows.splice(insertAt < 0 ? rows.length : insertAt, 0, {
        rect: [left, rect[1], right, rect[3]],
        origin: 'source-text'
      })
      repairs.push('missing-numeric-source-row-recovered')
    }
  }
  // A text-only comparison section may sit between two complete numeric
  // records without receiving a detector row. Recover only a contiguous
  // column-zero label in that gap; footnotes and ordinary wrapped labels are
  // excluded by the surrounding numeric-record proof.
  if (externalCaptions.length && columns.length >= 4) {
    const textGroups = groups
      .map((group) => {
        const firstColumn = group.filter((item) => columnOf(item) === 0)
        return firstColumn.length === group.length ? firstColumn : []
      })
      .filter((group) => group.length && /\p{L}/u.test(group.map((item) => item.text).join(' ')))
      .sort((a, b) => union(a)[1] - union(b)[1])
    const mergedGroups = []
    for (const group of textGroups) {
      const previous = mergedGroups.at(-1)
      const height = Math.max(...group.map((item) => item.height))
      if (
        previous &&
        Math.abs(union(previous)[0] - union(group)[0]) <= height &&
        union(group)[1] - union(previous)[3] <= height * 1.6
      )
        previous.push(...group)
      else mergedGroups.push([...group])
    }
    for (const group of mergedGroups) {
      const text = group
        .map((item) => item.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (
        text.length < 8 ||
        /\d/.test(text) ||
        !/\bvs\.?\b/i.test(text) ||
        /^(?:table|figure|note|source|bonferroni|post\s+hoc)\b/i.test(text) ||
        rows.some((row) => group.every((item) => inside(row.rect, item)))
      )
        continue
      const rect = union(group)
      const height = Math.max(...group.map((item) => item.height))
      const before = rows
        .filter((row) => row.rect[3] <= rect[1] + height * 0.4)
        .sort((a, b) => b.rect[3] - a.rect[3])[0]
      const after = rows
        .filter((row) => row.rect[1] >= rect[3] - height * 0.4)
        .sort((a, b) => a.rect[1] - b.rect[1])[0]
      const numericRecord = (row) =>
        items.filter((item) => inside(row.rect, item) && /(?:\d|\bns\b)/i.test(item.text)).length >=
        2
      if (
        !before ||
        !after ||
        !numericRecord(before) ||
        !numericRecord(after) ||
        rect[1] - before.rect[3] > height * 3 ||
        after.rect[1] - rect[3] > height * 3 ||
        hasHorizontalTableRuleBetween(rules, before.rect[3], after.rect[1])
      )
        continue
      const intersecting = rows.filter((row) => intersect(row.rect, rect) > 0)
      if (
        intersecting.some(
          (row) =>
            Math.max(0, Math.min(row.rect[3], rect[3]) - Math.max(row.rect[1], rect[1])) /
              (rect[3] - rect[1]) >
              0.5 &&
            items.some(
              (item) => inside(row.rect, item) && !group.includes(item) && /\d/.test(item.text)
            )
        )
      )
        continue
      const previousRows = [...rows]
      const sourceOwners = rows.filter((row) => {
        const owned = items.filter((item) => inside(row.rect, item))
        return owned.length && owned.every((item) => group.includes(item))
      })
      if (
        sourceOwners.length > 1 &&
        group.every((item) => sourceOwners.filter((row) => inside(row.rect, item)).length === 1)
      ) {
        sourceOwners[0].rect = [left, rect[1], right, rect[3]]
        sourceOwners[0].section = true
        for (const row of sourceOwners.slice(1)) rows.splice(rows.indexOf(row), 1)
        remapSourceRowSpans(recordGrid, previousRows, rows)
        repairs.push('wrapped-comparison-record-recovered')
        continue
      }
      before.rect[3] = Math.min(before.rect[3], (before.rect[3] + rect[1]) / 2)
      after.rect[1] = Math.max(after.rect[1], (rect[3] + after.rect[1]) / 2)
      const insertAt = rows.findIndex((row) => row.rect[1] > rect[1])
      rows.splice(insertAt < 0 ? rows.length : insertAt, 0, {
        rect: [left, rect[1], right, rect[3]],
        origin: 'source-text',
        section: true
      })
      remapSourceRowSpans(recordGrid, previousRows, rows)
      repairs.push('missing-section-row-recovered')
    }
  }
  // A compact source baseline can straddle two model bands when one record is
  // missing from the detector output. Rebuild only labelled numeric records
  // with a real source neighbour on each side; this keeps merged section rows
  // and prose bands out of the recovery path.
  const compactNumeric = (text) =>
    /^(?:[<>≤≥−+-]?\s*(?:\d|\.\d)[\d\s.,()%±*–−+\-/]*|[–—−-])$/u.test(
      text.replace(String.fromCharCode(8), ' ').replace(/\s+/g, ' ').trim()
    )
  const compactSourceText = (group, column) =>
    group
      .filter((item) => columnOf(item) === column)
      .map((item) => item.text.replace(String.fromCharCode(8), ' '))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
  const compactBoundary = (group) => {
    const label = compactSourceText(group, 0)
    return (
      label.length >= 2 &&
      /[\p{L}\d]/u.test(label) &&
      !/^(?:table|figure|note|group|p\s*value)$/i.test(label) &&
      group.some((item) => columnOf(item) === 0)
    )
  }
  const compactMarker = (group) =>
    group.length > 0 &&
    group.every((item) => columnOf(item) >= 0 && columnOf(item) > 0) &&
    group.every((item) => /^(?:NS|[a-z*†‡])$/i.test(item.text.trim()))
  const compactRecord = (group) => {
    const label = compactSourceText(group, 0)
    const special = /^(?:Alopecia|FEC|PR\s*[+−-]|IIA)$/iu.test(label)
    const values = columnRects
      .slice(1)
      .map((_, column) => compactSourceText(group, column + 1))
      .filter(Boolean)
    return (
      label.length >= 2 &&
      /\p{L}/u.test(label) &&
      !/^(?:table|figure|note|p\s*value|value)$/i.test(label) &&
      (!/^[IVX]+[A-Z]?$/u.test(label) || special) &&
      values.length >= 2 &&
      values.every(compactNumeric) &&
      group.some((item) => columnOf(item) === 0)
    )
  }
  const compactHandled = new Set()
  for (const [index, group] of groups.entries()) {
    if (!compactRecord(group) || compactHandled.has(group)) continue
    const special = /^(?:Alopecia|FEC|PR\s*[+−-]|IIA)$/iu.test(compactSourceText(group, 0))
    const fullGroup = [group]
    for (const adjacent of [groups[index - 1], groups[index + 1]])
      if (adjacent && compactMarker(adjacent)) fullGroup.push(adjacent)
    const recordRect = union(fullGroup.flat())
    const owner = rows.find((row) => group.every((item) => inside(row.rect, item)))
    const ownerMixed =
      owner &&
      items.some(
        (item) =>
          intersect(owner.rect, item.rect) > 0 &&
          !group.includes(item) &&
          (Math.abs(item.baseline - group[0].baseline) >
            Math.max(item.height, group[0].height) * 0.6 ||
            item.rect[3] <= group[0].rect[1] ||
            item.rect[1] >= group.at(-1).rect[3])
      )
    if (owner && !ownerMixed && !special) continue
    const previous = groups
      .slice(0, index)
      .reverse()
      .find((candidate) => compactBoundary(candidate) && union(candidate)[3] <= recordRect[1] + 2)
    const next = groups
      .slice(index + 1)
      .find((candidate) => compactBoundary(candidate) && union(candidate)[1] >= recordRect[3] - 2)
    if (!previous || !next) continue
    const previousRect = union(previous)
    const nextRect = union(next)
    const height = Math.max(...group.map((item) => item.height))
    if (
      previousRect[3] > recordRect[1] + height * 0.7 ||
      nextRect[1] < recordRect[3] - height * 0.7 ||
      nextRect[1] - previousRect[3] > height * 5
    ) {
      continue
    }
    const start = (previousRect[3] + recordRect[1]) / 2
    const end = (recordRect[3] + nextRect[1]) / 2
    if (end <= start) continue
    const affected = rows.filter((row) => row.rect[3] > start && row.rect[1] < end)
    if (!affected.length) continue
    const sourceItems = new Set(fullGroup.flat())
    const sourceOwnedRows = affected.filter((row) => {
      const owned = items.filter((item) => inside(row.rect, item))
      return owned.length > 0 && owned.every((item) => sourceItems.has(item))
    })
    if (sourceOwnedRows.length < (special ? 1 : 2)) continue
    const previousRows = affected.filter((row) =>
      previous.some((item) => intersect(row.rect, item.rect) > 0)
    )
    const nextRows = affected.filter((row) =>
      next.some((item) => intersect(row.rect, item.rect) > 0)
    )
    if (previousRows.some((row) => nextRows.includes(row))) continue
    for (const row of previousRows) row.rect[3] = Math.min(row.rect[3], start)
    for (const row of nextRows) row.rect[1] = Math.max(row.rect[1], end)
    let emptyRowsRemoved = 0
    for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex--) {
      const row = rows[rowIndex]
      if (!affected.includes(row) || previousRows.includes(row) || nextRows.includes(row)) continue
      const owned = items.filter((item) => intersect(row.rect, item.rect) > 0)
      if (owned.every((item) => sourceItems.has(item))) {
        if (!owned.length) emptyRowsRemoved++
        rows.splice(rowIndex, 1)
      }
    }
    rows.push({ rect: [left, start, right, end], origin: 'source-text' })
    for (let rowIndex = rows.length - 2; rowIndex >= 0; rowIndex--) {
      const row = rows[rowIndex]
      if (
        row.origin === 'model' &&
        row.rect[1] >= previousRect[3] - height &&
        row.rect[3] <= nextRect[1] + height &&
        !items.some((item) => inside(row.rect, item))
      ) {
        rows.splice(rowIndex, 1)
        emptyRowsRemoved++
      }
    }
    rows.sort((a, b) => a.rect[1] - b.rect[1])
    compactHandled.add(group)
    if (emptyRowsRemoved) repairs.push('empty-overlapping-row-removed')
    repairs.push('compact-source-record-recovered')
  }
  const priorSourceRows = [...rows]
  // A native grid may include a title above the actual crop. Remove only its
  // now-empty ruled band, keeping all surviving span identities.
  const precedingTitle = rows[0] && pageItems.filter((i) => inside(rows[0].rect, i))
  if (
    recordGrid?.headerRows?.includes(0) &&
    rows[0]?.origin === 'source-record' &&
    !items.some((i) => inside(rows[0].rect, i)) &&
    precedingTitle.length &&
    precedingTitle.every(
      (i) => excluded.has(i) || (i.horizontal && i.rect[3] < table.cropRect[1])
    ) &&
    horizontalRules.some(
      (r) => Math.abs(r[1] - rows[0].rect[3]) < 0.1 && r[0] <= left + 16 && r[2] >= right - 16
    )
  ) {
    rows.shift()
    repairs.push('empty-overlapping-row-removed')
  }
  if (externalCaptions.length)
    recoverUnownedSourceRows({ rows, groups, items, columnRects, repairs })
  if (!recordGrid?.completeSpans)
    recoverCitedRecordTails({ rows, items, columnRects, rules, repairs })
  if (externalCaptions.length && !recordGrid?.preservePhysicalRows)
    mergeWrappedStubTails({
      rows,
      items,
      columnRects,
      rules,
      repairs,
      externalItems: pageItems.filter((item) => intersect(item.rect, table.cropRect) === 0)
    })
  remapSourceRowSpans(recordGrid, priorSourceRows, rows)
  // Source recovery can insert a band that duplicates an existing model band.
  // Reconcile native ownership again before deriving cell spans from the rows.
  mergeDuplicateSourceRows({ rows, groups, items, columnRects, repairs })
  // Independent group and significance labels can sit just above the
  // first predicted row. Extend that header row when the labels are clearly
  // column-contained and use the table's own terminology.
  if (
    rows.length &&
    externalCaptions.length &&
    objects.some((o) => o.label === 'table column header')
  ) {
    const first = rows[0]
    const headerGroups = groups.filter((group) => {
      const rect = union(group)
      const text = group
        .map((item) => item.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      return (
        rect[1] < first.rect[1] &&
        rect[3] <= first.rect[1] + Math.max(...group.map((item) => item.height)) * 0.2 &&
        group.every((item) => columnOf(item) > 0 && /\p{L}/u.test(item.text)) &&
        /(?:group\s+[a-z]|p\s*value|value)/i.test(text)
      )
    })
    if (headerGroups.length) {
      first.rect[1] = Math.min(first.rect[1], ...headerGroups.map((group) => union(group)[1]))
      repairs.push('compact-source-header-recovered')
    }
  }
  // Some tables put compact group headers, each with an inline sample size,
  // above the detected header band. The labels are not model spans, but
  // repeated n/% child pairs and numeric records below give a deterministic
  // two-column parent layout. Recover only that complete pattern so ordinary
  // prose above a table is not claimed as a header.
  let compactCountHeaderStarts
  if (rows.length >= 3 && columns.length >= 6 && externalCaptions.length) {
    const leadingGroups = groups.filter((group) => {
      const rect = union(group),
        height = Math.max(...group.map((item) => item.height))
      const compact = group
        .map((item) => item.text)
        .join('')
        .replace(/\s+/g, '')
      return (
        rect[3] < rows[0].rect[1] &&
        rows[0].rect[1] - rect[3] <= height * 3 &&
        /^(?:[\p{L}\d]+\(?n=\d+\)){3,}$/u.test(compact) &&
        group.filter((item) => /^[\p{L}][\p{L}\d]*\s*\(?$/u.test(item.text)).length >= 3
      )
    })
    const leading = leadingGroups[0]
    const childRow = rows[1]
    if (leading && childRow) {
      const childItems = items.filter(
        (item) =>
          inside(childRow.rect, item) && /^(?:n|%)$/i.test(item.text.trim()) && columnOf(item) > 0
      )
      const childColumns = [...new Set(childItems.map(columnOf))].sort((a, b) => a - b)
      const labelItems = leading.filter(
        (item) =>
          /^[\p{L}][\p{L}\d]*\s*\(?$/u.test(item.text) && !/^(?:n|c|p)$/i.test(item.text.trim())
      )
      const starts = labelItems
        .map((label) =>
          childColumns.reduce(
            (best, column) =>
              Math.abs(
                (columnRects[column][0] + columnRects[column][2]) / 2 -
                  (label.rect[0] + label.rect[2]) / 2
              ) <
              Math.abs(
                (columnRects[best][0] + columnRects[best][2]) / 2 -
                  (label.rect[0] + label.rect[2]) / 2
              )
                ? column
                : best,
            childColumns[0] ?? -1
          )
        )
        .filter((column, index, all) => column >= 0 && all.indexOf(column) === index)
      const numericRows = rows.slice(2).filter((row) => {
        const values = items.filter(
          (item) => inside(row.rect, item) && childColumns.includes(columnOf(item))
        )
        return values.filter((item) => /\d/.test(item.text)).length >= childColumns.length
      })
      if (
        starts.length === 3 &&
        childColumns.length >= 6 &&
        starts.every((column, index) => column === childColumns[index * 2]) &&
        numericRows.length >= 2
      ) {
        compactCountHeaderStarts = starts
        rows[0].rect[1] = Math.min(rows[0].rect[1], union(leading)[1])
        repairs.push('compact-treatment-header-recovered')
      }
    }
  }
  // A missed parent tier above two repeated statistical triplets needs its
  // own row. Native underlines delimit each parent; the six leaf headings
  // must already belong to the first model row and remain separate cells.
  let sourceGroupedHeaderSpans
  if (!recordGrid && externalCaptions.length && columns.length === 7 && rows.length) {
    const leading = groups[0] ?? [],
      leaf = groups[1] ?? []
    const height = Math.max(...leading.map((item) => item.height))
    const parentRect = union(leading),
      leafRect = union(leaf)
    const frames = rules
      .filter(
        (rule) =>
          rule[1] === rule[3] &&
          rule[1] > parentRect[3] &&
          rule[1] < leafRect[1] &&
          rule[2] - rule[0] < (right - left) * 0.6
      )
      .sort((a, b) => a[0] - b[0])
    const parents = frames.map((rule) => ({
      rule,
      tokens: leading.filter((item) => item.rect[0] >= rule[0] - 1 && item.rect[2] <= rule[2] + 1),
      columns: columnRects.flatMap((rect, column) =>
        (rect[0] + rect[2]) / 2 >= rule[0] && (rect[0] + rect[2]) / 2 <= rule[2] ? [column] : []
      )
    }))
    if (
      leading.length >= 2 &&
      parentRect[3] < rows[0].rect[1] &&
      leafRect[1] - parentRect[3] <= height * 2 &&
      leaf.every((item) => inside(rows[0].rect, item)) &&
      objects.some(
        (object) =>
          object.label === 'table column header' && leaf.every((item) => inside(object.rect, item))
      ) &&
      parents.length === 2 &&
      parents[0].rule[2] < parents[1].rule[0] &&
      Math.abs(parents[0].rule[1] - parents[1].rule[1]) < 1 &&
      leading.every((item) => parents.some((parent) => parent.tokens.includes(item))) &&
      parents.every(
        ({ tokens, columns: covered }, index) =>
          tokens.some((item) => /\p{L}/u.test(item.text)) &&
          tokens.every((item, n) => !n || item.rect[0] - tokens[n - 1].rect[2] <= height * 0.5) &&
          covered.length === 3 &&
          covered.every((column, n) => column === 1 + index * 3 + n) &&
          covered
            .map((column) =>
              leaf
                .filter((item) => columnOf(item) === column)
                .map((item) => item.text)
                .join('')
                .replace(/\s+/g, '')
                .toLowerCase()
            )
            .join('|') === 'oddsratio|95%ci|p-value'
      )
    ) {
      sourceGroupedHeaderSpans = parents
      const split = parents[0].rule[1]
      rows[0].rect[1] = split
      rows.unshift({
        rect: [left, parentRect[1], right, split],
        origin: 'source-detached-parent-header'
      })
      repairs.push('ruled-group-header-recovered')
    }
  }
  // A native header may continue on a short line immediately above the first
  // model row. Recover only a same-column continuation inside a captioned
  // table; a nearby rule or a non-header row keeps the source independent.
  if (!recordGrid && rows.length && externalCaptions.length) {
    const modelHeader = objects.find((object) => object.label === 'table column header')
    const firstRow = rows[0]
    const headerOverlap =
      modelHeader &&
      intersect([left, firstRow.rect[1], right, firstRow.rect[3]], modelHeader.rect) /
        area([left, firstRow.rect[1], right, firstRow.rect[3]])
    if (modelHeader && headerOverlap > 0.5) {
      const lowerHeaderItems = items.filter(
        (item) =>
          item.horizontal &&
          inside(firstRow.rect, item) &&
          columnOf(item) >= 0 &&
          /\p{L}/u.test(item.text)
      )
      const statisticalContinuation = (item) =>
        /(?:post\s+hoc|pairwise|statistical|comparison|p[- ]?value)/iu.test(
          items
            .filter(
              (peer) =>
                peer.horizontal &&
                Math.abs(peer.baseline - item.baseline) <= item.height * 0.35 &&
                Math.abs(peer.rect[1] - item.rect[1]) <= item.height * 0.35 &&
                peer.rect[1] >= item.rect[1] - item.height * 0.2 &&
                peer.rect[3] <= firstRow.rect[1]
            )
            .sort((a, b) => a.rect[0] - b.rect[0])
            .map((peer) => peer.text)
            .join(' ')
        )
      const continuations = items.filter(
        (item) =>
          item.horizontal &&
          item.rect[3] <= firstRow.rect[1] &&
          firstRow.rect[1] - item.rect[3] <= item.height * 2.5 &&
          item.rect[1] >= top &&
          item.rect[0] >= left &&
          item.rect[2] <= right &&
          item.text.trim().length >= 3 &&
          /\p{Ll}/u.test(item.text) &&
          statisticalContinuation(item) &&
          !/[.!?]$/u.test(item.text.trim()) &&
          lowerHeaderItems.some(
            (headerItem) =>
              columnOf(headerItem) === columnOf(item) &&
              Math.abs(headerItem.rect[0] - item.rect[0]) <= item.height * 2
          ) &&
          !rules.some(
            (rule) =>
              rule[1] === rule[3] &&
              rule[1] > item.rect[3] &&
              rule[1] < firstRow.rect[1] &&
              rule[0] <= item.rect[0] &&
              rule[2] >= item.rect[2]
          )
      )
      if (continuations.length) {
        const topmost = Math.min(...continuations.map((item) => item.rect[1]))
        firstRow.rect[1] = topmost
        repairs.push('detached-header-continuation-recovered')
      }
    }
  }
  let sourceHeaderBands
  const modelHeaderBottom = Math.max(
    ...objects.filter((o) => o.label === 'table column header').map((o) => o.rect[3])
  )
  const cohortCuts = [columnRects[0]?.[0], ...columnRects.map((c) => c[2])]
  // A complete native header face tree can refine a recovered body grid too.
  // Retain the body's row objects so existing source spans survive the new
  // header depth. Decline if replacing a predicted header would lose body ink.
  if (
    Number.isFinite(modelHeaderBottom) &&
    externalCaptions.length &&
    !(recordGrid?.completeSpans && recordGrid.headerRows?.length > 1)
  ) {
    const height = Math.max(...items.map((item) => item.height))
    const edges = joinHorizontalTableRules(sourceRules)
      .filter(
        (rule) =>
          rule[1] === rule[3] &&
          rule[0] <= cohortCuts[0] + height &&
          rule[2] >= cohortCuts.at(-1) - height &&
          Math.abs(rule[1] - modelHeaderBottom) <= height * 2
      )
      .sort((a, b) => Math.abs(a[1] - modelHeaderBottom) - Math.abs(b[1] - modelHeaderBottom))
    for (const edge of edges) {
      const source = items.filter(
        (item) => item.horizontal && (item.rect[1] + item.rect[3]) / 2 < edge[1]
      )
      // The detected crop can start just inside a closed native frame. Use
      // its unique nearby top border only when it precedes all header ink
      // and does not cross caption ink; the closed-face proof stays exact.
      const sourceTop = Math.min(...source.map((item) => item.rect[1]))
      const nativeTops = [
        ...new Set(
          joinHorizontalTableRules(sourceRules)
            .filter(
              (rule) =>
                rule[1] === rule[3] &&
                Math.abs(top - rule[1]) < height &&
                rule[1] < sourceTop &&
                rule[0] <= cohortCuts[0] + height &&
                rule[2] >= cohortCuts.at(-1) - height &&
                !externalCaptions.some(
                  (caption) => caption.rect[3] > rule[1] && caption.rect[1] < sourceTop
                )
            )
            .map((rule) => rule[1])
        )
      ]
      const headerTop = nativeTops.length === 1 ? nativeTops[0] : top
      const recovered =
        recoverClosedNativeHeaderBands(source, cohortCuts, sourceRules, headerTop, edge[1]) ??
        recoverSourceHeaderTree(source, cohortCuts, sourceRules, headerTop, edge[1])
      if (!recovered) continue
      const body = rows.filter((row) => (row.rect[1] + row.rect[3]) / 2 > edge[1])
      const bodyItems = items.filter((item) => !source.includes(item))
      if (
        !body.length ||
        body.some((row) => source.some((item) => inside(row.rect, item))) ||
        bodyItems.some((item) => !body.some((row) => inside(row.rect, item)))
      )
        continue
      const previous = [...rows]
      rows.splice(
        0,
        rows.length,
        ...recovered.rows.map((rect) => ({ rect, origin: 'source-header' })),
        ...body
      )
      remapSourceRowSpans(recordGrid, previous, rows)
      sourceHeaderBands = { ...recovered, bottom: edge[1] }
      repairs.push('ruled-group-header-recovered')
      break
    }
  }
  // A native header tree may end in an ink gap instead of a full-width rule.
  // Strict hierarchy/sibling evidence can replace only its header rows, even
  // when the body already has a source grid. Preserve every body token/span.
  if (
    !sourceHeaderBands &&
    Number.isFinite(modelHeaderBottom) &&
    externalCaptions.length &&
    !(recordGrid?.completeSpans && recordGrid.headerRows?.length > 1)
  ) {
    const height = Math.max(
      ...items.filter((item) => item.rect[3] <= modelHeaderBottom).map((item) => item.height)
    )
    // The model can label the first body record as a header. Only nearby
    // physical ink gaps are candidates; the strict tree proves its topology.
    const ends = [...new Set(items.map((item) => item.rect[3]))]
      .filter((end) => Math.abs(end - modelHeaderBottom) <= height * 2)
      .sort((a, b) => Math.abs(a - modelHeaderBottom) - Math.abs(b - modelHeaderBottom))
    for (const end of ends) {
      const source = items.filter(
        (item) => item.horizontal && item.rect[1] >= top && item.rect[3] <= end
      )
      const bodyItems = items.filter((item) => !source.includes(item))
      const upperBottom = Math.max(...source.map((item) => item.rect[3]))
      const lowerTop = Math.min(...bodyItems.map((item) => item.rect[1]))
      if (source.length < 6 || lowerTop <= upperBottom || lowerTop - upperBottom >= height * 3)
        continue
      const bottom = (upperBottom + lowerTop) / 2
      const recovered = recoverSourceHeaderTree(source, cohortCuts, sourceRules, top, bottom)
      const body = rows.filter((row) => (row.rect[1] + row.rect[3]) / 2 > bottom)
      if (
        recovered &&
        body.length >= 2 &&
        !body.some((row) => source.some((item) => inside(row.rect, item))) &&
        bodyItems.every((item) => body.some((row) => inside(row.rect, item)))
      ) {
        const previous = [...rows]
        rows.splice(
          0,
          rows.length,
          ...recovered.rows.map((rect) => ({ rect, origin: 'source-header' })),
          ...body
        )
        remapSourceRowSpans(recordGrid, previous, rows)
        sourceHeaderBands = { ...recovered, bottom }
        repairs.push('ruled-group-header-recovered')
        break
      }
    }
  }
  const cohortHeight = Math.max(
    ...items.filter((i) => i.rect[3] <= modelHeaderBottom).map((i) => i.height)
  )
  const cohortEdges = !recordGrid
    ? sourceRules
        .filter(
          (r) =>
            r[1] === r[3] &&
            Math.abs(r[1] - modelHeaderBottom) < cohortHeight * 1.5 &&
            recoverSegmentedCohortHeaderBands(
              items.filter((i) => i.rect[3] <= r[1]),
              cohortCuts,
              sourceRules,
              top,
              r[1]
            )
        )
        .map((r) => [left, r[1], right, r[1]])
    : []
  if (
    !recordGrid &&
    !sourceHeaderBands &&
    (captions.some((c) => captionKind(c.lines[0]) === 'table') ||
      items.some((i) =>
        /^\(Table\s+\d+\s+continues on (?:the )?next page\)$/i.test(i.text.trim())
      ) ||
      cohortEdges.length)
  ) {
    const modelHeaders = objects.filter((o) => o.label === 'table column header')
    const headerBottom = Math.max(...modelHeaders.map((o) => o.rect[3]))
    const sourceCuts = [columnRects[0]?.[0], ...columnRects.map((c) => c[2])]
    const height = Math.max(...items.filter((i) => i.rect[3] <= headerBottom).map((i) => i.height))
    // Bridge tiny stroke gaps only for a complete, source-proven top/leaf
    // partition. Do not widen the rule tolerance for other header recognizers.
    const splitBorderEdges = joinHorizontalTableRules(sourceRules, height * 0.1).filter(
      (r) =>
        Math.abs(r[1] - headerBottom) < height * 2 &&
        recoverSplitBorderHeaderBands(
          items.filter((i) => i.rect[3] <= r[1]),
          sourceCuts,
          sourceRules,
          top,
          r[1]
        )
    )
    // Use the nearest native header border. A later body-row rule can also
    // lie within the tolerance; treating it as a header bottom absorbs data.
    for (const rule of [...rules, ...splitBorderEdges, ...cohortEdges]
      .filter(
        (r) =>
          r[1] === r[3] &&
          (r[2] - r[0] > (right - left) * 0.9 ||
            // A padded crop can include a neighboring frame. A rule covering
            // every native table glyph still spans the actual table width.
            (items.length && items.every((i) => i.rect[0] >= r[0] && i.rect[2] <= r[2])) ||
            // A blank stub header leaves the native header baseline inset.
            // Accept that edge only under a full-width top border and when
            // every header glyph lies on the ruled side of the empty stub.
            (r[0] <= sourceCuts[1] + height &&
              r[2] >= right - height &&
              items.filter((i) => i.rect[3] <= r[1]).length >= 6 &&
              items
                .filter((i) => i.rect[3] <= r[1])
                .every((i) => i.rect[0] >= r[0] - 1 && i.rect[2] <= r[2] + 1) &&
              rules.some(
                (edge) =>
                  edge[1] === edge[3] &&
                  edge[1] >= top &&
                  edge[1] < Math.min(...items.map((i) => i.rect[1])) &&
                  edge[0] <= left + height &&
                  edge[2] >= right - height
              ))) &&
          Math.abs(r[1] - headerBottom) < height * 2
      )
      .sort((a, b) => Math.abs(a[1] - headerBottom) - Math.abs(b[1] - headerBottom))
      .slice(0, 1)) {
      const source = items.filter((i) => i.rect[3] <= rule[1])
      if (source.length < 6) continue
      // A padded crop may begin inside an already excluded external caption.
      // Do not expand recovered header rows back across that caption: the
      // caller uses row extents to associate its title independently of cells.
      const firstSource = Math.min(...source.map((i) => i.rect[1]))
      const headerTop = Math.max(
        top,
        ...externalCaptions
          .filter(
            (c) =>
              c.rect[1] < top &&
              c.rect[3] > top &&
              c.rect[3] < firstSource &&
              c.rect[0] < right &&
              c.rect[2] > left
          )
          .map((c) => (c.rect[3] + firstSource) / 2)
      )
      const segmented =
        recoverSegmentedCohortHeaderBands(source, sourceCuts, sourceRules, headerTop, rule[1]) ??
        recoverSplitBorderHeaderBands(source, sourceCuts, sourceRules, headerTop, rule[1]) ??
        recoverSegmentedParentBands(source, sourceCuts, sourceRules, headerTop, rule[1])
      const header =
        segmented ?? recoverRuledHeaderBands(source, sourceCuts, sourceRules, headerTop, rule[1])
      const recovered =
        header?.rows.length > 1
          ? header
          : recoverRepeatedHeaderHierarchy(source, sourceCuts, headerTop, rule[1])
      if (!recovered) continue
      const parents = recovered.spans.filter((s) => s.row === 0 && s.colSpan >= 3)
      const wrappedPeer =
        parents.length >= 3 &&
        parents.some((s) => {
          const tokens = source.filter((i) =>
            inside(
              [
                sourceCuts[s.column],
                recovered.rows[0][1],
                sourceCuts[s.column + s.colSpan],
                recovered.rows[0][3]
              ],
              i
            )
          )
          return (
            tokens.length >= 2 &&
            Math.max(...tokens.map((i) => i.baseline)) -
              Math.min(...tokens.map((i) => i.baseline)) >
              height * 0.8
          )
        })
      const splitLeaf =
        header?.rows.length > 1 &&
        sourceCuts.slice(1).some((x, c) => {
          const leaf = source.filter(
            (i) => i.rect[1] > header.rows.at(-1)[1] && i.rect[0] >= sourceCuts[c] && i.rect[2] <= x
          )
          return (
            leaf.length > 1 &&
            new Set(leaf.map((i) => rows.findIndex((r) => inside(r.rect, i)))).size > 1
          )
        })
      const ruledPeers =
        header?.rows.length > 1 &&
        header.spans.filter((s) => {
          if (s.row !== 0 || s.colSpan < 2) return false
          const peers = source.filter(
            (i) =>
              i.rect[0] >= sourceCuts[s.column] &&
              i.rect[2] <= sourceCuts[s.column + s.colSpan] &&
              i.rect[3] <= header.rows[0][3]
          )
          return (
            Math.max(...peers.map((i) => i.baseline)) - Math.min(...peers.map((i) => i.baseline)) >
            height * 2
          )
        }).length >= 2
      // Complete text ownership does not prove the model's parent span.
      // A native root and a full partition of independently underlined child
      // groups establish the hierarchy even when no header text is missing.
      const nestedRuledParent = hasNativeNestedHeader(header, sourceCuts, rules, height)
      // A native parent underline plus separate textual children proves a
      // two-tier span even when the model assigned every glyph to one row.
      const nativeParentGroups = header?.spans.filter((s) => s.row === 0 && s.colSpan >= 2) ?? []
      const pairedCountParents =
        header?.rows.length === 2 &&
        nativeParentGroups.length >= 2 &&
        nativeParentGroups.every((s) => {
          if (s.colSpan !== 2) return false
          const upper = source.filter(
            (i) =>
              i.rect[3] <= header.rows[0][3] &&
              i.rect[0] >= sourceCuts[s.column] &&
              i.rect[2] <= sourceCuts[s.column + 2]
          )
          const text = upper
            .map((i) => i.text)
            .join('')
            .replace(/\s/g, '')
          return (
            /\p{L}{3}/u.test(text) &&
            /\(?n=\d+\)/i.test(text) &&
            [0, 1].every((n) => {
              const label = source
                .filter(
                  (i) =>
                    (i.rect[1] + i.rect[3]) / 2 > header.rows[0][3] &&
                    i.rect[0] >= sourceCuts[s.column + n] &&
                    i.rect[2] <= sourceCuts[s.column + n + 1]
                )
                .map((i) => i.text)
                .join('')
                .trim()
              return n ? label === '%' : /^(?:n|No\.)$/i.test(label)
            })
          )
        })
      const leftAlignedParents =
        header?.rows.length === 2 &&
        nativeParentGroups.length >= 2 &&
        nativeParentGroups.every((s) => {
          const upper = source.filter(
            (i) =>
              i.rect[3] <= header.rows[0][3] &&
              (i.rect[0] + i.rect[2]) / 2 >= sourceCuts[s.column] &&
              (i.rect[0] + i.rect[2]) / 2 < sourceCuts[s.column + s.colSpan]
          )
          return (
            upper.length &&
            rules.some(
              (r) =>
                r[1] === r[3] &&
                Math.abs(r[1] - header.rows[0][3]) < 0.1 &&
                Math.abs(union(upper)[0] - r[0]) < height * 0.6 &&
                upper.every((i) => i.rect[0] >= r[0] - 1 && i.rect[2] <= r[2] + 1)
            )
          )
        })
      const nativeParent =
        header?.rows.length === 2 &&
        header.spans.some((s) => {
          if (s.row !== 0 || s.colSpan < 2) return false
          const upper = source
            .filter(
              (i) =>
                i.rect[3] <= header.rows[0][3] &&
                (i.rect[0] + i.rect[2]) / 2 >= sourceCuts[s.column] &&
                (i.rect[0] + i.rect[2]) / 2 < sourceCuts[s.column + s.colSpan]
            )
            .sort((a, b) => a.rect[0] - b.rect[0])
          if (
            !upper.some((i) => /\p{L}{3}/u.test(i.text)) ||
            upper.some((i, n) => n && i.rect[0] - upper[n - 1].rect[2] > height * 0.8)
          )
            return false
          const underline = rules.find(
            (r) =>
              r[1] === r[3] &&
              Math.abs(r[1] - header.rows[0][3]) < 0.1 &&
              upper.every((i) => i.rect[0] >= r[0] - 1 && i.rect[2] <= r[2] + 1)
          )
          if (
            !underline ||
            (!leftAlignedParents &&
              Math.abs((union(upper)[0] + union(upper)[2] - underline[0] - underline[2]) / 2) >
                height * 0.6)
          )
            return false
          return Array.from({ length: s.colSpan }, (_, n) => s.column + n).every((c) =>
            source.some(
              (i) =>
                (i.rect[1] + i.rect[3]) / 2 > header.rows[0][3] &&
                i.rect[0] >= sourceCuts[c] &&
                i.rect[2] <= sourceCuts[c + 1] &&
                (/\p{L}/u.test(i.text) || (pairedCountParents && i.text.trim() === '%'))
            )
          )
        })
      if (
        !source.some((i) => !rows.some((r) => inside(r.rect, i))) &&
        !wrappedPeer &&
        !splitLeaf &&
        !ruledPeers &&
        !nestedRuledParent &&
        !segmented &&
        !nativeParent &&
        !pairedCountParents
      )
        continue
      const body = rows.filter((r) => (r.rect[1] + r.rect[3]) / 2 > rule[1])
      if (
        !body.length ||
        body.some((r) => source.some((i) => inside(r.rect, i))) ||
        items.some(
          (i) =>
            i.rect[1] > rule[1] &&
            rows.some((r) => !body.includes(r) && inside(r.rect, i)) &&
            !body.some((r) => inside(r.rect, i))
        )
      )
        continue
      sourceHeaderBands = { ...recovered, bottom: rule[1] }
      rows.splice(
        0,
        rows.length,
        ...recovered.rows.map((rect) => ({ rect, origin: 'source-header' })),
        ...body
      )
      break
    }
  }
  // An unframed table can still have a fully underlined header tree. Repeated
  // sample-qualified parents and identical leaf roles delimit that tree;
  // a clear native gap separates it from the first body record.
  if (!recordGrid && !sourceHeaderBands && externalCaptions.length) {
    const headerBottom = Math.max(
      ...objects.filter((o) => o.label === 'table column header').map((o) => o.rect[3])
    )
    const source = items.filter(
      (i) => i.horizontal && i.rect[1] >= top && i.rect[3] <= headerBottom
    )
    const bodySource = items.filter((i) => i.horizontal && i.rect[3] > headerBottom)
    const upperBottom = Math.max(...source.map((i) => i.rect[3]))
    const lowerTop = Math.min(...bodySource.map((i) => i.rect[1]))
    const height = Math.max(...source.map((i) => i.height))
    if (
      source.length >= 6 &&
      bodySource.length &&
      lowerTop > upperBottom &&
      lowerTop - upperBottom < height * 3
    ) {
      const bottom = (upperBottom + lowerTop) / 2
      const sourceCuts = [columnRects[0][0], ...columnRects.map((c) => c[2])]
      // The detector's padding can overlap the preceding caption. A native
      // top border before every header glyph owns the crop's upper edge.
      const headerTop = Math.max(
        top,
        ...sourceRules
          .filter(
            (r) =>
              r[1] === r[3] &&
              r[1] >= top &&
              r[1] < Math.min(...source.map((i) => i.rect[1])) &&
              r[0] <= left + height &&
              r[2] >= right - height
          )
          .map((r) => r[1])
      )
      const recovered = recoverRuledHeaderBands(source, sourceCuts, sourceRules, headerTop, bottom)
      const parents = recovered?.spans.filter((s) => s.row === 0 && s.colSpan >= 2) ?? []
      const cohorts = parents.filter((s) =>
        /\(n=\d+\)/i.test(
          source
            .filter(
              (i) =>
                i.rect[3] <= recovered.rows[0][3] &&
                i.rect[0] >= sourceCuts[s.column] &&
                i.rect[2] <= sourceCuts[s.column + s.colSpan]
            )
            .map((i) => i.text)
            .join('')
            .replace(/\s/g, '')
        )
      )
      const leaves = cohorts.map((s) =>
        readSourceRow(
          source.filter(
            (i) =>
              i.rect[1] >= recovered.rows[0][3] - height * 0.05 &&
              i.rect[0] >= sourceCuts[s.column] &&
              i.rect[2] <= sourceCuts[s.column + s.colSpan]
          ),
          sourceCuts
        )
      )
      const roles = leaves.map((v, n) =>
        v?.slice(cohorts[n].column, cohorts[n].column + cohorts[n].colSpan)
      )
      const body = rows.filter((r) => (r.rect[1] + r.rect[3]) / 2 > bottom)
      if (
        recovered?.rows.length >= 3 &&
        cohorts.length >= 2 &&
        roles.every(
          (v) => v?.every((s) => /\p{L}/u.test(s)) && JSON.stringify(v) === JSON.stringify(roles[0])
        ) &&
        body.length >= 2 &&
        !body.some((r) => source.some((i) => inside(r.rect, i))) &&
        (source.some((i) => !rows.some((r) => inside(r.rect, i))) ||
          (hasNativeNestedHeader(recovered, sourceCuts, sourceRules, height) &&
            sourceRules.some(
              (r) =>
                r[1] === r[3] &&
                r[1] >= top &&
                r[1] < Math.min(...source.map((i) => i.rect[1])) &&
                r[0] <= left + height &&
                r[2] >= right - height
            )))
      ) {
        sourceHeaderBands = { ...recovered, bottom }
        rows.splice(
          0,
          rows.length,
          ...recovered.rows.map((rect) => ({ rect, origin: 'source-header' })),
          ...body
        )
        repairs.push('ruled-group-header-recovered')
      }
    }
  }
  if (!recordGrid && !sourceHeaderBands)
    coalesceSampleSizeHeader({
      rows,
      items,
      columnRects,
      headers: objects.filter((o) => o.label === 'table column header'),
      rules,
      repairs
    })
  const baseCells = rows.flatMap((r, row) =>
    columnRects.map((c, column) => ({
      row,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect: [
        row === 0 && recoveredHeaderCuts && column ? recoveredHeaderCuts[column - 1] : c[0],
        row === 0 && stackedHeaderCellRect && column === columnOf(groups[0][0])
          ? stackedHeaderCellRect[1]
          : r.rect[1],
        row === 0 && recoveredHeaderCuts && column < cuts.length
          ? recoveredHeaderCuts[column]
          : c[2],
        r.rect[3]
      ],
      origin: 'model-grid'
    }))
  )
  const unresolvedSpans = []
  const proposals = []
  // Statistical parent headers are sometimes emitted as one source token
  // while the model leaves the child columns as separate empty cells. Require
  // a first-row table header, explicit mixed-model wording, and a matching
  // detector spanning cell before restoring the parent span.
  const statisticalParent = items.find(
    (item) =>
      item.horizontal && /^linear\s+mixed\s+model\s+statistical\s+tests$/iu.test(item.text.trim())
  )
  if (statisticalParent && rows[0]) {
    const row = rows.findIndex(
      (candidate) =>
        intersect(candidate.rect, statisticalParent.rect) / area(statisticalParent.rect) > 0.5
    )
    const start =
      row >= 0
        ? columnRects.findIndex(
            (column) =>
              statisticalParent.rect[0] >= column[0] && statisticalParent.rect[0] < column[2]
          )
        : -1
    const detectorSpan =
      row === 0 &&
      start >= 0 &&
      objects
        .filter((object) => object.label === 'table spanning cell')
        .map((object) => ({
          object,
          slots: baseCells.filter(
            (cell) => cell.row === row && intersect(cell.rect, object.rect) / area(cell.rect) > 0.2
          )
        }))
        .filter(
          ({ object, slots }) =>
            slots.length >= 4 &&
            object.rect[0] <= statisticalParent.rect[0] + statisticalParent.height &&
            object.rect[2] >= statisticalParent.rect[2] - statisticalParent.height
        )
        .sort((a, b) => b.slots.length - a.slots.length)[0]
    if (detectorSpan && detectorSpan.slots.every((cell) => cell.column >= start)) {
      removeOverlappingMergeProposals(proposals, detectorSpan.slots)
      proposals.push({
        slots: detectorSpan.slots,
        origin: 'source-ruled-stub',
        joinedLabel: true
      })
      repairs.push('statistical-parent-header-recovered')
    }
  }
  // A statistical section title can cross the stub and comparison columns
  // while the same row already owns numeric model statistics on the right.
  // Recover only long, descriptive section labels with several populated
  // numeric columns, leaving ordinary wrapped records untouched.
  for (const item of items.filter(
    (candidate) =>
      candidate.horizontal &&
      candidate.text.trim().length >= 18 &&
      /(?:well-being|subscale|score)/iu.test(candidate.text)
  )) {
    let row = rows.findIndex(
      (candidate) => intersect(candidate.rect, item.rect) / area(item.rect) > 0.5
    )
    if (row <= 0) continue
    const currentStubCell = baseCells.find((cell) => cell.row === row && cell.column === 0)
    const currentStub =
      currentStubCell &&
      items.some(
        (source) =>
          inside(currentStubCell.rect, source) &&
          source.baseline < item.baseline - item.height * 1.5 &&
          /\p{L}/u.test(source.text)
      )
    const nextRow = rows[row + 1]
    const nextContinuationCount = nextRow
      ? baseCells
          .filter((cell) => cell.row === row + 1 && cell.column > 0)
          .filter((cell) =>
            items.some(
              (source) =>
                inside(cell.rect, source) &&
                Math.abs(source.baseline - item.baseline) <= item.height * 1.6 &&
                /^\([^)]*\)$/.test(source.text.trim())
            )
          ).length
      : 0
    if (currentStub && nextContinuationCount >= 2) row += 1
    const valueStart = baseCells
      .filter((cell) => cell.row === row && cell.column > 0)
      .find((cell) =>
        items
          .filter(
            (source) =>
              inside(cell.rect, source) &&
              Math.abs(source.baseline - item.baseline) <= item.height * 1.6
          )
          .some((source) =>
            /^(?:[<>≤≥−+-]?\d[\d.,]*(?:\s*\([^)]*\))?|\(\d[^)]*\))$/.test(source.text.trim())
          )
      )?.column
    if (valueStart === undefined || valueStart < 3) continue
    const slots = baseCells.filter((cell) => cell.row === row && cell.column < valueStart)
    if (slots.length < 3 || !slots.some((slot) => intersect(slot.rect, item.rect) > 0)) continue
    const numericCount = baseCells
      .filter((cell) => cell.row === row && cell.column >= valueStart)
      .filter((cell) =>
        items
          .filter(
            (source) =>
              inside(cell.rect, source) &&
              Math.abs(source.baseline - item.baseline) <= item.height * 1.6
          )
          .some((source) => /\d/.test(source.text))
      ).length
    if (numericCount < 3) continue
    removeOverlappingMergeProposals(proposals, slots)
    proposals.push({ slots, origin: 'source-section', sectionHeader: true })
    repairs.push('statistical-section-span-recovered')
  }
  for (const group of sourceGroupedHeaderSpans ?? []) {
    const slots = baseCells.filter((cell) => cell.row === 0 && group.columns.includes(cell.column))
    if (slots.length === 3)
      proposals.push({ slots, origin: 'text-supported-header-span', joinedLabel: true })
  }
  if (compactCountHeaderStarts) {
    for (const start of compactCountHeaderStarts) {
      const slots = baseCells.filter(
        (cell) => cell.row === 0 && cell.column >= start && cell.column < start + 2
      )
      if (slots.length === 2) {
        removeOverlappingMergeProposals(proposals, slots)
        proposals.push({ slots, origin: 'source-ruled-stub' })
      }
    }
  }
  // A count-section label can extend into empty data columns while its
  // P value remains in the final column. Repeated same-table count headings
  // establish that the trailing N (%) belongs to the label, not a value.
  if (
    !recordGrid &&
    columns.length >= 4 &&
    groups.filter((g) =>
      /^[\p{L} ,‐-]+, N \(%\)$/u.test(
        g
          .filter((i) => columnOf(i) < columns.length - 1)
          .map((i) => i.text)
          .join(' ')
      )
    ).length >= 3
  ) {
    for (let row = 1; row < rows.length - 1; row++) {
      const slots = baseCells.filter((c) => c.row === row && c.column < columns.length - 1)
      const source = items
        .filter((i) => inside(union(slots), i))
        .sort((a, b) => a.rect[0] - b.rect[0])
      const value = items.filter((i) =>
        inside(baseCells.find((c) => c.row === row && c.column === columns.length - 1).rect, i)
      )
      if (
        source.length >= 2 &&
        /^[\p{L} ,‐-]+, N \(%\)$/u.test(source.map((i) => i.text).join(' ')) &&
        source.every(
          (i, n) =>
            !n ||
            (Math.abs(i.baseline - source[0].baseline) < i.height * 0.2 &&
              i.rect[0] - source[n - 1].rect[2] < i.height)
        ) &&
        value.length === 1 &&
        /^0?\.\d+$/.test(value[0].text) &&
        source.some((i) => columnOf(i) > 0)
      )
        proposals.push({ slots, origin: 'source-section' })
    }
  }
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
    if (
      compactCountHeaderStarts?.some((start) =>
        slots.some((cell) => cell.row === 0 && cell.column >= start && cell.column < start + 2)
      )
    )
      continue
    const spanSource = items.filter(
      (item) => intersect(item.rect, span.rect) / area(item.rect) > 0.5
    )
    // A numeric category followed by a value in every data column is a
    // complete record, even if the detector labels its row as a section.
    if (
      span.label === 'table projected row header' &&
      slots.length === columns.length &&
      new Set(slots.map((cell) => cell.row)).size === 1
    ) {
      const values = slots.map((cell) =>
        items
          .filter((i) => inside(cell.rect, i))
          .map((i) => i.text)
          .join(' ')
      )
      if (values.every((value) => /^[<>≤≥−+-]?\d[\d\s.,()%–−±/+-]*$/.test(value))) continue
    }
    // A source-recovered section already owns this projected header's text.
    // Keep predictions crossing another source row subject to normal validation.
    if (
      span.label === 'table projected row header' &&
      spanSource.length &&
      rows.some((row) => row.section && spanSource.every((item) => inside(row.rect, item)))
    )
      continue
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
        unresolvedSpans.push(span)
      continue
    }
    // A low-confidence model span can absorb one source value together with
    // empty neighboring slots in a sparse record. Keep true section headings,
    // but let source ownership restore the value to its single column when the
    // same row has another populated cell.
    const spanRows = new Set(slots.map((slot) => slot.row))
    if (spanRows.size === 1 && spanSource.length) {
      const row = [...spanRows][0]
      const sourceCell = baseCells.filter(
        (cell) => cell.row === row && spanSource.every((item) => columnOf(item) === cell.column)
      )
      const otherSource = items.some(
        (item) =>
          item.horizontal &&
          inside(rows[row].rect, item) &&
          !spanSource.includes(item) &&
          !sourceCell.some((cell) => inside(cell.rect, item))
      )
      if (
        row > 1 &&
        sourceCell.length === 1 &&
        otherSource &&
        spanSource.every((item) => columnOf(item) === sourceCell[0].column)
      ) {
        repairs.push('source-cell-span-discarded')
        continue
      }
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
  const headerRows = sourceHeaderBands
    ? sourceHeaderBands.rows.map((_, n) => n)
    : recordGrid?.headerRows
      ? [...recordGrid.headerRows]
      : rows.flatMap((r, i) =>
          recordGrid?.headerRows?.includes(i) ||
          r.origin === 'source-native-header' ||
          r.origin === 'source-statistic-header' ||
          r.origin === 'source-underlined-parent' ||
          r.origin === 'small-caps-header' ||
          r.origin === 'source-repeated-header' ||
          r.origin === 'source-ruled-interval-header' ||
          r.origin === 'source-detached-parent-header' ||
          headers.some(
            (h) =>
              intersect([left, r.rect[1], right, r.rect[3]], h.rect) /
                area([left, r.rect[1], right, r.rect[3]]) >
              0.5
          )
            ? [i]
            : []
        )
  // A native event-count title over two repeated arm/sample-size labels
  // establishes both header tiers even when no model header is present.
  if (!recordGrid && !headerRows.length && rows[1]) {
    const parents = items.filter(
      (i) => inside(rows[0].rect, i) && /^Number of (?:events|patients)$/.test(i.text.trim())
    )
    const children = items.filter(
      (i) => inside(rows[1].rect, i) && /^[A-Z][A-Za-z]* \d+ years \(n?$/.test(i.text.trim())
    )
    if (
      parents.length === 1 &&
      children.length === 2 &&
      children[0].text.replace(/\d+/, '') === children[1].text.replace(/\d+/, '') &&
      children.every((i) => Math.abs(i.baseline - children[0].baseline) < 1) &&
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[1] > parents[0].rect[3] &&
          r[1] < children[0].rect[1] &&
          r[0] <= children[0].rect[0] &&
          r[2] >= children[1].rect[2]
      )
    )
      headerRows.push(0, 1)
  }
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
        if (source.length !== 1 || !/^[a-zA-Z\d*†‡]$/.test(source[0].text)) continue
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
      // A native parent underline defines its children more precisely than
      // proximity to the parent text. In particular, the left stub must not
      // become a child of the first treatment group just because it is nearest.
      const underline = sourceRules.find(
        (r) =>
          r[1] === r[3] &&
          r[1] >= run.rect[3] &&
          r[1] < (rows[row + 1]?.rect[3] ?? 0) &&
          r[0] <= run.rect[0] &&
          r[2] >= run.rect[2] &&
          r[2] - r[0] < (right - left) * 0.8 &&
          runs.filter((other) => center(other) > r[0] && center(other) < r[2]).length === 1
      )
      let columnsForRun = childGroups
        .filter((columns) => {
          if (underline) {
            const children =
              headerRuns
                .get(row + 1)
                ?.filter((child) =>
                  columns.some(
                    (column) =>
                      center(child) >= columnRects[column][0] &&
                      center(child) <= columnRects[column][2]
                  )
                ) ?? []
            return (
              children.length > 0 &&
              children.every(
                (child) => child.rect[0] >= underline[0] - 1 && child.rect[2] <= underline[2] + 1
              )
            )
          }
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
        (!underline &&
          slots.filter((c) => intersect(c.rect, run.rect) / area(run.rect) > 0.05).length < 2) ||
        Math.abs(center(run) - center({ rect })) > (rect[2] - rect[0]) * 0.25 ||
        runs.some(
          (other) =>
            other !== run &&
            intersect(rect, other.rect) > 0 &&
            !(
              items.some(
                (i) => inside(run.rect, i) && /^Number of (?:events|patients)$/.test(i.text.trim())
              ) &&
              intersect(rect, other.rect) / area(other.rect) < 0.1 &&
              center(other) < rect[0]
            )
        )
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
  // A boxed questionnaire prompt precedes its actual column headings. The
  // enclosing native rules establish one full-width cell across the first row.
  if (!recordGrid && columns.length >= 3 && rows.length >= 3 && externalCaptions.length) {
    const prompt = groups.find(
      (g) =>
        g.length === 1 &&
        /\?$/.test(g[0].text.trim()) &&
        g[0].rect[2] - g[0].rect[0] > (right - left) * 0.7 &&
        g[0].rect[1] >= top &&
        g[0].rect[3] < rows[1].rect[1]
    )
    if (prompt) {
      const rect = union(prompt)
      const borders = rules.filter((r) => r[1] === r[3] && r[0] <= left + 8 && r[2] >= right - 8)
      if (
        borders.some((r) => r[1] <= rect[1] && rect[1] - r[1] < prompt[0].height) &&
        borders.some((r) => r[1] >= rect[3] && r[1] < rows[1].rect[1])
      ) {
        const slots = baseCells.filter((c) => c.row === 0)
        removeOverlappingMergeProposals(proposals, slots)
        proposals.push({ slots, origin: 'source-ruled-stub' })
      }
    }
  }
  if (!recordGrid && externalCaptions.length) {
    // Native treatment underlines retain both halves of a frequency/% header,
    // even when a sample-size suffix lands in the second predicted column.
    if (
      columns.length === 6 &&
      baseCells.some(
        (c) =>
          c.row === 1 &&
          c.column === 1 &&
          items.some((i) => inside(c.rect, i) && i.text === 'frequency')
      )
    ) {
      const parents = rules.filter(
        (r) =>
          r[1] === r[3] &&
          r[1] > rows[0].rect[1] &&
          r[1] < rows[1].rect[1] &&
          r[0] > columnRects[0][2] - 16
      )
      for (const rule of parents) {
        const slots = baseCells.filter(
          (c) =>
            c.row === 0 &&
            (c.rect[0] + c.rect[2]) / 2 > rule[0] &&
            (c.rect[0] + c.rect[2]) / 2 < rule[2]
        )
        const tokens = items.filter(
          (i) =>
            i.rect[1] >= rows[0].rect[1] &&
            i.rect[3] < rule[1] &&
            i.rect[0] >= rule[0] - 1 &&
            i.rect[2] <= rule[2] + 1
        )
        if (
          slots.length === 2 &&
          /\(n=\d+\)/i.test(
            tokens
              .map((i) => i.text)
              .join('')
              .replace(/\s/g, '')
          )
        ) {
          removeOverlappingMergeProposals(proposals, slots)
          proposals.push({ slots, origin: 'source-ruled-stub' })
        }
      }
    }
    // Repeated change columns establish paired treatment parents above them.
    if (
      columns.length === 5 &&
      [2, 4].every((c) =>
        baseCells.some(
          (b) =>
            b.row === 1 &&
            b.column === c &&
            items
              .filter((i) => inside(b.rect, i))
              .map((i) => i.text)
              .join('')
              .replace(/\s/g, '') === 'ChangefromBaseline'
        )
      )
    ) {
      for (const c of [1, 3]) {
        const slots = baseCells.filter((b) => b.row === 0 && (b.column === c || b.column === c + 1))
        if (
          slots.length === 2 &&
          items.some((i) => inside(slots[0].rect, i) && /\p{L}/u.test(i.text)) &&
          !items.some((i) => inside(slots[1].rect, i))
        ) {
          removeOverlappingMergeProposals(proposals, slots)
          proposals.push({ slots, origin: 'source-ruled-stub' })
        }
      }
    }
    // An internal count/percentage heading starts a new section. An age label
    // above it must not span that later header's empty stub.
    if (columns.length === 3)
      for (let r = 1; r < rows.length; r++) {
        const heading = [1, 2].map((c) =>
          items
            .filter((i) => inside(baseCells.find((b) => b.row === r && b.column === c).rect, i))
            .map((i) => i.text)
            .join('')
            .trim()
        )
        if (heading.join('|') === 'n|%') {
          const slots = baseCells.filter((c) => c.column === 0 && (c.row === r - 1 || c.row === r))
          removeOverlappingMergeProposals(proposals, slots)
        }
      }
  }
  // Repeated N/value leaves establish a timepoint pair even when its title
  // is left-aligned over N instead of centered. Require consecutive numbered
  // timepoints, adjacent leaf columns, and no text in the second parent slot.
  if (rows.length >= 3 && headerRows.includes(0) && headerRows.includes(1)) {
    const textAt = (row, column) =>
      items
        .filter((i) => {
          const cell = baseCells.find((c) => c.row === row && c.column === column)
          return cell && inside(cell.rect, i)
        })
        .map((i) => i.text)
        .join(' ')
        .trim()
    const pairs = []
    for (let c = 1; c < columns.length - 1; c++) {
      const parent = /^T\s*(\d+)$/i.exec(textAt(0, c))
      if (
        parent &&
        /^n$/i.test(textAt(1, c)) &&
        /^(?:Value,?\s*)?mean\s*\(SD\)$/i.test(textAt(1, c + 1)) &&
        !textAt(0, c + 1)
      )
        pairs.push({ column: c, number: Number(parent[1]) })
    }
    if (
      pairs.length >= 3 &&
      pairs.every(
        (p, n) =>
          !n || (p.column === pairs[n - 1].column + 2 && p.number === pairs[n - 1].number + 1)
      )
    ) {
      for (const pair of pairs) {
        const slots = baseCells.filter(
          (c) => c.row === 0 && c.column >= pair.column && c.column <= pair.column + 1
        )
        removeOverlappingMergeProposals(proposals, slots)
        proposals.push({ slots, origin: 'source-ruled-stub' })
      }
      repairs.push('header-span-inferred')
    }
  }
  if (parentRowSpans) applySourceHeaderSpans(proposals, baseCells, parentRowSpans, 2)
  if (ruledTierSpans) applySourceHeaderSpans(proposals, baseCells, ruledTierSpans, 3)
  if (nativeParentSpans) applySourceHeaderSpans(proposals, baseCells, nativeParentSpans, 2)
  if (detachedParentSpan) {
    const slots = baseCells.filter(
      (cell) =>
        cell.row === detachedParentSpan.row &&
        cell.column >= detachedParentSpan.column &&
        cell.column < detachedParentSpan.column + detachedParentSpan.colSpan
    )
    if (slots.length === detachedParentSpan.colSpan)
      proposals.push({ slots, origin: 'source-detached-parent-header' })
  }
  if (recoveredGroupColumns) {
    const slots = baseCells.filter((c) => c.row === 0 && recoveredGroupColumns.includes(c.column))
    removeOverlappingMergeProposals(proposals, slots)
    proposals.push({ slots, origin: 'text-supported-header-span' })
  }
  if (clippedWrappedHeader) {
    const slots = baseCells.filter(
      (c) =>
        c.column === clippedWrappedHeader.column &&
        (c.rect[1] + c.rect[3]) / 2 >= clippedWrappedHeader.rect[1] &&
        (c.rect[1] + c.rect[3]) / 2 <= clippedWrappedHeader.rect[3]
    )
    if (slots.length === 2) {
      removeOverlappingMergeProposals(proposals, slots)
      proposals.push({ slots, origin: 'source-ruled-stub', joinedLabel: true })
    }
  }
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
  // A multi-tier header may be represented by a source word, a native
  // underline, and a low-confidence model spanning-cell box. Require all
  // three pieces plus populated child headings before recovering the parent.
  // This keeps ordinary underlined labels and fixture grids untouched.
  for (const row of headerRows) {
    if (recordGrid) continue
    const childRow = rows[row + 1]
    if (!childRow) continue
    for (const item of items.filter(
      (candidate) =>
        candidate.horizontal &&
        (inside(rows[row].rect, candidate) ||
          (row === headerRows[0] &&
            candidate.rect[3] <= rows[row].rect[1] + candidate.height * 0.2 &&
            candidate.rect[3] >= rows[row].rect[1] - candidate.height * 4)) &&
        /\p{L}/u.test(candidate.text) &&
        objects.some(
          (object) =>
            object.label === 'table spanning cell' &&
            intersect(object.rect, candidate.rect) / area(candidate.rect) > 0.1
        )
    )) {
      const underline = rules
        .filter(
          (rule) =>
            rule[1] === rule[3] &&
            rule[1] >= item.rect[3] - 1 &&
            rule[1] <= rows[row].rect[3] + item.height &&
            rule[0] <= item.rect[0] + item.height &&
            rule[2] >= item.rect[2] - item.height &&
            rule[2] - rule[0] < (right - left) * 0.8
        )
        .sort((a, b) => Math.abs(a[1] - item.rect[3]) - Math.abs(b[1] - item.rect[3]))[0]
      if (!underline) continue
      const slots = baseCells.filter(
        (cell) => cell.row === row && cell.rect[2] > underline[0] && cell.rect[0] < underline[2]
      )
      const childSlots = baseCells.filter(
        (cell) => cell.row === row + 1 && cell.rect[2] > underline[0] && cell.rect[0] < underline[2]
      )
      const childItems = items.filter(
        (candidate) =>
          inside(childRow.rect, candidate) &&
          candidate.rect[2] > underline[0] &&
          candidate.rect[0] < underline[2] &&
          /\p{L}/u.test(candidate.text)
      )
      if (slots.length < 2 || childSlots.length < 2 || childItems.length < 2) continue
      const spanWidth = underline[2] - underline[0]
      const modelSpan = objects.find(
        (object) =>
          object.label === 'table spanning cell' &&
          intersect(object.rect, item.rect) / area(item.rect) > 0.1 &&
          object.rect[2] - object.rect[0] >= spanWidth * 0.55
      )
      if (!modelSpan) continue
      const span = union(slots)
      if (
        Math.abs((item.rect[0] + item.rect[2]) / 2 - (span[0] + span[2]) / 2) >
        (span[2] - span[0]) * 0.35
      )
        continue
      removeOverlappingMergeProposals(proposals, slots, headerRows)
      proposals.push({ slots, origin: 'text-supported-header-span' })
    }
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
  // A wide schedule can place a prose note across several empty model columns.
  // Treat it as a source-backed spanning cell only when the text is wholly
  // inside one source row, the covered slots contain no other source text, and
  // the row has an adjacent stub/header anchor. This avoids pulling crop-edge
  // prose or footnotes into the table merely because they cross column bounds.
  for (const item of items.filter(
    (i) =>
      i.horizontal &&
      i.text.trim().length >= 45 &&
      i.rect[0] >= left &&
      i.rect[2] <= right &&
      i.rect[1] >= top &&
      i.rect[3] <= bottom
  )) {
    const wideTokens = item.text.trim().split(/\s+/u)
    const numericWideRun =
      wideTokens.length >= 8 &&
      wideTokens.filter((token) => /^[<>≤≥−+-]?\d+(?:[.,]\d+)?%?$/.test(token)).length >= 8 &&
      wideTokens.slice(1).every((token) => /^[<>≤≥−+-]?\d+(?:[.,]\d+)?%?$/.test(token))
    if (numericWideRun && columns.length >= 8) continue
    const row = rows.findIndex(
      (candidate) =>
        item.rect[1] >= candidate.rect[1] - item.height * 0.25 &&
        item.rect[3] <= candidate.rect[3] + item.height * 0.25
    )
    if (row < 0) continue
    const slots = baseCells.filter(
      (cell) => cell.row === row && intersect(cell.rect, item.rect) / area(item.rect) > 0.01
    )
    if (slots.length < 2) continue
    const unionRect = union(slots)
    const rowItems = items.filter(
      (candidate) =>
        candidate !== item &&
        candidate.horizontal &&
        intersect(unionRect, candidate.rect) / area(candidate.rect) > 0.5
    )
    if (rowItems.length) continue
    const hasAnchor =
      row === 0 ||
      items.some(
        (candidate) =>
          candidate !== item &&
          candidate.horizontal &&
          candidate.rect[2] <= slots[0].rect[0] + 1 &&
          candidate.baseline >= rows[row].rect[1] - candidate.height * 0.25 &&
          candidate.rect[3] <= rows[row].rect[3] + candidate.height * 0.25 &&
          columnOf(candidate) === 0 &&
          /\p{L}/u.test(candidate.text)
      )
    if (!hasAnchor) continue
    if (proposals.some((proposal) => proposal.slots.some((slot) => slots.includes(slot)))) continue
    proposals.push({ slots, origin: 'source-wide-text-span' })
    repairs.push('source-wide-text-span-recovered')
  }
  // Section headings in long native tables are often emitted as one wide text
  // run. The run starts inside the stub, crosses several model columns, and
  // shares its baseline with P-value/footnote fragments. Those fragments can
  // leave every individual overlap below the normal ownership threshold. A
  // full-row source span is safe when the stub margin, heading punctuation,
  // same-baseline fragments, and a following numeric record agree.
  for (const item of items.filter(
    (candidate) =>
      candidate.horizontal &&
      candidate.text.trim().length >= 20 &&
      columnRects.length > 0 &&
      candidate.rect[0] <= columnRects[0][0] + (columnRects[0][2] - columnRects[0][0]) * 0.15 &&
      candidate.rect[2] > columnRects[0][2] + candidate.height &&
      /^\p{Lu}[\p{L}\s,'’–—-]+\(/u.test(candidate.text.trim()) &&
      !/[.!?]$/u.test(candidate.text.trim())
  )) {
    const row = rows
      .map((candidate, index) => ({
        candidate,
        index,
        overlap: intersect(candidate.rect, item.rect)
      }))
      .filter(({ overlap }) => overlap > 0)
      .sort((a, b) => b.overlap - a.overlap)[0]
    if (!row || headerRows.includes(row.index)) {
      continue
    }
    const height = item.height
    const sameBaseline = items.filter(
      (candidate) =>
        candidate !== item &&
        Math.abs(candidate.baseline - item.baseline) <= height * 0.35 &&
        intersect(rows[row.index].rect, candidate.rect) > 0
    )
    const statFragment = (text) => /^(?:P|=\s*[.]?\d+(?:[a-z]\)?)?|[();,a-z])$/iu.test(text.trim())
    // An inline footnote can split the qualifier from its parenthesized
    // heading. Its semicolon and the explicit following P expression keep
    // it distinct from a populated value in a neighboring column.
    const qualifiedStatistic =
      sameBaseline.some((candidate) => candidate.text.trim() === 'P') &&
      sameBaseline.some((candidate) => /^=\s*[.]?\d/.test(candidate.text.trim()))
    const summaryQualifier = /^,?(?:Mean±SD|Median\(IQR\))$/i.test(
      sameBaseline
        .slice()
        .sort((a, b) => a.rect[0] - b.rect[0])
        .map((i) => i.text)
        .join('')
        .replace(/\s/g, '')
    )
    if (
      sameBaseline.some(
        (candidate) =>
          !statFragment(candidate.text) &&
          !summaryQualifier &&
          !(qualifiedStatistic && /^[\p{L} -]+;$/u.test(candidate.text.trim()))
      )
    ) {
      continue
    }
    const next = rows
      .slice(row.index + 1)
      .find(
        (candidate) =>
          items.filter((source) => inside(candidate.rect, source) && /\d/.test(source.text))
            .length >= 2
      )
    if (!next) {
      continue
    }
    const slots = baseCells.filter((cell) => cell.row === row.index)
    if (slots.length !== columns.length) continue
    removeOverlappingMergeProposals(proposals, slots)
    if (proposals.some((proposal) => proposal.slots.some((slot) => slots.includes(slot)))) continue
    proposals.unshift({ slots, origin: 'source-section', sectionHeader: true })
    repairs.push('source-wide-section-span-recovered')
  }
  // Section labels in long ruled tables can cross the stub boundary while a
  // model row contains only a footnote marker. A closing rule and populated
  // numeric rows below establish a full-width section row without treating
  // ordinary row labels as merged cells.
  for (const item of items.filter(
    (candidate) =>
      candidate.horizontal &&
      candidate.text.trim().length >= 12 &&
      columnRects.length > 0 &&
      candidate.rect[0] <= columnRects[0][2] + candidate.height &&
      candidate.rect[2] > columnRects[0][2] + candidate.height
  )) {
    const row = rows.findIndex((candidate) => inside(candidate.rect, item))
    if (row < 0 || headerRows.includes(row)) continue
    const rowItems = items.filter((candidate) => inside(rows[row].rect, candidate))
    if (rowItems.some((candidate) => candidate !== item && /\d/.test(candidate.text))) continue
    const next = rows[row + 1]
    if (!next) continue
    const nextItems = items.filter((candidate) => inside(next.rect, candidate))
    if (nextItems.filter((candidate) => /\d/.test(candidate.text)).length < 2) continue
    if (
      !rules.some(
        (rule) =>
          rule[1] === rule[3] &&
          rule[1] >= item.rect[3] &&
          rule[1] <= next.rect[1] + item.height &&
          rules
            .filter(
              (candidate) => candidate[1] === candidate[3] && Math.abs(candidate[1] - rule[1]) < 1
            )
            .reduce(
              (width, candidate) =>
                width + Math.max(0, Math.min(right, candidate[2]) - Math.max(left, candidate[0])),
              0
            ) >=
            (right - left) * 0.9
      )
    )
      continue
    const slots = baseCells.filter((cell) => cell.row === row)
    if (
      slots.length !== columns.length ||
      proposals.some((proposal) => proposal.slots.some((slot) => slots.includes(slot)))
    )
      continue
    proposals.push({ slots, origin: 'source-section' })
    repairs.push('source-section-span-recovered')
  }
  if (clippedHeader?.spans?.length && !sourceHeaderBands) {
    for (const span of clippedHeader.spans) {
      const slots = baseCells.filter((c) => intersect(c.rect, span) / area(c.rect) > 0.5)
      if (slots.length < 2 || !slots.every((c) => headerRows.includes(c.row))) continue
      for (let n = proposals.length - 1; n >= 0; n--)
        if (proposals[n].slots.some((c) => slots.includes(c))) proposals.splice(n, 1)
      proposals.push({ slots, origin: 'source-ruled-stub' })
    }
  }
  if (sourceHeaderBands) {
    for (let n = proposals.length - 1; n >= 0; n--)
      if (proposals[n].slots.some((c) => headerRows.includes(c.row))) proposals.splice(n, 1)
    for (const span of sourceHeaderBands.spans)
      proposals.push({
        slots: baseCells.filter(
          (c) =>
            c.row >= span.row &&
            c.row < span.row + span.rowSpan &&
            c.column >= span.column &&
            c.column < span.column + span.colSpan
        ),
        origin: 'source-ruled-stub'
      })
    for (let n = unresolvedSpans.length - 1; n >= 0; n--)
      if (unresolvedSpans[n].rect[3] <= sourceHeaderBands.bottom) unresolvedSpans.splice(n, 1)
    repairs.push('header-span-inferred')
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
  const nativeMathOrder = proveNativeClosedMathOrder(
    table,
    pageItems,
    captions,
    sourceRules,
    observedRuns
  )
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
    nativeMathOrder,
    captions,
    rotatedContinuation: table.readingRotation === 90 || table.readingRotation === 270,
    issues,
    repairs
  })
  if (
    repairs.includes('rotated-column-header-recovered') &&
    items
      .filter((item) => !item.horizontal)
      .every(
        (item) =>
          isSupportedRotatedStubLabel(item) ||
          cells.some(
            (cell) =>
              cell.row === 0 &&
              cell.rowSpan === 1 &&
              cell.colSpan === 1 &&
              intersect(cell.rect, item.rect) / area(item.rect) >= 0.2
          )
      )
  )
    issues.delete('unsupported-text-orientation')
  reconcileStatisticStubStarts({ cells, baseCells, rows, rules, repairs })
  reconcileFragmentedCountHeaders({ cells, issues, repairs })
  if (nativeParentSpans && rows[1])
    for (let index = unresolvedSpans.length - 1; index >= 0; index--) {
      const span = unresolvedSpans[index]
      if (span.rect[1] < rows[1].rect[3] && span.rect[3] <= rows[1].rect[3] + 2) {
        unresolvedSpans.splice(index, 1)
        repairs.push('native-header-span-discarded')
      }
    }
  if (compactCountHeaderStarts?.length) {
    const compactSlots = baseCells.filter(
      (cell) =>
        cell.row === 0 &&
        compactCountHeaderStarts.some((start) => cell.column >= start && cell.column < start + 2)
    )
    for (let index = unresolvedSpans.length - 1; index >= 0; index--) {
      const span = unresolvedSpans[index]
      if (!compactSlots.some((slot) => intersect(slot.rect, span.rect) > 0)) continue
      const source = items.filter((item) => intersect(span.rect, item.rect) > 0)
      const headerOnly = span.rect[3] <= rows[0].rect[3] + 2
      const owners = source.map((item) =>
        cells.filter((cell) =>
          cell.sourceTokens.some((token) => token.rect === item.rect && token.text === item.text)
        )
      )
      const sourceOwnedByOneCell = source.length > 0 && owners.every((owner) => owner.length === 1)
      if ((headerOnly && !source.length) || sourceOwnedByOneCell) {
        unresolvedSpans.splice(index, 1)
        repairs.push('compact-treatment-model-span-discarded')
      }
    }
  }
  reconcileUnresolvedTableSpans({
    spans: unresolvedSpans,
    cells,
    items,
    rows,
    rules,
    issues,
    repairs
  })
  removeEmptyOverlappingRows({ rows, cells, items, rules, repairs })
  reconcileRepeatedSectionHeadings({ rows, cells, items, rules, repairs })
  reconcileRuledLeafHeaderSpans({ rows, cells, items, rules, repairs })
  reconcileSharedReferenceFields({ cells, items, rules, headerRows, unassigned, repairs })
  reconcileCategoricalComparisons({ cells, items, rules, headerRows, unassigned, repairs })
  reconcileSummaryRecordColumns({
    cells,
    rows,
    columns,
    headerRows,
    items,
    unassigned,
    issues,
    repairs
  })
  // A source-separated model alternative can leave a stale overlap diagnostic
  // after every surviving span has become a complete, single-row section
  // heading.  Clear only this fully reconciled shape; ordinary overlapping
  // spans and any unassigned source text remain review candidates.
  const survivingSpans = cells.filter((cell) => cell.rowSpan > 1 || cell.colSpan > 1)
  if (
    repairs.includes('source-separated-model-span-discarded') &&
    !unassigned.length &&
    survivingSpans.length > 0 &&
    survivingSpans.every(
      (cell) => cell.rowSpan === 1 && cell.column === 0 && cell.colSpan === columns.length
    )
  ) {
    issues.delete('conflicting-spanning-cells')
    repairs.push('reconciled-section-span-conflict-discarded')
  }
  reconcileResolvedSpanDiagnostics({
    cells,
    rows,
    columns,
    unassigned,
    issues,
    repairs
  })
  const reconciledItems = unassigned.reconciliationItems ?? []
  const boundaryWitnessItems = pageItems.filter(
    (item) => item.rect[1] >= table.cropRect[3] - 2 && !reconciledItems.includes(item)
  )
  const finalBounds = reconcileNativeFinalCellBounds({
    table,
    cells,
    rows,
    columnRects,
    tokens: unassigned.reconciliationItems?.length
      ? [...unassigned.reconciliationItems, ...boundaryWitnessItems]
      : unassigned.sourceItems?.length
        ? [...sourceItems, ...unassigned.sourceItems, ...boundaryWitnessItems]
        : [...sourceItems, ...boundaryWitnessItems],
    rules: sourceRules,
    unassigned,
    clipped,
    repairs
  })
  if (finalBounds.cropRect !== table.cropRect)
    table = rebaseTableCrop(table, finalBounds.cropRect, true)
  if (clipped.length && !finalBounds.clipped.length) issues.delete('text-crosses-crop-boundary')
  // A neighboring prose column can leave one or more empty detector columns
  // in front of an otherwise complete native table. If the only text crossing
  // the crop boundary is that prose, trim the empty prefix from the published
  // grid and thumbnail while preserving legitimate blank cells inside the
  // table. The source ownership and alignment checks above make this narrow.
  let outputCells = cells
  let outputClipped = finalBounds.clipped
  let outputCrop = table.cropRect
  const firstOwnedColumn = Math.min(
    ...cells
      .filter((cell) => cell.sourceRects?.length || cell.text.trim())
      .map((cell) => cell.column)
  )
  const hasOwnedColumn = Number.isFinite(firstOwnedColumn)
  const leadingCells = cells.filter((cell) => cell.column < firstOwnedColumn)
  const leadingEmpty =
    hasOwnedColumn &&
    firstOwnedColumn > 0 &&
    leadingCells.length > 0 &&
    leadingCells.every(
      (cell) =>
        cell.column + cell.colSpan <= firstOwnedColumn &&
        !cell.sourceRects?.length &&
        !cell.text.trim()
    )
  const firstOwnedLeft =
    firstOwnedColumn > 0
      ? Math.min(
          ...cells.filter((cell) => cell.column === firstOwnedColumn).map((cell) => cell.rect[0])
        )
      : Infinity
  const firstModelColumn = columns
    .filter((column) => Array.isArray(column.rect))
    .sort((a, b) => a.rect[0] - b.rect[0])[0]
  const firstModelColumnLeft = firstModelColumn ? firstModelColumn.rect[0] : Infinity
  const nativeVerticalRules = sourceRules.filter(
    (rule) =>
      Math.abs(rule[2] - rule[0]) < 0.5 &&
      rule[3] - rule[1] >= (table.cropRect[3] - table.cropRect[1]) * 0.45
  )
  const nativeLeft = nativeVerticalRules.length
    ? Math.min(...nativeVerticalRules.map((rule) => rule[0]))
    : Infinity
  const leadingOutsideNativeBounds =
    Number.isFinite(nativeLeft) &&
    firstOwnedLeft >= nativeLeft - 1 &&
    leadingCells.every((cell) => cell.rect[2] <= nativeLeft + 1)
  const clippedProseOnly =
    clipped.length > 0 &&
    clipped.every(
      (item) =>
        item.text.trim().split(/\s+/u).length >= 3 &&
        item.rect[2] <= firstOwnedLeft + 1 &&
        item.rect[2] <= firstModelColumnLeft + 1
    )
  if (
    leadingEmpty &&
    leadingOutsideNativeBounds &&
    clippedProseOnly &&
    Number.isFinite(firstOwnedLeft)
  ) {
    outputCrop = [Math.max(table.cropRect[0], firstOwnedLeft - 1.5), ...table.cropRect.slice(1)]
    outputCells = cells
      .filter((cell) => cell.column >= firstOwnedColumn)
      .map((cell) => ({ ...cell, column: cell.column - firstOwnedColumn }))
    outputClipped = []
    issues.delete('text-crosses-crop-boundary')
    repairs.push('narrative-leading-column-trimmed')
  }
  const grid = rows.map(() =>
    Array.from(
      {
        length: columns.length - (outputCells === cells || !hasOwnedColumn ? 0 : firstOwnedColumn)
      },
      () => ''
    )
  )
  for (const cell of outputCells) grid[cell.row][cell.column] = cell.text
  return {
    id: table.id,
    cropRect: outputCrop,
    grid,
    cells: outputCells,
    rows: rows.map(({ rect, origin }) => ({ rect, origin })),
    unassigned,
    clipped: outputClipped.map((i) => ({ text: i.text, rect: i.rect })),
    excludedCaptionItems: excludedCaptionItems.map((i) => i.text),
    issues: [...issues],
    repairs,
    reviewCandidate: issues.size === 0,
    selectedTextItems: items.length
  }
}
