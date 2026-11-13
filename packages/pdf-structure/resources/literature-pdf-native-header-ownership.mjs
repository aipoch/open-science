/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'
import { rebaseTableCrop, isAdjacentTableScript } from './literature-pdf-table-geometry.mjs'
import { proveNativeCompleteRuledSourcePacket } from './literature-pdf-native-leaf-record-repair.mjs'
import { recoverNativeSingleParentMathHeaderGrid } from './literature-pdf-native-single-parent-math-header.mjs'
import { recoverNativeCategoricalParentHeaderGrid } from './literature-pdf-native-categorical-parent-header.mjs'
import {
  readSourceRow,
  groupSourceRowsWithScripts,
  hasUniqueRecordTokens,
  recoverRuledHeaderBands
} from './literature-pdf-source-records.mjs'

// Native opening/divider/footer strokes, complete scalar records and unique
// physical baselines establish header ownership. Font boxes may touch a rule;
// their baseline must remain in the same uniquely bounded physical band.
export function recoverNativeHeaderOwnershipGrid(table, items, captions, rules) {
  const titleCrop = recoverClosedTitleCrop(table, items, captions, rules)
  if (titleCrop) table = rebaseTableCrop(table, titleCrop)
  const plan = recoverHeaderOwnershipPlan(table, items, captions, rules, Boolean(titleCrop))
  if (!plan) return
  const ink = [...plan.ownedTokens]
  const frameInk = plan.cropRect.map((v, n) =>
    n < 2 ? Math.min(v, ...ink.map((i) => i.rect[n])) : Math.max(v, ...ink.map((i) => i.rect[n]))
  )
  // Preserve existing padding when it contains only this table. Tighten a
  // vertical edge only for independently excluded ink outside the proved
  // opening/closing, while retaining every owned glyph and native stroke.
  const cropRect = frameInk.map((v, n) =>
    n < 2 ? Math.min(v, table.cropRect[n]) : Math.max(v, table.cropRect[n])
  )
  const external = items.filter(
    (i) =>
      i.horizontal &&
      i.text.trim() &&
      !plan.ownedTokens.has(i) &&
      i.rect[0] < table.cropRect[2] &&
      i.rect[2] > table.cropRect[0] &&
      i.rect[1] < table.cropRect[3] &&
      i.rect[3] > table.cropRect[1]
  )
  if (external.some((i) => i.baseline < plan.cropRect[1])) cropRect[1] = frameInk[1]
  if (external.some((i) => i.baseline > plan.cropRect[3])) cropRect[3] = frameInk[3]
  return { ...plan, cropRect, repair: 'native-body-records-recovered' }
}

// A title above the detector opening is admitted only when the same complete
// native header/body plan owns its independently closed band. Crop expansion
// alone cannot establish either its table or its full-width scope.
function recoverClosedTitleCrop(table, items, captions, rules) {
  const crop = table.cropRect
  const candidates = joinHorizontalTableRules(rules).filter(
    (r) => r[1] < crop[1] && r[0] >= crop[0] && r[2] <= crop[2]
  )
  const answers = []
  for (const opening of candidates) {
    const title = items.filter(
      (i) =>
        i.text.trim() &&
        i.rect[0] < opening[2] &&
        i.rect[2] > opening[0] &&
        i.rect[1] > opening[1] &&
        i.rect[3] < crop[1]
    )
    if (
      title.length !== 1 ||
      crop[1] - opening[1] > title[0].height * 2 ||
      !proveNativeUniqueWholeFonts(title, items)
    )
      continue
    const nextCrop = [crop[0], opening[1], crop[2], crop[3]]
    const plan = recoverHeaderOwnershipPlan(
      rebaseTableCrop(table, nextCrop),
      items,
      captions,
      rules,
      true
    )
    if (
      !plan ||
      plan.headerRows.length !== 3 ||
      !plan.ownedTokens.has(title[0]) ||
      !plan.spans.some(
        (s) => s.row === 0 && s.column === 0 && s.rowSpan === 1 && s.colSpan === plan.columns.length
      ) ||
      plan.rows[0][1] !== opening[1] ||
      title[0].rect[3] >= plan.rows[0][3]
    )
      continue
    answers.push(nextCrop)
  }
  if (answers.length === 1) return answers[0]
}

function recoverClosedTitleHeader(source, inventory, cuts, rules, top, bottom) {
  if (!source.length || !proveNativeUniqueWholeFonts(source, inventory)) return
  const full = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r[1] >= top &&
        r[1] < bottom &&
        Math.abs(r[0] - cuts[0]) <= 0.101 &&
        Math.abs(r[2] - cuts.at(-1)) <= 0.101
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length !== 2 ||
    full[0][1] !== top ||
    full[0][0] !== full[1][0] ||
    full[0][2] !== full[1][2]
  )
    return
  const split = full[1][1],
    title = source.filter((i) => i.rect[3] < split),
    children = source.filter((i) => i.rect[1] > split)
  if (
    title.length !== 1 ||
    children.length + 1 !== source.length ||
    title[0].rect[1] <= top ||
    title[0].rect[0] <= full[0][0] ||
    title[0].rect[2] >= full[0][2] ||
    !/\p{L}/u.test(title[0].text) ||
    Math.abs((title[0].rect[0] + title[0].rect[2] - full[0][0] - full[0][2]) / 2) >
      title[0].height ||
    rules.some(
      (r) => r[0] === r[2] && r[0] > full[0][0] && r[0] < full[0][2] && r[1] < split && r[3] > top
    )
  )
    return
  const owned = new Set(source)
  if (
    inventory.some(
      (i) =>
        i.text.trim() &&
        !owned.has(i) &&
        i.rect[0] < full[0][2] &&
        i.rect[2] > full[0][0] &&
        i.rect[1] < bottom &&
        i.rect[3] > top
    )
  )
    return
  const child = recoverRuledHeaderBands(children, cuts, rules, split, bottom)
  if (child?.rows.length !== 2 || child.spans.filter((s) => s.colSpan > 1).length < 2) return
  return {
    rows: [[cuts[0], top, cuts.at(-1), split], ...child.rows],
    spans: [
      { row: 0, column: 0, rowSpan: 1, colSpan: cuts.length - 1 },
      ...child.spans.map((s) => ({ ...s, row: s.row + 1 }))
    ]
  }
}

