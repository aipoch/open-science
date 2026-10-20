/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import {
  tableSourceItems,
  groupSourceRowsWithScripts,
  readSourceRow,
  hasUniqueRecordTokens
} from './literature-pdf-source-records.mjs'
import { captionKind } from './literature-pdf-caption-group.mjs'
import { union } from './literature-pdf-table-geometry.mjs'

function nativeSectionFrames(tokens, rules) {
  const horizontal = joinHorizontalTableRules(rules, 1),
    bands = []
  for (const rule of horizontal) {
    const prior = bands.find(
      (g) => Math.abs(g[0][0] - rule[0]) < 0.1 && Math.abs(g[0][2] - rule[2]) < 0.1
    )
    if (prior) prior.push(rule)
    else bands.push([rule])
  }
  const sections = []
  for (const band of bands.filter((b) => b.length === 4)) {
    const [top, titleEnd, bodyStart, bottom] = band
    const source = tableSourceItems(tokens, [top[0] - 0.01, top[1], top[2] + 0.01, bottom[1]])
    if (
      tokens.some(
        (item) =>
          item.horizontal &&
          item.text.trim() &&
          item.rect[0] < top[2] &&
          item.rect[2] > top[0] &&
          item.rect[1] < bottom[1] &&
          item.rect[3] > top[1] &&
          !source.includes(item)
      )
    )
      continue
    const titles = source.filter((item) => item.baseline < titleEnd[1])
    if (titles.length !== 1 || !titles[0].text.trim() || !/\p{L}/u.test(titles[0].text)) continue
    const heights = source.map((i) => i.height).sort((a, b) => a - b),
      height = heights[heights.length >> 1]
    if (
      !(height > 0) ||
      titleEnd[1] - top[1] > height * 2 ||
      bodyStart[1] - titleEnd[1] > height * 4
    )
      continue
    const parents = horizontal
      .filter((r) => r[1] > titleEnd[1] && r[1] < bodyStart[1] && r[0] > top[0] && r[2] < top[2])
      .sort((a, b) => a[0] - b[0])
    if (
      parents.length !== 2 ||
      Math.abs(parents[0][1] - parents[1][1]) > 0.1 ||
      parents[0][2] >= parents[1][0]
    )
      continue
    const parentTokens = source.filter(
      (i) => i.baseline > titleEnd[1] && i.baseline < parents[0][1]
    )
    if (
      parentTokens.length !== 2 ||
      parentTokens.some((i, n) => i.rect[0] < parents[n][0] || i.rect[2] > parents[n][2])
    )
      continue
    sections.push({
      band,
      source,
      height,
      parents,
      parentNames: parentTokens.map((i) => i.text),
      parentTokens
    })
  }
  return sections
}

// This proof authorizes only numeric glyph separation, never a new table or
// replacement values. Both independently underlined cohorts repeat the same
// complete statistical leaves inside an otherwise complete native section.
export function provePairedStatisticGutters(tokens, rules) {
  return nativeSectionFrames(tokens, rules).flatMap((section) => {
    const { band, source, height, parents, parentTokens } = section
    const title = source.filter((item) => item.baseline < band[1][1])
    const leaves = source
      .filter((item) => item.baseline > parents[0][1] && item.baseline < band[2][1])
      .sort((a, b) => a.rect[0] - b.rect[0])
    const body = source.filter((item) => item.baseline > band[2][1])
    const groups = groupSourceRowsWithScripts(body, height, 0.3)
    if (
      title.length !== 1 ||
      !/\p{L}/u.test(title[0].text) ||
      leaves.length !== 9 ||
      !groups ||
      groups.length < 3 ||
      !hasUniqueRecordTokens(source, [title, parentTokens, leaves, ...groups])
    )
      return []
    const names = leaves.slice(1, 5).map((item) => item.text)
    if (
      ![
        ['b', 'SE', 't', 'p'],
        ['Estimate', 'SE', 'z', 'p']
      ].some((pattern) => JSON.stringify(pattern) === JSON.stringify(names)) ||
      JSON.stringify(names) !== JSON.stringify(leaves.slice(5).map((item) => item.text))
    )
      return []
    if (
      parents.some((parent, n) =>
        leaves
          .slice(1 + n * 4, 5 + n * 4)
          .some(
            (item) =>
              item.rect[0] < parent[0] - height * 0.4 || item.rect[2] > parent[2] + height * 0.4
          )
      )
    )
      return []
    const numeric = /^[<>≤≥−+\d.\s-]+$/u
    if (
      groups.filter(
        (group) =>
          group
            .filter((item) => numeric.test(item.text))
            .map((item) => item.text)
            .join(' ')
            .match(/\d+/gu)?.length >= 4
      ).length < 3
    )
      return []
    const gutters = [0, 1].flatMap((n) =>
      leaves
        .slice(1 + n * 4, 4 + n * 4)
        .map((item, k) => [item.rect[2], leaves[2 + n * 4 + k].rect[0]])
    )
    if (gutters.some(([left, right]) => left >= right)) return []
    return [
      {
        rect: [band[0][0] - 0.01, band[2][1], band[0][2] + 0.01, band[3][1]],
        cuts: gutters.map(([left, right]) => (left + right) / 2),
        gutterBands: gutters,
        numericOnly: true
      }
    ]
  })
}

