/* eslint-disable @typescript-eslint/explicit-function-return-type, no-control-regex, no-useless-escape */
import { inside } from './literature-pdf-table-geometry.mjs'
import { area, intersection } from './literature-pdf-page-geometry.mjs'
import { hasNativeNonTableLayout } from './literature-pdf-native-non-table-layout.mjs'

// Native paragraph ink crosses a detector's artificial column cuts. Require
// several connected words on the same baseline; separate description columns
// and independently measured records do not supply this proof.
function hasContinuousNativeProse(table, items) {
  if (!table.cropRect || !table.cells?.length) return false
  const [left, top, right, bottom] = table.cropRect
  const cuts = [
    ...new Set(
      table.cells
        .filter((c) => c.colSpan === 1)
        .map((c) => c.rect[2])
        .filter((x) => x > left + 2 && x < right - 2)
    )
  ]
  if (!cuts.length) return false
  const source = items.filter(
    (i) =>
      i.horizontal &&
      i.height > 0 &&
      i.rect[3] > top &&
      i.rect[1] < bottom &&
      i.rect[2] > left &&
      i.rect[0] < right
  )
  if (!source.length) return false
  const em = Math.max(...source.map((i) => i.height))
  const rows = []
  for (const item of source
    .filter((i) => i.height >= em * 0.85)
    .sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0])) {
    const row = rows.find((r) => Math.abs(r[0].rect[1] - item.rect[1]) < em * 0.15)
    if (row) row.push(item)
    else rows.push([item])
  }
  const prose = []
  for (const row of rows) {
    const chains = []
    for (const item of row.sort((a, b) => a.rect[0] - b.rect[0])) {
      const chain = chains.at(-1),
        previous = chain?.at(-1)
      if (previous && item.rect[0] - previous.rect[2] < em * 0.9) chain.push(item)
      else chains.push([item])
    }
    for (const chain of chains) {
      const text = chain.map((i) => i.text).join(' ')
      if (
        (text.match(/\p{L}{2,}/gu) ?? []).length >= 5 &&
        chain.at(-1).rect[2] - chain[0].rect[0] > (right - left) * 0.5 &&
        cuts.some((x) => chain[0].rect[0] < x - em && chain.at(-1).rect[2] > x + em)
      )
        prose.push(chain)
    }
  }
  const measuredRows = table.grid.filter(
    (row) => row.filter((t) => /^[-+−]?\d+(?:\.\d+)?(?:\s*\([^)]*\))?$/.test(t.trim())).length >= 2
  )
  if (
    measuredRows.length ||
    table.grid.some((row) => row.some((t) => /^[-+−]?\d+(?:\.\d+)?\s*\([^)]*\)$/.test(t.trim())))
  )
    return false
  const text = source.map((i) => i.text).join(' ')
  return (
    prose.length >= 2 ||
    (prose.length === 1 && /[=≤≥⪰≳]/.test(text) && source.some((i) => /^[∇∥≥≤=−+]/.test(i.text)))
  )
}

function isNumberedNativeDisplay(table, items) {
  const equations = table.grid.filter(
    (row) =>
      row.some((t) => /^\((?:[A-Z]\.)?\d+(?:\.\d+)*\)$/.test(t.trim())) &&
      row.some((t) => /[=≤≥⪰∥∇]/.test(t))
  )
  if (!equations.length || !table.cropRect) return false
  const numericRows = table.grid.filter(
    (row) => row.filter((t) => /^[-+−]?\d+(?:\.\d+)?$/.test(t.trim())).length >= 2
  )
  if (numericRows.length) return false
  return equations.every((row) => {
    const label = row.find((t) => /^\((?:[A-Z]\.)?\d+(?:\.\d+)*\)$/.test(t.trim()))
    const matches = items.filter(
      (i) => i.horizontal && i.text.trim() === label && inside(table.cropRect, i)
    )
    return (
      matches.length === 1 &&
      matches[0].rect[0] > table.cropRect[0] + (table.cropRect[2] - table.cropRect[0]) * 0.8 &&
      items.some(
        (i) =>
          i.horizontal &&
          /[=≤≥⪰∥∇]/.test(i.text) &&
          Math.abs(i.rect[3] - matches[0].rect[3]) < matches[0].height * 0.2 &&
          matches[0].rect[0] - i.rect[2] > matches[0].height * 4
      )
    )
  })
}

// A displayed system of equations can be split into detector columns and look
// like a small table.  Without a caption, repeated mathematical rows and an
// equation ordinal are stronger evidence of native prose than tabular data.
function isNativeFormulaSystem(table, caption) {
  if (caption || !table.cropRect || table.grid.length < 3) return false
  const cells = table.grid
    .flat()
    .map((text) => text.trim())
    .filter(Boolean)
  if (cells.length < 5) return false
  const measuredRows = table.grid.filter(
    (row) =>
      row.filter((text) => /^[-+−]?\d+(?:\.\d+)?(?:\s*\([^)]*\))?$/.test(text.trim())).length >= 2
  )
  if (measuredRows.length) return false
  const formulaRows = table.grid.filter(
    (row) =>
      row.some((text) => /[=∈≤≥⪰∥∇]/u.test(text)) && row.some((text) => /[\p{L}α-ω]/u.test(text))
  )
  const ordinals = cells.filter((text) =>
    /(?:^|\s)\((?:[A-Z]\.)?\d+(?:\.\d+)*\)(?:$|[,.])/u.test(text)
  )
  const symbolic = cells.filter((text) => /[=∈≤≥⪰∥∇]/u.test(text)).length
  const prose = cells.filter(
    (text) => text.split(/\s+/).length >= 8 && !/[=∈≤≥⪰∥∇]/u.test(text)
  ).length
  return formulaRows.length >= 3 && ordinals.length >= 1 && symbolic >= 3 && prose <= 1
}

// Some appendix equations have enough aligned glyphs to be emitted as a
// detector table, but they do not contain a tabular record.  Captionless
// displays are already covered by isNativeFormulaSystem; this conservative
// companion also handles damaged math glyphs (for example boxed operators or
// replacement characters) when the crop carries a large amount of unowned
// text.  A complete two-column parameter table remains eligible because it has
// no crop-boundary/unassigned evidence.
function isDamagedNativeFormulaLayout(table, caption) {
  if (!table.cropRect || table.grid.length < 3) return false
  const populated = table.grid
    .flat()
    .map((text) => text.trim())
    .filter(Boolean)
  if (populated.length < 4) return false
  const math = /[=∈≤≥⪰∥∇∑√∞∫⋆ℓβγθνξ∆⊕⊗∀∃�−+*\/^]/u
  const formulaRows = table.grid.filter((row) => {
    const text = row.filter(Boolean).join(' ')
    return math.test(text) && /[\p{L}α-ω]/u.test(text)
  })
  if (caption && formulaRows.length < 2) return false
  const measuredRows = table.grid.filter(
    (row) =>
      row.filter((text) => /^[-+−]?\d+(?:\.\d+)?(?:\s*\([^)]*\))?$/.test(text.trim())).length >= 2
  )
  const controlGlyphs = populated.join(' ').match(/[\u0000-\u001f�]/gu)?.length ?? 0
  const ordinal = populated.some((text) =>
    /(?:^|\s)\((?:[A-Z]\.)?\d+(?:\.\d+)*\)(?:$|[,.])/u.test(text)
  )
  const symbolicCount = (populated.join(' ').match(/[=∈≤≥⪰∥∇∑√∞∫⋆ℓβγθνξ∆⊕⊗∀∃�−+*\/^]/gu) ?? [])
    .length
  if (caption && controlGlyphs === 0 && !ordinal && symbolicCount < 3) return false
  if (
    table.grid.length <= 4 &&
    controlGlyphs >= Math.max(2, Math.ceil(populated.length * 0.2)) &&
    (table.unassigned?.length ?? 0) + (table.clipped?.length ?? 0) >= 2
  )
    return true
  if (measuredRows.length || formulaRows.length < 2) return false
  const damage =
    (table.unassigned?.length ?? 0) + (table.clipped?.length ?? 0) >=
    Math.max(4, populated.length * 0.45)
  return damage && (ordinal || formulaRows.length >= 3 || table.grid.length <= 4)
}