// This independent proof runs on original whole fonts, before measured token
// subdivision. Complete records and a unique ordered parent partition establish
// two printed tiers without weakening the generic header-owner rules below.
export function recoverNativeTwoTierParentHeaderGrid(table, items, captions, rules, nativeContext) {
  const threeTier = recoverThreeTierNativeFences(table, items, captions, rules, nativeContext)
  if (threeTier) return threeTier
  if (
    table.readingRotation !== 0 ||
    !Array.isArray(items) ||
    items.some(
      (i) =>
        typeof i.text !== 'string' ||
        !Array.isArray(i.rect) ||
        i.rect.length !== 4 ||
        !i.rect.every(Number.isFinite) ||
        i.rect[2] <= i.rect[0] ||
        i.rect[3] <= i.rect[1] ||
        !Number.isFinite(i.baseline) ||
        !Number.isFinite(i.height) ||
        !(i.height > 0)
    )
  )
    return
  const context = proveNativeHeaderFrame(table, items, captions, rules)
  if (!context || context.edges.length !== 3) return
  const { crop, frame, edges, source, height } = context
  if (edges.some((r) => Math.abs(r[0] - frame[0]) > 0.1 || Math.abs(r[2] - frame[2]) > 0.1)) return
  const original = proveTwoTierWholeFontPacket(source, frame, nativeContext)
  if (!original) return
  if (context.belowCaption) {
    const below = captions.filter(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[1] >= frame[3] &&
        c.rect[1] - frame[3] < height * 4 &&
        c.rect[0] < frame[2] &&
        c.rect[2] > frame[0]
    )
    if (
      below.length !== 1 ||
      source.some((i) => i.sourceItem.pageNumber !== below[0].page) ||
      !proveTwoTierWholeCaption(below[0], items, original)
    )
      return
    return recoverNativeCategoricalParentHeaderGrid(table, items, context, rules, nativeContext)
  }
  const above = captions.filter(
    (c) =>
      captionKind(c.lines[0]) === 'table' &&
      c.rect[3] <= frame[1] &&
      frame[1] - c.rect[3] < height * 4 &&
      c.rect[0] < frame[2] &&
      c.rect[2] > frame[0]
  )
  if (
    above.length !== 1 ||
    source.some((i) => i.sourceItem.pageNumber !== above[0].page) ||
    !proveTwoTierWholeCaption(above[0], items, original)
  )
    return
  const singleParentMath = recoverNativeSingleParentMathHeaderGrid(
    table,
    items,
    context,
    nativeContext
  )
  if (singleParentMath) return singleParentMath
  const pairedUnderlined = recoverClosedPairedUnderlinedHeader(table, context, rules, nativeContext)
  if (pairedUnderlined) return { ...pairedUnderlined, repair: 'native-body-records-recovered' }
  const singleUnderlined = recoverClosedSingleUnderlinedHeader(
    table,
    items,
    context,
    rules,
    nativeContext
  )
  if (singleUnderlined) return { ...singleUnderlined, repair: 'native-body-records-recovered' }
  const terminalNumeric = recoverSingleTerminalNumericParentHeader(table, items, context, rules)
  if (terminalNumeric) return terminalNumeric
  if (!Array.isArray(table.structure?.objects)) return
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (
    columns.length < 5 ||
    columns.length > 10 ||
    columns.some((c) => !c.rect.every(Number.isFinite))
  )
    return
  const oldCuts = [
    frame[0] - 0.1,
    ...columns.slice(1).map((c, n) => crop[0] + (columns[n].rect[2] + c.rect[0]) / 2),
    frame[2] + 0.1
  ]
  if (oldCuts.some((x, n) => !Number.isFinite(x) || (n && x <= oldCuts[n - 1]))) return
  const head = source.filter((i) => i.baseline < edges[1][1]),
    body = groupSourceRowsWithScripts(
      source.filter((i) => !head.includes(i)),
      height,
      0.2
    )
  if (!head.length || !body || body.length < 4) return
  const scalar = (s) => /^[<>≤≥−–+-]?\d[\d.,%]*$/.test(s),
    owner = (i, xs) => {
      const center = (i.rect[0] + i.rect[2]) / 2
      if (center <= xs[0] || center >= xs.at(-1) || xs.includes(center)) return -1
      return xs.slice(1).findIndex((x) => center < x)
    }
  if (
    body.some((g) => {
      // A model boundary may cross a whole font. Its center establishes only a
      // provisional owner; the unique source-empty cuts below must preserve
      // that owner and contain the complete font before this plan is admitted.
      const lanes = oldCuts.slice(1).map((_, c) => g.filter((i) => owner(i, oldCuts) === c))
      if (g.length !== columns.length || lanes.some((a) => a.length !== 1)) return true
      const v = lanes.map((a) => a[0].text.trim())
      return (
        !v.every(Boolean) ||
        !/\p{L}/u.test(v[0]) ||
        v.slice(1).some((s) => !scalar(s)) ||
        g.some((i) => Math.abs(i.height - height) > height * 0.1)
      )
    }) ||
    head.some(
      (i) =>
        Math.abs(i.height - height) > height * 0.1 &&
        (i.height < height * 0.55 ||
          i.height >= height * 0.8 ||
          head.filter(
            (a) => Math.abs(a.height - height) <= height * 0.1 && isAdjacentTableScript(i, a)
          ).length !== 1)
    )
  )
    return
  const upperY = Math.min(...head.map((i) => i.baseline)),
    upper = head.filter((i) => Math.abs(i.baseline - upperY) < height * 0.2),
    lower = head.filter((i) => !upper.includes(i)),
    lowerY = Math.min(...lower.map((i) => i.baseline))
  if (
    !lower.length ||
    lowerY - upperY < height ||
    lowerY - upperY > height * 2.5 ||
    lower.some((i) => Math.abs(i.baseline - lowerY) >= height * 0.2) ||
    // The two printed tiers, their whole-font ink and the native fences bound
    // this band. A large empty opening/divider margin is not another tier.
    upper.some((i) => i.rect[1] < frame[1] - 0.1) ||
    lower.some((i) => i.baseline >= edges[1][1]) ||
    Math.min(...upper.map((i) => i.rect[1])) - frame[1] >= height ||
    edges[1][1] - Math.max(...lower.map((i) => i.baseline)) >= height
  )
    return
  const lowerOwned = lower.map((i) => [i, owner(i, oldCuts)]),
    bodyOwned = body.flat().map((i) => [i, owner(i, oldCuts)]),
    leaves = oldCuts.slice(1).map((_, c) => lowerOwned.filter(([, n]) => n === c).map(([i]) => i))
  if (lowerOwned.some(([, c]) => c < 0) || leaves.slice(1).some((g) => g.length !== 1)) return
  const clusters = []
  for (const i of [...upper].sort((a, b) => a.rect[0] - b.rect[0])) {
    const last = clusters.at(-1)
    if (last && i.rect[0] - Math.max(...last.map((a) => a.rect[2])) < height * 0.45) last.push(i)
    else clusters.push([i])
  }
  const upperStub = clusters.find((g) =>
      g.every((i) => i.rect[0] >= oldCuts[0] && i.rect[2] <= oldCuts[1])
    ),
    stub = upperStub ?? leaves[0],
    parents = clusters.filter((g) => g !== upperStub)
  if (
    stub.length !== 1 ||
    !/\p{L}/u.test(stub[0].text) ||
    (upperStub ? leaves[0].length !== 0 : leaves[0].length !== 1) ||
    parents.length < 2 ||
    parents.length > 4 ||
    parents.some((g) => !/\p{L}/u.test(g.map((i) => i.text).join(''))) ||
    !hasUniqueRecordTokens(source, [upper, lower, ...body])
  )
    return
  const bounds = (g) => [
      Math.min(...g.map((i) => i.rect[0])),
      Math.max(...g.map((i) => i.rect[2]))
    ],
    answers = []
  const visit = (n, start, scopes) => {
    if (n === parents.length) {
      if (start !== columns.length || scopes.filter((s) => s.end - s.start > 1).length < 2) return
      const cuts = [frame[0] - 0.1]
      for (let boundary = 1; boundary < columns.length; boundary++) {
        const left = [
            ...bodyOwned.filter(([, c]) => c === boundary - 1).map(([i]) => i),
            ...leaves[boundary - 1],
            ...(boundary === 1 ? stub : [])
          ],
          right = [
            ...bodyOwned.filter(([, c]) => c === boundary).map(([i]) => i),
            ...leaves[boundary]
          ]
        for (let k = 0; k < scopes.length; k++) {
          if (scopes[k].end === boundary) left.push(...parents[k])
          if (scopes[k].start === boundary) right.push(...parents[k])
        }
        const end = Math.max(...left.map((i) => i.rect[2])),
          beginning = Math.min(...right.map((i) => i.rect[0]))
        if (beginning - end < height * 0.45) return
        cuts.push((end + beginning) / 2)
      }
      cuts.push(frame[2] + 0.1)
      if (
        [...bodyOwned, ...lowerOwned].some(
          ([i, c]) => owner(i, cuts) !== c || i.rect[0] < cuts[c] || i.rect[2] > cuts[c + 1]
        ) ||
        scopes.some((s, k) =>
          parents[k].some((i) => i.rect[0] < cuts[s.start] || i.rect[2] > cuts[s.end])
        )
      )
        return
      answers.push({ cuts, scopes })
      return
    }
    const parent = bounds(parents[n])
    for (let end = start + 1; end <= columns.length; end++) {
      if (end === start + 1 && (n !== parents.length - 1 || end !== columns.length)) continue
      const children = bounds(leaves.slice(start, end).flat())
      if (Math.abs((parent[0] + parent[1] - children[0] - children[1]) / 2) >= height * 0.8)
        continue
      visit(n + 1, end, [...scopes, { start, end }])
    }
  }
  visit(0, 1, [])
  if (answers.length !== 1) return
  const { cuts, scopes } = answers[0],
    split = (Math.max(...upper.map((i) => i.baseline)) + lowerY) / 2,
    bands = sourceBodyBands(body, frame, edges[1][1])
  if (
    !bands ||
    upper.some((i) => (i.rect[1] + i.rect[3]) / 2 >= split) ||
    lower.some((i) => (i.rect[1] + i.rect[3]) / 2 <= split)
  )
    return
  return {
    rows: [
      [cuts[0], frame[1], cuts.at(-1), split],
      [cuts[0], split, cuts.at(-1), edges[1][1]],
      ...bands
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
    headerRows: [0, 1],
    spans: [
      { row: 0, column: 0, rowSpan: 2, colSpan: 1 },
      ...scopes.map((s) => ({ row: 0, column: s.start, rowSpan: 1, colSpan: s.end - s.start }))
    ],
    completeSpans: true,
    ownedTokens: new Set(source),
    cropRect: [crop[0], frame[1], crop[2], frame[3]],
    repair: 'native-body-records-recovered'
  }
}

// Three printed tiers are admitted by their nested native vertical fences,
// complete whole-font leaves and closed scalar records, independently of the
// unchanged two-tier/model-column limits above.
function recoverThreeTierNativeFences(table, items, captions, rules, nativeContext) {
  const crop = table.cropRect,
    model = table.structure?.objects
      ?.filter((o) => o.label === 'table column')
      .sort((a, b) => a.rect[0] - b.rect[0]),
    finite = (a) => Array.isArray(a) && a.length === 4 && a.every(Number.isFinite)
  if (
    table.readingRotation !== 0 ||
    !finite(crop) ||
    ![9, 13].includes(model?.length) ||
    model.some((c) => !finite(c.rect)) ||
    !Array.isArray(items) ||
    !Array.isArray(rules) ||
    rules.some((r) => !finite(r)) ||
    !Array.isArray(captions) ||
    captions.some(
      (c) =>
        !finite(c.rect) || !Array.isArray(c.lines) || c.lines.some((s) => typeof s !== 'string')
    ) ||
    items.some(
      (i) =>
        typeof i.text !== 'string' ||
        !finite(i.rect) ||
        i.rect[2] <= i.rect[0] ||
        i.rect[3] <= i.rect[1] ||
        !Number.isFinite(i.baseline) ||
        !Number.isFinite(i.height) ||
        i.height <= 0
    )
  )
    return
  const edges = joinHorizontalTableRules(rules)
    .filter((r) => r[1] >= crop[1] && r[1] <= crop[3] && r[0] >= crop[0] && r[2] <= crop[2])
    .sort((a, b) => a[1] - b[1])
  if (
    edges.length < 8 ||
    edges.some(
      (r) => !finite(r) || Math.abs(r[0] - edges[0][0]) > 0.1 || Math.abs(r[2] - edges[0][2]) > 0.1
    )
  )
    return
  const x0 = edges[0][0],
    x1 = edges[0][2],
    top = edges[0][1],
    bottom = edges.at(-1)[1]
  if (edges.some((r, n) => n && r[1] <= edges[n - 1][1])) return
  const bandFences = (a, b) => {
    const vertical = rules
      .filter((r) => finite(r) && r[0] === r[2] && r[0] >= x0 && r[0] <= x1 && r[1] < b && r[3] > a)
      .sort((l, r) => l[0] - r[0])
    if (
      vertical.length < 2 ||
      vertical.some(
        (r, n) =>
          Math.abs(r[1] - a) > 0.5 ||
          Math.abs(r[3] - b) > 0.5 ||
          (n && r[0] - vertical[n - 1][0] < 0.1)
      ) ||
      Math.abs(vertical[0]?.[0] - x0) > 0.5 ||
      Math.abs(vertical.at(-1)?.[0] - x1) > 0.5
    )
      return
    return vertical.map((r) => r[0])
  }
  const fences = edges.slice(1).map((r, n) => bandFences(edges[n][1], r[1]))
  const parents = (model.length - 1) / 4
  if (
    fences.some((a) => !a) ||
    fences[0].length !== parents + 2 ||
    fences[1].length !== parents * 2 + 2 ||
    fences[2].length !== model.length + 1
  )
    return
  const cuts = fences[2],
    same = (a, b) => Math.abs(a - b) < 0.1
  if (
    !fences[0].every((x, n) => same(x, cuts[n === 0 ? 0 : 1 + (n - 1) * 4])) ||
    !fences[1].every((x, n) => same(x, cuts[n === 0 ? 0 : 1 + (n - 1) * 2]))
  )
    return
  const source = items.filter(
    (i) =>
      i.horizontal &&
      i.text.trim() &&
      i.rect[0] < x1 &&
      i.rect[2] > x0 &&
      i.baseline > top &&
      i.baseline < bottom
  )
  if (!source.length) return
  const height = source.map((i) => i.height).sort((a, b) => a - b)[source.length >> 1],
    frame = [x0, Math.min(top, ...source.map((i) => i.rect[1])), x1, bottom],
    contains = (i, a, b) => i.rect[0] >= a - 0.1 && i.rect[2] <= b + 0.1
  if (
    !(height > 0) ||
    frame[1] < crop[1] ||
    source.some(
      (i) => !contains(i, x0, x1) || i.rect[3] > bottom || i.rect[1] < top - height * 0.25
    )
  )
    return
  const original = proveTwoTierWholeFontPacket(source, frame, nativeContext)
  if (!original || !proveNativeCompleteRuledSourcePacket(source, rules, nativeContext, frame))
    return
  const above = captions.filter(
    (c) =>
      captionKind(c.lines?.[0]) === 'table' &&
      c.rect[3] <= frame[1] &&
      frame[1] - c.rect[3] < height * 4 &&
      c.rect[0] < x1 &&
      c.rect[2] > x0
  )
  if (
    above.length !== 1 ||
    source.some((i) => i.sourceItem.pageNumber !== above[0].page) ||
    !proveTwoTierWholeCaption(above[0], items, original)
  )
    return
  const bands = edges
    .slice(1)
    .map((r, n) =>
      source.filter(
        (i) =>
          (i.rect[1] + i.rect[3]) / 2 > edges[n][1] &&
          (i.rect[1] + i.rect[3]) / 2 < r[1] &&
          i.baseline > edges[n][1] &&
          i.baseline < r[1]
      )
    )
  if (!hasUniqueRecordTokens(source, bands)) return
  // A healthy model already separates these physical tiers. Leave its existing
  // refinement/crop path intact; this branch addresses one merged parent/child
  // row only, proved independently by both whole-font tiers.
  const modelRows = table.structure.objects.filter((o) => o.label === 'table row'),
    owns = (o, i) =>
      crop[1] + o.rect[1] < (i.rect[1] + i.rect[3]) / 2 &&
      crop[1] + o.rect[3] > (i.rect[1] + i.rect[3]) / 2
  if (modelRows.some((o) => !finite(o.rect)) || !bands[0].length || !bands[1].length) return
  const childModels = modelRows.filter((o) => bands[1].every((i) => owns(o, i))),
    parentModels = modelRows.filter((o) => bands[0].some((i) => owns(o, i)))
  if (
    childModels.length !== 1 ||
    (parentModels.length &&
      (parentModels.length !== 1 ||
        parentModels[0] !== childModels[0] ||
        !bands[0].every((i) => owns(parentModels[0], i))))
  )
    return
  const modelHeaders = table.structure.objects.filter((o) => o.label === 'table column header')
  // The faulty prediction also absorbs an independently closed title band
  // into its header. A header ending at the real leaf divider already has an
  // existing recovery path, even when its parent row prediction is missing.
  if (
    modelHeaders.length !== 1 ||
    !finite(modelHeaders[0].rect) ||
    fences[3].length !== 2 ||
    bands[3].length !== 1 ||
    crop[1] + modelHeaders[0].rect[3] <= bands[3][0].baseline ||
    crop[1] + modelHeaders[0].rect[1] <= Math.max(...bands[0].map((i) => i.baseline))
  )
    return
  const byLane = (g, xs) => xs.slice(1).map((x, c) => g.filter((i) => contains(i, xs[c], x)))
  const normal = (i) => Math.abs(i.height - height) < height * 0.1,
    scalar = (s) => /^[<>≤≥−–+-]?\d[\d.,%]*$/.test(s.trim())
  const parentLanes = byLane(bands[0], fences[0]),
    childLanes = byLane(bands[1], fences[1]),
    leaves = byLane(bands[2], cuts)
  if (
    parentLanes[0].length ||
    childLanes[0].length ||
    parentLanes.slice(1).some((a) => a.length !== 1 || !normal(a[0])) ||
    leaves.some((a) => a.length !== 1 || !normal(a[0])) ||
    !hasUniqueRecordTokens(bands[0], parentLanes.slice(1)) ||
    !hasUniqueRecordTokens(bands[1], childLanes.slice(1)) ||
    !hasUniqueRecordTokens(bands[2], leaves)
  )
    return
  for (const a of childLanes.slice(1)) {
    const ordered = [...a].sort((l, r) => l.rect[0] - r.rect[0])
    if (
      ordered.length !== 2 ||
      !normal(ordered[0]) ||
      ordered[1].height < height * 0.6 ||
      ordered[1].height > height * 0.8 ||
      ordered[1].baseline <= ordered[0].baseline ||
      ordered[1].baseline - ordered[0].baseline > height * 0.3 ||
      ordered[1].rect[0] < ordered[0].rect[2] - 0.1 ||
      ordered[1].rect[0] - ordered[0].rect[2] > height * 0.1
    )
      return
  }
  const oldCuts = [
      crop[0],
      ...model.slice(1).map((c, n) => crop[0] + (model[n].rect[2] + c.rect[0]) / 2),
      crop[2]
    ],
    owner = (i, xs) => xs.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x),
    spans = [{ row: 2, column: 0, rowSpan: 1, colSpan: 1 }],
    numeric = []
  if (oldCuts.some((x, n) => !Number.isFinite(x) || (n && x <= oldCuts[n - 1]))) return
  for (let r = 3; r < bands.length; r++) {
    const g = bands[r],
      xs = fences[r]
    if (xs.length === 2) {
      if (
        g.length !== 1 ||
        !normal(g[0]) ||
        !/\p{L}/u.test(g[0].text) ||
        !contains(g[0], x0, x1) ||
        g[0].rect[0] <= cuts[1] ||
        g[0].rect[2] >= cuts.at(-2)
      )
        return
      spans.push({ row: r, column: 0, rowSpan: 1, colSpan: model.length })
    } else {
      const lanes = byLane(g, cuts)
      if (
        xs.length !== cuts.length ||
        !xs.every((x, n) => same(x, cuts[n])) ||
        lanes.some((a) => a.length !== 1 || !normal(a[0]) || !scalar(a[0].text)) ||
        !hasUniqueRecordTokens(g, lanes) ||
        g.some((i) => owner(i, cuts) !== owner(i, oldCuts))
      )
        return
      numeric.push(g)
    }
  }
  if (numeric.length < 4) return
  for (let p = 0; p < parents; p++) {
    spans.push({ row: 0, column: 1 + p * 4, rowSpan: 1, colSpan: 4 })
    for (let c = 0; c < 2; c++)
      spans.push({ row: 1, column: 1 + p * 4 + c * 2, rowSpan: 1, colSpan: 2 })
  }
  return {
    rows: edges.slice(1).map((r, n) => [x0, n === 0 ? frame[1] : edges[n][1], x1, r[1]]),
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, bottom]),
    headerRows: [0, 1, 2],
    spans: spans.filter((s) => s.colSpan > 1),
    completeSpans: true,
    ownedTokens: new Set(source),
    cropRect: [...crop],
    repair: 'native-body-records-recovered'
  }
}

// Two equal native parent fences have a common half-gap inset. Their shared
// gutter and independently closed right edge prove complete three-leaf scopes;
// original body lanes remain unchanged, including a genuinely empty first stub.
function recoverClosedPairedUnderlinedHeader(table, context, rules, nativeContext) {
  const { frame, height, source } = context
  const parents = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[0] > frame[0] &&
        r[2] < frame[2] &&
        r[1] > frame[1] + height * 0.5 &&
        r[1] < frame[1] + height * 3 &&
        r[2] - r[0] > height * 3
    )
    .sort((a, b) => a[0] - b[0])
  if (
    parents.length !== 2 ||
    Math.abs(parents[0][1] - parents[1][1]) > height * 0.01 ||
    Math.abs(parents[0][2] - parents[0][0] - parents[1][2] + parents[1][0]) > height * 0.01
  )
    return
  const inset = (parents[1][0] - parents[0][2]) / 2
  if (
    inset < height * 0.2 ||
    inset > height * 0.6 ||
    Math.abs(parents[1][2] + inset - frame[2]) > 0.1
  )
    return
  const scopes = [
    [parents[0][0] - inset, parents[0][2] + inset],
    [parents[1][0] - inset, frame[2]]
  ]
  if (
    scopes[0][0] <= frame[0] ||
    !proveNativeCompleteRuledSourcePacket(source, rules, nativeContext, frame)
  )
    return
  const plan = recoverUnderlinedSourceLeafGrid(context, rules, scopes)
  const columns = table.structure?.objects
    ?.filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (!plan || columns?.length !== 8 || columns.some((c) => !c.rect?.every(Number.isFinite))) return
  const oldCuts = [
    frame[0] - 0.1,
    ...columns.slice(1).map((c, n) => table.cropRect[0] + (columns[n].rect[2] + c.rect[0]) / 2),
    frame[2] + 0.1
  ]
  if (oldCuts.some((x, n) => !Number.isFinite(x) || (n && x <= oldCuts[n - 1]))) return
  const owner = (i, cuts) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const newCuts = [plan.columns[0][0], ...plan.columns.map((c) => c[2])]
  if (
    source
      .filter((i) => i.baseline > plan.rows[1][3])
      .some((i) => {
        const c = owner(i, oldCuts)
        return (
          c < 0 || owner(i, newCuts) !== c || i.rect[0] < newCuts[c] || i.rect[2] > newCuts[c + 1]
        )
      })
  )
    return
  return plan
}

// A shortened native underline can stop inside the outer leaf fonts. Admit
// that case only when complete repeated records independently establish every
// leaf lane and the stroke selects the same contiguous lanes in every record.
function recoverClosedSingleUnderlinedHeader(table, items, context, rules, nativeContext) {
  const { source, frame, height } = context
  const parents = rules.filter(
    (r) =>
      r[1] === r[3] &&
      r[0] > frame[0] &&
      r[2] < frame[2] &&
      r[1] > frame[1] + height * 0.5 &&
      r[1] < frame[1] + height * 3
  )
  if (
    parents.length !== 1 ||
    !proveNativeCompleteRuledSourcePacket(source, rules, nativeContext, frame)
  )
    return
  const references = items.flatMap((i) =>
    [
      i.sourceItem,
      i.sourceSegment,
      i.sourceToken,
      i.sourceToken?.sourceItem,
      i.sourceToken?.sourceSegment
    ].filter(Boolean)
  )
  if (
    source.some(
      (i) =>
        i.sourceToken ||
        i.sourceSegment ||
        references.filter(
          (o) => o.pageNumber === i.sourceItem.pageNumber && o.index === i.sourceItem.index
        ).length !== 1
    )
  )
    return
  const plan = recoverUnderlinedSourceLeafGrid(context, rules, undefined, true)
  const columns = table.structure?.objects
    ?.filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (
    !plan ||
    columns?.length !== plan.columns.length ||
    columns.some((c) => !c.rect?.every(Number.isFinite))
  )
    return
  const parent = plan.spans.filter((s) => s.colSpan > 1)
  if (parent.length !== 1) return
  const { column: start, colSpan: count } = parent[0],
    stroke = parents[0]
  const cuts = [plan.columns[0][0], ...plan.columns.map((c) => c[2])]
  const oldCuts = [
    frame[0] - 0.1,
    ...columns.slice(1).map((c, n) => table.cropRect[0] + (columns[n].rect[2] + c.rect[0]) / 2),
    frame[2] + 0.1
  ]
  if (oldCuts.some((x, n) => !Number.isFinite(x) || (n && x <= oldCuts[n - 1]))) return
  const center = (i) => (i.rect[0] + i.rect[2]) / 2
  const owner = (i, xs) => xs.slice(1).findIndex((x) => center(i) < x)
  const leaves = source.filter((i) => i.baseline > stroke[1])
  const lanes = plan.columns.map((_, c) => leaves.filter((i) => owner(i, cuts) === c))
  if (
    lanes.some((g) => !g.length) ||
    leaves.some((i) => {
      const c = owner(i, cuts)
      return (
        c < 0 ||
        i.rect[0] < cuts[c] ||
        i.rect[2] > cuts[c + 1] ||
        (i.baseline > plan.rows[1][3] && owner(i, oldCuts) !== c)
      )
    })
  )
    return
  for (const [edge, c] of [
    [stroke[0], start],
    [stroke[2], start + count - 1]
  ])
    if (
      edge < Math.min(...lanes[c].map((i) => i.rect[0])) ||
      edge > Math.max(...lanes[c].map((i) => i.rect[2]))
    )
      return
  for (const row of plan.rows.slice(2)) {
    const record = leaves.filter((i) => i.baseline > row[1] && i.baseline <= row[3])
    for (let c = 0; c < lanes.length; c++) {
      const group = record.filter((i) => owner(i, cuts) === c)
      if (!group.length) return
      const mid =
        (Math.min(...group.map((i) => i.rect[0])) + Math.max(...group.map((i) => i.rect[2]))) / 2
      if ((mid > stroke[0] && mid < stroke[2]) !== (c >= start && c < start + count)) return
    }
  }
  return plan
}