export function proveDescriptiveRecordBlock(tables, tokens, captions, rules) {
  const sections = nativeSectionFrames(tokens, rules)
  if (sections.length !== 3) return
  sections.sort((a, b) => a.band[0][1] - b.band[0][1])
  const [first, ...rest] = sections,
    [top, titleEnd, bodyStart, bottom] = first.band,
    { height, source, parents } = first
  if (
    rest.some(
      (s, n) =>
        JSON.stringify(s.parentNames) !== JSON.stringify(first.parentNames) ||
        s.band[0][1] - sections[n].band.at(-1)[1] > height
    )
  )
    return
  const owners = captions.filter(
    (c) =>
      captionKind(c.lines[0]) === 'table' &&
      c.rect[1] > rest.at(-1).band.at(-1)[1] &&
      c.rect[1] - rest.at(-1).band.at(-1)[1] < height * 2 &&
      Math.abs(c.rect[0] - top[0]) < height * 2
  )
  if (owners.length !== 1) return
  if (
    tables.some(
      (t) =>
        t.cropRect[0] < top[2] &&
        t.cropRect[2] > top[0] &&
        t.cropRect[1] < bottom[1] &&
        t.cropRect[3] > top[1]
    )
  )
    return
  if (
    rest.some(
      (s) =>
        !tables.some(
          (t) =>
            t.cropRect[1] > bottom[1] &&
            t.cropRect[1] <= s.band[2][1] &&
            t.cropRect[3] >= s.band[2][1] &&
            t.cropRect[0] < s.band[0][2] &&
            t.cropRect[2] > s.band[0][0]
        )
    )
  )
    return
  const title = source.filter((i) => i.baseline < titleEnd[1]),
    leaves = source
      .filter((i) => i.baseline > parents[0][1] && i.baseline < bodyStart[1])
      .sort((a, b) => a.rect[0] - b.rect[0]),
    body = source.filter((i) => i.baseline > bodyStart[1])
  if (
    title.length !== 1 ||
    !/\p{L}/u.test(title[0].text) ||
    leaves.length !== 7 ||
    leaves.some((i) => !/^[\p{L}\s-]+$/u.test(i.text)) ||
    leaves[3].text !== leaves[5].text ||
    leaves[4].text !== leaves[6].text
  )
    return
  if (
    parents.some((p, n) =>
      leaves.slice(3 + n * 2, 5 + n * 2).some((i) => i.rect[0] < p[0] || i.rect[2] > p[2])
    )
  )
    return
  const groups = groupSourceRowsWithScripts(body, height, 0.3)
  if (
    !groups ||
    groups.length < 6 ||
    !hasUniqueRecordTokens(source, [title, first.parentTokens, leaves, ...groups])
  )
    return
  const number = '[−+-]?(?:\\d+\\.\\d+|\\.\\d+)',
    pair = new RegExp(`^(?:${number}±${number}\\s+){3}${number}±${number}$`, 'u')
  for (const group of groups) {
    const numeric = group
        .filter((i) => /^[\d.±\s−+-]+$/u.test(i.text))
        .sort((a, b) => a.rect[0] - b.rect[0]),
      labels = group.filter((i) => !numeric.includes(i))
    if (
      !labels.length ||
      labels.some((i) => !/^[\p{L}\s-]+$/u.test(i.text)) ||
      labels.some((i) => i.rect[2] > leaves[3].rect[0])
    )
      return
    let text = ''
    for (let n = 0; n < numeric.length; n++)
      text +=
        (n && numeric[n].rect[0] - numeric[n - 1].rect[2] > height * 0.5 ? ' ' : '') +
        numeric[n].text
    if (!pair.test(text.trim().replace(/\s+/gu, ' '))) return
  }
  const cuts = [
    top[0] - 0.01,
    ...leaves.slice(1).map((i, n) => (leaves[n].rect[2] + i.rect[0]) / 2),
    top[2] + 0.01
  ]
  const gutterBands = leaves.slice(1).map((i, n) => [leaves[n].rect[2], i.rect[0]])
  return {
    rect: [cuts[0], top[1], cuts.at(-1), bottom[1]],
    cuts,
    gutterBands,
    band: first.band,
    parents,
    groups,
    caption: owners[0],
    sections,
    height
  }
}