function isImageBackedNonTable(table, caption, sourceGraphics = []) {
  if (caption || !table.cropRect || !sourceGraphics.length) return false
  const image = sourceGraphics.find(
    (graphic) =>
      graphic.kind === 'image' &&
      intersection(graphic.rect, table.cropRect) / area(table.cropRect) > 0.8 &&
      intersection(graphic.rect, table.cropRect) / area(graphic.rect) > 0.6
  )
  if (!image) return false
  const values = [...(table.grid ?? []).flat(), ...(table.unassigned ?? [])]
  const controlGlyphs = values.join(' ').match(/[\u0000-\u001f�]/gu)?.length ?? 0
  const measurements = values.filter((text) =>
    /^[-+−]?\d+(?:\.\d+)?(?:\s*[%±].*)?$/.test(text.trim())
  )
  const cleanWords = values.filter(
    (text) => /\p{L}{2,}/u.test(text) && !/[\u0000-\u001f�]/u.test(text)
  )
  return (
    measurements.length === 0 &&
    controlGlyphs >= Math.max(2, Math.ceil(values.length * 0.2)) &&
    (cleanWords.length < 3 || (table.unassigned?.length ?? 0) >= 2)
  )
}

function isCaptionedNarrativeCard(table, caption) {
  if (!caption || !table.grid.length || !table.unassigned?.length) return false
  const text = table.grid.flat().join(' ')
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  const measurements = table.grid
    .flat()
    .filter((cell) => /^[-+−]?\d+(?:\.\d+)?(?:\s*[%±].*)?$/.test(cell.trim()))
  return (
    measurements.length === 0 &&
    words >= 40 &&
    table.unassigned.length >= 8 &&
    (table.issues?.includes('text-crosses-crop-boundary') ||
      table.issues?.includes('overlapping-predicted-columns')) &&
    table.grid.length <= 5
  )
}

function isNativeSingleColumnDerivation(table, caption, items, rules) {
  if (
    !Array.isArray(rules) ||
    !caption?.rect ||
    !table.cropRect ||
    table.grid.length < 4 ||
    table.grid.some((row) => row.length !== 1)
  )
    return false
  const [left, top, right, bottom] = table.cropRect
  const source = items.filter((i) => i.horizontal && i.height > 0 && inside(table.cropRect, i))
  const em = Math.max(0, ...source.map((i) => i.height))
  const captionTop = caption.rect[1] * 1.5,
    bodyBottom = Math.max(
      ...(table.cells ?? []).flatMap((c) => (c.sourceRects ?? []).map((r) => r[3]))
    )
  if (
    !em ||
    captionTop - bottom > em * 3 ||
    (captionTop < bottom &&
      (!Number.isFinite(bodyBottom) || bottom - captionTop > em * 2 || captionTop <= bodyBottom))
  )
    return false
  if (
    rules.some(
      (r) => r[1] === r[3] && r[1] >= top && r[1] <= bottom && r[2] - r[0] > (right - left) * 0.5
    )
  )
    return false
  const physicalRows = []
  for (const item of source
    .filter((i) => i.rect[1] >= top && i.height >= em * 0.85)
    .sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0])) {
    const row = physicalRows.find((r) => Math.abs(r[0].rect[1] - item.rect[1]) < em * 0.15)
    if (row) row.push(item)
    else physicalRows.push([item])
  }
  const prose = physicalRows
    .map((row) => {
      row.sort((a, b) => a.rect[0] - b.rect[0])
      return {
        text: row.map((i) => i.text).join(' '),
        rect: [row[0].rect[0], row[0].rect[1], row.at(-1).rect[2], row[0].rect[3]],
        continuous: row.every((i, n) => !n || i.rect[0] - row[n - 1].rect[2] < em * 0.9)
      }
    })
    .filter(
      (i) =>
        i.continuous &&
        i.rect[2] - i.rect[0] > (right - left) * 0.5 &&
        (i.text.match(/\p{L}{2,}/gu) ?? []).length >= 5
    )
  if (prose.length < 3 || prose.some((i) => Math.abs(i.rect[0] - prose[0].rect[0]) > em * 0.2))
    return false
  const labels = source.filter(
    (i) => /^\(\d+(?:\.\d+)*\)$/.test(i.text.trim()) && i.rect[0] > left + (right - left) * 0.8
  )
  return (
    labels.length === 1 &&
    table.grid.some((row) => (row[0].match(/=/g) ?? []).length >= 2) &&
    source.some(
      (i) =>
        /=/.test(i.text) &&
        Math.abs(i.rect[3] - labels[0].rect[3]) < em * 0.2 &&
        labels[0].rect[0] - i.rect[2] > em * 4
    )
  )
}

// Risk strips belong to their survival plot. A detector can cross the plot
// boundary into prose, so test the assigned numeric cells rather than padding.
export function isFigureRiskTable(table, figures, page, scale = 1.5) {
  const numeric = table.cells.filter((c) => /\d/.test(c.text) && !/\p{L}/u.test(c.text))
  if (numeric.length < 6 || new Set(numeric.map((c) => c.row)).size < 2) return false
  const contains = (outer, inner) =>
    inner.every((v, n) => (n < 2 ? v >= outer[n] - 2 : v <= outer[n] + 2))
  return figures.some(
    (f) =>
      f.rect &&
      /Kaplan[–-]Meier|cumulative (?:risk|incidence)|survival/i.test(f.caption.lines.join(' ')) &&
      page.lines.some(
        (l) =>
          /^(?:Number|No\.?) (?:at risk|of (?:patients|participants) at risk)/i.test(
            l.text.trim()
          ) && contains(f.rect, [l.x, l.y, l.x + l.width, l.y + l.height])
      ) &&
      numeric.every(
        (c) =>
          c.sourceRects?.length &&
          c.sourceRects.every((r) =>
            contains(
              f.rect,
              r.map((v) => v / scale)
            )
          )
      )
  )
}

// A lettered appendix contents directory can look like a two-column table: each
// row has a one-letter section marker, a dotted leader, and a page number. Keep
// this proof deliberately narrow. A real data table may use letter categories,
// but it should not also have a page-level CONTENTS heading and dotted leaders.
function isLetteredContentsDirectory(table, pageItems) {
  if (table.grid.length < 3 || table.grid.some((row) => row.length !== 2)) return false
  if (
    !table.grid.every((row) => {
      const marker = row[0]?.trim() ?? ''
      const entry = row[1]?.trim() ?? ''
      return (
        /^[A-Z]$/.test(marker) &&
        /(?:\s*\.){3,}\s*\d{1,4}\s*$/.test(entry) &&
        /\p{L}{2}/u.test(entry)
      )
    })
  )
    return false

  const heading = pageItems.some((item) => /^contents$/i.test(item?.text?.trim() ?? ''))
  if (heading) return true

  const horizontal = pageItems
    .filter((item) => item?.horizontal !== false && item?.text?.trim() && Array.isArray(item.rect))
    .sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0])
  const lines = []
  for (const item of horizontal) {
    const itemHeight = Number.isFinite(item.height) ? item.height : item.rect[3] - item.rect[1]
    const line = lines.find(
      (candidate) =>
        Math.abs(candidate[0].rect[1] - item.rect[1]) <
          Math.min(
            Number.isFinite(candidate[0].height)
              ? candidate[0].height
              : candidate[0].rect[3] - candidate[0].rect[1],
            itemHeight
          ) *
            0.3 ||
        Math.abs(candidate[0].rect[3] - item.rect[3]) <
          Math.min(
            Number.isFinite(candidate[0].height)
              ? candidate[0].height
              : candidate[0].rect[3] - candidate[0].rect[1],
            itemHeight
          ) *
            0.3
    )
    if (line) line.push(item)
    else lines.push([item])
  }
  return lines.some(
    (line) =>
      line
        .sort((a, b) => a.rect[0] - b.rect[0])
        .map((item) => item.text.trim())
        .join('')
        .replace(/\s+/g, '')
        .toLowerCase() === 'contents'
  )
}