function proveTwoTierWholeFontPacket(source, frame, context) {
  const raw = context?.sourceContent,
    v = context?.viewport,
    finite = (a, length) => Array.isArray(a) && a.length === length && a.every(Number.isFinite)
  if (
    !Array.isArray(raw?.items) ||
    !raw.styles ||
    !finite(v?.transform, 6) ||
    v.transform[0] <= 0 ||
    v.transform[1] !== 0 ||
    v.transform[2] !== 0 ||
    v.transform[3] >= 0 ||
    v.rotation !== 0 ||
    !Number.isFinite(v.width) ||
    !Number.isFinite(v.height) ||
    !(v.width > 0) ||
    !(v.height > 0)
  )
    return
  const viewport = {
      transform: v.transform,
      convertToViewportPoint: (x, y) => [
        v.transform[0] * x + v.transform[2] * y + v.transform[4],
        v.transform[1] * x + v.transform[3] * y + v.transform[5]
      ]
    },
    original = [],
    pageNumber = raw.items.find((i) => typeof i.str === 'string' && i.str.trim())?.sourceItem
      ?.pageNumber
  for (let index = 0; index < raw.items.length; index++) {
    const i = raw.items[index]
    if (typeof i.str !== 'string' || !i.str.trim()) continue
    if (
      !finite(i.transform, 6) ||
      !Number.isFinite(i.width) ||
      !Number.isFinite(i.height) ||
      !(i.width > 0) ||
      !(i.height > 0) ||
      !Number.isInteger(pageNumber) ||
      pageNumber < 1 ||
      i.sourceItem?.pageNumber !== pageNumber ||
      i.sourceItem.index !== index ||
      i.sourceItem.text !== i.str ||
      !raw.styles[i.fontName] ||
      Array.isArray(raw.styles[i.fontName]) ||
      typeof raw.styles[i.fontName] !== 'object' ||
      typeof raw.styles[i.fontName].fontFamily !== 'string' ||
      !Number.isFinite(raw.styles[i.fontName].ascent) ||
      !Number.isFinite(raw.styles[i.fontName].descent)
    )
      return
    const font = tableTextToken(i, viewport, 0)
    original.push(font)
    if (
      font.rect[0] >= frame[2] ||
      font.rect[2] <= frame[0] ||
      font.rect[1] >= frame[3] ||
      font.rect[3] <= frame[1]
    )
      continue
    const s = i.sourceItem,
      match = source.filter((f) => f.sourceItem?.index === index)
    if (
      !font.horizontal ||
      i.transform[0] <= 0 ||
      i.transform[1] !== 0 ||
      i.transform[2] !== 0 ||
      i.transform[3] <= 0 ||
      i.transform[0] !== i.transform[3] ||
      i.transform[3] !== i.height ||
      i.inlineSymbol ||
      !raw.styles[i.fontName] ||
      raw.styles[i.fontName].vertical === true ||
      !s ||
      !Number.isInteger(s.pageNumber) ||
      s.pageNumber < 1 ||
      s.index !== index ||
      s.text !== i.str ||
      match.length !== 1 ||
      match[0].sourceItem.pageNumber !== s.pageNumber ||
      match[0].sourceItem.text !== i.str ||
      match[0].text !== i.str ||
      match[0].inlineSymbol ||
      match[0].sourceToken !== undefined ||
      match[0].baseline !== font.baseline ||
      match[0].height !== font.height ||
      match[0].rect.some((x, n) => x !== font.rect[n])
    )
      return
  }
  const intersects = original.filter(
    (i) =>
      i.rect[0] < frame[2] && i.rect[2] > frame[0] && i.rect[1] < frame[3] && i.rect[3] > frame[1]
  )
  if (intersects.length !== source.length) return
  return original
}

function proveTwoTierWholeCaption(caption, items, original) {
  if (!caption.rect?.every(Number.isFinite) || !Number.isInteger(caption.page)) return
  const contains = (i) =>
      i.horizontal &&
      i.rect[0] >= caption.rect[0] - 0.1 &&
      i.rect[2] <= caption.rect[2] + 0.1 &&
      i.rect[1] >= caption.rect[1] - 0.1 &&
      i.rect[3] <= caption.rect[3] + 0.1,
    parts = original.filter(contains),
    literal = (s) => s.replace(/\s+/g, '')
  return (
    parts.length > 0 &&
    literal(parts.map((i) => i.text).join('')) === literal(caption.lines.join('')) &&
    parts.every((i) => {
      const s = i.sourceItem,
        match = items.filter((f) => f.sourceItem?.index === s?.index)
      return (
        s?.pageNumber === caption.page &&
        s.text === i.text &&
        match.length === 1 &&
        match[0].sourceItem.pageNumber === s.pageNumber &&
        match[0].text === i.text &&
        match[0].baseline === i.baseline &&
        match[0].height === i.height &&
        match[0].rect.every((x, n) => x === i.rect[n]) &&
        match[0].sourceToken === undefined
      )
    })
  )
}

function proveNativeHeaderFrame(table, items, captions, rules, closedTitle = false) {
  const crop = table.cropRect
  if (!crop?.every(Number.isFinite)) return
  const near = items.filter(
    (i) =>
      i.horizontal &&
      i.text.trim() &&
      i.rect[0] < crop[2] &&
      i.rect[2] > crop[0] &&
      i.rect[1] < crop[3] &&
      i.rect[3] > crop[1]
  )
  const heights = near
    .map((i) => i.height)
    .filter((h) => Number.isFinite(h) && h > 0)
    .sort((a, b) => a - b)
  const height = heights[heights.length >> 1]
  if (!(height > 0)) return
  const edges = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r.every(Number.isFinite) &&
        Math.abs(r[0] - crop[0]) < height * 2 &&
        Math.abs(r[2] - crop[2]) < height * 2 &&
        r[1] > crop[1] - height &&
        r[1] < crop[3] + height
    )
    .sort((a, b) => a[1] - b[1])
  if (edges.length < 3) return
  const opening = edges[0],
    closing = edges.at(-1)
  if (
    Math.abs(opening[0] - closing[0]) > 0.5 ||
    Math.abs(opening[2] - closing[2]) > 0.5 ||
    opening[1] - crop[1] > height ||
    Math.abs(closing[1] - crop[3]) > height * 2
  )
    return
  const frame = [opening[0], opening[1], opening[2], closing[1]]
  const contains = (rect, i) =>
    i.rect[0] >= rect[0] - 0.1 &&
    i.rect[2] <= rect[2] + 0.1 &&
    i.rect[1] >= rect[1] - 0.1 &&
    i.rect[3] <= rect[3] + 0.1
  const belowParts = new Map()
  for (const c of captions) {
    if (
      captionKind(c.lines[0]) !== 'table' ||
      c.rect[1] < closing[1] - height * 0.25 ||
      c.rect[1] - closing[1] >= height * 4
    )
      continue
    const parts = items.filter((i) => i.horizontal && i.text.trim() && contains(c.rect, i))
    const literal = (s) => s.replace(/\s+/g, '')
    if (
      parts.length &&
      parts.every((i) => Number.isFinite(i.baseline) && i.baseline > closing[1]) &&
      literal(parts.map((i) => i.text).join('')) === literal(c.lines.join(''))
    )
      belowParts.set(c, new Set(parts))
  }
  const aboveCandidates = captions.filter(
    (c) =>
      captionKind(c.lines[0]) === 'table' &&
      c.rect[3] <= opening[1] &&
      opening[1] - c.rect[3] < height * 4 &&
      c.rect[0] < frame[2] &&
      c.rect[2] > frame[0]
  )
  const candidates = aboveCandidates.length
    ? aboveCandidates
    : captions.filter((c) => belowParts.has(c) && c.rect[0] < frame[2] && c.rect[2] > frame[0])
  if (candidates.length !== 1 && !(closedTitle && candidates.length === 0)) return
  const intersects = items.filter(
    (i) =>
      i.horizontal &&
      i.text.trim() &&
      i.rect[0] < frame[2] &&
      i.rect[2] > frame[0] &&
      i.rect[1] < frame[3] &&
      i.rect[3] > frame[1] &&
      !(belowParts.get(candidates[0])?.has(i) || (candidates[0] && contains(candidates[0].rect, i)))
  )
  const source = intersects
    .filter(
      (i) =>
        i.rect.every(Number.isFinite) &&
        Number.isFinite(i.baseline) &&
        Number.isFinite(i.height) &&
        i.height > 0 &&
        i.rect[0] >= frame[0] - 0.1 &&
        i.rect[2] <= frame[2] + 0.1 &&
        i.baseline > frame[1] &&
        i.baseline < frame[3] &&
        i.rect[1] >= frame[1] - height * 0.25 &&
        i.rect[3] <= frame[3] + 0.1
    )
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
  if (
    source.length !== intersects.length ||
    (closedTitle && !proveNativeUniqueWholeFonts(source, items))
  )
    return
  return {
    crop,
    height,
    edges,
    opening,
    closing,
    frame,
    source,
    belowCaption: belowParts.has(candidates[0])
  }
}

function recoverHeaderOwnershipPlan(table, items, captions, rules, closedTitle = false) {
  const compound = !closedTitle && recoverAboveCaptionPhysicalLeaves(table, items, captions, rules)
  if (compound) return compound
  const context = proveNativeHeaderFrame(table, items, captions, rules, closedTitle)
  if (!context) return
  if (context.belowCaption) return recoverCompoundPhysicalLeafGrid(table, context)
  const grouped = recoverCenteredGroupStubGrid(table, context)
  if (grouped) return grouped
  const prose = recoverRuledProseHeaderGrid(table, context)
  if (prose) return prose
  const underlined = recoverUnderlinedSourceLeafGrid(context, rules)
  if (underlined) return underlined
  const separated = recoverSeparatedNumericParentGrid(table, context)
  if (separated) return separated
  const aligned = recoverAlignedLeafHeaderGrid(table, context)
  if (aligned) return aligned
  const { crop, height, edges, frame, source } = context
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length < 3 || predicted.length > 18) return
  const cuts = [
    frame[0] - 0.1,
    ...predicted.slice(1).map((c, n) => crop[0] + (predicted[n].rect[2] + c.rect[0]) / 2),
    frame[2] + 0.1
  ]
  if (cuts.some((x, n) => !Number.isFinite(x) || (n && x <= cuts[n - 1]))) return
  const scalar = (v) => /^(?:[<>≤≥−–+\-|]?\d[\d.,()[\]±−–+\-|%*/=<>≤≥]*|[—–-])$/.test(v)
  const physical = []
  for (const item of source.filter((i) => i.height >= height * 0.8)) {
    const last = physical.at(-1)
    if (last && Math.abs(last[0].baseline - item.baseline) < height * 0.2) last.push(item)
    else physical.push([item])
  }
  const measured = physical
    .map((g) => readSourceRow(g, cuts))
    .map(
      (v) => v && v.filter((x) => scalar(x)).length >= 2 && v.slice(2).every((x) => !x || scalar(x))
    )
  const first = measured.indexOf(true)
  if (first < 1 || first > 6 || measured.filter(Boolean).length < 3) return
  const firstBaseline = physical[first][0].baseline
  let head = source.filter((i) => i.baseline < firstBaseline - height * 0.5)
  let body = groupSourceRowsWithScripts(
    source.filter((i) => !head.includes(i)),
    height,
    0.2
  )
  const sectionPlan = recoverNativeFullWidthSections(source, cuts, edges, frame, height)
  const sections = sectionPlan?.sections ?? []
  if (sectionPlan) {
    head = sectionPlan.head
    body = sectionPlan.body
  }
  if (!body || (!sectionPlan && measured.slice(first).some((v) => !v))) return
  const bodyValues = body
    .filter((_, row) => !sections.includes(row))
    .map((g) => readSourceRow(g, cuts))
  if (bodyValues.some((v) => !v)) return
  // This branch proves header scopes only. An empty detector leaf is not a
  // native column, and sparse shared body cells need the existing categorical
  // and statistical span recovery rather than a complete-spans declaration.
  if (
    cuts.slice(1).some((_, c) => !bodyValues.some((v) => v[c])) ||
    cuts.slice(2).some((_, n) => {
      const values = bodyValues.map((v) => v[n + 1])
      return values.filter(Boolean).length === 1 && values.filter((v) => !v).length >= 2
    }) ||
    bodyValues.some((v) => !v[0] && v.slice(1).some((x) => !x))
  )
    return
  const divider = edges.filter(
    (r) =>
      r[1] > Math.max(...head.map((i) => i.baseline)) &&
      r[1] < Math.min(...body[0].map((i) => i.baseline))
  )
  if (divider.length !== 1) return
  const closedHeader = recoverClosedTitleHeader(head, items, cuts, rules, frame[1], divider[0][1])
  if (
    (closedTitle && !closedHeader) ||
    (closedHeader && bodyValues.some((row) => row.some((v) => !v)))
  )
    return
  if (divider[0][1] - (closedHeader ? closedHeader.rows[1][1] : frame[1]) > height * 5) return
  let header = closedHeader ?? recoverRuledHeaderBands(head, cuts, rules, frame[1], divider[0][1])
  if (header?.rows.length === 1) {
    const parents = recoverSingleTierParentScopes(head, cuts, body, height)
    header =
      recoverCenteredParentHeaderScopes(head, cuts, frame[1], divider[0][1], height, body.flat()) ??
      (parents ? { ...header, spans: parents.spans } : header)
  }
  if (!header || header.rows.length < 1 || header.rows.length > 3) return
  // A new plan must actually recover a native header tier, rather than use a
  // numeric table as a general body-reconstruction escape hatch.
  if (
    header.rows.length === 1 &&
    head.some((i) => i.rect[1] >= frame[1] && i.rect[1] >= divider[0][1])
  )
    return
  let repairedLeafCut = false
  if (header.rows.length === 1 && !header.spans.some((s) => s.colSpan > 1)) {
    // A complete one-line leaf can straddle a detector cut. The unique ink
    // gutter may move that cut only while every numeric record keeps its lane.
    const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
    const numericBody = body.filter((_, n) => !sections.includes(n))
    const owned = head.map((i) => [i, col(i)]),
      bodyOwned = numericBody.flat().map((i) => [i, col(i)])
    for (let c = 1; c < cuts.length - 1; c++) {
      const left = head.filter((i) => col(i) === c - 1),
        right = head.filter((i) => col(i) === c)
      if (!left.length || !right.length) return
      const end = Math.max(...left.map((i) => i.rect[2])),
        start = Math.min(...right.map((i) => i.rect[0]))
      if (end >= start) return
      if (end > cuts[c] || start < cuts[c]) {
        cuts[c] = (end + start) / 2
        repairedLeafCut = true
      }
    }
    if (
      head.some((i, n) => col(i) !== owned[n][1]) ||
      bodyOwned.some(([i, c]) => col(i) !== c) ||
      numericBody.some((g) => !readSourceRow(g, cuts))
    )
      return
  }
  if (header.rows.length === 1 && !header.spans.length && !sections.length && !repairedLeafCut)
    return
  const spanOwner = (i, row) =>
    header.spans.find(
      (s) =>
        s.row <= row &&
        s.row + s.rowSpan > row &&
        (i.rect[0] + i.rect[2]) / 2 >= cuts[s.column] &&
        (i.rect[0] + i.rect[2]) / 2 < cuts[s.column + s.colSpan]
    )
  for (const i of head) {
    const row = header.rows.findIndex((r) => i.baseline > r[1] && i.baseline < r[3])
    if (row < 0) return
    const s = spanOwner(i, row),
      c = cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
    if (
      c < 0 ||
      i.rect[0] < cuts[s?.column ?? c] - 0.1 ||
      i.rect[2] > cuts[s ? s.column + s.colSpan : c + 1] + 0.1
    )
      return
  }
  if (!hasUniqueRecordTokens(source, [head, ...body])) return
  const bodyBands = sourceBodyBands(body, frame, divider[0][1])
  if (!bodyBands) return
  const rows = [...header.rows, ...bodyBands]
  return {
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
    headerRows: header.rows.map((_, n) => n),
    spans: [
      ...header.spans,
      ...sections.map((row) => ({
        row: row + header.rows.length,
        column: 0,
        rowSpan: 1,
        colSpan: cuts.length - 1
      }))
    ],
    completeSpans: true,
    ownedTokens: new Set(source),
    cropRect: frame
  }
}