export function recoverDescriptiveRecordBlock(proof, tokens, pageNumber) {
  if (!proof) return
  const { rect, band, parents, height } = proof,
    source = tableSourceItems(tokens, rect),
    cuts = [...proof.cuts]
  for (let c = 1; c < cuts.length - 1; c++) {
    const crossing = source.filter(
      (i) => i.baseline > band[2][1] && i.rect[0] < cuts[c] && i.rect[2] > cuts[c]
    )
    if (!crossing.length) continue
    if (c <= 2 && crossing.every((i) => /^[\p{L}\s-]+$/u.test(i.text))) {
      const edge = Math.max(...crossing.map((i) => i.rect[2]))
      if (edge > proof.gutterBands[c - 1][0] && edge < proof.gutterBands[c - 1][1]) {
        cuts[c] = edge + 0.001
        continue
      }
    }
    const edge = Math.min(...crossing.map((i) => i.rect[0]))
    if (edge <= proof.gutterBands[c - 1][0] || edge >= proof.gutterBands[c - 1][1]) return
    cuts[c] = edge - 0.001
  }
  const body = source.filter((i) => i.baseline > band[2][1]),
    groups = groupSourceRowsWithScripts(body, height, 0.3)
  if (!groups || groups.length !== proof.groups.length) return
  const pair = /^[−+-]?(?:\d+\.\d+|\.\d+)±[−+-]?(?:\d+\.\d+|\.\d+)$/u
  if (
    groups.some((g) => {
      const v = readSourceRow(g, cuts)
      return (
        !v ||
        !v.slice(0, 3).every((s) => /\p{L}/u.test(s)) ||
        !v.slice(3).every((s) => pair.test(s))
      )
    })
  )
    return
  const rows = [
    [rect[0], rect[1], rect[2], band[1][1]],
    [rect[0], band[1][1], rect[2], parents[0][1]],
    [rect[0], parents[0][1], rect[2], band[2][1]],
    ...groups.map((g, n) => [
      rect[0],
      n ? (union(groups[n - 1])[3] + union(g)[1]) / 2 : band[2][1],
      rect[2],
      groups[n + 1] ? (union(g)[3] + union(groups[n + 1])[1]) / 2 : rect[3]
    ])
  ]
  const object = (label, r) => ({ label, score: 1, rect: r.map((v, axis) => v - rect[axis % 2]) })
  const spans = [
    rows[0],
    ...parents.map((p, n) => [cuts[3 + n * 2], rows[1][1], cuts[5 + n * 2], rows[1][3]])
  ]
  return {
    id: `page-${pageNumber}-native-descriptive-record-block`,
    cropRect: rect,
    structure: {
      objects: [
        ...rows.map((r) => object('table row', r)),
        ...cuts.slice(1).map((x, c) => object('table column', [cuts[c], rect[1], x, rect[3]])),
        object('table column header', [rect[0], rect[1], rect[2], band[2][1]]),
        ...spans.map((r) => object('table spanning cell', r))
      ]
    }
  }
}

export function groupDescriptiveRecordBlocks(tables, proof) {
  if (!proof?.tables?.every(Boolean)) return tables
  const parts = proof.tables.map((raw) => tables.find((table) => table.id === raw.id))
  if (parts.length !== 3 || parts.some((part) => !part || part.parts || !part.grid?.length))
    return tables
  const first = parts[0]
  if (!first.caption || parts.some((part) => part.caption?.text !== first.caption.text))
    return tables
  const notes = [
    ...new Map(
      parts.flatMap((part) => part.notes ?? []).map((note) => [JSON.stringify(note), note])
    ).values()
  ]
  return [
    ...tables.filter((table) => !parts.includes(table)),
    {
      id: first.id,
      page: first.page,
      caption: first.caption,
      cropRect: [
        Math.min(...parts.map((part) => part.cropRect[0])),
        Math.min(...parts.map((part) => part.cropRect[1])),
        Math.max(...parts.map((part) => part.cropRect[2])),
        Math.max(...parts.map((part) => part.cropRect[3]))
      ],
      notes,
      parts: parts.map((part, n) => ({
        title: proof.sections[n].source
          .filter((item) => item.baseline < proof.sections[n].band[1][1])
          .map((item) => item.text)
          .join(' '),
        sourceViewport: part.sourceViewport,
        grid: part.grid,
        cells: part.cells,
        unassigned: part.unassigned,
        issues: part.issues,
        notes: []
      }))
    }
  ]
}