// Detection confidence alone also accepts affiliations and prose. Like the upstream
// content-supported row/column refinement, require evidence from source text.
// ponytail: uncaptioned single-column or single-row tables remain ambiguous with lists;
// retain them only with a reliable table caption until richer layout evidence is available.
export function hasTableEvidence(table, caption, pageItems = [], sourceRules, sourceGraphics = []) {
  const populatedRows = table.grid.map((row) => row.filter((text) => text.trim()).length)
  if (!populatedRows.some((count) => count > 0)) return false
  if (!caption && isLetteredContentsDirectory(table, pageItems)) return false
  // A supplementary-materials directory names several external tables. Its
  // neighboring entry is not a caption for the directory or nearby references.
  if (
    /^Supplementary Table/i.test(caption?.lines?.[0] ?? '') &&
    [...table.grid.map((row) => row.join(' ')), ...(table.unassigned ?? [])].filter((text) =>
      /^Supplementary Table S?\d+\s*[|:]/i.test(text)
    ).length >= 2
  )
    return false
  // A contents list has repeated numbered captions followed by page numbers.
  // A caption association to its first entry must not turn the list into a table.
  const contentsRows = table.grid.map((row) => row.join(' ').trim())
  if (
    contentsRows.filter((text) => /^(?:TABLE|FIGURE)\s+\d+\b.*\s\d+$/i.test(text)).length >= 3 &&
    table.grid.every((row) => row.filter((text) => text.trim()).length <= 3)
  )
    return false
  if (isNativeSingleColumnDerivation(table, caption, pageItems, sourceRules)) return false
  if (isNativeFormulaSystem(table, caption)) return false
  if (isDamagedNativeFormulaLayout(table, caption)) return false
  if (isCaptionedNarrativeCard(table, caption)) return false
  if (isImageBackedNonTable(table, caption, sourceGraphics)) return false
  if (caption) return true
  if (hasNativeNonTableLayout(table, pageItems, sourceRules)) return false
  if (
    table.repairs?.some((r) =>
      ['closed-numeric-grid-recovered', 'wrapped-count-grid-recovered'].includes(r)
    )
  )
    return true
  const sourceText = pageItems.map((item) => item.text).join(' ')
  // Preserve an explicitly labelled, completely assigned native glossary.
  // A distant mention of abbreviations is not enough to admit an arbitrary list.
  if (
    table.cropRect &&
    table.grid.length >= 4 &&
    !table.unassigned?.length &&
    table.grid.every(
      (row) =>
        row.length === 2 &&
        /^[A-Z][A-Za-z\d/&–-]{0,15}$/.test(row[0].trim()) &&
        /\p{L}/u.test(row[1])
    ) &&
    pageItems.some(
      (i) =>
        i.horizontal &&
        /^(?:List of )?Abbreviations\s*:?$/i.test(i.text.trim()) &&
        i.rect[3] <= table.cropRect[1] + i.height * 0.2 &&
        table.cropRect[1] - i.rect[3] < i.height * 2 &&
        i.rect[0] >= table.cropRect[0] - i.height &&
        i.rect[0] < table.cropRect[2]
    )
  )
    return true
  const cropText = [...table.grid.flat(), ...(table.unassigned ?? [])].join(' ')
  const compactText = cropText.replace(/\s/g, '')
  const words = (text) => (text.trim() ? text.trim().split(/\s+/).length : 0)
  if (
    /\bAuthor contributions\b/i.test(sourceText) &&
    table.grid.every((row) => row.length === 2) &&
    table.grid[0].some((text) => /^Author Initials$/i.test(text.trim())) &&
    /conception|design|final approval/i.test(cropText)
  )
    return false
  const measurement = (text) => /^[-+−]?\d+(?:\.\d+)?(?:\s*\([^)]*\))?$/.test(text.trim())
  const hasMeasurement = table.grid.some((row) => row.some(measurement))
  if (hasContinuousNativeProse(table, pageItems) || isNumberedNativeDisplay(table, pageItems))
    return false
  // Repeated affiliation markers, institutions and contact addresses identify
  // an author footer even when word-spaced prose became many model columns.
  if (
    !hasMeasurement &&
    (cropText.match(/[†‡§¶]/g) ?? []).length >= 3 &&
    (cropText.match(/\b(?:Department|University|Institute|College)\b/gi) ?? []).length >= 3 &&
    (cropText.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g) ?? []).length >= 2
  )
    return false
  // Article metadata can form a false stub beside the abstract. Receipt and
  // acceptance dates plus a DOI or a complete history/keywords heading identify
  // that publication block independently of the neighboring abstract.
  if (
    !hasMeasurement &&
    table.grid.every((row) => row.length <= 2) &&
    /\bReceived\s+\d/i.test(cropText) &&
    /\bAccepted\s+\d/i.test(cropText) &&
    (/\bDOI\s*:\s*10\./i.test(cropText) ||
      (/\bArticle history\s*:/i.test(cropText) &&
        /\bAvailable online\b/i.test(cropText) &&
        /\bKeywords\s*:/i.test(cropText)))
  )
    return false
  // Abstract headings and clipped paragraph tails do not become a table
  // merely because the detector aligns the headings into a stub column.
  if (
    table.grid.length >= 3 &&
    table.grid.every((row) => row.length === 2) &&
    table.grid.filter((row) =>
      /^(?:Background|Methods?|Results?|Conclusions?|Objectives?)[:.]?$/i.test(row[0].trim())
    ).length >= 3 &&
    table.grid.every((row) => !measurement(row[1])) &&
    (table.clipped?.length >= 3 || table.issues?.includes('text-crosses-crop-boundary'))
  )
    return false
  // Numbered affiliation blocks can have an extra model column containing
  // only affiliation ordinals. Require institutional prose on both sides.
  if (
    table.grid.length >= 2 &&
    table.grid.every((row) => row.length <= 3 && row.filter(measurement).length <= 1) &&
    table.grid.filter(
      (row) =>
        row.filter((text) =>
          /\b(?:Department|University|Institute|Hospital|College|Unit)\b/i.test(text)
        ).length >= 2
    ).length >= 2 &&
    table.grid.filter((row) => /^\d+\s+\p{L}/u.test(row[0])).length >= 2
  )
    return false
  // A lone citation plus a page number may be entirely inside its crop.
  // Publication year/volume/page syntax and an author list are independent
  // evidence; the page number must not masquerade as a measured data row.
  if (
    table.grid.length <= 4 &&
    table.grid.every((row) => row.length <= 2) &&
    /^\d+\.\s+\p{Lu}[\p{L} '-]+\s+[A-Z][, .]/u.test(cropText.trim()) &&
    /\bet al\./i.test(cropText) &&
    /\b(?:19|20)\d{2};\d+(?::|\()[A-Z]*\d+[–-]\d+/.test(cropText) &&
    table.grid.filter((row) => row.some(measurement)).length <= 1
  )
    return false
  // Author-year bibliographies may fill the crop without clipping a single
  // line. Repeated parenthesized years and journal volume/page ranges together
  // identify the prose columns; measured or captioned tables remain eligible.
  if (
    !hasMeasurement &&
    table.grid.every((row) => row.length <= 2) &&
    (cropText.match(/\((?:19|20)\d{2}[a-z]?\)/g) ?? []).length >= 3 &&
    (cropText.match(/\b\d{1,4}\s*,\s*\d+[–-]\d+[.]/g) ?? []).length >= 3
  )
    return false
  // Author blocks repeat personal names followed by affiliations in both page
  // columns. Neither particular institutions nor country names prove ownership.
  // Preserve captioned tables above and measured comparisons below.
  const populatedCells = table.grid.flat().filter((text) => text.trim())
  const authorAffiliations = populatedCells.filter((text) =>
    /^(?:(?:\p{Lu}[\p{L}’'-]+|\p{Lu}\.)\s+){2,6}(?:University|College|School|Institute|Hospital|Center)\b/u.test(
      text.trim()
    )
  )
  if (
    !hasMeasurement &&
    table.grid.every((row) => row.length <= 2) &&
    authorAffiliations.length >= 4 &&
    authorAffiliations.length >= populatedCells.length * 0.6
  )
    return false
  // Publication sidebars can cross into an abstract. A DOI split across native
  // lines leaves an apparently numeric last cell, so require publication and
  // licensing anchors together instead of treating that fragment as a value.
  if (
    table.grid.every((row) => row.length <= 2 && row.filter(measurement).length < 2) &&
    /Acceptedon/i.test(compactText) &&
    /published(?:at|on|online)/i.test(compactText) &&
    /\bDOI\b/i.test(cropText) &&
    /(?:org\/|DOI:)10\./i.test(compactText) &&
    /(?:CreativeCommons|©)/i.test(compactText)
  )
    return false
  // Section outlines contain numbered prose headings, sometimes with a
  // completely empty detector column. Those ordinals are not measurements.
  if (
    table.grid.length <= 4 &&
    table.grid.length >= 2 &&
    table.grid.every(
      (row) =>
        /^\d+(?:\.\d+)*\.$/.test(row[0]?.trim() ?? '') &&
        row.slice(1).filter((text) => text.trim()).length === 1 &&
        row.slice(1).some((text) => /^[\p{L} -]+$/u.test(text.trim()))
    ) &&
    table.issues?.includes('text-crosses-crop-boundary')
  )
    return false
  // A detector can turn a reference column or a prose section outline into a
  // two-column grid. These candidates commonly cross the crop boundary and
  // leave source text unassigned. Keep a measured comparison or a captioned
  // table above, but reject the unstructured shapes before they reach output.
  const referenceHeading = pageItems.some((item) =>
    /^(?:References|Bibliography)\s*:?$/i.test(item.text.trim())
  )
  const numberedReferenceMarkers = pageItems.filter((item) =>
    /^\d+[.)]?$/.test(item.text.trim())
  ).length
  const sourceReferenceMarkers = (sourceText.match(/(?:^|\s)\d+\.\s/g) ?? []).length
  const citationYears = (sourceText.match(/\b(?:19|20)\d{2}\b/g) ?? []).length
  const citationUrls = (cropText.match(/https?:\/\/|doi\.org/gi) ?? []).length
  const referenceLikeGrid = table.grid.every((row) => row.length <= 6)
  const numberedCitationRows = table.grid.filter((row) => {
    const marker = row[0]?.trim() ?? ''
    const citation = row.slice(1).join(' ').trim()
    return (
      /^\d+[.)]?$/.test(marker) &&
      words(citation) >= 8 &&
      /(?:19|20)\d{2}\b/.test(citation) &&
      /\b(?:Journal|Cancer|BMJ|Eur|doi|et al\.)\b/i.test(citation)
    )
  }).length
  if (
    !hasMeasurement &&
    referenceLikeGrid &&
    table.issues?.includes('text-crosses-crop-boundary') &&
    ((referenceHeading && numberedReferenceMarkers >= 3) ||
      (numberedReferenceMarkers >= 3 && citationYears >= 3) ||
      (citationUrls >= 2 && citationYears >= 2) ||
      (sourceReferenceMarkers >= 3 && citationYears >= 3))
  )
    return false
  // A two-column detector crop can also treat a short bibliography tail as a
  // table. Numeric-only left cells are ordinals in this shape, not measured
  // values; require every row to carry a long citation before rejecting it.
  if (
    !caption &&
    table.issues?.includes('text-crosses-crop-boundary') &&
    numberedCitationRows >= 2 &&
    numberedCitationRows === table.grid.length
  )
    return false
  // Multi-column review questions often resemble a sparse table because each
  // answer option lands in a separate detector column. Repeated question
  // numbers, option markers, and question punctuation identify the outline;
  // measured or captioned tables remain eligible.
  const questionRows = table.grid.filter((row) => /\b\d+\.\s+/u.test(row.join(' '))).length
  const questionMarks = (cropText.match(/\?/g) ?? []).length
  const optionCount = (cropText.match(/(?:^|\s)[a-c][.)]\s/giu) ?? []).length
  if (
    !caption &&
    table.issues?.includes('text-crosses-crop-boundary') &&
    !hasMeasurement &&
    questionRows >= 2 &&
    (questionMarks >= 2 || (questionMarks === 1 && questionRows >= 4)) &&
    optionCount >= 6
  )
    return false
  // Detector spans can merge footnotes or prose notes into a wide cell and
  // then split the following paragraph into two columns. Without a caption or
  // measured records, a majority of full-width model spans is stronger
  // evidence of a page note than of a data table. Keep this generic so real
  // qualitative tables with a coherent row grid remain eligible.
  if (
    !caption &&
    table.issues?.includes('text-crosses-crop-boundary') &&
    table.issues?.includes('unassigned-source-text') &&
    table.cells?.length &&
    table.grid.length >= 4 &&
    table.grid.length <= 12 &&
    !hasMeasurement
  ) {
    const columnCount = Math.max(...table.grid.map((row) => row.length))
    const fullWidthSpanRows = new Set(
      table.cells
        .filter((cell) => cell.origin === 'model-span' && (cell.colSpan ?? 1) >= columnCount)
        .map((cell) => cell.row)
    )
    const longProseRows = table.grid.filter((row) => row.some((text) => words(text) >= 8)).length
    if (
      fullWidthSpanRows.size >= 3 &&
      fullWidthSpanRows.size >= Math.ceil(table.grid.length * 0.5) &&
      longProseRows >= 2
    )
      return false
  }
  // A small detector crop at the end of a prose column can look like a two
  // column table when the adjacent sentence and journal furniture are split
  // into separate cells. Require a caption or measured content for this
  // ambiguous shape; quoted narrative tables remain eligible.
  if (
    !caption &&
    table.cropRect &&
    table.issues?.includes('text-crosses-crop-boundary') &&
    table.issues?.includes('unassigned-source-text') &&
    table.grid.length <= 3 &&
    table.grid.every((row) => row.length <= 2 && !row.some(measurement)) &&
    (table.unassigned?.length ?? 0) >= 2
  ) {
    const populated = table.grid.flat().filter((text) => text.trim())
    const hasQuotedNarrative = populated.some((text) => /^[“"']/u.test(text.trim()))
    if (!hasQuotedNarrative && populated.filter((text) => words(text) >= 4).length >= 2)
      return false
  }
  // A displayed equation followed by parameter bullets is explanatory prose.
  // Require repeated bullet markers, a mathematical expression, long prose
  // cells and no measured record; retain captioned and numeric tables above.
  if (
    !hasMeasurement &&
    table.grid.every((row) => row.length <= 2) &&
    table.grid.filter((row) => /^[•◦]$/.test(row[0]?.trim() ?? '')).length >= 3 &&
    table.grid.filter((row) => row.some((text) => words(text) >= 8)).length >= 3 &&
    /[=∈]/u.test(cropText) &&
    (cropText.match(/[α-ω]/gu) ?? []).length >= 3
  )
    return false
  const sectionLabelRows = table.grid.filter(
    (row) => !row[0]?.trim() || /^\d+\.\d+(?:\.\d+)*$/.test(row[0].trim())
  ).length
  const sectionProseRows = table.grid.filter((row) => words(row[1] ?? '') >= 8).length
  if (
    table.grid.length >= 3 &&
    table.grid.every((row) => row.length === 2) &&
    !table.grid.some((row) => measurement(row[1])) &&
    sectionLabelRows >= table.grid.length * 0.6 &&
    sectionProseRows >= table.grid.length * 0.6
  )
    return false
  // Quoted callouts are frequently boxed like a small two-column table. Keep
  // them in the source document unless a real table caption or measurement
  // column provides explicit structure evidence.
  const quotedRows = table.grid.filter((row) => /^[“”"']/.test((row[0] ?? '').trim()))
  if (
    !caption &&
    !hasMeasurement &&
    table.grid.length <= 4 &&
    table.grid.every((row) => row.length <= 2) &&
    quotedRows.length > 0 &&
    words(table.grid.flat().join(' ')) >= 6
  )
    return false
  // Article title/author blocks can align into two detector columns and may
  // contain a journal year or page range. They have no table caption and no
  // measured data, so discard the structural false positive.
  if (
    !caption &&
    !hasMeasurement &&
    table.grid.every((row) => row.length <= 2) &&
    /\b(?:Department|University|Institute)\b/i.test(
      [...table.grid.flat(), ...(table.unassigned ?? [])].join(' ')
    ) &&
    /(?:©|\b(?:19|20)\d{2}\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+[–-]\d+)/u.test(
      [...table.grid.flat(), ...(table.unassigned ?? [])].join(' ')
    )
  )
    return false
  if (table.cropRect && table.grid.every((r) => r.length <= 2 && !r.some(measurement))) {
    const [left, top, right, bottom] = table.cropRect
    const prose = pageItems.filter(
      (i) =>
        i.horizontal &&
        i.rect[1] >= top - i.height &&
        i.rect[3] <= bottom + i.height &&
        i.text.trim().split(/\s+/).length >= 5
    )
    // A short detector box can cut into the left article column while its right
    // edge happens to coincide with the other column's margin.
    if (
      table.grid.length <= 6 &&
      prose.filter((i) => i.rect[0] < left - i.height && i.rect[2] > left).length >= 3 &&
      prose.filter(
        (i) => i.rect[0] > left + (right - left) * 0.4 && Math.abs(i.rect[2] - right) < i.height
      ).length >= 3 &&
      pageItems.filter(
        (i) =>
          i.horizontal &&
          i.rect[1] < bottom &&
          i.rect[3] > bottom &&
          i.text.trim().split(/\s+/).length >= 5
      ).length >= 2
    )
      return false
    // A clipped questionnaire outline can leave most of the predicted table
    // empty. Its repeated source bullets outside the crop establish list prose.
    if (
      prose.length >= 6 &&
      Math.max(...prose.map((i) => i.rect[3])) < top + (bottom - top) * 0.4 &&
      pageItems.filter(
        (i) =>
          /^[•◦]$/.test(i.text) &&
          i.rect[0] < left &&
          i.rect[0] >= left - i.height * 3 &&
          i.rect[1] >= top &&
          i.rect[3] < bottom
      ).length >= 3
    )
      return false
  }
  if (
    !table.grid.some((row) => row.filter(measurement).length >= 2) &&
    ((/Prepublication history/i.test(cropText) &&
      /supplemental\s+material/i.test(cropText) &&
      /doi(?:[.:]|\.org)/i.test(cropText)) ||
      (/Acknowledgements/i.test(cropText) &&
        table.grid.filter(
          (row) =>
            /^[A-Z][A-Za-z]{1,8}$/.test(row[0]) &&
            row.slice(1).some((text) => text.split(/\s+/).length >= 2)
        ).length >= 3) ||
      (table.grid.every((row) => row.length <= 3) &&
        (cropText.match(/\b(?:Department|University|Institute|College|School)\b/g) ?? []).length >=
          5 &&
        (cropText.match(/\b(?:UK|USA|Ukraine|Korea|Belarus|Federation)\b/g) ?? []).length >= 3))
  )
    return false

  if (
    /Full protocol available at:/i.test(cropText) &&
    /Raw data available at:/i.test(cropText) &&
    /\S+@\S+/.test(cropText) &&
    !table.grid.some((r) => r.some(measurement))
  )
    return false
  // Tiny detections across two prose columns contain clipped sentences rather
  // than independently measured records. Require source overhang on both sides.
  if (
    table.cropRect &&
    table.grid.length <= 3 &&
    table.grid.every((r) => r.length <= 2 && !r.some(measurement))
  ) {
    const prose = pageItems.filter(
      (i) =>
        i.horizontal &&
        i.rect[1] >= table.cropRect[1] - i.height &&
        i.rect[3] <= table.cropRect[3] &&
        i.text.trim().split(/\s+/).length >= 7
    )
    if (
      prose.some(
        (i) => i.rect[0] < table.cropRect[0] - i.height && i.rect[2] > table.cropRect[0]
      ) &&
      prose.some((i) => i.rect[0] < table.cropRect[2] && i.rect[2] > table.cropRect[2] + i.height)
    )
      return false
  }

  // A numbered parameter list has punctuation on each ordinal and one prose
  // field. Ordinals alone must not count as a measurement column.
  if (
    table.grid.every(
      (row) => row.length === 2 && (!row[0].trim() || /^\d+\.$/.test(row[0].trim()))
    ) &&
    table.grid.filter((row) => /^\d+\.$/.test(row[0].trim()) && /\p{L}/u.test(row[1])).length >=
      4 &&
    !table.grid.some((row) => measurement(row[1]))
  )
    return false
  // A small detection across several empty model columns is a prose fragment
  // when native sentences cross its edges and it contains no measured records.
  if (
    table.cropRect &&
    table.grid.length <= 3 &&
    table.grid[0]?.length >= 3 &&
    table.grid.every((row) => row.filter((s) => s.trim()).length <= 4 && !row.some(measurement)) &&
    pageItems.filter(
      (i) =>
        i.text.length > 40 &&
        i.rect[1] < table.cropRect[3] &&
        i.rect[3] > table.cropRect[1] &&
        (i.rect[0] < table.cropRect[0] || i.rect[2] > table.cropRect[2])
    ).length >= 2
  )
    return false

  // Short metadata and bibliography fragments may produce plausible-looking
  // columns. Require explicit publication anchors and no measured data pairs.
  if (
    table.grid.every((row) => row.length <= 3 && row.filter(measurement).length < 2) &&
    ((/\bKey words?:/i.test(cropText) && table.grid.length <= 3) ||
      ((cropText.match(/\((?:19|20)\d{2}\)\s*:/g) ?? []).length >= 3 &&
        /\b(?:Ophthalmol|Cancer|Journ?al)\b/i.test(cropText)))
  )
    return false
  // Disclosure directories align names and relationship labels in columns.
  // Require several explicit relationship labels and no measurement columns;
  // a captioned research table has already been accepted above.
  if (
    table.grid.every((row) => row.length <= 2 && !row.some(measurement)) &&
    (
      cropText.match(
        /\b(?:Consulting or Advisory Role|Research Funding|Honoraria|Speakers[’'] Bureau|Uncompensated Relationships|Travel, Accommodations, Expenses)\s*:/g
      ) ?? []
    ).length >= 3
  )
    return false
  if (
    table.grid.every((row) => row.filter(measurement).length <= 1) &&
    ((/Published Online:/i.test(cropText) && /doi:\s*10\./i.test(cropText)) ||
      ((
        cropText.match(
          /\b(?:Department of|Clinic of|Clinical Epidemiology|College of|Medical School|Epidemiology Division)\b/gi
        ) ?? []
      ).length >= 3 &&
        table.grid.every((row) => row.length <= 3)) ||
      (/\b(?:PhD|MD)\b/.test(cropText) &&
        /\bJournal of\b/.test(cropText) &&
        /\bDOI:\s*10\./i.test(sourceText) &&
        /©/.test(sourceText) &&
        table.grid.length <= 3 &&
        table.grid.every((row) => row.length <= 2)))
  )
    return false
  if (
    /Corresponding Author\s*:/i.test(cropText) &&
    /E-mail\s*:\s*\S+@\S+/i.test(cropText) &&
    /doi\s*:\s*10\./i.test(cropText) &&
    /(?:Creative Commons|Published by)/i.test(cropText)
  )
    return false
  if (
    /Reprints and permission/i.test(cropText) &&
    /DOI:\s*10\./i.test(cropText) &&
    /https?:\/\//.test(cropText) &&
    table.grid.every((r) => r.length <= 2)
  )
    return false
  // Citation prose may use volume, page range and a parenthesized year instead of semicolons.
  if (
    (cropText.match(/\d+,?\s+\d+[–-]\d+\s*\((?:19|20)\d{2}\)/g) ?? []).length >= 2 &&
    /\bet al\b/i.test(cropText) &&
    table.grid.every((r) => r.length <= 2)
  )
    return false
  // Small fragments of a bibliography may contain only one citation. Require
  // multiple complete journal references in the source and no numeric columns.
  const journalReference = /\b(?:19|20)\d{2}\s*;\s*\d+(?:\(\d+\))?\s*:\s*\d+/g
  const journalCitations = (cropText.match(journalReference) ?? []).length
  if (
    journalCitations >= 3 &&
    table.issues?.includes('text-crosses-crop-boundary') &&
    table.grid.every((row) => row.length <= 3) &&
    table.grid.every((row) =>
      row.filter((text) => measurement(text)).every((text) => /^\d{1,3}$/.test(text.trim()))
    ) &&
    table.grid.filter((row) => row.some((text) => words(text) >= 20)).length >= 2
  )
    return false
  if (
    table.grid.length <= 3 &&
    table.grid.every((r) => r.length <= 3) &&
    (sourceText.match(journalReference) ?? []).length >= 3 &&
    journalReference.test(cropText) &&
    /\bet al\b/i.test(cropText) &&
    !table.grid.some((r) => r.some((c) => /^[-−+]?\d+(?:\.\d+)?(?:\s*\([^)]*\))?$/.test(c.trim())))
  )
    return false

  if (
    /Updated version/i.test(sourceText) &&
    /Reprints and/i.test(sourceText) &&
    /Permissions/i.test(sourceText) &&
    /(?:most recent (?:version|supplemental material)|free email-alerts)/i.test(cropText)
  )
    return false
  if (
    /Search (?:profile|strategy)/i.test(sourceText) &&
    (cropText.match(/\d+\s+(?:OR|AND)\s+\d+/g) ?? []).length >= 2 &&
    table.grid.every((row) => row.length <= 2)
  )
    return false
  // Structured abstracts align section labels with prose, not measurements.
  const abstractLabels =
    /^(?:background|purpose|objectives?|patients and methods|methods|results|conclusions?)\s*:?$/i
  const sections = pageItems.filter((item) => abstractLabels.test(item.text.trim()))
  if (
    sections.length >= 3 &&
    sections.some((item) => /conclusion/i.test(item.text)) &&
    table.grid.every((row) => row.length <= 3) &&
    table.grid.some((row) => row.some((text) => text.length > 100)) &&
    sections.some((item) => inside(table.cropRect, item))
  )
    return false
  if (
    /\b(?:Tel\.|Telephone|Fax)\s*:/i.test(cropText) &&
    /\S+@\S+/.test(cropText) &&
    !table.grid.some(
      (row) => row.filter((text) => /^[-+−]?\d+(?:\.\d+)?$/.test(text.trim())).length >= 2
    )
  )
    return false
  if (
    /ARTICLE TOOLS/i.test(cropText) &&
    /PERMISSIONS/i.test(cropText) &&
    /https?:\/\//.test(cropText)
  )
    return false
  if (
    /Email alerting service/i.test(cropText) &&
    /Receive free email alerts/i.test(cropText) &&
    /https?:\/\//.test(cropText)
  )
    return false
  // R/knitr console output is preformatted statistical text, not a predicted
  // cell grid. Keep it in the original PDF instead of publishing a broken grid.
  if (pageItems.filter((i) => /^##/.test(i.text.trim())).length >= 3) return false
  if (/\bAbstract\b/i.test(cropText) && /\bK\s*E\s*Y\s*W\s*O\s*R\s*D\s*S\b/i.test(sourceText))
    return false
  if (
    (cropText.match(/\b(?:19|20)\d{2}\s*;/g) ?? []).length >= 3 &&
    /\bet al\b/i.test(cropText) &&
    !table.grid.some((r) => r.filter((c) => /^\d+(?:\.\d+)?$/.test(c.trim())).length >= 2)
  )
    return false
  if (
    table.grid.length <= 4 &&
    table.grid.every((r) => r.length >= 2) &&
    /\b(?:ethics committee|ethics decision|ethics decisi-)\b/i.test(cropText) &&
    /\b(?:approval|approved)\b/i.test(sourceText)
  )
    return false
  if (
    /(?:通讯作者|通訊作者)/.test(compactText) &&
    /(?:收到|收稿|修订|接受|电子邮[件箱]|電子郵件|orcid\.org)/i.test(compactText)
  )
    return false
  if (
    table.grid[0]?.length >= 2 &&
    (compactText.match(/\p{Script=Han}/gu) ?? []).length > 30 &&
    (/(?:参考文献|參考文獻|orcid\.org)/i.test(compactText) ||
      (compactText.match(/(?:19|20)\d{2}[；;年]/g) ?? []).length >= 2)
  )
    return false
  if (
    (/\bPII\s*:/i.test(cropText) ||
      (cropText.match(/\b(?:Received|Revised|Accepted) Date:/g) ?? []).length >= 2) &&
    /\bDOI\s*:/i.test(cropText) &&
    /\b(?:Reference|To appear in)\s*:/i.test(cropText)
  )
    return false
  if (
    /\S+@\S+/.test(cropText) &&
    table.grid.length <= 6 &&
    table.grid.every(
      (row) =>
        row.length === 2 &&
        /^\d+$/.test(row[0]) &&
        /\b(?:Department|Division|University|Hospital|School)\b/i.test(row[1])
    )
  )
    return false
  if (
    (cropText.match(/\[\d+\]/g) ?? []).length >= 3 &&
    (cropText.match(/\b(?:19|20)\d{2}\s*[;:,]/g) ?? []).length >= 3 &&
    !table.grid.some(
      (row) => row.filter((cell) => /^[-−+]?\d+(?:\.\d+)?$/.test(cell.trim())).length >= 2
    )
  )
    return false
  if (
    /Edited by\s*:/i.test(sourceText) &&
    /Reviewed by\s*:/i.test(sourceText) &&
    /(?:Reviewed by|University|Correspondence|Received|doi\s*:)/i.test(cropText)
  )
    return false
  if (
    /Academic Editor\s*:/i.test(sourceText) &&
    /Received\s*:/i.test(sourceText) &&
    /(?:doi\.org|Keywords\s*:|Academic Editor)/i.test(cropText)
  )
    return false
  const columnText = pageItems
    .filter(
      (item) =>
        !table.cropRect ||
        (item.rect?.[0] >= table.cropRect[0] &&
          item.rect?.[2] <= table.cropRect[2] &&
          item.rect[1] <= table.cropRect[1] + (item.rect[3] - item.rect[1]) * 2 &&
          item.rect[3] >= table.cropRect[1] - (item.rect[3] - item.rect[1]) * 6)
    )
    .map((item) => item.text)
    .join(' ')
  if (
    /A\s*R\s*T\s*I\s*C\s*L\s*E\s+I\s*N\s*F\s*O/i.test(columnText) &&
    /A\s*B\s*S\s*T\s*R\s*A\s*C\s*T/i.test(columnText) &&
    /Keywords\s*:/i.test(cropText)
  )
    return false
  if (
    table.grid[0]?.length === 2 &&
    table.grid.some((row) => /^\s*\*\s*$/.test(row[0]) && /\S+@\S+/.test(row[1])) &&
    table.grid.some(
      (row) => /^\d+$/.test(row[0]) && /\b(?:Department|University|School)\b/i.test(row[1])
    )
  )
    return false
  if (
    /\b(?:Abbreviations|Nomenclature)\b/i.test(sourceText + ' ' + cropText) &&
    table.grid.length >= 4 &&
    table.grid.every(
      (row) => row.length >= 2 && row[0].length < 35 && row.slice(2).every((s) => !s.trim())
    ) &&
    table.grid.filter(
      ([key, value]) => /^[A-Z][A-Za-z\d-]{1,15}$/.test(key) && /\p{L}/u.test(value)
    ).length >= 4 &&
    !table.grid.some((row) => row.some((value) => /^[-−+]?\d+(?:\.\d+)?$/.test(value.trim())))
  )
    return false
  // Publishers lay out abbreviation keys in two parallel key/description lists.
  // Require the heading and repeated acronym pairs, not merely a four-column grid.
  if (
    /\bAbbreviations\b/i.test(cropText) &&
    table.grid.every((row) => row.length === 4) &&
    table.grid
      .flatMap((row) => [
        [row[0], row[1]],
        [row[2], row[3]]
      ])
      .filter(([key, value]) => /^[A-Z][A-Z\d–-]{1,15}$/.test(key) && /\p{L}/u.test(value))
      .length >= 6 &&
    !table.grid.some((row) => row.filter((value) => /^\d+(?:\.\d+)?$/.test(value)).length >= 2)
  )
    return false
  if (
    pageItems.some((item) => /^Affiliations\s*$/i.test(item.text)) &&
    (cropText.match(/\b(?:University|Hospital|College|Department)\b/g) ?? []).length >= 4 &&
    !table.grid.some(
      (row) => row.filter((value) => /^\d+(?:\.\d+)?$/.test(value.trim())).length >= 2
    )
  )
    return false
  if (
    table.grid.length >= 3 &&
    table.grid.filter((row) => row.some((text) => /^\[\d+\]$/.test(text.trim()))).length >=
      table.grid.length * 0.7 &&
    /(?:Data availability|Informed consent)/i.test(cropText)
  )
    return false
  if (
    populatedRows.filter((n) => n === 0).length >= table.grid.length / 2 &&
    table.grid.some((row) => row.some((text) => /\bFig\.\s*\d/.test(text)))
  )
    return false
  // Parallel correspondence blocks are metadata even when addresses contain numbers.
  if (
    /\bCorresponding author[.:]/i.test(cropText) &&
    /\bE-?mail(?: address)?\s*:/i.test(cropText) &&
    /\S+@\S+/.test(cropText) &&
    /\b(?:Department|University|Hospital|Oncology|Therapy)\b/i.test(cropText) &&
    !table.grid.some(
      (row) => row.filter((value) => /^\d+(?:\.\d+)?$/.test(value.trim())).length >= 2
    )
  )
    return false
  // Some journals print author initials and years without DOI links. Require
  // repeated citation anchors, volume/page ranges and long prose, not bare dates.
  if (
    table.grid.every((row) => row.length <= 3) &&
    (cropText.match(/\b[A-Z]{1,3}\s+(?:19|20)\d{2}\b/g) ?? []).length >= 3 &&
    (cropText.match(/\b\d+\s+\d+[–-]\d+/g) ?? []).length >= 2 &&
    table.grid.flat().filter((text) => text.split(/\s+/).length >= 8).length >= 3 &&
    !table.grid.some(
      (row) => row.filter((value) => /^\d+(?:\.\d+)?$/.test(value.trim())).length >= 2
    )
  )
    return false
  // Author-year reference lists may have no numbered margin. Repeated DOI
  // anchors and publication years distinguish them from uncaptained data.
  if (
    table.grid.every((row) => row.length <= 3) &&
    (cropText.match(/\bdoi\s*:\s*10\./gi) ?? []).length >= 3 &&
    (cropText.match(/\b(?:19|20)\d{2}\b/g) ?? []).length >= 3 &&
    /\bet al\b/i.test(cropText) &&
    !table.grid.some(
      (row) => row.filter((value) => /^\d+(?:\.\d+)?$/.test(value.trim())).length >= 2
    )
  )
    return false
  if (
    table.grid[0]?.length >= 2 &&
    table.grid[0].every((_, column) => {
      const text = table.grid.map((row) => row[column]).join(' ')
      return /\bE-?mail\s*:/i.test(text) && /\b(?:Tel\.?|Telephone|Fax)\s*:/i.test(text)
    })
  )
    return false
  // Inspect source citation anchors as well as the reconstructed grid: a poor
  // grid can absorb the numbers into author names or lose whole reference rows.
  const cropItems = pageItems.filter((item) => table.cropRect && inside(table.cropRect, item))
  const possibleNumbers = cropItems.filter(
    (item) =>
      /^\d+$/.test(item.text.trim()) &&
      item.rect[0] < table.cropRect[0] + (table.cropRect[2] - table.cropRect[0]) * 0.12
  )
  const numberLeft = Math.min(...possibleNumbers.map((item) => item.rect[0]))
  const marginNumbers = possibleNumbers
    .filter((item) => Math.abs(item.rect[0] - numberLeft) < item.height * 0.3)
    .sort((a, b) => a.baseline - b.baseline)
  if (
    marginNumbers.length >= 5 &&
    marginNumbers.every(
      (item, i) => !i || Number(item.text) === Number(marginNumbers[i - 1].text) + 1
    ) &&
    marginNumbers.filter((number) => {
      const text = cropItems
        .filter(
          (item) =>
            item.horizontal &&
            item.rect[0] > number.rect[2] &&
            item.height >= number.height * 0.9 &&
            Math.abs(item.baseline - number.baseline) < number.height * 0.4
        )
        .sort((a, b) => a.rect[0] - b.rect[0])
        .map((item) => item.text)
        .join(' ')
      return text.length >= 40 && text.split(/\s+/).length >= 8
    }).length >=
      marginNumbers.length * 0.6
  )
    return false
  const possibleAnchors = cropItems.filter((item) => /^\d+\.$/.test(item.text.trim()))
  const anchorLeft = Math.min(...possibleAnchors.map((item) => item.rect[0]))
  const citationAnchors = possibleAnchors
    .filter((item) => Math.abs(item.rect[0] - anchorLeft) < item.height * 0.5)
    .sort((a, b) => a.baseline - b.baseline)
  if (
    citationAnchors.length >= 3 &&
    citationAnchors.every(
      (item, i) =>
        !i ||
        (Math.abs(item.rect[0] - citationAnchors[0].rect[0]) < item.height &&
          Number.parseInt(item.text) === Number.parseInt(citationAnchors[i - 1].text) + 1)
    ) &&
    (
      cropItems
        .map((item) => item.text)
        .join(' ')
        .match(/\b(?:19|20)\d{2}\./g) ?? []
    ).length >= 3
  )
    return false
  // Publisher disclosure forms contain aligned fields and checklists, not research
  // tables. Require the template marker and a form section, not common row labels.
  if (
    pageItems.some((item) =>
      /^nature(?: portfolio| research)?\s*\|\s*(?:life sciences )?reporting summary$/i.test(
        item.text.trim()
      )
    ) &&
    pageItems.some((item) =>
      /^(?:Experimental design|Field-specific reporting|Life sciences study design|Reporting for specific materials, systems and methods)$/i.test(
        item.text.trim()
      )
    )
  )
    return false
  if (table.issues.includes('overlapping-predicted-columns')) return false
  // Parallel prose columns also produce confident multi-column predictions. A crop cutting
  // through paragraph text, with long prose in most cells of most rows, lacks row evidence.
  // Keep captioned tables and tables with short row labels/numeric or sequence values.
  if (
    (table.unassigned ?? []).some((text) => /^abbreviations\s*:?$/i.test(text.trim())) &&
    table.grid.length >= 3 &&
    table.grid.every(
      (row) => row.length === 2 && /^[\p{L}\d‒–-]+$/u.test(row[0]) && words(row[1]) >= 2
    )
  )
    return false
  const publicationSidebar = table.grid.map((row) => row[0] ?? '')
  if (
    publicationSidebar.some((text) => /^Received:\s+.*\b(?:19|20)\d{2}\b/i.test(text)) &&
    publicationSidebar.some((text) => /^Accepted:\s+.*\b(?:19|20)\d{2}\b/i.test(text)) &&
    publicationSidebar.some((text) => /^(?:Published online:|Check for updates)/i.test(text)) &&
    table.grid.some((row) => row.slice(1).some((text) => words(text) >= 60))
  )
    return false
  // Bibliography continuations may have no section heading. Their numbered entries
  // form a hanging-indent list, with publication years/author citations in prose.
  const referenceNumber = (row) => row[0]?.trim().match(/^[-–−]?\s*(\d+)[.)]?(?:\s+\p{L}+)?$/u)?.[1]
  const numbered = table.grid.filter((row) => referenceNumber(row))
  if (
    numbered.length >= 3 &&
    numbered.length >= populatedRows.filter((count) => count >= 2).length * 0.7 &&
    numbered.every(
      (row, i) => !i || Number(referenceNumber(row)) > Number(referenceNumber(numbered[i - 1]))
    ) &&
    numbered.filter(
      (row, i) => i && Number(referenceNumber(row)) === Number(referenceNumber(numbered[i - 1])) + 1
    ).length >=
      (numbered.length - 1) * 0.7 &&
    numbered.filter((row) => words(row.slice(1).join(' ')) >= 12).length >= numbered.length * 0.7 &&
    (
      [...numbered.flatMap((row) => row.slice(1)), ...(table.unassigned ?? [])]
        .join(' ')
        .match(/(?:\bet al\.|\((?:19|20)\d{2}\)|\b(?:19|20)\d{2};\d)/g) ?? []
    ).length >= 3 &&
    !table.grid
      .slice(0, table.grid.indexOf(numbered[0]))
      .some((row) => row.filter((text) => /\p{L}/u.test(text)).length >= 2)
  )
    return false
  // A ruled article-info/abstract panel is not a table, even when the whole prose
  // fits inside the crop. Require both the keyword sidebar and a nearby ABSTRACT
  // heading. A heading clipped by the upper edge also needs its paired ARTICLE
  // INFO label, so a cell mentioning an abstract remains valid.
  const keywordColumn = table.grid[0]?.findIndex((text) => /^key\s*words?\s*:?$/i.test(text.trim()))
  if (
    keywordColumn >= 0 &&
    table.grid.some((row) =>
      row.some((text, column) => column !== keywordColumn && words(text) >= 80)
    ) &&
    pageItems.some(
      (item) =>
        /^abstract:?$/i.test(item.text.replace(/\s+/g, '')) &&
        table.cropRect &&
        item.rect[0] >= table.cropRect[0] &&
        item.rect[2] <= table.cropRect[2] &&
        ((item.rect[3] <= table.cropRect[1] &&
          table.cropRect[1] - item.rect[3] <= 4 * (item.rect[3] - item.rect[1])) ||
          (Math.abs(item.rect[1] - table.cropRect[1]) <= item.rect[3] - item.rect[1] &&
            pageItems
              .filter(
                (other) =>
                  other.rect[0] >= table.cropRect[0] &&
                  other.rect[2] < item.rect[0] &&
                  Math.abs(other.rect[3] - item.rect[3]) < (item.rect[3] - item.rect[1]) * 0.5
              )
              .sort((a, b) => a.rect[0] - b.rect[0])
              .map((other) => other.text.replace(/\s+/g, ''))
              .join('')
              .toLowerCase() === 'articleinfo'))
    )
  )
    return false
  // A standalone bibliography heading plus a numbered, linked citation is prose,
  // even when the detector splits just one reference across several short columns.
  // A References column beside other headers is not a section heading.
  if (
    table.issues.includes('text-crosses-crop-boundary') &&
    table.grid.some(
      (row) =>
        row.filter((text) => text.trim()).length === 1 &&
        row.some((text) => /^(?:references|bibliography)\s*:?$/i.test(text.trim()))
    ) &&
    table.grid.some((row) =>
      /^\s*(?:\d+[.)]|\[\d+\])\s+\p{L}/u.test(row.find((text) => text.trim()) ?? '')
    ) &&
    [...table.grid.flat(), ...(table.unassigned ?? [])].some((text) => /https?:\/\//i.test(text))
  )
    return false
  const mostlyUnassigned =
    words((table.unassigned ?? []).join(' ')) > words(table.grid.flat().join(' '))
  // A predicted divider through an ordinary paragraph has word-sized gaps on
  // both sides, not a stable column gutter. Require repeated prose rows and actual
  // source positions, so compact numeric tables and captioned prose tables survive.
  // Whole source lines can cross both the crop edge and its first divider.
  // Two such prose lines prove that a narrow three-column prediction cuts
  // ordinary paragraphs; do not reject captioned tables or numeric records.
  if (
    table.cropRect &&
    table.issues.includes('text-crosses-crop-boundary') &&
    table.grid.every((row) => row.length === 3 && !row.some(measurement)) &&
    (table.cells ?? []).filter(
      (cell) =>
        cell.column === 0 &&
        cell.colSpan === 1 &&
        pageItems.some(
          (item) =>
            item.rect &&
            words(item.text) >= 5 &&
            inside(cell.rect, item) &&
            item.rect[0] < table.cropRect[0] - item.height &&
            item.rect[2] > cell.rect[2] + item.height
        )
    ).length >= 2
  )
    return false
  // A crop starting inside a native prose column can leave an unrelated
  // paragraph or list marker in its second model column. Reassemble only
  // word-spaced source lines, and require repeated long lines crossing the
  // left crop edge; isolated overhanging labels remain eligible.
  if (
    table.cropRect &&
    table.issues.includes('text-crosses-crop-boundary') &&
    table.grid.every((row) => row.length === 2 && !row.some(measurement))
  ) {
    const [left, top, right, bottom] = table.cropRect
    const lines = []
    for (const item of pageItems
      .filter((i) => i.horizontal && i.rect[1] >= top && i.rect[3] <= bottom)
      .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
      const line = lines.find((g) => Math.abs(g[0].baseline - item.baseline) < item.height * 0.3)
      if (line) line.push(item)
      else lines.push([item])
    }
    const crossed = lines.filter((line) => {
      const chunks = []
      for (const item of line.sort((a, b) => a.rect[0] - b.rect[0])) {
        const prior = chunks.at(-1)
        if (prior && item.rect[0] - prior.at(-1).rect[2] < item.height) prior.push(item)
        else chunks.push([item])
      }
      return chunks.some(
        (g) =>
          g[0].rect[0] < left - 1 &&
          g.at(-1).rect[2] > left + (right - left) * 0.6 &&
          g.at(-1).rect[2] < right - g[0].height * 2 &&
          words(g.map((i) => i.text).join(' ')) >= 6
      )
    })
    if (crossed.length >= 2 && crossed.length >= lines.length * 0.6) return false
  }
  // A detector can split a long paragraph into one populated cell per row
  // while leaving the neighboring model column empty. Without a caption or
  // measured values this is unstructured page prose, not a table.
  if (
    !caption &&
    table.issues.includes('text-crosses-crop-boundary') &&
    table.grid.length >= 8 &&
    table.grid.filter((row) => row.filter((text) => text.trim()).length === 1).length >=
      table.grid.length * 0.75 &&
    table.grid.filter(
      (row) => row.filter((text) => text.trim()).length === 1 && words(row.join(' ')) >= 4
    ).length >=
      table.grid.length * 0.75 &&
    !table.grid.some((row) => row.some(measurement))
  )
    return false
  const proseRecords = table.grid.filter((row) => row.filter((text) => text.trim()).length >= 2)
  const dividedProse =
    proseRecords.length >= 2 &&
    table.grid.every(
      (row) => row.filter((text) => text.trim()).length <= 2 && !row.some(measurement)
    ) &&
    proseRecords.filter(
      (row) =>
        row.some((text) => /\p{L}/u.test(text)) && row.reduce((n, text) => n + words(text), 0) >= 7
    ).length >=
      proseRecords.length * 0.6
  if (dividedProse) {
    const crossed = (table.cells ?? []).filter(
      (cell) =>
        cell.column === 0 &&
        cell.colSpan === 1 &&
        pageItems.some(
          (a) =>
            a.rect &&
            inside(cell.rect, a) &&
            pageItems.some(
              (b) =>
                b.rect &&
                (b.rect[0] + b.rect[2]) / 2 >= cell.rect[2] &&
                b.rect[0] - a.rect[2] >= 0 &&
                b.rect[0] - a.rect[2] < a.height * 1.5 &&
                Math.abs(a.baseline - b.baseline) < a.height * 0.35
            )
        )
    )
    if (crossed.length >= 2 && crossed.length >= proseRecords.length * 0.6) return false
    // A detector can start in the tail of the neighboring prose column. The
    // apparent stub continues text outside the crop rather than naming a row.
    const paragraphTails = (table.cells ?? []).filter(
      (cell) =>
        table.cropRect &&
        cell.column === 0 &&
        cell.colSpan === 1 &&
        pageItems.some(
          (item) =>
            item.rect &&
            inside(cell.rect, item) &&
            pageItems.some(
              (before) =>
                before.rect &&
                before.rect[0] < table.cropRect[0] - item.height * 2 &&
                before.rect[2] <= item.rect[0] &&
                item.rect[0] - before.rect[2] < item.height * 1.5 &&
                Math.abs(before.baseline - item.baseline) < item.height * 0.35 &&
                /\p{L}/u.test(before.text)
            )
        )
    )
    if (paragraphTails.length >= 2 && paragraphTails.length >= proseRecords.length * 0.6)
      return false
  }
  const proseRows = table.grid.filter((row) => {
    const counts = row.map(words)
    return (
      row.length >= 2 &&
      (counts.every((count) => count >= 6) ||
        (mostlyUnassigned &&
          !row.some((text) => /^\s*[<>≤≥~±+−-]?(?:\d|[.,]\d)/u.test(text)) &&
          // A detached citation number is a prose continuation, not a numeric data column.
          counts.every((count, index) => count >= 2 || /^\[\d+\]$/.test(row[index].trim())) &&
          counts.some((count) => count >= 6) &&
          counts.reduce((sum, count) => sum + count, 0) >= 8))
    )
  })
  if (
    table.issues.includes('text-crosses-crop-boundary') &&
    proseRows.length > table.grid.length / 2
  )
    return false
  return populatedRows.filter((count) => count >= 2).length >= 2
}