// Four whole native leaves and four complete scalar-peer records can establish
// their own closed frame inside detector padding. This proof keeps the original
// body lane owners, even when a detector midpoint misowns a complete header.
// It does not change the generic proximity or header-owner guards above.
function recoverAboveCaptionPhysicalLeaves(table, items, captions, rules) {
  const crop = table.cropRect,
    columns = table.structure?.objects?.filter((o) => o.label === 'table column')
  if (
    table.readingRotation !== 0 ||
    !crop?.every(Number.isFinite) ||
    columns?.length !== 4 ||
    columns.some((o) => !o.rect?.every(Number.isFinite))
  )
    return
  const near = items.filter(
    (i) =>
      i.horizontal &&
      i.text.trim() &&
      i.rect[0] < crop[2] &&
      i.rect[2] > crop[0] &&
      i.rect[1] < crop[3] &&
      i.rect[3] > crop[1]
  )
  const heights = near.map((i) => i.height).sort((a, b) => a - b),
    height = heights[heights.length >> 1]
  if (!Number.isFinite(height) || height <= 0) return
  const edges = joinHorizontalTableRules(rules).filter(
    (r) =>
      r.every(Number.isFinite) &&
      r[0] >= crop[0] &&
      r[2] <= crop[2] &&
      r[2] > r[0] &&
      r[1] >= crop[1] - height &&
      r[1] <= crop[3]
  )
  if (
    edges.length !== 3 ||
    edges.some((r) => Math.abs(r[0] - edges[0][0]) > 0.1 || Math.abs(r[2] - edges[0][2]) > 0.1)
  )
    return
  const frame = [edges[0][0], edges[0][1], edges[0][2], edges[2][1]]
  if (Math.abs(frame[1] - crop[1]) > height || crop[3] - frame[3] > height * 2) return
  const context = proveNativeHeaderFrame({ ...table, cropRect: frame }, items, captions, rules)
  if (!context || context.belowCaption || context.edges.length !== 3) return
  const above = captions.filter(
    (c) =>
      captionKind(c.lines[0]) === 'table' &&
      c.rect.every(Number.isFinite) &&
      c.rect[3] <= frame[1] &&
      frame[1] - c.rect[3] < height * 4 &&
      c.rect[0] < frame[2] &&
      c.rect[2] > frame[0]
  )
  if (above.length !== 1) return
  const caption = above[0],
    parts = items.filter(
      (i) =>
        i.horizontal &&
        i.text.trim() &&
        i.rect[0] >= caption.rect[0] - 0.1 &&
        i.rect[2] <= caption.rect[2] + 0.1 &&
        i.rect[1] >= caption.rect[1] - 0.1 &&
        i.rect[3] <= caption.rect[3] + 0.1
    ),
    literal = (s) => s.replace(/\s+/g, '')
  if (
    !parts.length ||
    literal(parts.map((i) => i.text).join('')) !== literal(caption.lines.join(''))
  )
    return
  const origins = new Set()
  for (const i of [...parts, ...context.source]) {
    const s = i.sourceItem,
      key = s && `${s.pageNumber}:${s.index}`
    if (
      !i.rect.every(Number.isFinite) ||
      !Number.isFinite(i.baseline) ||
      !Number.isFinite(i.height) ||
      i.height <= 0 ||
      i.inlineSymbol ||
      !s ||
      !Number.isInteger(s.pageNumber) ||
      s.pageNumber !== caption.page ||
      !Number.isInteger(s.index) ||
      s.index < 0 ||
      s.text !== i.text ||
      origins.has(key)
    )
      return
    origins.add(key)
  }
  const head = context.source.filter((i) => i.baseline < edges[1][1]),
    body = groupSourceRowsWithScripts(
      context.source.filter((i) => !head.includes(i)),
      height,
      0.2
    )
  if (head.length !== 4 || !body || body.length < 4 || body.some((g) => g.length !== 4)) return
  // Preserve detector coordinates when the reusable compound proof compares
  // old body ownership with the new complete native gutters.
  return recoverCompoundPhysicalLeafGrid(table, { ...context, crop }, true)
}

// A single physical header baseline has independent ink clusters. Move a
// detector cut only when it actually splits one such cluster, and every body
// glyph keeps its original lane. Sparse stubs additionally need repeated native
// full-width section boundaries and one flush label per section.
function recoverCompoundPhysicalLeafGrid(table, context, wholeLeafCut = false) {
  const { crop, height, edges, frame, source } = context
  const divider = edges[1]
  if (divider[1] - frame[1] > height * 3) return
  const head = source.filter((i) => i.baseline < divider[1]),
    body = source.filter((i) => !head.includes(i)),
    records = groupSourceRowsWithScripts(body, height, 0.2)
  if (
    !head.length ||
    !records ||
    records.length < 4 ||
    Math.max(...head.map((i) => i.baseline)) - Math.min(...head.map((i) => i.baseline)) >
      height * 0.2
  )
    return
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length < 4 || columns.length > 12) return
  const original = [
    frame[0] - 0.1,
    ...columns.slice(1).map((c, n) => crop[0] + (columns[n].rect[2] + c.rect[0]) / 2),
    frame[2] + 0.1
  ]
  if (original.some((x, n) => !Number.isFinite(x) || (n && x <= original[n - 1]))) return
  const clusters = []
  for (const i of [...head].sort((a, b) => a.rect[0] - b.rect[0])) {
    const last = clusters.at(-1)
    if (last && i.rect[0] - Math.max(...last.map((a) => a.rect[2])) < height * 0.45) last.push(i)
    else clusters.push([i])
  }
  if (clusters.length !== columns.length) return
  const col = (i, cuts) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const splitLeaf = clusters.some((g, c) =>
    g.some(
      (i) =>
        col(i, original) !== c ||
        (wholeLeafCut && (i.rect[0] < original[c] || i.rect[2] > original[c + 1]))
    )
  )
  const headerBodySpan = (table.spans ?? []).some((s) => {
    const r = s.rect.map((x, n) => x + crop[n % 2])
    const contains = (i) =>
      i.rect[0] >= r[0] && i.rect[2] <= r[2] && i.baseline >= r[1] && i.baseline <= r[3]
    return (
      r[2] <= original[1] + 0.1 &&
      r[1] < divider[1] &&
      r[3] > divider[1] &&
      clusters[0].every(contains) &&
      body.some((i) => col(i, original) === 0 && contains(i))
    )
  })
  if (!splitLeaf && !headerBodySpan) return
  const owned = body.map((i) => col(i, original))
  if (owned.some((c) => c < 0)) return
  const cuts = [frame[0] - 0.1]
  for (let c = 1; c < columns.length; c++) {
    const left = Math.max(
        ...[...clusters[c - 1], ...body.filter((_, n) => owned[n] === c - 1)].map((i) => i.rect[2])
      ),
      right = Math.min(
        ...[...clusters[c], ...body.filter((_, n) => owned[n] === c)].map((i) => i.rect[0])
      )
    if (right - left < height * 0.45) return
    cuts.push((left + right) / 2)
  }
  cuts.push(frame[2] + 0.1)
  const values = records.map((g) => readSourceRow(g, cuts))
  const scalar = (x) => /^[<>≤≥−–+-]?\d[\d.,%]*$/.test(x)
  if (
    values.some((v) => !v || v.filter(scalar).length < 2) ||
    body.some((i, n) => col(i, cuts) !== owned[n]) ||
    !hasUniqueRecordTokens(source, [head, ...records])
  )
    return
  const spans = []
  for (let c = 0; c < columns.length; c++) {
    if (values.every((v) => v[c])) continue
    if (edges.length < 4 || c > 1) return
    const groups = edges
      .slice(1, -1)
      .map((r, n) =>
        records
          .map((g, row) => (g[0].baseline > r[1] && g[0].baseline < edges[n + 2][1] ? row : -1))
          .filter((row) => row >= 0)
      )
    if (
      groups.length < 2 ||
      groups.some(
        (g) => g.length < 3 || !values[g[0]][c] || g.slice(1).some((row) => values[row][c])
      )
    )
      return
    for (const g of groups) spans.push({ row: g[0] + 1, column: c, rowSpan: g.length, colSpan: 1 })
  }
  const bands = sourceBodyBands(records, frame, divider[1])
  if (!bands || !readSourceRow(head, cuts)?.every(Boolean)) return
  // Caption distance follows owned body ink, while the rendering crop retains
  // the independent footer. A below-caption font box may overhang that stroke.
  bands.at(-1)[3] = Math.max(...records.at(-1).map((i) => i.rect[3]))
  return {
    rows: [[frame[0] - 0.1, frame[1], frame[2] + 0.1, divider[1]], ...bands],
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
    headerRows: [0],
    spans,
    completeSpans: true,
    ownedTokens: new Set(source),
    cropRect: [frame[0], frame[1] - 0.5, frame[2], frame[3] + 0.5]
  }
}

function recoverRuledProseHeaderGrid(table, context) {
  const { crop, height, edges, opening, frame, source } = context
  const cols = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (
    cols.length !== 3 ||
    edges.length < 5 ||
    edges.length > 10 ||
    edges.some((r) => Math.abs(r[0] - opening[0]) > 0.5 || Math.abs(r[2] - opening[2]) > 0.5) ||
    edges[1][1] - opening[1] > height * 2
  )
    return
  const cuts = [
    frame[0] - 0.1,
    ...cols.slice(1).map((c, n) => crop[0] + (cols[n].rect[2] + c.rect[0]) / 2),
    frame[2] + 0.1
  ]
  if (cuts.some((x, n) => !Number.isFinite(x) || (n && x <= cuts[n - 1]))) return
  const records = edges
    .slice(1)
    .map((r, n) => source.filter((i) => i.baseline > edges[n][1] && i.baseline < r[1]))
  if (
    !hasUniqueRecordTokens(source, records) ||
    records.some((g) => {
      const v = readSourceRow(g, cuts)
      return !v || v.some((x) => !x || !/\p{L}/u.test(x))
    })
  )
    return
  const header = records[0]
  if (
    Math.max(...header.map((i) => i.baseline)) - Math.min(...header.map((i) => i.baseline)) >
      height * 0.1 ||
    records
      .slice(1)
      .some(
        (g) =>
          Math.max(...g.map((i) => i.baseline)) - Math.min(...g.map((i) => i.baseline)) < height
      )
  )
    return
  // Baselines establish native faces; complete glyph centers must agree so the
  // renderer never borrows a tail from the adjoining physical record.
  if (
    records.some((g, n) =>
      g.some(
        (i) =>
          (i.rect[1] + i.rect[3]) / 2 <= edges[n][1] ||
          (i.rect[1] + i.rect[3]) / 2 >= edges[n + 1][1]
      )
    )
  )
    return
  return {
    rows: edges.slice(1).map((r, n) => [frame[0] - 0.1, edges[n][1], frame[2] + 0.1, r[1]]),
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
    headerRows: [0],
    spans: [],
    completeSpans: true,
    ownedTokens: new Set(source),
    cropRect: frame
  }
}

function recoverAlignedLeafHeaderGrid(table, context) {
  const { height, edges, opening, frame, source } = context
  if (edges.length !== 3) return
  const divider = edges[1]
  if (divider[1] - opening[1] > height * 3) return
  const head = source.filter((i) => i.baseline < divider[1]),
    body = source.filter((i) => !head.includes(i)),
    records = groupSourceRowsWithScripts(body, height, 0.2)
  if (!head.length || !records || records.length < 4) return
  const lanes = records.map((g) => {
    const clusters = []
    for (const i of [...g].sort((a, b) => a.rect[0] - b.rect[0])) {
      const last = clusters.at(-1)
      if (last && i.rect[0] - Math.max(...last.map((a) => a.rect[2])) < height * 0.45) last.push(i)
      else clusters.push([i])
    }
    return clusters
  })
  const width = lanes[0].length
  if (table.structure.objects.filter((o) => o.label === 'table column').length === width) return
  if (
    width < 5 ||
    width > 12 ||
    lanes.some(
      (row) =>
        row.length !== width ||
        row.filter((g) => /^[−+-]?\d[\d.,]*$/.test(g.map((i) => i.text).join(''))).length < 3
    )
  )
    return
  const headGroups = []
  for (const i of [...head].sort((a, b) => a.rect[0] - b.rect[0])) {
    const last = headGroups.at(-1)
    if (last && i.rect[0] - Math.max(...last.map((a) => a.rect[2])) < height * 0.45) last.push(i)
    else headGroups.push([i])
  }
  if (headGroups.length !== width) return
  const cuts = [frame[0] - 0.1]
  for (let c = 1; c < width; c++) {
    const left = Math.max(
        ...[headGroups[c - 1], ...lanes.map((row) => row[c - 1])].flat().map((i) => i.rect[2])
      ),
      right = Math.min(
        ...[headGroups[c], ...lanes.map((row) => row[c])].flat().map((i) => i.rect[0])
      )
    if (right - left < height * 0.45) return
    cuts.push((left + right) / 2)
  }
  cuts.push(frame[2] + 0.1)
  const header = readSourceRow(head, cuts)
  if (
    !header ||
    header.some((v) => !v) ||
    records.some((g) => !readSourceRow(g, cuts)) ||
    !hasUniqueRecordTokens(source, [head, ...records])
  )
    return
  const bands = sourceBodyBands(records, frame, divider[1])
  if (!bands) return
  return {
    rows: [[frame[0] - 0.1, frame[1], frame[2] + 0.1, divider[1]], ...bands],
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
    headerRows: [0],
    spans: [],
    completeSpans: true,
    ownedTokens: new Set(source),
    cropRect: frame
  }
}

// A centered stub may name several records. Native full-width separators, or
// repeated leading separated by one unique larger gap, bound its scope.
function recoverCenteredGroupStubGrid(table, context) {
  const { crop, height, edges, opening, frame, source } = context
  const cols = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (cols.length < 4 || cols.length > 10) return
  const cuts = [
    frame[0] - 0.1,
    ...cols.slice(1).map((c, n) => crop[0] + (cols[n].rect[2] + c.rect[0]) / 2),
    frame[2] + 0.1
  ]
  if (cuts.some((x, n) => !Number.isFinite(x) || (n && x <= cuts[n - 1]))) return
  const divider = edges[1]
  if (divider[1] - opening[1] > height * 3) return
  const head = source.filter((i) => i.baseline < divider[1]),
    allBody = source.filter((i) => !head.includes(i))
  if (!head.length || !readSourceRow(head, cuts)) return
  const stubs = allBody.filter((i) => i.rect[0] >= cuts[0] && i.rect[2] <= cuts[1]),
    data = allBody.filter((i) => !stubs.includes(i))
  if (!stubs.length) return
  const records = groupSourceRowsWithScripts(data, height, 0.2)
  const scalar = (x) => /^[<>≤≥−–+-]?\d[\d.,%]*$/.test(x)
  if (
    !records ||
    records.length < 6 ||
    records.some((g) => {
      const v = readSourceRow(g, cuts)
      return !v || v.filter(scalar).length < 3 || v[0] || v.slice(2).some((x) => !scalar(x))
    })
  )
    return
  const labels = groupSourceRowsWithScripts(stubs, height, 0.2)
  if (!labels || labels.length < 2 || labels.length > 5) return
  const ys = records.map((g) => g.find((i) => i.height >= height * 0.8)?.baseline)
  if (ys.some((y) => !Number.isFinite(y))) return
  const gaps = ys.slice(1).map((y, n) => y - ys[n]),
    leading = Math.min(...gaps)
  if (leading < height || leading > height * 1.8) return
  const groups = []
  if (edges.length > 3) {
    for (let n = 1; n < edges.length - 1; n++)
      groups.push(
        records
          .map((g, r) => (ys[r] > edges[n][1] && ys[r] < edges[n + 1][1] ? r : -1))
          .filter((r) => r >= 0)
      )
  } else {
    let group = []
    for (let r = 0; r < records.length; r++) {
      if (r && gaps[r - 1] > leading * 1.3) {
        groups.push(group)
        group = []
      } else if (r && Math.abs(gaps[r - 1] - leading) > height * 0.1) return
      if (r && gaps[r - 1] > leading * 2) return
      group.push(r)
    }
    groups.push(group)
  }
  if (
    groups.length !== labels.length ||
    groups.some((g) => g.length < 3) ||
    groups.flat().length !== records.length
  )
    return
  const owners = []
  for (let n = 0; n < groups.length; n++) {
    const g = groups[n],
      lo = ys[g[0]],
      hi = ys[g.at(-1)],
      label = labels[n]
    if (
      Math.abs((lo + hi) / 2 - label[0].baseline) > height * 0.1 ||
      g.slice(1).some((r, k) => Math.abs(ys[r] - ys[g[k]] - leading) > height * 0.1)
    )
      return
    owners.push(label)
  }
  if (!hasUniqueRecordTokens(source, [head, ...records, ...owners])) return
  const bands = sourceBodyBands(records, frame, divider[1])
  if (!bands) return
  return {
    rows: [[frame[0] - 0.1, frame[1], frame[2] + 0.1, divider[1]], ...bands],
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
    headerRows: [0],
    spans: groups.map((g) => ({ row: g[0] + 1, column: 0, rowSpan: g.length, colSpan: 1 })),
    completeSpans: true,
    ownedTokens: new Set(source),
    cropRect: frame
  }
}

