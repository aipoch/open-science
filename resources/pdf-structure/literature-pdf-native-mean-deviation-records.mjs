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

const intersects = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
function nativeBands(tokens, rules) {
  const horizontal = joinHorizontalTableRules(rules, 1),
    groups = []
  for (const rule of horizontal) {
    const group = groups.find(
      (g) => Math.abs(g[0][0] - rule[0]) < 0.1 && Math.abs(g[0][2] - rule[2]) < 0.1
    )
    if (group) group.push(rule)
    else groups.push([rule])
  }
  return groups
    .filter((g) => g.length === 4)
    .map((band) => {
      const [top, titleEnd, bodyStart, bottom] = band,
        rect = [top[0] - 0.01, top[1], top[2] + 0.01, bottom[1]],
        source = tableSourceItems(tokens, rect),
        heights = source.map((i) => i.height).sort((a, b) => a - b),
        height = heights[heights.length >> 1]
      if (
        !(height > 0) ||
        titleEnd[1] - top[1] > height * 2 ||
        bodyStart[1] - titleEnd[1] > height * 4 ||
        tokens.some((i) => i.text?.trim() && intersects(i.rect, rect) && !source.includes(i))
      )
        return
      const title = source.filter((i) => i.baseline < titleEnd[1]),
        parents = horizontal
          .filter(
            (r) => r[1] > titleEnd[1] && r[1] < bodyStart[1] && r[0] > top[0] && r[2] < top[2]
          )
          .sort((a, b) => a[0] - b[0])
      if (
        !title.length ||
        !title.some((i) => /\p{L}/u.test(i.text)) ||
        title.some((i) => Math.abs(i.baseline - title[0].baseline) > height * 0.1)
      )
        return
      return { band, rect, source, height, title, parents }
    })
    .filter(Boolean)
    .sort((a, b) => a.rect[1] - b.rect[1])
}
function parentTokens(section) {
  if (
    section.parents.length !== 2 ||
    Math.abs(section.parents[0][1] - section.parents[1][1]) > 0.1 ||
    section.parents[0][2] >= section.parents[1][0]
  )
    return
  const tokens = section.source.filter(
    (i) => i.baseline > section.band[1][1] && i.baseline < section.parents[0][1]
  )
  return tokens.length === 2 &&
    tokens.every(
      (i, n) =>
        i.rect[0] >= section.parents[n][0] - section.height * 0.25 &&
        i.rect[2] <= section.parents[n][2] + section.height * 0.25
    )
    ? tokens
    : undefined
}

// Existing model ownership, repeated native cohort underlines, complete paired
// statistics and a uniquely closed adjacent caption chain prove this repair.
// Numeric text is read from its original glyph rectangles; it is never split by
// equal widths or rewritten into guessed values.
export function recoverNativeMeanDeviationRecords(tables, tokens, captions, rules) {
  const sections = nativeBands(tokens, rules),
    replacements = []
  for (const section of sections) {
    const { band, rect, source, height, title, parents } = section,
      parent = parentTokens(section)
    if (title.length !== 1 || !parent) continue
    const leaves = source
      .filter((i) => i.baseline > parents[0][1] && i.baseline < band[2][1])
      .sort((a, b) => a.rect[0] - b.rect[0])
    if (
      leaves.length !== 4 ||
      leaves.some((i) => !/^\p{L}[\p{L}\s-]*$/u.test(i.text)) ||
      leaves[2].text !== leaves[3].text ||
      leaves[1].rect[2] >= parents[0][0] ||
      [2, 3].some(
        (c) =>
          leaves[c].rect[0] < parents[c - 2][0] - height * 0.25 ||
          leaves[c].rect[2] > parents[c - 2][2] + height * 0.25
      )
    )
      continue
    const cuts = [
        rect[0],
        ...leaves.slice(1).map((i, n) => (leaves[n].rect[2] + i.rect[0]) / 2),
        rect[2]
      ],
      body = source.filter((i) => i.baseline > band[2][1]),
      groups = groupSourceRowsWithScripts(body, height, 0.3)
    const pair = /^[−+-]?(?:\d+\.\d+|\.\d+)±[−+-]?(?:\d+\.\d+|\.\d+)$/u
    if (
      !groups ||
      groups.length < 4 ||
      !hasUniqueRecordTokens(source, [title, parent, leaves, ...groups]) ||
      groups.some((g) => {
        const v = readSourceRow(g, cuts)
        return (
          !v ||
          !v.slice(0, 2).every((s) => /^\p{L}[\p{L}\s-]*$/u.test(s)) ||
          !v.slice(2).every((s) => pair.test(s))
        )
      })
    )
      continue
    const next = sections.find((s) => s.rect[1] > rect[3] && s.rect[1] - rect[3] <= height),
      nextParents = next && parentTokens(next)
    if (!nextParents || nextParents.some((i, n) => i.text !== parent[n].text)) continue
    const lowerLeaves = next.source
      .filter((i) => i.baseline > next.parents[0][1] && i.baseline < next.band[2][1])
      .sort((a, b) => a.rect[0] - b.rect[0])
    if (
      lowerLeaves.length !== 9 ||
      lowerLeaves.slice(1, 5).some((i, n) => i.text !== lowerLeaves[5 + n].text)
    )
      continue
    const chain = [section, next]
    for (const other of sections.filter((s) => s.rect[1] > next.rect[3])) {
      if (other.rect[1] - chain.at(-1).rect[3] > height) break
      chain.push(other)
    }
    const footer = chain.at(-1).rect[3],
      owners = captions.filter(
        (c) =>
          captionKind(c.lines[0]) === 'table' &&
          c.rect[1] > footer &&
          c.rect[1] - footer < height * 2 &&
          c.rect[0] < rect[2] &&
          c.rect[2] > rect[0]
      )
    if (
      owners.length !== 1 ||
      captions.some(
        (c) =>
          c !== owners[0] &&
          c.rect[1] >= rect[1] &&
          c.rect[3] <= owners[0].rect[1] &&
          c.rect[0] < rect[2] &&
          c.rect[2] > rect[0]
      )
    )
      continue
    const models = tables.filter(
      (t) =>
        t.structure?.objects?.filter((o) => o.label === 'table column').length === 4 &&
        intersects(t.cropRect, rect) &&
        Math.abs(t.cropRect[0] - rect[0]) <= height &&
        Math.abs(t.cropRect[2] - rect[2]) <= height &&
        t.cropRect[1] <= band[2][1] &&
        t.cropRect[3] >= union(groups.at(-1))[3]
    )
    if (
      models.length !== 1 ||
      tables.some((t) => !models.includes(t) && intersects(t.cropRect, rect))
    )
      continue
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
    const object = (label, r) => ({ label, score: 1, rect: r.map((v, n) => v - rect[n % 2]) }),
      spans = [rows[0], ...[0, 1].map((c) => [cuts[c], band[1][1], cuts[c + 1], band[2][1]])]
    const original = models[0]
    replacements.push({
      original,
      caption: owners[0],
      table: {
        id: original.id,
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
    })
  }
  return replacements.length ? { replacements } : undefined
}