function sourceBodyBands(records, frame, top) {
  const bounds = records.map((g) => [
    Math.min(...g.map((i) => (i.rect[1] + i.rect[3]) / 2)),
    Math.max(...g.map((i) => (i.rect[1] + i.rect[3]) / 2))
  ])
  if (
    bounds.some(
      (b, n) =>
        !b.every(Number.isFinite) ||
        b[0] <= top ||
        b[1] >= frame[3] ||
        (n && b[0] <= bounds[n - 1][1])
    )
  )
    return
  const edges = [top, ...bounds.slice(1).map((b, n) => (bounds[n][1] + b[0]) / 2), frame[3]]
  return records.map((_, n) => [frame[0] - 0.1, edges[n], frame[2] + 0.1, edges[n + 1]])
}

// Repeated literal separators delimit equal-sized numerical subgroups on every
// source baseline. Their wide gutters and uniquely centered parent ink prove
// a shared header scope without borrowing the model's phantom separator lane.
function recoverSeparatedNumericParentGrid(table, context) {
  const { crop, height, edges, opening, frame, source } = context
  const divider = edges.find((r) => r[1] > opening[1] + height && r[1] < opening[1] + height * 4)
  if (!divider) return
  const header = source.filter((i) => i.baseline < divider[1]),
    body = source.filter((i) => !header.includes(i))
  const records = groupSourceRowsWithScripts(body, height, 0.2)
  if (
    !records ||
    records.length < 3 ||
    !header.length ||
    !hasUniqueRecordTokens(source, [header, ...records])
  )
    return
  const scalar = (i) =>
    i.height >= height * 0.8 &&
    /^[−–+-]?\d[\d.,%]*$/.test(i.text) &&
    Math.abs(
      i.baseline -
        records.find((g) => g.includes(i))?.find((a) => a.height >= height * 0.8)?.baseline
    ) <
      height * 0.2
  const groups = []
  let firstNumericLeft, groupCuts
  for (const row of records) {
    const values = row
      .filter(
        (i) =>
          scalar(i) &&
          (firstNumericLeft === undefined || i.rect[0] >= firstNumericLeft - height * 2)
      )
      .sort((a, b) => a.rect[0] - b.rect[0])
    if (values.length < 4 || values.length > 20) return
    const separators = row
      .filter((i) => i.text === '|' && i.rect[0] > values[0].rect[0])
      .sort((a, b) => a.rect[0] - b.rect[0])
    const terms = [...values, ...separators].sort((a, b) => a.rect[0] - b.rect[0]),
      partition = []
    if (groupCuts) {
      for (let p = 0; p < groupCuts.length - 1; p++)
        partition.push(
          terms.filter((i) => i.rect[0] >= groupCuts[p] && i.rect[2] <= groupCuts[p + 1])
        )
      if (!hasUniqueRecordTokens(terms, partition)) return
    } else {
      for (const i of terms) {
        const last = partition.at(-1)
        if (last && i.rect[0] - last.at(-1).rect[2] < height * 0.65) last.push(i)
        else partition.push([i])
      }
    }
    if (partition.length < 2 || partition.length > 5) return
    const count = partition[0].filter(scalar).length
    if (
      count < 2 ||
      count > 4 ||
      partition.some(
        (g) => g.length !== count * 2 - 1 || g.some((i, n) => (n % 2 ? i.text !== '|' : !scalar(i)))
      ) ||
      partition.some((g, n) => n && g[0].rect[0] - partition[n - 1].at(-1).rect[2] < height)
    )
      return
    if (!groupCuts) {
      firstNumericLeft = values[0].rect[0]
      groupCuts = [
        firstNumericLeft - height * 2,
        ...partition.slice(1).map((g, n) => (partition[n].at(-1).rect[2] + g[0].rect[0]) / 2),
        frame[2] + 0.1
      ]
    }
    groups.push(partition)
  }
  const count = groups[0][0].filter(scalar).length,
    parents = groups[0].length
  if (groups.some((g) => g.length !== parents || g.some((p) => p.filter(scalar).length !== count)))
    return
  const heads = groupSourceRowsWithScripts(header, height, 0.2)
  if (!heads || heads.length !== 1) return
  const clusters = []
  for (const i of [...header].sort((a, b) => a.rect[0] - b.rect[0])) {
    const last = clusters.at(-1)
    if (last && i.rect[0] - Math.max(...last.map((a) => a.rect[2])) < height * 0.65) last.push(i)
    else clusters.push([i])
  }
  const stubCount = clusters.length - parents
  if (stubCount < 1 || stubCount > 2) return
  const boundaries = Array.from({ length: parents + 1 }, (_, n) => {
    if (!n) return Math.min(...groups.map((g) => g[0][0].rect[0]))
    if (n === parents) return frame[2] + 0.1
    return (
      (Math.max(...groups.map((g) => g[n - 1].at(-1).rect[2])) +
        Math.min(...groups.map((g) => g[n][0].rect[0]))) /
      2
    )
  })
  for (let p = 0; p < parents; p++) {
    const ink = clusters[stubCount + p],
      box = [Math.min(...ink.map((i) => i.rect[0])), Math.max(...ink.map((i) => i.rect[2]))]
    const centers = groups.map((g) => (g[p][0].rect[0] + g[p].at(-1).rect[2]) / 2)
    if (
      box[0] < boundaries[p] ||
      box[1] > boundaries[p + 1] ||
      Math.abs((box[0] + box[1]) / 2 - centers[0]) > height ||
      Math.max(...centers) - Math.min(...centers) > height
    )
      return
  }
  const numericStart = Math.min(...groups.map((g) => g[0][0].rect[0]))
  const stubGroups = records.map((row) => row.filter((i) => i.rect[2] < numericStart))
  const stubCuts = []
  for (let c = 0; c < stubCount; c++) {
    if (!c) {
      stubCuts.push(frame[0] - 0.1)
      continue
    }
    const predicted = table.structure.objects
      .filter((o) => o.label === 'table column')
      .sort((a, b) => a.rect[0] - b.rect[0])
    const cut = crop[0] + (predicted[c - 1].rect[2] + predicted[c].rect[0]) / 2
    if (!Number.isFinite(cut) || cut <= stubCuts.at(-1) || cut >= numericStart) return
    stubCuts.push(cut)
  }
  const stubEnd = Math.max(...stubGroups.flat().map((i) => i.rect[2]))
  if (stubEnd >= numericStart - height * 0.5) return
  const cuts = [...stubCuts, (stubEnd + numericStart) / 2]
  for (let p = 0; p < parents; p++) {
    for (let c = 1; c < count; c++) {
      const left = Math.max(...groups.map((g) => g[p][c * 2 - 1].rect[2])),
        right = Math.min(...groups.map((g) => g[p][c * 2].rect[0]))
      if (left >= right) return
      cuts.push((left + right) / 2)
    }
    cuts.push(p === parents - 1 ? frame[2] + 0.1 : boundaries[p + 1])
  }
  if (records.some((row) => !readSourceRow(row, cuts))) return
  const spans = Array.from({ length: parents }, (_, p) => ({
    row: 0,
    column: stubCount + p * count,
    rowSpan: 1,
    colSpan: count
  }))
  for (let c = 0; c < stubCount; c++)
    if (clusters[c].some((i) => i.rect[0] < cuts[c] || i.rect[2] > cuts[c + 1])) return
  const rows = [
    [frame[0] - 0.1, frame[1], frame[2] + 0.1, divider[1]],
    ...records.map((g, n) => [
      frame[0] - 0.1,
      n
        ? (Math.max(...records[n - 1].map((i) => i.baseline)) +
            Math.min(...g.map((i) => i.baseline))) /
          2
        : divider[1],
      frame[2] + 0.1,
      records[n + 1]
        ? (Math.max(...g.map((i) => i.baseline)) +
            Math.min(...records[n + 1].map((i) => i.baseline))) /
          2
        : frame[3]
    ])
  ]
  return {
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
    headerRows: [0],
    spans,
    completeSpans: true,
    ownedTokens: new Set(source),
    cropRect: frame
  }
}

// Independent native parent strokes and complete repeated body baselines
// identify the leaf lanes. Horizontal source-run adjacency is used only for
// ownership; no literal text, number or script is rewritten by this plan.
function recoverUnderlinedSourceLeafGrid(context, rules, pairedScopes, singleFence = false) {
  const { height, edges: full, frame, source } = context
  const parents = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[0] >= frame[0] - 0.1 &&
        r[2] <= frame[2] + 0.1 &&
        r[2] - r[0] < (frame[2] - frame[0]) * 0.85 &&
        r[2] - r[0] > height * 3 &&
        r[1] > frame[1] + height * 0.5 &&
        r[1] < frame[1] + height * 3
    )
    .sort((a, b) => a[0] - b[0])
  if (
    !parents.length ||
    parents.length > 4 ||
    parents.some(
      (r, n) =>
        Math.abs(r[1] - parents[0][1]) > height * 0.1 || (n && r[0] < parents[n - 1][2] - 0.1)
    )
  )
    return
  const split = parents[0][1],
    dividers = full.filter((r) => r[1] > split + height * 0.5 && r[1] < frame[1] + height * 5)
  if (dividers.length !== 1) return
  const divider = dividers[0][1]
  const head = source.filter((i) => i.baseline < divider),
    body = source.filter((i) => !head.includes(i)),
    records = groupSourceRowsWithScripts(body, height, 0.2)
  if (
    !records ||
    records.length < 3 ||
    !head.length ||
    !hasUniqueRecordTokens(source, [head, ...records])
  )
    return
  const clusters = (parts) => {
    const groups = []
    for (const i of [...parts].sort((a, b) => a.rect[0] - b.rect[0])) {
      const last = groups.at(-1)
      if (last && i.rect[0] - Math.max(...last.map((a) => a.rect[2])) < height * 0.45) last.push(i)
      else groups.push([i])
    }
    return groups
  }
  const parentProof = [],
    leaves = []
  for (const stroke of parents) {
    const upper = head.filter(
      (i) =>
        i.baseline < stroke[1] &&
        i.rect[0] >= stroke[0] - height * 0.15 &&
        i.rect[2] <= stroke[2] + height * 0.15
    )
    const lower = head.filter(
      (i) =>
        i.baseline > stroke[1] &&
        (singleFence
          ? (i.rect[0] + i.rect[2]) / 2 > stroke[0] && (i.rect[0] + i.rect[2]) / 2 < stroke[2]
          : i.rect[0] >= stroke[0] - height * 0.15 && i.rect[2] <= stroke[2] + height * 0.15)
    )
    const leaf = clusters(lower)
    if (
      !upper.length ||
      leaf.length < 2 ||
      leaf.length > 5 ||
      Math.abs(
        (Math.min(...upper.map((i) => i.rect[0])) +
          Math.max(...upper.map((i) => i.rect[2])) -
          stroke[0] -
          stroke[2]) /
          2
      ) > height
    )
      return
    const start = leaves.length
    for (const g of leaf) leaves.push({ items: g, parent: parentProof.length })
    parentProof.push({ stroke, upper, start, count: leaf.length })
  }
  const reserved = parentProof.flatMap((p) => [
    ...p.upper,
    ...leaves.filter((l) => l.parent === parentProof.indexOf(p)).flatMap((l) => l.items)
  ])
  if (new Set(reserved).size !== reserved.length) return
  const remaining = head.filter((i) => !reserved.includes(i))
  for (const g of clusters(remaining)) leaves.push({ items: g, parent: -1 })
  leaves.sort(
    (a, b) =>
      Math.min(...a.items.map((i) => i.rect[0])) - Math.min(...b.items.map((i) => i.rect[0]))
  )
  if (leaves.length < 3 || leaves.length > 16) return
  if (
    pairedScopes &&
    (leaves.length !== 8 ||
      parentProof.length !== 2 ||
      parentProof.some((p) => p.count !== 3) ||
      leaves.slice(0, 2).some((l) => l.parent !== -1) ||
      leaves.slice(2).some((l, c) => l.parent !== (c < 3 ? 0 : 1)))
  )
    return
  const center = (l) =>
    (Math.min(...l.items.map((i) => i.rect[0])) + Math.max(...l.items.map((i) => i.rect[2]))) / 2
  const centers = leaves.map(center),
    owners = leaves.map((l) => [...l.items])
  const provisional = [
    frame[0] - 0.1,
    ...centers.slice(1).map((x, c) => (centers[c] + x) / 2),
    frame[2] + 0.1
  ]
  const ownRecords = []
  for (const record of records) {
    const cells = leaves.map(() => [])
    for (const g of clusters(record)) {
      const left = Math.min(...g.map((i) => i.rect[0])),
        right = Math.max(...g.map((i) => i.rect[2])),
        mid = (left + right) / 2
      const c = provisional.slice(1).findIndex((x) => mid < x)
      if (c < 0 || left < frame[0] - 0.1 || right > frame[2] + 0.1) return
      const p = leaves[c].parent >= 0 ? parentProof[leaves[c].parent] : undefined
      if (
        !singleFence &&
        p &&
        (left < p.stroke[0] - height * 0.15 || right > p.stroke[2] + height * 0.15)
      )
        return
      cells[c].push(...g)
      owners[c].push(...g)
    }
    const values = cells.map((g) => g.map((i) => i.text).join(''))
    if ((!values[0] && !pairedScopes) || values.filter((v) => /\d/.test(v)).length < 2) return
    if (
      pairedScopes &&
      ((!values[0] && !ownRecords.length) ||
        (values[0] && !/\p{L}/u.test(values[0])) ||
        !/\p{L}/u.test(values[1]) ||
        values.slice(2).some((v) => !/^\d+(?:\.\d+)?$/u.test(v)))
    )
      return
    ownRecords.push(cells)
  }
  if (owners.some((g, c) => ownRecords.filter((row) => row[c].length).length < 3)) return
  const cuts = [frame[0] - 0.1]
  for (let c = 1; c < leaves.length; c++) {
    const left = Math.max(...owners[c - 1].map((i) => i.rect[2])),
      right = Math.min(...owners[c].map((i) => i.rect[0]))
    if (left >= right) return
    if (pairedScopes && (c === 2 || c === 5)) {
      const edge = pairedScopes[c === 2 ? 0 : 1][0]
      if (edge <= left || edge >= right) return
      cuts.push(edge)
      continue
    }
    const native = parents
      .flatMap((r) => [r[0], r[2]])
      .filter((x) => x > left - 0.1 && x < right + 0.1)
    const unique = [...new Set(native)]
      .sort((a, b) => a - b)
      .filter((x, n, a) => !n || x - a[n - 1] > 0.1)
    if (unique.length > 1) return
    cuts.push(unique.length ? unique[0] : (left + right) / 2)
  }
  cuts.push(frame[2] + 0.1)
  if (records.some((row) => !readSourceRow(row, cuts))) return
  const insets = parentProof.flatMap((proof, p) => {
    const indices = leaves.map((l, c) => (l.parent === p ? c : -1)).filter((c) => c >= 0)
    return [proof.stroke[0] - cuts[indices[0]], cuts[indices.at(-1) + 1] - proof.stroke[2]]
  })
  const repeatedInset =
    parentProof.length >= 2 &&
    insets.every((x) => x >= height * 0.2 && x <= height * 0.6) &&
    Math.max(...insets) - Math.min(...insets) <= height * 0.1
  const spans = []
  for (let p = 0; p < parentProof.length; p++) {
    const indices = leaves.map((l, c) => (l.parent === p ? c : -1)).filter((c) => c >= 0),
      start = indices[0]
    if (indices.some((c, n) => c !== start + n)) return
    const proof = parentProof[p]
    if (
      !singleFence &&
      !repeatedInset &&
      (Math.abs(cuts[start] - proof.stroke[0]) > height * 0.2 ||
        Math.abs(cuts[start + indices.length] - proof.stroke[2]) > height * 0.2)
    )
      return
    spans.push({ row: 0, column: start, rowSpan: 1, colSpan: indices.length })
  }
  for (let c = 0; c < leaves.length; c++)
    if (leaves[c].parent < 0) spans.push({ row: 0, column: c, rowSpan: 2, colSpan: 1 })
  if (
    !hasUniqueRecordTokens(head, [
      ...parentProof.map((p) => p.upper),
      ...leaves.map((l) => l.items)
    ])
  )
    return
  const rows = [
    [frame[0] - 0.1, frame[1], frame[2] + 0.1, split],
    [frame[0] - 0.1, split, frame[2] + 0.1, divider],
    ...records.map((g, n) => [
      frame[0] - 0.1,
      n
        ? (Math.max(...records[n - 1].map((i) => i.baseline)) +
            Math.min(...g.map((i) => i.baseline))) /
          2
        : divider,
      frame[2] + 0.1,
      records[n + 1]
        ? (Math.max(...g.map((i) => i.baseline)) +
            Math.min(...records[n + 1].map((i) => i.baseline))) /
          2
        : frame[3]
    ])
  ]
  return {
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
    headerRows: [0, 1],
    spans,
    completeSpans: true,
    ownedTokens: new Set(source),
    cropRect: frame
  }
}

function recoverCenteredParentHeaderScopes(head, cuts, top, bottom, height, body) {
  const main = head.filter((i) => i.height >= height * 0.8),
    baselines = []
  for (const i of main) {
    if (!baselines.some((y) => Math.abs(i.baseline - y) < height * 0.2)) baselines.push(i.baseline)
  }
  if (
    baselines.length !== 2 ||
    baselines[1] - baselines[0] < height ||
    baselines[1] - baselines[0] > height * 2.5
  )
    return
  const upper = head.filter((i) => i.baseline < baselines[0] + height * 0.5),
    lower = head.filter((i) => !upper.includes(i)),
    leaf = readSourceRow(lower, cuts)
  if (!leaf || leaf.filter(Boolean).length < 4) return
  const clusters = []
  for (const i of [...upper].sort((a, b) => a.rect[0] - b.rect[0])) {
    const last = clusters.at(-1)
    if (last && i.rect[0] - Math.max(...last.map((a) => a.rect[2])) < height * 0.45) last.push(i)
    else clusters.push([i])
  }
  const column = (i, xs) => xs.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const oldCuts = [...cuts],
    bodyOwners = body.map((i) => column(i, cuts))
  const stubs = clusters
    .map((g) => ({
      g,
      c: column(
        {
          rect: [Math.min(...g.map((i) => i.rect[0])), 0, Math.max(...g.map((i) => i.rect[2])), 0]
        },
        cuts
      )
    }))
    .filter(({ c }) => c >= 0 && !leaf[c])
  for (const { c } of stubs)
    for (const boundary of [c, c + 1]) {
      if (boundary === 0 || boundary === cuts.length - 1) continue
      const left = [
        ...body.filter((i, n) => bodyOwners[n] === boundary - 1),
        ...lower.filter((i) => column(i, oldCuts) === boundary - 1),
        ...stubs.filter((s) => s.c === boundary - 1).flatMap((s) => s.g)
      ]
      const right = [
        ...body.filter((i, n) => bodyOwners[n] === boundary),
        ...lower.filter((i) => column(i, oldCuts) === boundary),
        ...stubs.filter((s) => s.c === boundary).flatMap((s) => s.g)
      ]
      if (!left.length || !right.length) return
      const end = Math.max(...left.map((i) => i.rect[2])),
        start = Math.min(...right.map((i) => i.rect[0]))
      if (end >= start) return
      if (end > cuts[boundary] || start < cuts[boundary]) cuts[boundary] = (end + start) / 2
    }
  if (body.some((i, n) => column(i, cuts) !== bodyOwners[n]) || !readSourceRow(lower, cuts)) return
  const spans = [],
    parents = []
  for (const group of clusters) {
    const l = Math.min(...group.map((i) => i.rect[0])),
      r = Math.max(...group.map((i) => i.rect[2])),
      center = (l + r) / 2
    const c = cuts.slice(1).findIndex((x) => center < x)
    if (c < 0) return
    if (!leaf[c] && l >= cuts[c] && r <= cuts[c + 1])
      spans.push({ row: 0, column: c, rowSpan: 2, colSpan: 1 })
    else parents.push(group)
  }
  if (parents.length < 2 || parents.length > 4) return
  const occupied = leaf.map((v, c) => (v ? c : -1)).filter((c) => c >= 0)
  if (occupied.some((c, n) => n && c !== occupied[n - 1] + 1)) return
  const answers = []
  const visit = (n, start, plan) => {
    if (n === parents.length) {
      if (start === occupied.at(-1) + 1) answers.push(plan)
      return
    }
    const group = parents[n],
      l = Math.min(...group.map((i) => i.rect[0])),
      r = Math.max(...group.map((i) => i.rect[2]))
    for (let end = start + 2; end <= occupied.at(-1) + 1; end++)
      if (
        l >= cuts[start] &&
        r <= cuts[end] &&
        Math.abs((l + r - cuts[start] - cuts[end]) / 2) < height * 0.8
      )
        visit(n + 1, end, [...plan, { row: 0, column: start, rowSpan: 1, colSpan: end - start }])
  }
  visit(0, occupied[0], [])
  if (
    answers.length !== 1 ||
    !hasUniqueRecordTokens(head, [
      ...clusters,
      ...cuts
        .slice(1)
        .map((_, c) => lower.filter((i) => i.rect[0] >= cuts[c] && i.rect[2] <= cuts[c + 1]))
        .filter((g) => g.length)
    ])
  )
    return
  const split =
    (Math.max(...upper.map((i) => i.baseline)) + Math.min(...lower.map((i) => i.baseline))) / 2
  return {
    rows: [
      [cuts[0], top, cuts.at(-1), split],
      [cuts[0], split, cuts.at(-1), bottom]
    ],
    spans: [...spans, ...answers[0]]
  }
}

function recoverNativeFullWidthSections(source, cuts, edges, frame, height) {
  const answers = []
  for (const edge of edges.filter(
    (r) => r[1] > frame[1] + height && r[1] < frame[1] + height * 5
  )) {
    const head = source.filter((i) => i.baseline < edge[1]),
      body = groupSourceRowsWithScripts(
        source.filter((i) => !head.includes(i)),
        height,
        0.2
      )
    if (!head.length || !body) continue
    const sections = [],
      sectionLines = []
    let measures = 0,
      valid = true
    for (let n = 0; n < body.length; n++) {
      const g = body[n],
        v = readSourceRow(g, cuts),
        scalar = (x) => /^(?:[<>≤≥−–+-]?\d[\d.,()[\]±−–+\-%*/=<>≤≥]*|[—–-])$/.test(x)
      if (v && v.filter(scalar).length >= 2 && v.slice(2).every((x) => !x || scalar(x))) {
        measures++
        continue
      }
      const line = [...g].sort((a, b) => a.rect[0] - b.rect[0]),
        left = line[0].rect[0],
        right = Math.max(...line.map((i) => i.rect[2])),
        last = n ? Math.max(...body[n - 1].map((i) => i.baseline)) : edge[1]
      const border = edges.filter(
        (r) =>
          r[1] >= last &&
          r[1] < Math.min(...g.map((i) => i.baseline)) &&
          Math.min(...g.map((i) => i.baseline)) - r[1] < height * 1.5
      )
      if (
        Math.abs(left - frame[0]) > height ||
        !g.some((i) => /\p{L}{4}/u.test(i.text)) ||
        border.length !== 1 ||
        line.some(
          (i, k) =>
            k && i.rect[0] - Math.max(...line.slice(0, k).map((a) => a.rect[2])) > height * 0.65
        ) ||
        Math.max(...g.filter((i) => i.height >= height * 0.8).map((i) => i.baseline)) -
          Math.min(...g.filter((i) => i.height >= height * 0.8).map((i) => i.baseline)) >
          height * 0.2
      ) {
        valid = false
        break
      }
      sections.push(n)
      sectionLines.push({ g, left, right })
    }
    // A short setting line inherits a full-width scope only from two other
    // independently ruled setting lines, with the same source size and inset.
    if (sectionLines.some((s) => s.right <= cuts[1])) {
      const peers = sectionLines.filter((s) => s.right > cuts[1])
      if (
        peers.length < 2 ||
        sectionLines.some(
          (s) =>
            Math.abs(s.left - peers[0].left) > height * 0.1 ||
            s.g.some(
              (i) =>
                Math.abs(i.height - peers[0].g[0].height) > height * 0.1 ||
                ((peers[0].g[0].font ?? peers[0].g[0].fontName) !== undefined &&
                  (i.font ?? i.fontName) !== (peers[0].g[0].font ?? peers[0].g[0].fontName))
            )
        )
      )
        valid = false
    }
    if (
      valid &&
      measures >= 3 &&
      sections.length >= 1 &&
      hasUniqueRecordTokens(source, [head, ...body])
    )
      answers.push({ head, body, sections })
  }
  return answers.length === 1 ? answers[0] : undefined
}

function recoverSingleTierParentScopes(head, cuts, body, height) {
  const grouped = groupSourceRowsWithScripts(head, height, 0.2)
  if (!grouped || grouped.length !== 1) return
  const clusters = []
  for (const i of [...head].sort((a, b) => a.rect[0] - b.rect[0])) {
    const last = clusters.at(-1)
    if (last && i.rect[0] - Math.max(...last.map((a) => a.rect[2])) < height * 0.45) last.push(i)
    else clusters.push([i])
  }
  const scalar = (x) => /^[<>≤≥−–+-]?\d[\d.,()[\]±−–+\-%*/=<>≤≥]*$/.test(x)
  const measured = body
    .map((g) => readSourceRow(g, cuts))
    .filter((v) => v && v.filter(scalar).length >= 2)
  if (measured.length < 3) return
  const leading = cuts.slice(1).findIndex((_, c) => measured.some((v) => scalar(v[c])))
  if (
    leading < 1 ||
    leading > 2 ||
    clusters.length >= cuts.length - 1 ||
    clusters.length - leading < 2
  )
    return
  for (let c = 0; c < leading; c++)
    if (clusters[c].some((i) => i.rect[0] < cuts[c] || i.rect[2] > cuts[c + 1])) return
  const parents = clusters.slice(leading),
    answers = []
  const visit = (n, start, plan) => {
    if (n === parents.length) {
      if (start === cuts.length - 1) answers.push(plan)
      return
    }
    const group = parents[n],
      l = Math.min(...group.map((i) => i.rect[0])),
      r = Math.max(...group.map((i) => i.rect[2]))
    for (let end = start + 2; end < cuts.length; end++)
      if (
        l >= cuts[start] &&
        r <= cuts[end] &&
        Math.abs((l + r - cuts[start] - cuts[end]) / 2) < height
      )
        visit(n + 1, end, [...plan, { row: 0, column: start, rowSpan: 1, colSpan: end - start }])
  }
  visit(0, leading, [])
  if (answers.length !== 1) return
  return {
    rows: [
      [
        cuts[0],
        Math.min(...head.map((i) => i.rect[1])),
        cuts.at(-1),
        Math.max(...head.map((i) => i.rect[3]))
      ]
    ],
    spans: answers[0]
  }
}

// A complete terminal numeric parent can share a header with categorical stub lanes.
// The caller has already proved the full native frame, whole font and caption.
function recoverSingleTerminalNumericParentHeader(table, items, context, rules) {
  const { source, frame, edges, height: h } = context
  const model = table.structure?.objects
    ?.filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (
    model?.length !== 6 ||
    edges.length !== 3 ||
    !source.length ||
    source.some(
      (i) =>
        i.height !== h ||
        i.sourceToken ||
        i.sourceSegment ||
        !i.sourceItem ||
        i.sourceItem.text !== i.text
    )
  )
    return
  const original = new Set(source.map((i) => `${i.sourceItem.pageNumber}:${i.sourceItem.index}`))
  if (
    original.size !== source.length ||
    source.some(
      (i) =>
        items.filter(
          (a) =>
            a.sourceItem?.pageNumber === i.sourceItem.pageNumber &&
            a.sourceItem?.index === i.sourceItem.index
        ).length !== 1
    )
  )
    return
  const head = source.filter((i) => i.baseline < edges[1][1]),
    body = groupSourceRowsWithScripts(
      source.filter((i) => !head.includes(i)),
      h,
      0.2
    )
  if (!body || body.length < 4 || body.length > 32) return
  const upperY = Math.min(...head.map((i) => i.baseline)),
    upper = head.filter((i) => Math.abs(i.baseline - upperY) < h * 0.2),
    lower = head.filter((i) => !upper.includes(i))
  if (upper.length !== 1 || !/\p{L}/u.test(upper[0].text) || !lower.length) return
  const lowerY = Math.min(...lower.map((i) => i.baseline))
  if (
    lower.some((i) => Math.abs(i.baseline - lowerY) >= h * 0.2) ||
    lowerY - upperY < h ||
    lowerY - upperY > h * 2.5 ||
    Math.max(...upper.map((i) => i.rect[3])) >= Math.min(...lower.map((i) => i.rect[1]))
  )
    return
  const oldCuts = [
    frame[0] - 0.1,
    ...model.slice(1).map((c, n) => table.cropRect[0] + (model[n].rect[2] + c.rect[0]) / 2),
    frame[2] + 0.1
  ]
  if (oldCuts.some((x, n) => !Number.isFinite(x) || (n && x <= oldCuts[n - 1]))) return
  const owner = (i, xs) => xs.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const leaves = model.map((_, c) => lower.filter((i) => owner(i, oldCuts) === c))
  if (
    leaves.slice(0, 3).some((g) => g.length !== 1 || !/\p{L}/u.test(g[0].text)) ||
    leaves.slice(3).some((g) => !g.length || g.length > 3)
  )
    return
  const dose = leaves.slice(3).map((g) =>
    /^(\d+(?:\.\d+)?)(\p{L}[\p{L}%/-]*)$/u.exec(
      g
        .sort((a, b) => a.rect[0] - b.rect[0])
        .map((i) => i.text)
        .join('')
        .replace(/\s/gu, '')
    )
  )
  if (
    dose.some((m) => !m) ||
    dose.some((m, n) => m[2] !== dose[0][2] || (n && Number(m[1]) <= Number(dose[n - 1][1])))
  )
    return
  const scalar = (s) => /^[<>≤≥−–+-]?\d[\d.,%]*$/.test(s),
    categorical = (s) => /^\p{L}[\p{L}\p{N}-]{0,15}(?: \p{L}[\p{L}\p{N}-]{0,15})?$/u.test(s)
  const records = body.map((g) => model.map((_, c) => g.filter((i) => owner(i, oldCuts) === c)))
  if (
    body.some((g) => g.length !== 6) ||
    records.some(
      (r) =>
        r.some((g) => g.length !== 1) ||
        !/\p{L}/u.test(r[0][0].text) ||
        r[0][0].text.length > 80 ||
        /[.!?;]/u.test(r[0][0].text) ||
        !scalar(r[1][0].text) ||
        !categorical(r[2][0].text) ||
        r.slice(3).some((g) => !scalar(g[0].text))
    )
  )
    return
  const categories = records.map((r) => r[2][0].text)
  if (
    new Set(records.map((r) => r[0][0].text)).size !== body.length ||
    new Set(categories).size < 2 ||
    [...new Set(categories)].some((v) => categories.filter((s) => s === v).length < 2)
  )
    return
  const lanes = model.map((_, c) => [...leaves[c], ...records.flatMap((r) => r[c])]),
    cuts = [frame[0] - 0.1]
  for (let c = 1; c < 6; c++) {
    const end = Math.max(...lanes[c - 1].map((i) => i.rect[2])),
      start = Math.min(...lanes[c].map((i) => i.rect[0]))
    if (start - end < h * 0.45) return
    cuts.push((end + start) / 2)
  }
  cuts.push(frame[2] + 0.1)
  if (
    lanes.some((g, c) =>
      g.some(
        (i) =>
          i.rect[0] < cuts[c] || i.rect[2] > cuts[c + 1] || owner(i, cuts) !== owner(i, oldCuts)
      )
    )
  )
    return
  const parent = upper[0]
  if (
    parent.rect[0] < cuts[3] ||
    parent.rect[2] > cuts[6] ||
    parent.rect[0] >= cuts[4] ||
    parent.rect[2] <= cuts[5] ||
    Math.abs(
      (parent.rect[0] +
        parent.rect[2] -
        Math.min(...leaves[3].map((i) => i.rect[0])) -
        Math.max(...leaves[5].map((i) => i.rect[2]))) /
        2
    ) >=
      h * 0.8
  )
    return
  if (
    rules.some(
      (r) =>
        r[1] === r[3] && r[0] > frame[0] && r[2] < frame[2] && r[1] > frame[1] && r[1] < edges[1][1]
    ) ||
    rules.some(
      (r) =>
        r[0] === r[2] && r[0] > frame[0] && r[0] < frame[2] && r[1] < edges[1][1] && r[3] > frame[1]
    )
  )
    return
  const bands = sourceBodyBands(body, frame, edges[1][1]),
    split = (parent.rect[3] + Math.min(...lower.map((i) => i.rect[1]))) / 2
  if (!bands || !hasUniqueRecordTokens(source, [upper, lower, ...body])) return
  return {
    rows: [[cuts[0], frame[1], cuts[6], split], [cuts[0], split, cuts[6], edges[1][1]], ...bands],
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
    headerRows: [0, 1],
    spans: [
      ...[0, 1, 2].map((column) => ({ row: 0, column, rowSpan: 2, colSpan: 1 })),
      { row: 0, column: 3, rowSpan: 1, colSpan: 3 }
    ],
    completeSpans: true,
    ownedTokens: new Set(source),
    cropRect: table.cropRect,
    repair: 'native-body-records-recovered'
  }
}

// A native common parent can remain in one detector slot while its complete
// original font and two independent underlines establish a closed group scope.
// This proposes only a span for an already owned whole Source; it assigns none.
export function recoverNativeOwnedGroupedParentSpan({
  cells,
  rows,
  columns,
  items,
  headerRows,
  rules,
  nativeContext
}) {
  if (
    !Array.isArray(cells) ||
    !Array.isArray(rows) ||
    rows.length < 5 ||
    rows.length > 34 ||
    columns?.length !== 7 ||
    headerRows?.length !== 2 ||
    headerRows[0] !== 0 ||
    headerRows[1] !== 1 ||
    !Array.isArray(items) ||
    !Array.isArray(rules) ||
    cells.length !== rows.length * columns.length ||
    cells.some((c) => c.rowSpan !== 1 || c.colSpan !== 1 || c.sourceSegments !== undefined)
  )
    return
  const slots = new Set(cells.map((c) => `${c.row}:${c.column}`))
  if (
    slots.size !== cells.length ||
    cells.some(
      (c) =>
        !Number.isInteger(c.row) ||
        !Number.isInteger(c.column) ||
        c.row < 0 ||
        c.row >= rows.length ||
        c.column < 0 ||
        c.column >= 7
    )
  )
    return
  const center = (r) => (r[0] + r[2]) / 2,
    identity = (s) =>
      s && Number.isInteger(s.pageNumber) && Number.isInteger(s.index)
        ? `${s.pageNumber}:${s.index}`
        : undefined,
    same = (a, b) =>
      identity(a.sourceItem) === identity(b.sourceItem) &&
      a.text === b.text &&
      a.rect?.length === 4 &&
      b.rect?.length === 4 &&
      a.rect.every((x, n) => x === b.rect[n])
  const claims = (c) => c.sourceItems ?? []
  const upper = cells.filter((c) => c.row === 0 && c.text?.trim())
  if (
    upper.length !== 2 ||
    upper.some(
      (c) =>
        c.sourceTokens?.length !== 1 ||
        c.sourceItems?.length !== 1 ||
        c.sourceSegments?.length ||
        c.text !== c.sourceTokens[0].text ||
        !/\p{L}/u.test(c.text)
    )
  )
    return
  const upperTokens = upper.map((c) =>
    items.find((i) => identity(i.sourceItem) === identity(c.sourceItems[0]))
  )
  if (upperTokens.some((i) => !i)) return
  const h = upperTokens[0].height
  if (
    !(h > 0) ||
    upperTokens.some(
      (t) =>
        t.height !== h ||
        t.sourceItem.text !== t.text ||
        !t.rect?.every(Number.isFinite) ||
        !Number.isFinite(t.baseline) ||
        items.filter((i) => same(i, t)).length !== 1 ||
        cells.filter((c) => claims(c).some((i) => identity(i) === identity(t.sourceItem)))
          .length !== 1 ||
        upper.some(
          (c) =>
            identity(c.sourceItems[0]) === identity(t.sourceItem) &&
            !c.sourceTokens.some(
              (a) =>
                a.text === t.text &&
                a.baseline === t.baseline &&
                a.height === t.height &&
                a.rect.every((x, n) => x === t.rect[n])
            )
        )
    )
  )
    return
  if (Math.abs(upperTokens[0].baseline - upperTokens[1].baseline) > h * 0.1) return
  const horizontal = joinHorizontalTableRules(rules),
    left = columns[0].rect[0],
    right = columns.at(-1).rect[2],
    full = horizontal.filter(
      (r) =>
        r.every(Number.isFinite) &&
        Math.abs(r[0] - left) < h * 0.5 &&
        Math.abs(r[2] - right) < h * 0.5
    ),
    top = Math.min(...upperTokens.map((t) => t.rect[1])),
    bottom = rows[1].rect[3],
    openings = full.filter((r) => r[1] < top && top - r[1] < h),
    dividers = full.filter((r) => r[1] >= bottom && r[1] - bottom < h)
  if (openings.length !== 1 || dividers.length !== 1) return
  const opening = openings[0],
    divider = dividers[0]
  if (Math.abs(opening[0] - divider[0]) > 0.1 || Math.abs(opening[2] - divider[2]) > 0.1) return
  const frame = [opening[0], opening[1], opening[2], divider[1]],
    head = items.filter(
      (i) =>
        i.horizontal &&
        i.text?.trim() &&
        i.rect[0] < frame[2] &&
        i.rect[2] > frame[0] &&
        i.rect[1] < frame[3] &&
        i.rect[3] > frame[1]
    )
  if (
    head.length !== 7 ||
    head.some(
      (i) =>
        !i.sourceItem ||
        i.sourceToken ||
        i.sourceSegment ||
        i.sourceItem.text !== i.text ||
        i.height !== h ||
        i.rect[0] < frame[0] ||
        i.rect[2] > frame[2] ||
        i.rect[1] < frame[1] ||
        i.rect[3] > frame[3]
    ) ||
    new Set(head.map((i) => identity(i.sourceItem))).size !== 7 ||
    !proveTwoTierWholeFontPacket(head, frame, nativeContext)
  )
    return
  const upperY = upperTokens[0].baseline,
    lower = head.filter((i) => !upperTokens.some((t) => same(i, t)))
  if (
    lower.length !== 5 ||
    lower.some(
      (i) =>
        i.baseline - upperY < h ||
        i.baseline - upperY > h * 2.5 ||
        Math.abs(i.baseline - lower[0].baseline) > h * 0.1
    )
  )
    return
  const strokes = horizontal.filter(
    (r) =>
      r[0] > frame[0] &&
      r[2] < frame[2] &&
      r[1] > Math.max(...upperTokens.map((t) => t.rect[3])) &&
      r[1] < Math.min(...lower.map((t) => t.rect[1]))
  )
  if (strokes.length !== 2 || Math.abs(strokes[0][1] - strokes[1][1]) > 0.1) return
  strokes.sort((a, b) => a[0] - b[0])
  if (strokes[0][2] >= strokes[1][0]) return
  const centers = columns.map((c) => center(c.rect)),
    scopes = strokes.map((r) =>
      centers.map((x, c) => (x >= r[0] && x <= r[2] ? c : -1)).filter((c) => c >= 0)
    )
  if (
    scopes[0].length !== 1 ||
    scopes[0][0] !== 1 ||
    scopes[1].length !== 5 ||
    scopes[1].some((c, n) => c !== n + 2)
  )
    return
  const owners = strokes.map((r) =>
    upper.filter(
      (c) =>
        Math.abs(center(upperTokens[upper.indexOf(c)].rect) - center(r)) < h * 0.1 &&
        upperTokens[upper.indexOf(c)].rect[0] >= r[0] - h * 0.5 &&
        upperTokens[upper.indexOf(c)].rect[2] <= r[2] + h * 0.5
    )
  )
  if (
    owners.some((a) => a.length !== 1) ||
    owners[0][0] === owners[1][0] ||
    owners[0][0].column !== 1 ||
    !scopes[1].includes(owners[1][0].column)
  )
    return
  const parent = owners[1][0],
    covered = cells.filter((c) => c.row === 0 && c.column >= 2 && c.column <= 6),
    emptyKeys = new Set([
      'row',
      'column',
      'rowSpan',
      'colSpan',
      'rect',
      'text',
      'sourceTokens',
      'sourceRects',
      'origin'
    ])
  if (
    covered.length !== 5 ||
    covered.some(
      (c) =>
        c !== parent &&
        (c.text !== '' ||
          c.sourceTokens?.length ||
          c.sourceRects?.length ||
          c.origin !== 'model-grid' ||
          Reflect.ownKeys(c).some((k) => !emptyKeys.has(k)))
    )
  )
    return
  const leafOrder = lower.slice().sort((a, b) => a.rect[0] - b.rect[0]),
    compound = leafOrder[2]
  if (
    !same(
      leafOrder[0],
      items.find((i) => identity(i.sourceItem) === identity(leafOrder[0].sourceItem))
    ) ||
    leafOrder[0].rect[0] < frame[0] ||
    leafOrder[0].rect[2] >= centers[1] ||
    leafOrder[1].rect[0] <= centers[0] ||
    ![1].every((c) => centers[c] >= leafOrder[1].rect[0] && centers[c] <= leafOrder[1].rect[2])
  )
    return
  const leafRuns = leafOrder
    .slice(2)
    .map((i) =>
      centers.map((x, c) => (x >= i.rect[0] && x <= i.rect[2] ? c : -1)).filter((c) => c >= 0)
    )
  if (
    leafRuns[0].length !== 3 ||
    leafRuns[0].some((c, n) => c !== n + 2) ||
    leafRuns[1].length !== 1 ||
    leafRuns[1][0] !== 5 ||
    leafRuns[2].length !== 1 ||
    leafRuns[2][0] !== 6 ||
    cells.some((c) => claims(c).some((t) => identity(t) === identity(compound.sourceItem)))
  )
    return
  const closing = full.filter((r) => r[1] > rows.at(-1).rect[3] && r[1] - rows.at(-1).rect[3] < h)
  if (
    closing.length !== 1 ||
    Math.abs(closing[0][0] - frame[0]) > 0.1 ||
    Math.abs(closing[0][2] - frame[2]) > 0.1
  )
    return
  const nativeBody = items.filter(
    (i) =>
      i.horizontal &&
      i.text?.trim() &&
      i.baseline > divider[1] &&
      i.baseline < closing[0][1] &&
      i.rect[0] >= frame[0] &&
      i.rect[2] <= frame[2]
  )
  const sourceById = new Map(nativeBody.map((i) => [identity(i.sourceItem), i]))
  if (!nativeBody.length || sourceById.size !== nativeBody.length || sourceById.has(undefined))
    return
  const allIntersecting = items.filter(
    (i) =>
      i.horizontal &&
      i.text?.trim() &&
      i.rect[0] < frame[2] &&
      i.rect[2] > frame[0] &&
      i.rect[1] < closing[0][1] &&
      i.rect[3] > frame[1]
  )
  if (
    !proveTwoTierWholeFontPacket(
      allIntersecting,
      [frame[0], frame[1], frame[2], closing[0][1]],
      nativeContext
    )
  )
    return
  const groups = [
      [leafOrder[0]],
      [
        upperTokens.find((t) => identity(t.sourceItem) === identity(owners[0][0].sourceItems[0])),
        leafOrder[1]
      ],
      [
        upperTokens.find((t) => identity(t.sourceItem) === identity(parent.sourceItems[0])),
        ...leafOrder.slice(2)
      ]
    ],
    owned = new Map()
  for (let row = 2; row < rows.length; row++) {
    const present = new Set()
    for (const c of cells.filter((c) => c.row === row))
      for (const s of claims(c)) {
        const key = identity(s),
          raw = sourceById.get(key),
          group = c.column === 0 ? 0 : c.column === 1 ? 1 : 2
        if (!raw || raw.sourceItem.text !== s.text || (owned.has(key) && owned.get(key) !== group))
          return
        owned.set(key, group)
        present.add(group)
      }
    if (present.size !== 3) return
  }
  if (owned.size !== nativeBody.length) return
  for (const [key, group] of owned) groups[group].push(sourceById.get(key))
  const cuts = [frame[0]]
  for (let n = 1; n < 3; n++) {
    const end = Math.max(...groups[n - 1].map((i) => i.rect[2])),
      start = Math.min(...groups[n].map((i) => i.rect[0]))
    if (start - end < h * 0.3) return
    cuts.push((end + start) / 2)
  }
  cuts.push(frame[2])
  if (
    !(
      cuts[1] > centers[0] &&
      cuts[1] < centers[1] &&
      cuts[2] > centers[1] &&
      cuts[2] < centers[2]
    ) ||
    groups.some((g, n) => g.some((i) => i.rect[0] < cuts[n] || i.rect[2] > cuts[n + 1]))
  )
    return
  return { parent, firstColumn: 2, lastColumn: 6 }
}

// Complete native mean/deviation fields can contradict detector cuts through
// their values. Keep the scalar prefix and use only shared whole-source gutters.
export function wholeMeanDeviationColumnPlan({
  table,
  items,
  columnRects,
  rows,
  objects,
  rules = [],
  nativeContext
}) {
  if (!Array.isArray(columnRects) || columnRects.length < 5 || rows.length < 4) return
  const headers = objects.filter((o) => o.label === 'table column header')
  if (headers.length !== 1) return
  const header = headers[0].rect,
    [left, top, right, bottom] = table.cropRect,
    bodyRows = rows.filter((r) => (r.rect[1] + r.rect[3]) / 2 > header[3])
  if (bodyRows.length < 3 || bodyRows.some((r) => r.origin !== 'model')) return
  const heights = items
      .filter((i) => i.horizontal && i.baseline > header[3] && i.rect[1] < bottom && i.height > 0)
      .map((i) => i.height)
      .sort((a, b) => a - b),
    h = heights[heights.length >> 1],
    modelBottom = Math.max(...bodyRows.map((r) => r.rect[3])),
    closings = rules
      .filter(
        (r) =>
          r[1] === r[3] &&
          r[1] >= modelBottom &&
          r[1] <= bottom &&
          r[1] - modelBottom < h * 2 &&
          Math.abs(r[0] - left) < h * 1.25 &&
          Math.abs(r[2] - right) < h * 1.25 &&
          r[2] - r[0] > (right - left) * 0.9
      )
      .sort((a, b) => a[1] - b[1]),
    closing = closings[0]
  if (
    !closing ||
    closings.some(
      (r) =>
        r[1] - closing[1] > h * 0.35 ||
        Math.abs(r[0] - closing[0]) > h * 0.1 ||
        Math.abs(r[2] - closing[2]) > h * 0.1
    )
  )
    return
  const bodyBottom = closing[1]
  const deviationAtoms = items.filter(
    (i) =>
      i.horizontal &&
      i.text?.includes('±') &&
      i.baseline > header[3] &&
      i.rect[1] < bodyBottom &&
      i.rect[3] > top &&
      i.rect[2] > left &&
      i.rect[0] < right
  )
  if (!deviationAtoms.length) return
  const whole = (i) =>
    i?.horizontal === true &&
    i.sourceItem &&
    Number.isInteger(i.sourceItem.pageNumber) &&
    i.sourceItem.pageNumber > 0 &&
    Number.isInteger(i.sourceItem.index) &&
    i.sourceItem.index >= 0 &&
    i.sourceItem.text === i.text &&
    i.text.trim() &&
    i.rect?.length === 4 &&
    i.rect.every(Number.isFinite) &&
    i.height > 0 &&
    Number.isFinite(i.baseline) &&
    !['sourceSegment', 'sourceSegments', 'sourceToken', 'sourceTokens'].some(
      (k) => i[k] !== undefined
    )
  const candidates = []
  for (let start = 1; start < columnRects.length - 2; start++) {
    const edge = columnRects[start][0],
      domain = items.filter(
        (i) =>
          i.horizontal &&
          i.text?.trim() &&
          i.baseline > header[3] &&
          i.rect[2] > edge &&
          i.rect[0] < right &&
          i.rect[3] > top &&
          i.rect[1] < bodyBottom
      )
    if (
      !domain.length ||
      deviationAtoms.some((i) => !domain.includes(i)) ||
      domain.some(
        (i) =>
          !whole(i) ||
          i.rect[0] < edge ||
          i.rect[2] > right ||
          i.rect[1] < top ||
          i.rect[3] > bodyBottom
      )
    )
      continue
    const page = domain[0].sourceItem.pageNumber,
      keys = domain.map((i) => i.sourceItem.pageNumber + ':' + i.sourceItem.index)
    if (domain.some((i) => i.sourceItem.pageNumber !== page) || new Set(keys).size !== keys.length)
      continue
    const height = domain.map((i) => i.height).sort((a, b) => a - b)[domain.length >> 1],
      groups = []
    if (domain.some((i) => Math.abs(i.height - height) > height * 0.05)) continue
    for (const i of domain
      .slice()
      .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
      let group = groups.at(-1)
      if (!group || Math.abs(group[0].baseline - i.baseline) > height * 0.05)
        groups.push((group = []))
      group.push(i)
    }
    if (groups.length !== bodyRows.length) continue
    const owners = groups.map((g) =>
      bodyRows.filter((r) =>
        g.every((i) => {
          const y = (i.rect[1] + i.rect[3]) / 2
          return y >= r.rect[1] && y <= r.rect[3]
        })
      )
    )
    if (
      owners.some((o) => o.length !== 1) ||
      new Set(owners.map((o) => o[0])).size !== bodyRows.length
    )
      continue
    const gaps = groups.slice(1).map((g, n) => g[0].baseline - groups[n][0].baseline)
    if (
      gaps.some((g) => g < height * 0.9 || g > height * 1.5) ||
      Math.max(...gaps) - Math.min(...gaps) > height * 0.05
    )
      continue
    const records = groups.map((g) => {
        const fields = []
        for (const i of g.slice().sort((a, b) => a.rect[0] - b.rect[0])) {
          let field = fields.at(-1)
          if (!field || i.rect[0] - field.at(-1).rect[2] > height * 0.4) fields.push((field = []))
          field.push(i)
        }
        return fields
      }),
      count = records[0].length
    if (
      count < 3 ||
      count >= columnRects.length - start ||
      records.some(
        (r) =>
          r.length !== count ||
          r.some(
            (f) =>
              !/^\d+(?:\.\d+)?±\d+(?:\.\d+)?$/u.test(
                f
                  .map((i) => i.text)
                  .join('')
                  .replace(/\s/gu, '')
              )
          )
      )
    )
      continue
    const gutters = Array.from({ length: count - 1 }, (_, n) => [
      Math.max(...records.map((r) => r[n].at(-1).rect[2])),
      Math.min(...records.map((r) => r[n + 1][0].rect[0]))
    ])
    if (gutters.some(([a, b]) => b - a <= height * 0.35)) continue
    const cuts = [
      ...columnRects.slice(0, start).map((r) => r[0]),
      edge,
      ...gutters.map(([a, b]) => (a + b) / 2),
      right
    ]
    if (
      rules.some(
        (r) =>
          r[0] === r[2] &&
          r[3] > domain[0].rect[1] &&
          r[1] < Math.max(...domain.map((i) => i.rect[3])) &&
          cuts
            .slice(start, -1)
            .some((x, n) => r[0] > x + height * 0.05 && r[0] < cuts[start + n + 1] - height * 0.05)
      )
    )
      continue
    const leaf = items.filter(
      (i) =>
        i.horizontal &&
        i.text?.trim() &&
        i.baseline >= header[1] &&
        i.baseline <= header[3] &&
        i.rect[2] > edge &&
        i.rect[0] < right
    )
    if (
      !leaf.length ||
      leaf.some(
        (i) =>
          !whole(i) ||
          i.rect[0] < edge ||
          i.rect[2] > right ||
          /^(?:SD|SE|SEM|Standard(?: deviation)?|deviation)$/iu.test(i.text.trim())
      )
    )
      continue
    const headerKeys = leaf.map((i) => i.sourceItem.pageNumber + ':' + i.sourceItem.index)
    if (
      leaf.some((i) => i.sourceItem.pageNumber !== page) ||
      new Set(headerKeys).size !== headerKeys.length ||
      headerKeys.some((k) => keys.includes(k))
    )
      continue
    const leafGroups = cuts
      .slice(start, -1)
      .map((x, n) => leaf.filter((i) => i.rect[0] >= x && i.rect[2] <= cuts[start + n + 1]))
    if (
      leafGroups.some((g) => !g.length || !g.some((i) => /\p{L}/u.test(i.text))) ||
      leafGroups.flat().length !== leaf.length
    )
      continue
    if (
      !proveTwoTierWholeFontPacket(
        [...leaf, ...domain],
        [edge, header[1], right, bodyBottom],
        nativeContext
      )
    )
      continue
    candidates.push({ start, count, cuts })
  }
  if (!candidates.length) return
  const largest = Math.max(...candidates.map((c) => c.count)),
    plans = candidates.filter((c) => c.count === largest)
  if (plans.length !== 1) return
  const selected = plans[0]
  return {
    ...selected,
    columns: selected.cuts.slice(selected.start, -1).map((x, n) => ({
      rect: [x, top, selected.cuts[selected.start + n + 1], bottom],
      origin: 'source-whole-deviation-column',
      score: 1
    }))
  }
}

// Keep two independently underlined, already owned whole parent labels apart.
// The native original tuple inventory verifies fonts; no body Source is emitted.
export function recoverNativeOwnedRepeatedParentPartition({
  cells,
  rows,
  columns,
  headerRows,
  rules,
  nativeContext
}) {
  if (
    !Array.isArray(cells) ||
    !Array.isArray(rows) ||
    rows.length < 5 ||
    columns?.length !== 9 ||
    headerRows?.length !== 2 ||
    headerRows[0] !== 0 ||
    headerRows[1] !== 1 ||
    !Array.isArray(rules)
  )
    return
  const parents = cells.filter(
      (c) => c.row === 0 && c.column === 1 && c.rowSpan === 1 && c.colSpan === 8
    ),
    leaves = cells.filter((c) => c.row === 1).sort((a, b) => a.column - b.column)
  if (
    parents.length !== 1 ||
    leaves.length !== 9 ||
    leaves.some((c, n) => c.column !== n || c.rowSpan !== 1 || c.colSpan !== 1 || !c.text?.trim())
  )
    return
  const parent = parents[0],
    allowed = new Set([
      'row',
      'column',
      'rowSpan',
      'colSpan',
      'rect',
      'origin',
      'text',
      'sourceTokens',
      'sourceRects',
      'sourceItems'
    ])
  if (
    parent.origin !== 'source-ruled-stub' ||
    parent.sourceItems?.length !== 2 ||
    parent.sourceTokens?.length !== 2 ||
    parent.sourceRects?.length !== 2 ||
    Reflect.ownKeys(parent).some((k) => !allowed.has(k))
  )
    return
  const norm = (s) => s.replace(/\s/gu, ''),
    key = (s) =>
      s &&
      Number.isInteger(s.pageNumber) &&
      s.pageNumber > 0 &&
      Number.isInteger(s.index) &&
      s.index >= 0
        ? `${s.pageNumber}:${s.index}`
        : undefined,
    center = (r) => (r[0] + r[2]) / 2,
    sameRect = (a, b) => a?.length === 4 && b?.length === 4 && a.every((x, n) => x === b[n])
  const header = cells.filter((c) => c.row < 2),
    tokenKeys = new Set(['text', 'rect', 'baseline', 'height']),
    refKeys = new Set(['pageNumber', 'index', 'text']),
    headerKeys = new Set([...allowed, 'textRuns'])
  if (
    header.length !== 11 ||
    header.some((c) => Reflect.ownKeys(c).some((k) => !headerKeys.has(k))) ||
    header.some((c) =>
      (c.sourceItems ?? []).some((s) => Reflect.ownKeys(s).some((k) => !refKeys.has(k)))
    )
  )
    return
  if (
    header.some((c) => c.sourceSegments !== undefined) ||
    header
      .filter((c) => c.row === 0 && c !== parent)
      .some((c) => c.text?.trim() || c.sourceItems?.length || c.sourceTokens?.length)
  )
    return
  const refs = header.flatMap((c) => c.sourceItems ?? []),
    ids = refs.map(key)
  if (
    refs.length < 10 ||
    ids.includes(undefined) ||
    new Set(ids).size !== ids.length ||
    parent.sourceItems[0].text === parent.sourceItems[1].text ||
    norm(parent.text) !== norm(parent.sourceItems.map((s) => s.text).join(' ')) ||
    leaves.slice(1, 5).some((c, n) => norm(c.text) !== norm(leaves[n + 5].text)) ||
    new Set(leaves.slice(1, 5).map((c) => norm(c.text))).size !== 4
  )
    return
  const raw = nativeContext?.sourceContent,
    v = nativeContext?.viewport
  if (!Array.isArray(raw?.items) || typeof v?.convertToViewportPoint !== 'function') return
  let originals
  try {
    originals = raw.items
      .filter((i) => typeof i.str === 'string' && i.str.trim())
      .map((i) => tableTextToken(i, v, 0))
  } catch {
    return
  }
  const byId = new Map(originals.map((i) => [key(i.sourceItem), i]))
  if (
    byId.size !== originals.length ||
    byId.has(undefined) ||
    refs.some((s) => byId.get(key(s))?.text !== s.text)
  )
    return
  const own = parent.sourceItems.map((s) => byId.get(key(s))),
    h = own[0].height
  if (
    !(h > 0) ||
    own.some(
      (i, n) =>
        i.height !== h ||
        !Number.isFinite(i.baseline) ||
        !sameRect(i.rect, parent.sourceRects[n]) ||
        !sameRect(i.rect, parent.sourceTokens[n].rect) ||
        i.text !== parent.sourceTokens[n].text ||
        i.baseline !== parent.sourceTokens[n].baseline ||
        i.height !== parent.sourceTokens[n].height ||
        Reflect.ownKeys(parent.sourceTokens[n]).some((k) => !tokenKeys.has(k)) ||
        Math.abs(i.baseline - own[0].baseline) > h * 0.1
    )
  )
    return
  const full = rules.filter(
      (r) =>
        r?.length === 4 &&
        r.every(Number.isFinite) &&
        r[1] === r[3] &&
        Math.abs(r[0] - leaves[0].rect[0]) < h &&
        Math.abs(r[2] - leaves[8].rect[2]) < h
    ),
    opening = full.filter(
      (r) =>
        r[1] < Math.min(...own.map((i) => i.rect[1])) &&
        Math.min(...own.map((i) => i.rect[1])) - r[1] < h
    ),
    closing = full.filter((r) => Math.abs(r[1] - rows[1].rect[3]) < 0.1)
  if (
    opening.length !== 1 ||
    closing.length !== 1 ||
    Math.abs(opening[0][0] - closing[0][0]) > 0.1 ||
    Math.abs(opening[0][2] - closing[0][2]) > 0.1
  )
    return
  const frame = [opening[0][0], opening[0][1], opening[0][2], closing[0][1]],
    inventory = originals.filter(
      (i) =>
        i.rect[0] < frame[2] && i.rect[2] > frame[0] && i.rect[1] < frame[3] && i.rect[3] > frame[1]
    )
  if (!proveTwoTierWholeFontPacket(inventory, frame, nativeContext)) return
  // Body em boxes can intersect the header divider. Keep them in the complete
  // font packet, while baseline membership closes only the logical header tier.
  const logical = inventory.filter((i) => i.baseline > frame[1] && i.baseline < frame[3]),
    logicalIds = logical.map((i) => key(i.sourceItem))
  if (
    logicalIds.length !== ids.length ||
    new Set(logicalIds).size !== logicalIds.length ||
    logicalIds.some((id) => !ids.includes(id)) ||
    ids.some((id) => !logicalIds.includes(id))
  )
    return
  for (const cell of leaves) {
    if (
      !cell.sourceItems?.length ||
      !Array.isArray(cell.sourceRects) ||
      cell.sourceRects.length !== cell.sourceItems.length ||
      cell.sourceTokens?.length !== cell.sourceItems.length ||
      cell.sourceItems.some((s, n) => {
        const font = byId.get(key(s))
        const matches = cell.sourceTokens.filter(
            (t) =>
              t.text === font?.text &&
              sameRect(t.rect, font?.rect) &&
              t.baseline === font?.baseline &&
              t.height === font?.height
          ),
          token = matches[0]
        return (
          !font ||
          !sameRect(cell.sourceRects[n], font.rect) ||
          matches.length !== 1 ||
          !token ||
          token.text !== font.text ||
          !sameRect(token.rect, font.rect) ||
          token.baseline !== font.baseline ||
          token.height !== font.height ||
          Reflect.ownKeys(token).some((k) => !tokenKeys.has(k)) ||
          font.baseline <= parent.rect[3] ||
          font.baseline >= frame[3]
        )
      })
    )
      return
  }
  const strokes = rules
    .filter(
      (r) =>
        r?.length === 4 &&
        r.every(Number.isFinite) &&
        r[1] === r[3] &&
        Math.abs(r[1] - parent.rect[3]) < 0.1 &&
        r[0] > frame[0] &&
        r[2] <= frame[2] + 0.1 &&
        r[2] > r[0]
    )
    .sort((a, b) => a[0] - b[0])
  if (
    strokes.length !== 2 ||
    Math.abs(strokes[0][1] - strokes[1][1]) > 0.1 ||
    Math.abs(strokes[0][2] - strokes[1][0]) > 0.1
  )
    return
  const centers = leaves.map((c) => center(c.rect)),
    scopes = strokes.map((r) =>
      centers.map((x, c) => (x > r[0] && x < r[2] ? c : -1)).filter((c) => c >= 0)
    )
  if (
    scopes.some((g, n) => g.length !== 4 || g.some((c, k) => c !== 1 + n * 4 + k)) ||
    strokes.some(
      (r, n) =>
        Math.abs(center(r) - center(own[n].rect)) > h * 0.1 ||
        own[n].rect[0] < r[0] ||
        own[n].rect[2] > r[2] ||
        own[n].rect[3] >= r[1]
    )
  )
    return
  const leafFonts = leaves.slice(1).map((c) => c.sourceItems.map((s) => byId.get(key(s)))),
    leftEnd = Math.max(
      ...leafFonts
        .slice(0, 4)
        .flat()
        .map((i) => i.rect[2])
    ),
    rightStart = Math.min(
      ...leafFonts
        .slice(4)
        .flat()
        .map((i) => i.rect[0])
    ),
    boundary = leaves[5].rect[0]
  if (!(
    leftEnd < rightStart &&
    strokes[0][2] > leftEnd &&
    strokes[0][2] < rightStart &&
    strokes[1][0] > leftEnd &&
    strokes[1][0] < rightStart &&
    boundary > leftEnd &&
    boundary < rightStart
  ))
    return
  const parts = own.map((font, n) => ({
    column: 1 + n * 4,
    colSpan: 4,
    sourceItem: parent.sourceItems[n],
    sourceToken: parent.sourceTokens[n],
    rect: [leaves[1 + n * 4].rect[0], parent.rect[1], leaves[4 + n * 4].rect[2], parent.rect[3]]
  }))
  return { parent, parts }
}
