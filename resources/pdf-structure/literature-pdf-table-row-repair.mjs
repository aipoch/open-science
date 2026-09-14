/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { hasHorizontalTableRuleBetween } from './literature-pdf-table-rules.mjs'
import {
  readSourceRow,
  groupSourceRowsWithScripts,
  splitOwnedSourceRow,
  splitOwnedSourceRows
} from './literature-pdf-source-records.mjs'
import { area, intersection } from './literature-pdf-page-geometry.mjs'
import { inside, union, isAdjacentTableScript } from './literature-pdf-table-geometry.mjs'

// Resource records start with aligned name/source/identifier fields. Native
// section borders distinguish headings from wrapped labels; every other line
// must have exactly one preceding record owner before replacing model bands.
function recoverResourceRows({ rows, items, columnRects, rules, repairs }) {
  if (columnRects.length !== 3 || items.some((item) => !item.horizontal)) return
  const cuts = [columnRects[0][0], ...columnRects.map((rect) => rect[2])]
  const heights = items.map((item) => item.height).sort((a, b) => a - b)
  const height = heights[Math.floor(heights.length / 2)]
  const source = items.slice().sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
  const lines = groupSourceRowsWithScripts(source, height, 0.35)
  if (!lines || lines.length < 10) return
  const values = lines.map((line) => readSourceRow(line, cuts))
  if (
    values.some((value) => !value) ||
    !/^(?:REAGENTorRESOURCE|RESOURCE)$/i.test(values[0][0]) ||
    values[0][1] !== 'SOURCE' ||
    values[0][2] !== 'IDENTIFIER'
  )
    return
  const bounds = lines.map(union)
  const borders = rules.filter(
    (rule) =>
      rule[1] === rule[3] &&
      Math.abs(rule[0] - cuts[0]) < height * 1.5 &&
      Math.abs(rule[2] - cuts[3]) < height * 1.5
  )
  const bordered = (rect, below) =>
    borders.some((rule) => {
      const gap = below ? rule[1] - rect[3] : rect[1] - rule[1]
      return gap >= 0 && gap < height
    })
  if (!bordered(bounds[0], true) || !bordered(bounds.at(-1), true)) return
  const records = [{ members: [...lines[0]], section: false }]
  let sections = 0,
    complete = 0,
    wrapped = 0
  for (let n = 1; n < lines.length; n++) {
    const value = values[n],
      line = lines[n],
      rect = bounds[n]
    if (value.every(Boolean)) {
      if (!/\p{L}/u.test(value[0]) || !/\p{L}/u.test(value[1])) return
      records.push({ members: [...line], section: false })
      complete++
    } else if (
      value[0] &&
      !value[1] &&
      !value[2] &&
      bordered(rect, false) &&
      bordered(rect, true)
    ) {
      if (!/\p{L}/u.test(value[0])) return
      records.push({ members: [...line], section: true })
      sections++
    } else {
      const previous = records.at(-1)
      if (
        previous.section ||
        records.length === 1 ||
        // A fresh URL or catalog identifier is a record even if its source is blank.
        /^(?:https?:\/\/|N\/A$|[A-Z]*\d[\w./–−-]*$)/i.test(value[2]) ||
        rect[1] <= bounds[n - 1][3] ||
        line[0].baseline - lines[n - 1][0].baseline > height * 1.5 ||
        hasHorizontalTableRuleBetween(rules, bounds[n - 1][3], rect[1]) ||
        line.some((item) => {
          const column = columnRects.findIndex((r) => inside(r, item))
          if (column < 0) return true
          const anchors = previous.members.filter((anchor) => inside(columnRects[column], anchor))
          return (
            !anchors.length ||
            Math.abs(item.rect[0] - Math.min(...anchors.map((a) => a.rect[0]))) > height
          )
        })
      )
        return
      previous.members.push(...line)
      wrapped++
    }
  }
  if (sections < 2 || complete < 6 || wrapped < 2) return
  rows.splice(
    0,
    rows.length,
    ...records.map(({ members, section }) => {
      const rect = union(members)
      return { rect: [cuts[0], rect[1], cuts[3], rect[3]], origin: 'source-text', section }
    })
  )
  repairs.push('text-supported-wrapped-records-recovered')
  return true
}

// Mutates row bands and appends repair reasons before ruled-grid recovery.
export function repairWrappedTableRows({
  rows,
  items,
  groups = [],
  columnRects,
  rules,
  right,
  repairs
}) {
  if (recoverResourceRows({ rows, items, columnRects, rules, repairs })) return
  const columnOf = (item) => columnRects.findIndex((column) => inside(column, item))
  // A separate ruled band of consecutive time headings may be excluded from
  // every model row. Join split glyphs for recognition only; keep source text.
  const head = groups[0]
  if (head?.length && columnRects.length >= 5) {
    const texts = columnRects.map((_, c) =>
      head
        .filter((i) => columnOf(i) === c)
        .map((i) => i.text)
        .join('')
        .replace(/\s/g, '')
    )
    const first = texts.findIndex(Boolean)
    const hs = union(head)
    const divider = rules.find(
      (r) =>
        r[1] === r[3] &&
        r[0] <= columnRects[0][0] + 12 &&
        r[2] >= right - 12 &&
        r[1] > hs[3] &&
        r[1] - hs[3] < head[0].height
    )
    if (
      first > 0 &&
      texts.length - first >= 3 &&
      texts.slice(first).every((s, n) => new RegExp(`^[tT]${n}$`).test(s)) &&
      divider &&
      head.every((i) => Math.abs(i.baseline - head[0].baseline) < 1) &&
      !items.some((i) => !head.includes(i) && i.rect[1] < divider[1])
    ) {
      for (let r = rows.length - 1; r >= 0; r--) {
        if (rows[r].rect[3] <= divider[1]) rows.splice(r, 1)
        else rows[r].rect[1] = Math.max(rows[r].rect[1], divider[1])
      }
      rows.unshift({
        rect: [columnRects[0][0], hs[1], right, divider[1]],
        origin: 'source-time-header'
      })
      repairs.push('ruled-time-header-recovered')
    }
  }
  // A complete labeled P-value record can fall in a gap between model bands.
  // Require two explicit P values, matching labeled peers, and native table
  // borders; a numeric continuation without its own label is not a record.
  const cuts = [columnRects[0]?.[0], ...columnRects.map((r) => r[2])]
  // Duplicate/overlapping bands can give a complete counted record two owners.
  // Rebuild only the intersecting bands when every contained source baseline
  // is itself a complete record or a sample-size heading.
  for (const group of groups) {
    const values = readSourceRow(group, cuts)
    const counted = (v) =>
      v && v.filter((s) => /^\d+(?:\/\d+)?\(\d+(?:\.\d+)?%\)$/.test(s)).length >= 2
    if (!counted(values)) continue
    const owners = rows.filter((r) => group.some((i) => inside(r.rect, i)))
    if (owners.length < 2) continue
    const members = items.filter((i) => owners.some((r) => inside(r.rect, i)))
    const bands = groups.filter((g) => g.some((i) => members.includes(i)))
    if (bands.length < 2 || bands.some((g) => g.some((i) => !members.includes(i)))) continue
    if (
      bands.some((g) => {
        const v = readSourceRow(g, cuts)
        return (
          !counted(v) &&
          !(v && /\p{L}/u.test(v[0]) && v.filter((x) => /^n=\d+$/.test(x)).length >= 2)
        )
      })
    )
      continue
    const boxes = bands.map(union)
    if (
      boxes.some((r, n) => n && r[1] <= boxes[n - 1][3]) ||
      rows.some((r) => !owners.includes(r) && members.some((i) => inside(r.rect, i)))
    )
      continue
    const start = rows.indexOf(owners[0])
    if (owners.some((r, n) => rows.indexOf(r) !== start + n)) continue
    rows.splice(
      start,
      owners.length,
      ...boxes.map((r) => ({ rect: [cuts[0], r[1], right, r[3]], origin: 'source-text' }))
    )
    repairs.push('counted-record-bands-restored')
  }

  // A final R-squared expression is a sparse in-table record, not a
  // coefficient continuation. Require coefficient headings, repeated paired
  // numeric rows, native enclosure and one uniquely anchored exponent.
  if (columnRects.length === 3 && rows.length >= 5) {
    const last = rows.at(-1)
    const tail = items.filter((i) => i.rect[1] >= last.rect[3])
    const label = tail.find((i) => i.text === 'R')
    const power = tail.find((i) => i.text === '2' && label && isAdjacentTableScript(i, label))
    const value = tail.find((i) => /^=\s*0?\.\d+\*{0,3}$/.test(i.text.trim()))
    const header = readSourceRow(groups[0] ?? [], cuts)
    if (
      tail.length === 3 &&
      label &&
      power &&
      value &&
      header?.[1] === 'B' &&
      header[2] === 'SEB' &&
      tail.every((i) => columnOf(i) === 1) &&
      Math.abs(label.baseline - value.baseline) < label.height * 0.2 &&
      value.rect[0] >= power.rect[2] &&
      value.rect[0] - power.rect[2] < label.height &&
      label.rect[1] - last.rect[3] < label.height &&
      groups.filter((g) => {
        const v = readSourceRow(g, cuts)
        return (
          v &&
          /\p{L}/u.test(v[0]) &&
          v.slice(1).every((s) => /^[<>−+-]?\d+(?:\.\d+)?\*{0,3}$/.test(s))
        )
      }).length >= 4 &&
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[0] <= cuts[0] + 4 &&
          r[2] >= right - 4 &&
          r[1] > Math.max(...tail.map((i) => i.rect[3])) &&
          r[1] - label.baseline < label.height * 2
      ) &&
      !hasHorizontalTableRuleBetween(rules, last.rect[3], label.rect[1])
    ) {
      const rect = union(tail)
      rows.push({ rect: [cuts[0], rect[1], right, rect[3]], origin: 'source-text' })
      repairs.push('trailing-regression-summary-recovered')
    }
  }
  // A labeled record can fall just above the model row holding its closing
  // brackets. Recover only repeated labels and paired, source-aligned values;
  // this joins physical lines without inferring displaced scientific pairings.
  for (let n = 1; n + 1 < groups.length; n++) {
    const head = groups[n],
      tail = groups[n + 1]
    const values = readSourceRow(head, cuts),
      endings = readSourceRow(tail, cuts)
    if (!values || !endings || !/^[A-Za-z][A-Za-z -]+$/.test(values[0])) continue
    const columns = values.slice(1).flatMap((v, c) => (v ? [c + 1] : []))
    const a = union(head),
      b = union(tail)
    if (
      columns.length < 2 ||
      endings[0] ||
      !columns.every((c) => /^\[\d+\(\d+(?:\.\d+)?\)$/.test(values[c]) && endings[c] === ']') ||
      endings.some((v, c) => v && !columns.includes(c)) ||
      head.some((i) => Math.abs(i.baseline - head[0].baseline) > i.height * 0.2) ||
      tail.some((i) => Math.abs(i.baseline - tail[0].baseline) > i.height * 0.2) ||
      b[1] < a[3] ||
      b[1] - a[3] > head[0].height * 0.5 ||
      rows.some((r) => head.some((i) => inside(r.rect, i))) ||
      hasHorizontalTableRuleBetween(rules, a[1], b[3]) ||
      groups.filter((g) => readSourceRow(g, cuts)?.[0] === values[0]).length < 3
    )
      continue
    const owners = rows.filter((r) => tail.every((i) => inside(r.rect, i)))
    if (owners.length !== 1) continue
    const owner = owners[0]
    const expanded = [cuts[0], a[1], right, owner.rect[3]]
    if (
      owner.rect[1] < a[3] - head[0].height * 0.5 ||
      items.some((i) => inside(expanded, i) && !head.includes(i) && !tail.includes(i)) ||
      rows.some((r) => r !== owner && r.rect[1] < a[3] && r.rect[3] > a[1])
    )
      continue
    owner.rect = expanded
    repairs.push('text-supported-wrapped-records-recovered')
  }
  // Repeated n (%) labels can occupy a gap between model rows. Require an
  // empty stub, every value column and two complete counted records below;
  // a sample size or a lone numeric continuation is not a header.
  for (let n = 1; n + 2 < groups.length; n++) {
    const header = groups[n],
      values = readSourceRow(header, cuts),
      rect = union(header)
    if (
      columnRects.length < 3 ||
      !values ||
      values[0] ||
      !values.slice(1).every((v) => /^n\(%\)$/i.test(v)) ||
      header.some((i) => Math.abs(i.baseline - header[0].baseline) > i.height * 0.2) ||
      rows.some((r) => r.rect[1] < rect[3] && r.rect[3] > rect[1]) ||
      !groups.slice(n + 1, n + 3).every((g) => {
        const v = readSourceRow(g, cuts)
        return v && /\p{L}/u.test(v[0]) && v.slice(1).every((s) => /^\d+\(\d+(?:\.\d+)?\)$/.test(s))
      }) ||
      union(groups[n - 1])[3] >= rect[1] ||
      rect[3] >= union(groups[n + 1])[1] ||
      groups[n + 1][0].baseline - header[0].baseline > header[0].height * 1.8 ||
      hasHorizontalTableRuleBetween(rules, rect[3], union(groups[n + 1])[1])
    )
      continue
    rows.push({ rect: [cuts[0], rect[1], right, rect[3]], origin: 'source-statistic-header' })
    rows.sort((a, b) => a.rect[1] - b.rect[1])
  }
  // A flush wrapped category can fall across the gap before the next model
  // row. Its lowercase tail has no values; matching counted records on both
  // sides establish the owning label column independently of the model span.
  for (let n = 2; n + 1 < groups.length; n++) {
    const head = groups[n - 1],
      tail = groups[n],
      next = groups[n + 1]
    const c = columnOf(tail[0]),
      label = head.filter((i) => columnOf(i) === c)
    if (c < 0 || !label.length || !tail.every((i) => columnOf(i) === c)) continue
    const a = union(label),
      b = union(tail),
      following = next.filter((i) => columnOf(i) === c)
    const counted = (g) => {
      const v = readSourceRow(g, cuts)
      return (
        v &&
        v.slice(c + 1).filter(Boolean).length >= 3 &&
        v.slice(c + 1).every((s) => !s || /^\d+\(\d+(?:\.\d+)?\)$/.test(s))
      )
    }
    if (
      !/^\p{Lu}/u.test(label[0].text) ||
      !/^\p{Ll}/u.test(tail[0].text) ||
      !following.length ||
      !/^\p{Lu}/u.test(following[0].text) ||
      ![groups[n - 2], head, next].every(counted) ||
      head.some((i) => columnOf(i) < c) ||
      a[2] - a[0] < (columnRects[c][2] - columnRects[c][0]) * 0.5 ||
      Math.abs(a[0] - b[0]) > label[0].height * 0.1 ||
      Math.abs(a[0] - following[0].rect[0]) > label[0].height * 0.1 ||
      tail.some((i) => Math.abs(i.height - label[0].height) > label[0].height * 0.1) ||
      b[1] <= a[3] ||
      b[3] >= union(next)[1] ||
      tail[0].baseline - label[0].baseline > label[0].height * 1.6 ||
      rules.some((r) => r[1] === r[3] && r[1] > a[3] && r[1] < b[3] && r[0] < b[2] && r[2] > b[0])
    )
      continue
    const owners = rows.filter((r) => head.every((i) => inside(r.rect, i)))
    const followingOwners = rows.filter((r) => following.every((i) => inside(r.rect, i)))
    if (owners.length !== 1 || followingOwners.length !== 1) continue
    const previous = owners[0],
      followingRow = followingOwners[0]
    if (
      rows.indexOf(followingRow) !== rows.indexOf(previous) + 1 ||
      items.some(
        (i) => !head.includes(i) && !tail.includes(i) && i.rect[1] < b[3] && i.rect[3] > a[1]
      )
    )
      continue
    const boundary = (b[3] + union(next)[1]) / 2
    previous.rect[3] = boundary
    followingRow.rect[1] = boundary
  }
  for (let n = 1; n < groups.length; n++) {
    const g = groups[n],
      rect = union(g),
      values = readSourceRow(g, cuts)
    const coefficient =
      values &&
      values.length >= 6 &&
      !values[0] &&
      /[A-Za-z].*×/.test(values[1]) &&
      values.slice(2).filter(Boolean).length >= 4 &&
      values
        .slice(2)
        .every(
          (v) =>
            !v || /^[−+-]?(?:\d*\.)?\d+(?:\([−+-]?(?:\d*\.)?\d+,[−+-]?(?:\d*\.)?\d+\))?$/.test(v)
        ) &&
      values.some((v) => /\(.*,/.test(v))
    const counted =
      values &&
      !values[0] &&
      /^\p{L}.*[<>≤≥]/u.test(values[1]) &&
      values.slice(2).filter(Boolean).length === 2 &&
      values.slice(2).every((v) => !v || /^\d+\/\d+\(\d+(?:\.\d+)?%\)$/.test(v)) &&
      groups.filter((other) => readSourceRow(other, cuts)?.[1] === values[1]).length >= 3
    const stub = coefficient || counted ? 1 : 0
    if (
      !values ||
      (!coefficient &&
        !counted &&
        (!/^[A-Za-z][A-Za-z -]*$/.test(values[0]) ||
          values.slice(1).filter(Boolean).length < 2 ||
          values.slice(1).some((v) => v && !/^p[=<>≤≥](?:0?\.\d+|1(?:\.0+)?)$/i.test(v)))) ||
      rows.some((r) => g.some((i) => inside(r.rect, i)))
    )
      continue
    const peers = groups.filter(
      (other) =>
        other !== g &&
        other.some(
          (i) =>
            columnOf(i) === stub && /\p{L}/u.test(i.text) && Math.abs(i.rect[0] - g[0].rect[0]) < 1
        ) &&
        rows.some((r) => other.every((i) => inside(r.rect, i)))
    )
    if (
      !peers.some((p) => union(p)[3] < rect[1]) ||
      (!peers.some((p) => union(p)[1] > rect[3]) &&
        !(counted && n === groups.length - 1 && peers.length >= 3)) ||
      !rules.some(
        (r) => r[1] === r[3] && r[0] <= cuts[0] + 12 && r[2] >= right - 12 && r[1] < rect[1]
      ) ||
      (!counted &&
        !rules.some(
          (r) => r[1] === r[3] && r[0] <= cuts[0] + 12 && r[2] >= right - 12 && r[1] > rect[3]
        ))
    )
      continue
    const overlap = rows.filter((r) => r.rect[1] < rect[3] && r.rect[3] > rect[1])
    if (
      overlap.some((r) =>
        items.some(
          (i) =>
            !g.includes(i) &&
            inside(r.rect, i) &&
            (i.rect[1] + i.rect[3]) / 2 >= rect[1] &&
            (i.rect[1] + i.rect[3]) / 2 <= rect[3]
        )
      )
    )
      continue
    for (const r of overlap) {
      if (r.rect[1] < rect[1]) r.rect[3] = rect[1]
      else r.rect[1] = rect[3]
    }
    rows.push({ rect: [cuts[0], rect[1], right, rect[3]], origin: 'source-p-record' })
    rows.sort((a, b) => a.rect[1] - b.rect[1])
    repairs.push(
      coefficient
        ? 'coefficient-record-recovered'
        : counted
          ? 'counted-record-recovered'
          : 'labeled-p-record-recovered'
    )
  }
  // A complete summary and its lowercase statistic-label continuation can
  // straddle overlapping model rows. Rebuild only bands owning these exact
  // tokens, with every numeric column present and no intervening native rule.
  for (let n = 0; n + 1 < groups.length; n++) {
    const head = groups[n],
      tail = groups[n + 1],
      values = readSourceRow(head, cuts)
    if (
      !values ||
      values.length < 3 ||
      !/^(?:Mean|Median)\p{L}/u.test(values[0]) ||
      !values
        .slice(1)
        .every((v) => /^[<>≤≥−+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:\([−+-]?\d+(?:\.\d+)?\))?$/.test(v)) ||
      tail.some((i) => columnOf(i) !== 0) ||
      !/^[a-z].*\((?:IQR|SD|range)\)$/.test(tail.map((i) => i.text).join(' ')) ||
      Math.abs(tail[0].rect[0] - head[0].rect[0]) > 1 ||
      tail[0].baseline - head[0].baseline > head[0].height * 1.6
    )
      continue
    const members = [...head, ...tail],
      rect = union(members)
    const owners = rows.filter((row) => members.some((i) => inside(row.rect, i)))
    if (
      owners.length < 2 ||
      owners.length > 3 ||
      items.some((i) => !members.includes(i) && owners.some((row) => inside(row.rect, i))) ||
      members.some((i) => !owners.some((row) => inside(row.rect, i))) ||
      hasHorizontalTableRuleBetween(rules, union(head)[3], union(tail)[1])
    )
      continue
    const rest = rows.filter((row) => !owners.includes(row))
    if (rest.some((row) => row.rect[1] < rect[3] && row.rect[3] > rect[1])) continue
    rows.splice(0, rows.length, ...rest, {
      rect: [cuts[0], rect[1], right, rect[3]],
      origin: 'source-summary'
    })
    rows.sort((a, b) => a.rect[1] - b.rect[1])
    repairs.push('overlapping-wrapped-summary-recovered')
  }
  recoverLeadingSampleSection({ rows, groups, items, columnRects, rules, repairs })
  // A numeric interval can wrap into the next predicted row. Its explicit
  // opening and closing parentheses establish ownership before the next label.
  for (let n = 1; n < groups.length - 1; n++) {
    const head = groups[n - 1],
      tail = groups[n],
      next = groups[n + 1]
    const c = columnOf(tail[0])
    if (c <= 0 || !tail.every((i) => columnOf(i) === c)) continue
    const text = (g) =>
      g
        .filter((i) => columnOf(i) === c)
        .sort((a, b) => a.rect[0] - b.rect[0])
        .map((i) => i.text)
        .join('')
        .replace(/\s/g, '')
    if (
      !/^\([−+-]?\d+(?:\.\d+)?,?$/.test(text(head)) ||
      !/^[−+-]?\d+(?:\.\d+)?\)$/.test(text(tail)) ||
      !head.some((i) => columnOf(i) === 0 && /\p{L}/u.test(i.text)) ||
      !next.some((i) => columnOf(i) === 0 && /\p{L}/u.test(i.text)) ||
      new Set(head.map(columnOf).filter((c) => c > 0)).size < 3 ||
      union(tail)[1] < union(head)[3] ||
      union(tail)[3] >= union(next)[1] ||
      tail[0].baseline - head[0].baseline > tail[0].height * 1.8
    )
      continue
    const previous = rows.find((r) => head.some((i) => columnOf(i) === 0 && inside(r.rect, i)))
    const following = rows.find((r) => next.some((i) => columnOf(i) === 0 && inside(r.rect, i)))
    if (
      !previous ||
      !following ||
      previous === following ||
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[1] > union(head)[3] &&
          r[1] < union(tail)[1] &&
          r[0] <= columnRects[c][0] &&
          r[2] >= columnRects[c][2]
      )
    )
      continue
    const boundary = (union(tail)[3] + union(next)[1]) / 2
    previous.rect[3] = boundary
    following.rect[1] = boundary
    repairs.push('wrapped-numeric-interval-owned')
  }
  // Some interval columns print their two endpoints on separate baselines.
  // Require repeated complete records followed only by CI endpoints; a blank
  // stub alone is not evidence that two rows describe the same observation.
  const intervalColumns = columnRects.flatMap((column, c) =>
    groups.some((group) =>
      /^95%\s*CI$/i.test(
        group
          .filter((item) => inside(column, item))
          .map((item) => item.text)
          .join(' ')
      )
    )
      ? [c]
      : []
  )
  if (intervalColumns.length >= 2 && !intervalColumns.includes(0)) {
    const numeric = (item) => /^[-−]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(item.text)
    const pairs = groups.flatMap((head, index) => {
      const tail = groups[index + 1]
      if (
        !tail ||
        !head.some((i) => columnOf(i) === 0 && /\p{L}/u.test(i.text)) ||
        !columnRects
          .slice(1)
          .every((_, c) => head.some((i) => columnOf(i) === c + 1 && numeric(i))) ||
        tail.length !== intervalColumns.length ||
        !intervalColumns.every((c) => tail.some((i) => columnOf(i) === c && numeric(i))) ||
        union(tail)[1] < union(head)[3] ||
        tail[0].baseline - head[0].baseline > tail[0].height * 1.8 ||
        rules.some(
          (r) =>
            r[1] === r[3] &&
            r[1] > union(head)[3] &&
            r[1] < union(tail)[1] &&
            r[0] <= columnRects[0][2] &&
            r[2] >= right - 4
        )
      )
        return []
      return [[...head, ...tail]]
    })
    if (pairs.length >= 2) {
      for (const pair of pairs) {
        const rect = union(pair)
        const replaced = rows.filter((row) => row.rect[1] < rect[3] && row.rect[3] > rect[1])
        if (
          !replaced.length ||
          items.some((i) => !pair.includes(i) && replaced.some((row) => inside(row.rect, i)))
        )
          continue
        rows.splice(0, rows.length, ...rows.filter((row) => !replaced.includes(row)), {
          rect: [columnRects[0][0], rect[1], right, rect[3]],
          origin: 'source-interval-record'
        })
        repairs.push('wrapped-interval-record-recovered')
      }
      rows.sort((a, b) => a.rect[1] - b.rect[1])
    }
  }
  // An explicit trailing plus sign establishes an unfinished treatment label.
  // Join its next stub-only line only when no source rule separates the pair.
  for (let r = 1; r < rows.length; r++) {
    const prior = items.filter((i) => inside(rows[r - 1].rect, i)),
      tail = items.filter((i) => inside(rows[r].rect, i))
    const stub = prior.filter((i) => columnOf(i) === 0).sort((a, b) => a.baseline - b.baseline)
    const joinedTreatment =
      stub.length &&
      /\+$/.test(stub.at(-1).text) &&
      prior.filter((i) => columnOf(i) > 0 && /^\d/.test(i.text)).length >= 2 &&
      tail.every((i) => columnOf(i) === 0 && /^[A-Za-z]/.test(i.text))
    // A repeated statistic definition can wrap onto a stub-only line. Two
    // complete source peers with the same literal suffix establish ownership;
    // parentheses alone could instead introduce a new category.
    const ending = tail
      .map((i) => i.text)
      .join(' ')
      .trim()
    const statistic = /\b(mean|median)$/i.exec(
      stub
        .slice()
        .sort((a, b) => a.rect[0] - b.rect[0])
        .map((i) => i.text)
        .join(' ')
        .trim()
    )?.[0]
    const statisticTail =
      statistic &&
      tail.length === 1 &&
      columnOf(tail[0]) === 0 &&
      /^\([^()]+\)$/.test(ending) &&
      tail[0].rect[0] >= Math.min(...stub.map((i) => i.rect[0])) &&
      tail[0].rect[0] - Math.min(...stub.map((i) => i.rect[0])) <=
        Math.max(...stub.map((i) => i.height)) * 1.1 &&
      columnRects
        .slice(1)
        .every((_, c) => prior.some((i) => columnOf(i) === c + 1 && /^\d/.test(i.text))) &&
      groups.filter(
        (g) =>
          g.some((i) => columnOf(i) === 0 && i.text.endsWith(`${statistic} ${ending}`)) &&
          columnRects
            .slice(1)
            .every((_, c) => g.some((i) => columnOf(i) === c + 1 && /^\d/.test(i.text)))
      ).length >= 2
    const dosingTail =
      columnRects.length === 4 &&
      items.some((i) => i.text === 'Dosing recommendations') &&
      stub.some((i) => /substrates?$/.test(i.text)) &&
      !tail.some((i) => columnOf(i) === 0) &&
      [1, 2, 3].every((c) => tail.some((i) => columnOf(i) === c && /\p{L}/u.test(i.text)))
    const thresholdTail =
      stub.length === 1 &&
      /\p{L}/u.test(stub[0].text) &&
      tail.length > 0 &&
      tail.every((i) => columnOf(i) === 0) &&
      /^[<>≤≥]\s*\d+(?:\.\d+)?\s*\(%\)$/.test(tail.map((i) => i.text).join(' ')) &&
      Math.abs(Math.min(...tail.map((i) => i.rect[0])) - stub[0].rect[0]) < 1 &&
      [1, 2].every((c) =>
        /^\d+\s*\(\d+(?:\.\d+)?\)$/.test(
          prior
            .filter((i) => columnOf(i) === c)
            .map((i) => i.text)
            .join(' ')
        )
      )
    if (
      !tail.length ||
      !stub.length ||
      !(joinedTreatment || dosingTail || thresholdTail || statisticTail) ||
      Math.min(...tail.map((i) => i.baseline)) - Math.max(...prior.map((i) => i.baseline)) >
        (statisticTail ? Math.max(...stub.map((i) => i.height)) : stub[0].height) * 1.8 ||
      rules.some(
        (rule) =>
          rule[1] === rule[3] &&
          rule[1] > Math.max(...prior.map((i) => i.baseline)) &&
          rule[1] < Math.min(...tail.map((i) => i.baseline))
      )
    )
      continue
    rows[r - 1].rect[3] = rows[r].rect[3]
    rows.splice(r--, 1)
    repairs.push(
      thresholdTail ? 'wrapped-threshold-label-recovered' : 'explicit-prose-continuation-recovered'
    )
  }
  // A hyphenated stub continuation has no measurements of its own. Keep
  // consecutive lowercase continuations with that record, stopping at a rule.
  for (let r = 1; r < rows.length; r++) {
    const previous = rows[r - 1],
      current = rows[r]
    const tail = items.filter((i) => inside(current.rect, i))
    const prior = items.filter((i) => inside(previous.rect, i))
    const stub = prior.filter((i) => columnOf(i) === 0).sort((a, b) => a.baseline - b.baseline)
    if (
      !tail.length ||
      !stub.length ||
      !tail.every((i) => columnOf(i) === 0 && /^[a-z]/.test(i.text)) ||
      !(previous.hyphenatedStub || /[-\u2010\u2011]$/.test(stub.at(-1).text)) ||
      prior.filter((i) => columnOf(i) > 0 && /^\d/.test(i.text)).length < 2 ||
      tail.some(
        (i) =>
          Math.abs(i.rect[0] - stub[0].rect[0]) > i.height ||
          i.baseline - stub.at(-1).baseline > i.height * 1.6
      ) ||
      rules.some(
        (rule) =>
          rule[1] === rule[3] &&
          rule[1] > stub.at(-1).baseline &&
          rule[1] < tail[0].baseline &&
          rule[0] <= stub[0].rect[0] &&
          rule[2] >= tail[0].rect[2]
      )
    )
      continue
    previous.rect[3] = current.rect[3]
    previous.hyphenatedStub = true
    rows.splice(r--, 1)
    repairs.push('hyphenated-stub-continuation-recovered')
  }
  // Dense tables can wrap labels flush left (or slightly outdent them).
  // Require repeated source line spacing and populated comparison columns;
  // an isolated lowercase line is not enough evidence to remove a boundary.
  const denseContinuations = []
  for (let r = 1; columnRects.length >= 4 && r < rows.length - 1; r++) {
    const prior = items.filter((i) => inside(rows[r - 1].rect, i))
    const tail = items.filter((i) => inside(rows[r].rect, i))
    const stub = prior.filter((i) => columnOf(i) === 0)
    const following = items.filter((i) => inside(rows[r + 1].rect, i))
    const head = stub[0],
      first = tail[0]
    const populated = (line) =>
      columnRects
        .slice(1, -1)
        .every((_, c) => line.some((i) => columnOf(i) === c + 1 && /^\d/.test(i.text)))
    const statistics = prior.filter((i) => columnOf(i) > 0)
    const category =
      statistics.length === 1 &&
      columnOf(statistics[0]) === columnRects.length - 1 &&
      /^0?\.\d+$/.test(statistics[0].text) &&
      populated(following)
    if (
      !head ||
      !first ||
      !/^[a-z]/.test(first.text) ||
      !tail.every((i) => columnOf(i) === 0) ||
      stub.map((i) => i.text).join(' ').length < 12 ||
      !stub.every((i) => Math.abs(i.baseline - head.baseline) < head.height * 0.2) ||
      !tail.every((i) => Math.abs(i.baseline - first.baseline) < first.height * 0.2) ||
      Math.abs(first.rect[0] - head.rect[0]) > head.height * 0.35 ||
      Math.abs(first.height - head.height) > head.height * 0.05 ||
      first.baseline - head.baseline < head.height * 0.95 ||
      first.baseline - head.baseline > head.height * 1.1 ||
      (!populated(prior) && !category) ||
      !following.some((i) => columnOf(i) === 0 && /^[A-Z]/.test(i.text)) ||
      rules.some(
        (rule) =>
          rule[1] === rule[3] &&
          rule[1] > head.baseline &&
          rule[1] < first.baseline &&
          rule[0] <= head.rect[0] &&
          rule[2] >= first.rect[2]
      )
    )
      continue
    denseContinuations.push({ index: r, height: head.height, gap: first.baseline - head.baseline })
  }
  for (const candidate of denseContinuations.reverse()) {
    if (
      denseContinuations.filter(
        (peer) =>
          Math.abs(peer.height - candidate.height) < candidate.height * 0.05 &&
          Math.abs(peer.gap - candidate.gap) < candidate.height * 0.05
      ).length < 3
    )
      continue
    rows[candidate.index - 1].rect[3] = rows[candidate.index].rect[3]
    rows.splice(candidate.index, 1)
    repairs.push('dense-stub-continuation-recovered')
  }
  // A hanging lowercase continuation has no data of its own. Keep it with
  // the preceding label, including raised footnote fragments. Require a
  // multi-column numeric table, close source baselines and a positive indent.
  for (let r = 1; columnRects.length >= 3 && r < rows.length - 1; r++) {
    const previous = rows[r - 1],
      current = rows[r]
    const prior = items.filter((i) => inside(previous.rect, i))
    const tail = items.filter((i) => inside(current.rect, i)).sort((a, b) => a.rect[0] - b.rect[0])
    const stub = prior.filter((i) => columnOf(i) === 0).sort((a, b) => a.rect[0] - b.rect[0])
    const head = stub[0],
      first = tail[0]
    // Category labels can wrap while only the final P-value column is filled.
    // Balanced parentheses and the following counted subrow supply evidence
    // for joining this otherwise empty line, including numeric category names.
    const label = stub.map((item) => item.text).join(' ')
    const ending = tail.map((item) => item.text).join(' ')
    const balance = (text) => (text.match(/\(/g) ?? []).length - (text.match(/\)/g) ?? []).length
    const statistics = prior.filter((item) => columnOf(item) !== 0)
    const categoryContinuation =
      columnRects.length >= 4 &&
      balance(label) === 1 &&
      balance(label + ending) === 0 &&
      statistics.length === 1 &&
      columnOf(statistics[0]) === columnRects.length - 1 &&
      /^0?\.\d+$/.test(statistics[0].text) &&
      items.some(
        (item) =>
          inside(rows[r + 1].rect, item) && columnOf(item) === 0 && /^[<>≤≥]?\d+$/.test(item.text)
      )
    const following = items.filter((item) => inside(rows[r + 1].rect, item))
    const repeatedBeforeSection =
      head &&
      first &&
      following.length > 0 &&
      following.every((item) => columnOf(item) === 0 && /\p{L}/u.test(item.text)) &&
      Math.min(...following.map((item) => item.rect[0])) < head.rect[0] - head.height * 0.25 &&
      new Set(statistics.filter((item) => /[0-9]/.test(item.text)).map(columnOf)).size >= 2 &&
      items.filter((item) => columnOf(item) === 0 && item.text === head.text).length >= 2 &&
      items.filter((item) => columnOf(item) === 0 && item.text === first.text).length >= 2
    if (
      !head ||
      !first ||
      !/^[a-z]/.test(first.text) ||
      !tail.every((i) => columnOf(i) === 0) ||
      stub.map((i) => i.text).join(' ').length < 12 ||
      stub.some((i) => Math.abs(i.baseline - head.baseline) > head.height * 0.35) ||
      first.rect[0] - head.rect[0] < head.height * 0.25 ||
      first.rect[0] - head.rect[0] > head.height ||
      Math.abs(first.height - head.height) > head.height * 0.1 ||
      first.baseline - head.baseline <= head.height ||
      first.baseline - head.baseline > head.height * (categoryContinuation ? 1.8 : 1.6) ||
      tail.some((i) => Math.abs(i.baseline - first.baseline) > first.height * 0.5) ||
      (!categoryContinuation &&
        !items.some(
          (i) => inside(rows[r + 1].rect, i) && columnOf(i) === 0 && /^[A-Z]/.test(i.text)
        )) ||
      (!repeatedBeforeSection &&
        columnRects
          .slice(1, categoryContinuation ? -1 : undefined)
          .some(
            (_, c) =>
              !items.some(
                (i) => inside(rows[r + 1].rect, i) && columnOf(i) === c + 1 && /^\d/.test(i.text)
              )
          )) ||
      rules.some(
        (rule) =>
          rule[1] === rule[3] &&
          rule[1] > head.baseline &&
          rule[1] < first.baseline &&
          rule[0] <= head.rect[0] &&
          rule[2] >= first.rect[2]
      )
    )
      continue
    previous.rect[3] = current.rect[3]
    if (prior.every((i) => columnOf(i) === 0)) previous.section = true
    rows.splice(r--, 1)
    repairs.push('indented-stub-continuation-recovered')
  }
  // Repeated wrapped stubs can occupy an otherwise empty model row. Require
  // an indented lowercase continuation with values in every data column.
  for (let r = rows.length - 2; r >= 0; r--) {
    const head = items.filter((i) => inside(rows[r].rect, i))
    const tail = items.filter((i) => inside(rows[r + 1].rect, i))
    const label = tail.filter((i) => columnOf(i) === 0).sort((a, b) => a.rect[0] - b.rect[0])
    if (
      head.length !== 1 ||
      columnOf(head[0]) !== 0 ||
      !label.length ||
      !/^[a-z]/.test(label[0].text) ||
      label[0].rect[0] <= head[0].rect[0] ||
      label[0].rect[0] - head[0].rect[0] > head[0].height ||
      label[0].baseline - head[0].baseline > head[0].height * 1.6 ||
      items.filter((i) => i.text === head[0].text && columnOf(i) === 0).length < 2 ||
      columnRects
        .slice(1)
        .some((_, c) => !tail.some((i) => columnOf(i) === c + 1 && /^\d/.test(i.text))) ||
      rules.some(
        (rule) =>
          rule[1] === rule[3] &&
          rule[1] > head[0].baseline &&
          rule[1] < label[0].rect[1] &&
          rule[0] <= head[0].rect[0] &&
          rule[2] >= right - 2
      )
    )
      continue
    rows[r + 1].rect[1] = Math.min(rows[r].rect[1], head[0].rect[1])
    rows[r + 1].recoveredWrappedStub = true
    rows.splice(r, 1)
    repairs.push('repeated-wrapped-stub-recovered')
  }
  // The detector can stop one native baseline early. Recover a final numeric
  // suffix only when at least two earlier records have the same populated
  // columns and token forms. A paragraph or a partial numeric row is ineligible.
  const last = rows.at(-1)
  if (last && columnRects.length >= 4) {
    const cuts = [columnRects[0][0], ...columnRects.map((r) => r[2])]
    const signature = (g) => {
      const values = readSourceRow(g, cuts)
      if (!values) return
      const start = values.findIndex(Boolean)
      if (
        start < 0 ||
        values.length - start < 4 ||
        !/^(?:[A-Z]{1,3}\d+|[<>≤≥−+-]?(?:\d+(?:\.\d+)?|\.\d+))$/.test(values[start]) ||
        values
          .slice(start + 1)
          .some((s) => !/^[<>≤≥−+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:\/\d+(?:\.\d+)?)?\*{0,2}$/.test(s))
      )
        return
      return start + ':' + (/^[A-Z]/.test(values[start]) ? 'identifier' : 'numeric')
    }
    for (const g of groups.filter((g) => union(g)[1] >= last.rect[3])) {
      const b = union(g),
        key = signature(g)
      if (b[1] - rows.at(-1).rect[3] > g[0].height * 1.5) break
      if (
        !key ||
        groups.filter(
          (prior) =>
            prior !== g &&
            signature(prior) === key &&
            rows.some((row) => prior.every((i) => inside(row.rect, i)))
        ).length < 2
      )
        break
      if (hasHorizontalTableRuleBetween(rules, rows.at(-1).rect[3], b[1])) break
      rows.push({ rect: [columnRects[0][0], b[1], right, b[3]], origin: 'source-text' })
      repairs.push('trailing-numeric-record-recovered')
    }
    const tail = groups.find(
      (g) =>
        g.length === 1 &&
        columnOf(g[0]) === 0 &&
        /^[A-Z]{1,3}\d+$/.test(g[0].text) &&
        (g[0].rect[1] + g[0].rect[3]) / 2 >= last.rect[3] &&
        g[0].rect[1] - last.rect[3] < g[0].height
    )
    if (tail) {
      const matches = groups.filter((g, n) => {
        const next = groups[n + 1]
        return (
          next?.length === 1 &&
          columnOf(next[0]) === 0 &&
          /^[A-Z]{1,3}\d+$/.test(next[0].text) &&
          Math.abs(next[0].rect[0] - tail[0].rect[0]) < 1 &&
          g.some((i) => columnOf(i) === 0 && /^[A-Z]{1,3}\d+ vs$/.test(i.text)) &&
          columnRects
            .slice(1)
            .every((_, c) => g.some((i) => columnOf(i) === c + 1 && /^[<>]?\d/.test(i.text))) &&
          next[0].baseline - g[0].baseline < next[0].height * 1.2
        )
      })
      if (matches.length >= 3 && matches.at(-1).every((i) => inside(last.rect, i))) {
        last.rect[3] = tail[0].rect[3]
        repairs.push('trailing-wrapped-comparison-recovered')
      }
    }
  }
  // Repeated arm prefixes identify two physical lines of one outcome. Use the
  // source pair, not a shifted model band that puts control values in the next row.
  const prefix = (item) => /^([A-Z]):\s*[−-]?\d+(?:\.\d+)?$/.exec(item.text.trim())?.[1]
  const pairs = groups.flatMap((head, index) => {
    const tail = groups[index + 1]
    const values = head.filter(prefix)
    if (!tail || values.length < 2 || !head.some((i) => columnOf(i) === 0 && /\p{L}/u.test(i.text)))
      return []
    const first = prefix(values[0]),
      second = prefix(tail.find(prefix) ?? { text: '' })
    const columns = values.map(columnOf).sort((a, b) => a - b)
    if (
      !second ||
      first === second ||
      columns[0] < 1 ||
      values.some((i) => prefix(i) !== first) ||
      tail.some(
        (i) =>
          columnOf(i) === 0 ||
          (prefix(i) ? prefix(i) !== second : !/^[<>≤≥]?\s*\d+(?:\.\d+)?$/.test(i.text.trim()))
      ) ||
      JSON.stringify(
        tail
          .filter(prefix)
          .map(columnOf)
          .sort((a, b) => a - b)
      ) !== JSON.stringify(columns) ||
      union(tail)[1] < union(head)[3] ||
      union(tail)[1] - union(head)[3] > values[0].height ||
      hasHorizontalTableRuleBetween(rules, union(head)[3], union(tail)[1])
    )
      return []
    return [{ items: [...head, ...tail], first, second, columns }]
  })
  if (
    pairs.length < 3 ||
    pairs.some(
      (p) =>
        p.first !== pairs[0].first ||
        p.second !== pairs[0].second ||
        JSON.stringify(p.columns) !== JSON.stringify(pairs[0].columns)
    )
  )
    return
  const bounds = union(pairs.flatMap((p) => p.items))
  const members = new Set(pairs.flatMap((p) => p.items))
  const other = groups.filter((g) =>
    g.some((i) => !members.has(i) && i.rect[1] >= bounds[1] && i.rect[3] <= bounds[3])
  )
  if (
    other.some(
      (g) =>
        !g.every((i) => columnOf(i) === 0) ||
        !g
          .map((i) => i.text)
          .join(' ')
          .endsWith(':')
    )
  )
    return
  const left = columnRects[0][0]
  rows.splice(
    0,
    rows.length,
    ...rows.filter((r) => r.rect[3] <= bounds[1] || r.rect[1] >= bounds[3]),
    ...[...pairs.map((p) => p.items), ...other].map((g) => ({
      rect: [left, union(g)[1], right, union(g)[3]],
      origin: 'source-arm-record'
    }))
  )
  rows.sort((a, b) => a.rect[1] - b.rect[1])
  repairs.push('paired-arm-outcomes-recovered')
}

// A count/percentage table can start with a category total, whose percentage
// is intentionally blank. Repeated sparse category rows distinguish that total
// from a wrapped heading or a sample size belonging to the column heading.
export function separateCountedCategoryHeader({ rows, groups, columnRects, headers, repairs }) {
  if (columnRects.length !== 3 || groups.length < 5 || !rows.length) return
  const values = (group) =>
    columnRects.map((column) =>
      group
        .filter((item) => inside(column, item))
        .map((item) => item.text)
        .join(' ')
        .trim()
    )
  const sparse = (group) => {
    const [label, count, percent] = values(group)
    return /\p{L}/u.test(label) && /^\d+$/.test(count) && !percent
  }
  const [heading, category, record] = groups
  const [label, count, percent] = values(heading)
  if (
    !/\p{L}/u.test(label) ||
    !/^(?:Number|Count|No\.|N)$/i.test(count) ||
    !/^(?:%|Percent(?:age)?)$/i.test(percent) ||
    !sparse(category) ||
    !groups.slice(3).some(sparse) ||
    !values(record)
      .slice(1)
      .every((value) => /^\d+(?:\.\d+)?%?$/.test(value))
  )
    return
  const headRect = union(heading),
    categoryRect = union(category)
  const first = rows[0]
  if (
    !heading.every((item) => inside(first.rect, item)) ||
    !category.every((item) => inside(first.rect, item)) ||
    headRect[3] >= categoryRect[1] ||
    categoryRect[1] - headRect[3] > Math.max(...heading.map((item) => item.height)) ||
    !headers.some((header) => heading.every((item) => inside(header.rect, item)))
  )
    return
  const split = (headRect[3] + categoryRect[1]) / 2
  rows.splice(
    0,
    1,
    { ...first, rect: [first.rect[0], Math.min(first.rect[1], headRect[1]), first.rect[2], split] },
    {
      rect: [first.rect[0], split, first.rect[2], Math.max(first.rect[3], categoryRect[3])],
      origin: 'source-category'
    }
  )
  for (const header of headers.filter((header) =>
    heading.some((item) => inside(header.rect, item))
  ))
    header.rect[3] = Math.min(header.rect[3], split)
  repairs.push('counted-category-header-separated')
}

// A lowered/raised glyph can fall into an otherwise empty predicted row.
// Attach it only when the rest of its source baseline already has one owner;
// do not expand across any unrelated text.
export function repairInlineFragmentRows({ rows, groups, items, left, right, repairs }) {
  for (const group of groups) {
    const height = Math.max(...group.map((i) => i.height))
    const body = group.filter((i) => i.height >= height * 0.8)
    const small = group.filter((i) => i.height < height * 0.8)
    if (!body.length || !small.length) continue
    const owners = rows.filter((r) =>
      body.some((i) => inside([left, r.rect[1], right, r.rect[3]], i))
    )
    if (owners.length !== 1) continue
    const owner = owners[0]
    if (!body.every((i) => inside([left, owner.rect[1], right, owner.rect[3]], i))) continue
    const outside = small.filter((i) => !inside([left, owner.rect[1], right, owner.rect[3]], i))
    if (!outside.length) continue
    const centers = outside.map((i) => (i.rect[1] + i.rect[3]) / 2)
    const rect = [
      left,
      Math.min(owner.rect[1], ...centers) - 0.01,
      right,
      Math.max(owner.rect[3], ...centers) + 0.01
    ]
    if (
      items.some(
        (i) =>
          !group.includes(i) &&
          inside(rect, i) &&
          !inside([left, owner.rect[1], right, owner.rect[3]], i)
      )
    )
      continue
    const touched = rows.filter((r) => r !== owner && r.rect[1] < rect[3] && r.rect[3] > rect[1])
    if (
      touched.some((r) =>
        items.some((i) => inside([left, r.rect[1], right, r.rect[3]], i) && !small.includes(i))
      )
    )
      continue
    rows.splice(0, rows.length, ...rows.filter((r) => !touched.includes(r)))
    owner.rect = rect
    repairs.push('inline-fragment-row-recovered')
  }
}

// A projected section span can drift into the next numeric row. Source text
// ownership and a continuous label establish the actual section row.
export function recoverProjectedSectionRows({
  rows,
  items,
  groups = [],
  columnRects,
  headers,
  repairs
}) {
  if (columnRects.length < 4) return
  const left = columnRects[0][0],
    right = columnRects.at(-1)[2]
  const columnOf = (item) => columnRects.findIndex((column) => inside(column, item))
  // Repeated centered section labels can have a projected span but no row.
  // Matching literal wording, two existing section peers and consecutive
  // records on both sides establish the omitted band without guessing its text.
  const sectionKey = (text) => text.replace(/\d+(?:[.,]\d+)?/g, '#')
  const centeredSection = (group) =>
    group.length === 1 &&
    /\p{L}/u.test(group[0].text) &&
    group[0].rect[2] - group[0].rect[0] > (right - left) * 0.3 &&
    Math.abs((group[0].rect[0] + group[0].rect[2]) / 2 - (left + right) / 2) <
      (right - left) * 0.08 &&
    headers.some((header) => intersection(header.rect, group[0].rect) / area(group[0].rect) > 0.8)
  for (let n = 1; n < groups.length - 1; n++) {
    const group = groups[n],
      label = group[0]
    if (!centeredSection(group) || rows.some((row) => inside(row.rect, label))) continue
    const peers = groups.filter(
      (g) =>
        g !== group &&
        centeredSection(g) &&
        sectionKey(g[0].text) === sectionKey(label.text) &&
        rows.some((row) => inside(row.rect, g[0]))
    )
    if (peers.length < 2) continue
    const neighbors = [groups[n - 1], groups[n + 1]]
    const ids = neighbors.map((g) => g.filter((i) => columnOf(i) === 0))
    if (
      !neighbors.every((g) => new Set(g.map(columnOf)).size === columnRects.length) ||
      !ids.every((stub) => stub.length === 1 && /^[1-9]\d*$/.test(stub[0].text)) ||
      Number(ids[1][0].text) !== Number(ids[0][0].text) + 1 ||
      union(neighbors[0])[3] >= label.rect[1] ||
      label.rect[3] >= union(neighbors[1])[1] ||
      rows.some((row) => row.rect[1] < label.rect[3] && row.rect[3] > label.rect[1])
    )
      continue
    rows.push({
      rect: [left, label.rect[1], right, label.rect[3]],
      origin: 'source-text',
      section: true
    })
    rows.sort((a, b) => a.rect[1] - b.rect[1])
    repairs.push('repeated-centered-section-recovered')
  }
  // A shifted section band can contain both a short heading and the complete
  // first record. Repeated indented records and the projected-header evidence
  // distinguish this from a wrapped data label.
  for (let n = 0; n < groups.length - 2; n++) {
    const heading = groups[n],
      record = groups[n + 1],
      next = groups[n + 2]
    const label = heading[0]
    const stub = record.filter((item) => columnOf(item) === 0)
    const numeric = (group) =>
      columnRects.slice(1).every((_, c) =>
        /^[<>≤≥−+-]?\s*\d[\d\s.,()%±*–−+\-/]*$/.test(
          group
            .filter((item) => columnOf(item) === c + 1)
            .map((item) => item.text)
            .join(' ')
        )
      )
    if (
      heading.length !== 1 ||
      columnOf(label) !== 0 ||
      !/^\p{Lu}/u.test(label.text) ||
      stub.length !== 1 ||
      !/^\p{Lu}/u.test(stub[0].text) ||
      stub[0].rect[0] - label.rect[0] < label.height * 0.5 ||
      union(heading)[3] >= union(record)[1] ||
      union(record)[3] >= union(next)[1] ||
      record[0].baseline - label.baseline > label.height * 1.8 ||
      !numeric(record) ||
      !numeric(next) ||
      !next.some(
        (item) =>
          columnOf(item) === 0 && Math.abs(item.rect[0] - stub[0].rect[0]) < label.height * 0.1
      ) ||
      !headers.some((header) => intersection(header.rect, label.rect) / area(label.rect) > 0.4)
    )
      continue
    const split = splitOwnedSourceRow(rows, items, heading, record, [left, right])
    if (!split) continue
    split.rows[0].section = true
    split.rows[1].numericRecord = true
    rows.splice(split.index, 1, ...split.rows)
    repairs.push('projected-section-record-separated')
  }
  // A complete binary (+/-) record cannot wrap into an uppercase section
  // abbreviation on the next baseline. Require another binary count record
  // below it and unique model-row ownership before separating that heading.
  for (let n = 0; n < groups.length - 2; n++) {
    const record = groups[n],
      heading = groups[n + 1]
    let next = groups[n + 2]
    const following = groups[n + 3]
    if (
      following &&
      next.every((item) =>
        following.some(
          (anchor) => isAdjacentTableScript(item, anchor) && columnOf(item) === columnOf(anchor)
        )
      )
    )
      next = [...next, ...following]
    const label = heading[0]
    const binaryCounts = (group) => {
      const stub = group.filter((item) => columnOf(item) === 0)
      return (
        stub.length === 1 &&
        /^[+−-]$/.test(stub[0].text) &&
        [1, 2].every((c) => group.some((item) => columnOf(item) === c && /^\d+$/.test(item.text)))
      )
    }
    if (
      heading.length !== 1 ||
      columnOf(label) !== 0 ||
      !/^[A-Z][A-Z\d-]{1,12}$/.test(label.text) ||
      !binaryCounts(record) ||
      !binaryCounts(next) ||
      record.some((item) => columnOf(item) > 0 && !/^\d+$/.test(item.text)) ||
      union(record)[3] >= label.rect[1] ||
      label.rect[3] >= union(next)[1] ||
      label.baseline - record[0].baseline > label.height * 1.8 ||
      next[0].baseline - label.baseline > label.height * 1.8
    )
      continue
    const split = splitOwnedSourceRow(rows, items, record, heading, [left, right])
    if (!split) continue
    split.rows[1].section = true
    split.rows[0].numericRecord = true
    rows.splice(split.index, 1, ...split.rows)
    repairs.push('binary-record-section-separated')
  }
  // Short unit-bearing headings share the same section role when at least
  // three projected headings precede complete, equally indented summaries.
  // A standalone stub or a blank value row is insufficient on its own.
  const summaries = rows.flatMap((row, r) => {
    const owned = items.filter((i) => inside(row.rect, i))
    const label = owned[0]
    if (
      owned.length !== 1 ||
      !/^\p{Lu}[\p{L} -]+ \([a-z]{1,3}\)$/u.test(label.text) ||
      columnOf(label) !== 0 ||
      !rows[r + 1] ||
      !headers.some((h) => intersection(h.rect, label.rect) / area(label.rect) > 0.4)
    )
      return []
    const next = items.filter((i) => inside(rows[r + 1].rect, i))
    const stub = next.filter((i) => columnOf(i) === 0)
    if (
      stub.length !== 1 ||
      !/^(?:Median \(range\)|Mean \(SD\))$/.test(stub[0].text) ||
      stub[0].rect[0] - label.rect[0] < label.height * 0.5 ||
      stub[0].rect[0] - label.rect[0] > label.height * 1.5 ||
      label.rect[3] >= union(next)[1] ||
      columnRects.slice(1).some(
        (_, c) =>
          !/^[−-]?\d[\d\s.,()–−-]*$/.test(
            next
              .filter((i) => columnOf(i) === c + 1)
              .map((i) => i.text)
              .join(' ')
          )
      )
    )
      return []
    return [{ row, label, summary: stub[0].text }]
  })
  for (const candidate of summaries) {
    const peers = summaries.filter(
      (s) =>
        s.summary === candidate.summary &&
        Math.abs(s.label.rect[0] - candidate.label.rect[0]) < candidate.label.height * 0.2
    )
    if (new Set(peers.map((s) => s.label.text)).size < 3 || candidate.row.section) continue
    candidate.row.section = true
    repairs.push('repeated-summary-section-recovered')
  }
  for (let r = 1; r < rows.length - 1; r++) {
    if (rows[r].section) continue
    const owned = items
      .filter((i) => i.horizontal && inside([left, rows[r].rect[1], right, rows[r].rect[3]], i))
      .sort((a, b) => a.rect[0] - b.rect[0])
    const label = owned[0]
    // A complete treatment/section name ending in a sample size may be short
    // enough to cross only the first data column. It still spans the section
    // when the projected header and contiguous source fragments agree.
    const sampleSection = /^[A-Z][\p{L}\s+/-]{5,}\(\s*n\s*=\s*\d+\s*\)$/u.test(
      owned.map((item) => item.text).join(' ')
    )
    if (
      !label ||
      !/^\p{L}/u.test(label.text) ||
      rows.filter((row) => inside([left, row.rect[1], right, row.rect[3]], label)).length !== 1 ||
      (!sampleSection &&
        intersection([left, rows[r].rect[1], right, rows[r].rect[3]], label.rect) /
          area(label.rect) >=
          0.8) ||
      label.rect[0] - left > label.height * 1.5 ||
      (!sampleSection && label.rect[2] - label.rect[0] < (columnRects[0][2] - left) * 2) ||
      !headers.some((h) => intersection(h.rect, label.rect) / area(label.rect) > 0.4) ||
      !owned.every(
        (item, index) =>
          Math.abs(item.baseline - label.baseline) < label.height * 0.5 &&
          (!index || item.rect[0] - owned[index - 1].rect[2] < label.height * 0.5)
      )
    )
      continue
    const populated = columnRects
      .slice(1)
      .filter((c) =>
        items.some(
          (i) =>
            inside([c[0], rows[r + 1].rect[1], c[2], rows[r + 1].rect[3]], i) && /^\d/.test(i.text)
        )
      )
    if (populated.length < 3) continue
    rows[r].section = true
    repairs.push('projected-section-row-recovered')
  }
}

// Repeated full-width centered labels between complete numeric records are
// section bands, even when a short label fits entirely inside a data column.
function recoverCenteredCountSections({ rows, groups, items, columnRects, repairs }) {
  if (columnRects.length < 3) return
  const cuts = [columnRects[0][0], ...columnRects.map((column) => column[2])]
  const center = (cuts[0] + cuts.at(-1)) / 2
  const complete = (group) => {
    const values = readSourceRow(group, cuts)
    return values?.[0] && values.slice(1).every((v) => /^[<>≤≥−+-]?\d[\d.,()%±–−+\-/]*$/.test(v))
  }
  const candidates = groups.flatMap((group, n) => {
    const label = group[0],
      next = groups[n + 1],
      previous = groups[n - 1]
    if (
      group.length !== 1 ||
      !/^\p{Lu}/u.test(label.text) ||
      !previous ||
      !next ||
      !complete(previous) ||
      !complete(next) ||
      Math.abs((label.rect[0] + label.rect[2]) / 2 - center) > label.height * 0.25 ||
      union(previous)[3] >= label.rect[1] ||
      label.rect[3] >= union(next)[1] ||
      label.baseline - previous[0].baseline > label.height * 1.8 ||
      next[0].baseline - label.baseline > label.height * 1.8
    )
      return []
    const owners = rows.filter((row) => inside(row.rect, label))
    if (owners.length !== 1 || items.some((i) => i !== label && inside(owners[0].rect, i)))
      return []
    return [{ row: owners[0], label }]
  })
  if (new Set(candidates.map(({ label }) => label.text)).size < 3) return
  for (const { row } of candidates) {
    row.section = true
    row.centeredSection = true
  }
  repairs.push('centered-count-sections-recovered')
}

// Repeated measurement blocks establish a section boundary even when the
// detector combines the section name with its first measurement. Require a
// matching earlier section and three repetitions of the measured quantity.
export function recoverRepeatedMeasurementSections({ rows, groups, items, columnRects, repairs }) {
  recoverCenteredCountSections({ rows, groups, items, columnRects, repairs })
  recoverIndentedSummarySections({ rows, groups, items, columnRects, repairs })
  recoverRepeatedUnitSections({ rows, groups, items, columnRects, repairs })
  recoverRepeatedStatisticRows({ rows, groups, items, columnRects, repairs })
  if (columnRects.length < 4) return
  const left = columnRects[0][0],
    right = columnRects.at(-1)[2]
  const columnOf = (item) => columnRects.findIndex((column) => inside(column, item))
  const stub = (group) =>
    group
      .filter((item) => columnOf(item) === 0)
      .map((item) => item.text)
      .join('')
      .replace(/\s/g, '')
  const measured = (group) => {
    const values = group
      .filter((item) => columnOf(item) !== 0)
      .sort((a, b) => a.rect[0] - b.rect[0])
    return (
      values.length >= 3 &&
      values.every((item, index) => columnOf(item) === index + 1 && /^\d[\d .]*$/.test(item.text))
    )
  }
  for (let n = 1; n < groups.length - 1; n++) {
    const heading = groups[n],
      record = groups[n + 1],
      label = heading[0]
    if (
      heading.length !== 1 ||
      columnOf(label) !== 0 ||
      !/^[A-Z][a-z]+$/.test(label.text) ||
      !measured(record) ||
      !stub(record).startsWith(label.text)
    )
      continue
    const suffix = stub(record).slice(label.text.length)
    if (
      !/^[a-z]+\([^()]+\)$/.test(suffix) ||
      groups.filter((group) => stub(group) === stub(record) && measured(group)).length < 3 ||
      !groups
        .slice(0, n - 1)
        .some(
          (group, index) =>
            group.length === 1 &&
            columnOf(group[0]) === 0 &&
            /^[A-Z][a-z]+$/.test(group[0].text) &&
            group[0].text !== label.text &&
            stub(groups[index + 1]) === group[0].text + suffix &&
            measured(groups[index + 1]) &&
            rows.some(
              (row) =>
                items.filter((item) => inside([left, row.rect[1], right, row.rect[3]], item))
                  .length === 1 && inside(row.rect, group[0])
            )
        ) ||
      label.rect[3] >= union(record)[1] ||
      record[0].baseline - label.baseline > label.height * 1.8
    )
      continue
    const split = splitOwnedSourceRow(rows, items, heading, record, [left, right])
    if (!split) continue
    split.rows[0].section = true
    split.rows[1].numericRecord = true
    rows.splice(split.index, 1, ...split.rows)
    repairs.push('repeated-measurement-section-separated')
  }
  // A complete percentage record followed by a standalone title and three
  // measurements with the same explicit unit establishes a new section.
  for (let n = 1; n < groups.length - 3; n++) {
    const record = groups[n - 1],
      heading = groups[n],
      label = heading[0]
    const previousStub = record.filter((item) => columnOf(item) === 0)
    const values = (group, c) =>
      group
        .filter((i) => columnOf(i) === c)
        .map((i) => i.text)
        .join(' ')
    const filled = (group) =>
      columnRects
        .slice(1)
        .every((_, c) => /^[<>≤≥]?\s*\d[\d\s.,()%–−+-]*$/.test(values(group, c + 1)))
    if (
      heading.length !== 1 ||
      columnOf(label) !== 0 ||
      !/^(?:\p{Lu}\p{L}+\s+){1,3}\p{Lu}\p{L}+$/u.test(label.text) ||
      previousStub.length !== 1 ||
      !/\(%\)$/.test(previousStub[0].text) ||
      !filled(record) ||
      columnRects.filter((_, c) => c > 0 && /^\d+(?:\.\d+)?%$/.test(values(record, c))).length <
        2 ||
      union(record)[3] >= label.rect[1] ||
      label.baseline - record[0].baseline > label.height * 1.8
    )
      continue
    const measurements = []
    for (const group of groups.slice(n + 1)) {
      const stubs = group.filter((i) => columnOf(i) === 0)
      if (!stubs.length) {
        if (!measurements.length || group.some((i) => !/^[\d\s.,()–−-]+$/.test(i.text))) break
        continue
      }
      if (stubs.length !== 1 || !filled(group)) break
      const unit = /\(([a-zA-Z]+\/[a-zA-Z]+)\)$/.exec(stubs[0].text)?.[1]
      if (!unit || Math.abs(stubs[0].rect[0] - label.rect[0]) > label.height * 0.1) break
      measurements.push({ unit, group })
      if (measurements.length === 3) break
    }
    if (
      measurements.length !== 3 ||
      new Set(measurements.map((m) => m.unit)).size !== 1 ||
      label.rect[3] >= union(measurements[0].group)[1] ||
      measurements[0].group[0].baseline - label.baseline > label.height * 1.8
    )
      continue
    const split = splitOwnedSourceRow(rows, items, record, heading, [left, right])
    if (!split) continue
    split.rows[1].section = true
    split.rows[0].numericRecord = true
    rows.splice(split.index, 1, ...split.rows)
    repairs.push('unit-measurement-section-separated')
  }
}

// Two overlapping model bands can claim exactly the same source record. Merge
// only identical token ownership across a labelled, multi-value native baseline.
export function mergeDuplicateSourceRows({ rows, groups, items, columnRects, repairs }) {
  if (columnRects.length < 3) return
  const left = columnRects[0][0],
    right = columnRects.at(-1)[2]
  for (let n = 1; n < rows.length; n++) {
    const previous = rows[n - 1],
      current = rows[n]
    if (previous.rect[3] <= current.rect[1]) continue
    const before = items.filter((i) => inside([left, previous.rect[1], right, previous.rect[3]], i))
    const after = items.filter((i) => inside([left, current.rect[1], right, current.rect[3]], i))
    let shared = before.filter((i) => after.includes(i))
    if (shared.length < 3) continue
    if (
      !shared.some((item) => {
        const a =
          intersection([left, previous.rect[1], right, previous.rect[3]], item.rect) /
          area(item.rect)
        const b =
          intersection([left, current.rect[1], right, current.rect[3]], item.rect) / area(item.rect)
        return a > 0.5 && b > 0.5 && Math.abs(a - b) < 0.1
      })
    )
      continue
    const attachedScript = (item) =>
      shared.filter(
        (anchor) =>
          isAdjacentTableScript(item, anchor) &&
          columnRects.some((column) => inside(column, item) && inside(column, anchor))
      ).length === 1
    if (
      !groups.some(
        (g) =>
          shared.every((i) => g.includes(i)) &&
          g.every((i) => shared.includes(i) || attachedScript(i))
      )
    )
      continue
    shared = [
      ...new Set([...shared, ...before.filter(attachedScript), ...after.filter(attachedScript)])
    ]
    const rect = union(shared)
    const extras = [...new Set([...before, ...after])].filter((i) => !shared.includes(i))
    const hasExternalOwner = (item) => {
      if (rows.some((r) => r !== previous && r !== current && inside(r.rect, item))) return true
      const anchors = items.filter(
        (anchor) =>
          isAdjacentTableScript(item, anchor) &&
          columnRects.some((c) => inside(c, item) && inside(c, anchor))
      )
      if (anchors.length !== 1) return false
      const owners = rows.filter((r) => inside(r.rect, anchors[0]))
      return owners.length === 1 && owners[0] !== previous && owners[0] !== current
    }
    const values = columnRects.map((c) =>
      shared
        .filter((i) => inside([c[0], -Infinity, c[2], Infinity], i))
        .map((i) => i.text)
        .join('')
        .replace(/\s/g, '')
    )
    const populated = values.filter(Boolean)
    const numeric = (value) => /^[−+-]?\d[\d.,·⋅()%±–−+*/-]*$/.test(value)
    const labelledValues =
      /\p{L}/u.test(populated[0] ?? '') && populated.slice(1).filter(numeric).length >= 2
    if (!labelledValues) continue
    if (extras.some((i) => inside(rect, i))) continue
    const unowned = extras.filter((i) => !hasExternalOwner(i))
    if (unowned.length) {
      // Preserve a following count-section heading swallowed by the duplicate
      // band. Its n (%) label and the complete record below establish a split;
      // arbitrary extra prose or another numeric fragment cannot do so.
      const section = groups.find(
        (g) => unowned.every((i) => g.includes(i)) && g.every((i) => unowned.includes(i))
      )
      const next = section && groups[groups.indexOf(section) + 1]
      const nextValues =
        next &&
        columnRects.slice(1).map((column) =>
          next
            .filter((item) => inside(column, item))
            .map((item) => item.text)
            .join('')
            .replace(/\s/g, '')
        )
      if (
        !section ||
        !next ||
        !section.every((i) => inside(columnRects[0], i)) ||
        !/\bn\s*\(%\)$/.test(section.map((i) => i.text).join(' ')) ||
        union(section)[1] <= rect[3] ||
        union(section)[3] >= union(next)[1] ||
        nextValues.filter(numeric).length < 2 ||
        before.some((i) => unowned.includes(i)) ||
        !unowned.every((i) => after.includes(i))
      )
        continue
      previous.rect = [left, rect[1], right, rect[3]]
      current.rect = [left, union(section)[1], right, union(section)[3]]
      current.section = true
      repairs.push('duplicate-source-row-section-separated')
      continue
    }
    previous.rect = [left, rect[1], right, rect[3]]
    rows.splice(n--, 1)
    repairs.push('duplicate-source-row-merged')
  }
}

// An extra model band can straddle two complete source records without owning
// any text. Remove only that overlap, after assignment has proved ownership.
// Blank ruled rows and rows covered by vertical spans must remain intact.
export function removeEmptyOverlappingRows({ rows, cells, items, rules, repairs }) {
  for (let row = rows.length - 2; row > 0; row--) {
    const band = rows[row]
    const empty = cells.filter((cell) => cell.row === row)
    const neighbors = [row - 1, row + 1].map((r) =>
      cells.filter((cell) => cell.row === r).sort((a, b) => a.column - b.column)
    )
    if (
      band.origin !== 'model' ||
      empty.length < 3 ||
      empty.some(
        (cell) => cell.text || cell.sourceRects.length || cell.rowSpan !== 1 || cell.colSpan !== 1
      ) ||
      cells.some((cell) => cell.row < row && cell.row + cell.rowSpan > row) ||
      rules.some(
        (rule) =>
          rule[1] === rule[3] &&
          rule[1] >= band.rect[1] &&
          rule[1] <= band.rect[3] &&
          rule[2] > band.rect[0] &&
          rule[0] < band.rect[2]
      )
    )
      continue
    const section = (record) =>
      record.length === 1 &&
      record[0].column === 0 &&
      record[0].colSpan === empty.length &&
      record[0].rowSpan === 1 &&
      record[0].sourceRects.length === 1 &&
      /^\p{L}/u.test(record[0].text)
    const complete = (record) =>
      record.length === empty.length &&
      record.every(
        (cell, c) =>
          cell.column === c &&
          cell.rowSpan === 1 &&
          cell.colSpan === 1 &&
          (cell.text && cell.sourceRects.length
            ? c
              ? /^[−+-]?\d[\d\s.,()%±–−+*/-]*$/.test(cell.text)
              : /^(?:\p{L}|[<>≤≥]?\d)/u.test(cell.text)
            : c === record.length - 1 && !cell.text && !cell.sourceRects.length)
      ) &&
      record.filter((cell) => cell.sourceRects.length).length >= 3
    const overlap = [rows[row - 1].rect[3] > band.rect[1], band.rect[3] > rows[row + 1].rect[1]]
    let sources
    if (overlap.every(Boolean)) {
      if (
        !neighbors.every((record) => complete(record) || section(record)) ||
        !neighbors.some(complete)
      )
        continue
      sources = neighbors.map((record) => record.flatMap((cell) => cell.sourceRects))
    } else {
      // A short duplicate band may lie wholly on one source baseline. It must
      // contain only glyphs already owned by that populated neighboring row.
      const neighbor = overlap[0] ? neighbors[0] : overlap[1] ? neighbors[1] : undefined
      if (!neighbor || !complete(neighbor) || !/\p{L}/u.test(neighbor[0].text)) continue
      sources = [neighbor.flatMap((cell) => cell.sourceRects)]
    }
    // A raised unit exponent belongs to its adjacent anchor's baseline. Keep
    // its rectangle in the ownership proof, but not in baseline alignment.
    const baselines = sources.map((record) => {
      const tokens = items.filter((i) => record.some((r) => r.every((v, n) => v === i.rect[n])))
      return record.filter(
        (rect) =>
          !tokens.some(
            (i) =>
              rect.every((v, n) => v === i.rect[n]) &&
              tokens.filter((anchor) => isAdjacentTableScript(i, anchor)).length === 1
          )
      )
    })
    const height = Math.min(...baselines.flat().map((rect) => rect[3] - rect[1]))
    if (
      height <= 0 ||
      baselines.some((record) =>
        record.some((rect) => Math.abs(rect[3] - record[0][3]) > height * 0.1)
      )
    )
      continue
    if (sources.length === 2) {
      if (
        baselines[1][0][1] <= baselines[0][0][3] ||
        baselines[1][0][3] - baselines[0][0][3] > height * 1.8
      )
        continue
    } else {
      const center = (band.rect[1] + band.rect[3]) / 2
      if (
        band.rect[3] - band.rect[1] > height * 1.3 ||
        center <= baselines[0][0][1] ||
        center >= baselines[0][0][3]
      )
        continue
    }
    if (
      items.some(
        (item) =>
          intersection(band.rect, item.rect) > 0 &&
          !sources.flat().some((rect) => rect.every((value, i) => value === item.rect[i]))
      )
    )
      continue
    rows.splice(row, 1)
    for (let i = cells.length - 1; i >= 0; i--) {
      if (cells[i].row === row) cells.splice(i, 1)
      else if (cells[i].row > row) cells[i].row--
    }
    repairs.push('empty-overlapping-row-removed')
  }
}

// Separate parent/child text packed into one predicted header row. Native
// underlines must partition every value column, with repeated child labels.
export function splitRuledParentRow({ rows, items, columnRects, rules, repairs }) {
  if (rows.length < 2 || columnRects.length < 5) return
  const first = [...rows[0].rect]
  // A missing child-header band can lie in the gap before the first data row.
  // The repeated labels and separate parent rules below must establish it.
  if (rows[1].rect[1] - first[3] <= (first[3] - first[1]) * 3)
    first[3] = Math.max(first[3], rows[1].rect[1])
  const levels = Map.groupBy(
    rules.filter((r) => r[1] === r[3] && r[1] > first[1] && r[1] < first[3]),
    (r) => Math.round(r[1])
  )
  for (const level of levels.values()) {
    const parents = level
      .map((rule) => ({
        rule,
        columns: columnRects.flatMap((c, n) => {
          const center = (c[0] + c[2]) / 2
          return n && center >= rule[0] && center <= rule[2] ? [n] : []
        })
      }))
      .filter((p) => p.columns.length >= 2)
      .sort((a, b) => a.rule[0] - b.rule[0])
    // A schedule can have one two-visit baseline parent beside independent
    // duration columns. Its underline and repeated duration labels establish
    // the exceptional header shape without interpreting the body markers.
    if (parents.length === 1 && parents[0].columns.length === 2) {
      const { rule, columns } = parents[0],
        y = rule[1]
      const head = items.filter(
        (i) =>
          i.horizontal &&
          i.rect[1] >= first[1] &&
          i.rect[3] <= y &&
          i.rect[0] >= rule[0] - 1 &&
          i.rect[2] <= rule[2] + 1
      )
      const times = items.filter(
        (i) =>
          i.horizontal &&
          /^\d+[MDWY]$/.test(i.text) &&
          i.rect[1] >= first[1] &&
          i.rect[3] <= first[3] &&
          i.rect[0] > rule[2]
      )
      const children = columns.map((c) =>
        items.filter(
          (i) =>
            i.horizontal && i.rect[1] >= y && i.rect[3] <= first[3] && inside(columnRects[c], i)
        )
      )
      if (
        head.length === 1 &&
        /\p{L}/u.test(head[0].text) &&
        times.length >= 2 &&
        Math.abs((head[0].rect[0] + head[0].rect[2] - rule[0] - rule[2]) / 2) < head[0].height &&
        children.every((g) => g.length && g.every((i) => /^[\p{L} ]+$/u.test(i.text))) &&
        times.every((i) => Math.abs(i.baseline - times[0].baseline) < i.height * 0.3)
      ) {
        rows.splice(
          0,
          1,
          { rect: [first[0], first[1], first[2], y], origin: 'source-header' },
          { rect: [first[0], y, first[2], first[3]], origin: 'source-header' }
        )
        repairs.push('ruled-schedule-parent-split')
        return [
          { row: 0, column: columns[0], rowSpan: 1, colSpan: 2 },
          ...columnRects.flatMap((_, c) =>
            columns.includes(c) ? [] : [{ row: 0, column: c, rowSpan: 2, colSpan: 1 }]
          )
        ]
      }
    }
    if (parents.length < 2 || parents.some((p) => p.columns.length !== parents[0].columns.length))
      continue
    const occupied = parents.flatMap((p) => p.columns)
    if (occupied.length !== columnRects.length - 1 || occupied.some((c, n) => c !== n + 1)) continue
    const y = level[0][1]
    const head = items.filter(
      (i) =>
        i.horizontal && i.rect[1] >= first[1] && i.rect[3] <= y && i.rect[0] >= columnRects[1][0]
    )
    if (
      !head.length ||
      head.some((i) => !/\p{L}/u.test(i.text) && !/^\([%\p{L} /]+\)$/u.test(i.text))
    )
      continue
    if (
      parents.some(
        (p) => !head.some((i) => i.rect[0] >= p.rule[0] - 1 && i.rect[2] <= p.rule[2] + 1)
      )
    )
      continue
    if (
      head.some(
        (i) => !parents.some((p) => i.rect[0] >= p.rule[0] - 1 && i.rect[2] <= p.rule[2] + 1)
      )
    )
      continue
    const child = columnRects.slice(1).map((c) =>
      items
        .filter(
          (i) => i.horizontal && i.rect[3] <= first[3] && inside([c[0], y, c[2], first[3]], i)
        )
        .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
        .map((i) => i.text)
        .join('')
        .replace(/\s/g, '')
    )
    const width = parents[0].columns.length
    if (child.some((s, n) => !/\p{L}/u.test(s) || s !== child[n % width])) continue
    rows.splice(
      0,
      1,
      { rect: [first[0], first[1], first[2], y], origin: 'source-header' },
      { rect: [first[0], y, first[2], first[3]], origin: 'source-header' }
    )
    repairs.push('ruled-parent-row-split')
    return [
      ...parents.map((p) => ({
        row: 0,
        column: p.columns[0],
        rowSpan: 1,
        colSpan: p.columns.length
      })),
      { row: 0, column: 0, rowSpan: 2, colSpan: 1 }
    ]
  }
}

// A stub-only sample section can be folded into an otherwise empty header
// stub. Repeated later sample sections and identical complete first records
// distinguish this from a wrapped column heading or a sample-size header.
function recoverLeadingSampleSection({ rows, groups, items, columnRects, rules, repairs }) {
  if (rows.length < 4 || groups.length < 7 || columnRects.length < 3) return
  const columnOf = (item) => columnRects.findIndex((column) => inside(column, item))
  const stub = (group) =>
    group
      .filter((i) => columnOf(i) === 0)
      .map((i) => i.text)
      .join('')
      .replace(/\s/g, '')
  const complete = (group) =>
    columnRects.slice(1).every((_, c) =>
      /^[<>≤≥−+-]?\d[\d\s.,()%±*–−+\-/]*$/.test(
        group
          .filter((i) => columnOf(i) === c + 1)
          .map((i) => i.text)
          .join(' ')
      )
    )
  const [heading, title, sample, record] = groups
  if (
    heading.length !== columnRects.length - 1 ||
    !heading.every((i, c) => columnOf(i) === c + 1 && /^\p{L}[\p{L} -]*$/u.test(i.text)) ||
    title.length !== 1 ||
    columnOf(title[0]) !== 0 ||
    !/^\p{L}.+,$/u.test(title[0].text) ||
    !sample.every((i) => columnOf(i) === 0) ||
    !/^n=\d+$/i.test(stub(sample)) ||
    !complete(record) ||
    !/^\p{L}/u.test(stub(record)) ||
    groups.filter(
      (g, n) =>
        n > 3 &&
        g.every((i) => columnOf(i) === 0) &&
        /^\p{L}.+,n=\d+$/u.test(stub(g)) &&
        groups[n + 1] &&
        stub(groups[n + 1]) === stub(record) &&
        complete(groups[n + 1])
    ).length < 2
  )
    return
  const headBounds = union(heading),
    bodyBounds = union([...title, ...sample])
  if (
    headBounds[3] >= bodyBounds[1] ||
    union(title)[3] >= union(sample)[1] ||
    union(sample)[1] - union(title)[3] > title[0].height ||
    headBounds[3] + title[0].height * 2 < bodyBounds[1] ||
    Math.min(...sample.map((i) => i.rect[0])) < title[0].rect[0] ||
    Math.min(...sample.map((i) => i.rect[0])) - title[0].rect[0] > title[0].height * 1.5 ||
    hasHorizontalTableRuleBetween(rules, union(title)[3], union(sample)[1])
  )
    return
  const firstRows = rows.slice(0, 2),
    members = [...heading, ...title, ...sample]
  if (
    members.some((i) => firstRows.filter((r) => inside(r.rect, i)).length !== 1) ||
    items.some((i) => !members.includes(i) && firstRows.some((r) => inside(r.rect, i))) ||
    rows.slice(2).some((r) => members.some((i) => inside(r.rect, i)))
  )
    return
  const left = columnRects[0][0],
    right = columnRects.at(-1)[2]
  const boundary = (headBounds[3] + bodyBounds[1]) / 2
  rows.splice(
    0,
    2,
    { rect: [left, headBounds[1], right, boundary], origin: 'source-header' },
    { rect: [left, boundary, right, bodyBounds[3]], origin: 'source-section', section: true }
  )
  repairs.push('leading-sample-section-separated')
}

// In two-column summaries, an outdented unit/count title followed by at least
// two complete indented records establishes a section. Split only the source
// groups uniquely owned by its model band; leave other records untouched.
function recoverIndentedSummarySections({ rows, groups, items, columnRects, repairs }) {
  if (columnRects.length !== 2) return
  const left = columnRects[0][0],
    right = columnRects[1][2]
  const cuts = [left, columnRects[0][2], right]
  for (let n = 0; n < groups.length - 2; n++) {
    const heading = groups[n],
      label = readSourceRow(heading, cuts)
    if (!label || label[1] || !/^\p{Lu}.*\([a-zA-Z/]+\)$/u.test(label[0])) continue
    const anchor = heading[0],
      indent = groups[n + 1][0].rect[0] - anchor.rect[0]
    if (indent < anchor.height * 0.5 || indent > anchor.height * 2) continue
    const records = []
    for (const group of groups.slice(n + 1)) {
      const text = readSourceRow(group, cuts),
        previous = records.at(-1) ?? heading
      if (
        !text ||
        !/^\p{Lu}/u.test(text[0]) ||
        !/^[−+-]?\d+(?:\.\d+)?(?:[±–−-]\d+(?:\.\d+)?)?$/.test(text[1]) ||
        Math.abs(group[0].rect[0] - anchor.rect[0] - indent) > anchor.height * 0.1 ||
        group.some((i) => Math.abs(i.height - anchor.height) > anchor.height * 0.1) ||
        union(previous)[3] >= union(group)[1] ||
        group[0].baseline - previous[0].baseline > anchor.height * 1.8
      )
        break
      records.push(group)
    }
    if (records.length < 2) continue
    for (let count = records.length; count >= 1; count--) {
      const split = splitOwnedSourceRows(
        rows,
        items,
        [heading, ...records.slice(0, count)],
        [left, right]
      )
      if (!split) continue
      split.rows[0].section = true
      for (const row of split.rows.slice(1)) row.numericRecord = true
      rows.splice(split.index, 1, ...split.rows)
      repairs.push('indented-summary-section-separated')
      break
    }
  }
}

// Repeated arm pairs beneath unit-bearing headings establish a section role.
// A fragmented heading may be swallowed by the preceding complete record.
function recoverRepeatedUnitSections({ rows, groups, items, columnRects, repairs }) {
  if (columnRects.length < 4) return
  const cuts = [columnRects[0][0], ...columnRects.map((c) => c[2])]
  const blocks = groups.flatMap((heading, n) => {
    const label = readSourceRow(heading, cuts)
    const arms = groups.slice(n + 1, n + 3)
    const values = arms.map((g) => readSourceRow(g, cuts))
    if (
      !label ||
      !/^\p{Lu}[\p{L}\d]*\([a-zA-Z]+\/[a-zA-Z]+\)$/u.test(label[0]) ||
      label.slice(1).some(Boolean) ||
      arms.length !== 2 ||
      values.some((v) => !v || !/^\p{Lu}\p{Ll}+$/u.test(v[0])) ||
      values[0][0] === values[1][0] ||
      arms.some(
        (g) =>
          g[0].rect[0] - heading[0].rect[0] < heading[0].height * 0.5 ||
          g[0].rect[0] - heading[0].rect[0] > heading[0].height * 1.5
      ) ||
      values.some((v) =>
        v.slice(1, 4).some((s) => !/^\d+(?:\.\d+)?\(\d+(?:\.\d+)?[–−-]\d+(?:\.\d+)?\)$/.test(s))
      ) ||
      union(heading)[3] >= union(arms[0])[1] ||
      union(arms[0])[3] >= union(arms[1])[1] ||
      arms[1][0].baseline - heading[0].baseline > heading[0].height * 3
    )
      return []
    return [{ heading, n, label: label[0], arms: values.map((v) => v[0]) }]
  })
  for (const block of blocks) {
    const peers = blocks.filter(
      (b) =>
        b.arms.every((arm, n) => arm === block.arms[n]) &&
        Math.abs(b.heading[0].rect[0] - block.heading[0].rect[0]) < block.heading[0].height * 0.1
    )
    if (new Set(peers.map((b) => b.label)).size < 3 || !block.n) continue
    const previous = groups[block.n - 1]
    if (readSourceRow(previous, cuts)?.[0] !== block.arms[1]) continue
    const split = splitOwnedSourceRow(rows, items, previous, block.heading, [cuts[0], cuts.at(-1)])
    if (!split) continue
    split.rows[0].numericRecord = true
    split.rows[1].section = true
    rows.splice(split.index, 1, ...split.rows)
    repairs.push('repeated-unit-section-separated')
  }
}

// Repeated explicit P expressions are separate records below count/interval
// pairs. Attach only geometrically adjacent scripts and preserve their tokens.
function recoverRepeatedStatisticRows({ rows, groups, items, columnRects, repairs }) {
  if (columnRects.length < 3) return
  const cuts = [columnRects[0][0], ...columnRects.map((c) => c[2])]
  const candidates = groups.flatMap((group, n) => {
    const values = readSourceRow(group, cuts)
    if (!values || values[0]) return []
    const columns = values.flatMap((v, c) => (v ? [c] : []))
    if (!columns.length || columns.some((c) => !/^P[=<>≤≥](?:0?\.\d+|1(?:\.0+)?)$/.test(values[c])))
      return []
    const scripts = groups[n - 1] ?? []
    const attached =
      scripts.length &&
      scripts.every(
        (i) =>
          /^[a-z]$/.test(i.text) &&
          group.filter((a) => a.text === 'P' && isAdjacentTableScript(i, a)).length === 1
      )
    const record = groups[n - (attached ? 2 : 1)]
    const previous = groups[n - (attached ? 3 : 2)]
    const paired = (g) => {
      const v = g && readSourceRow(g, cuts)
      return (
        v?.[0] &&
        columns.every(
          (c) =>
            c >= 2 &&
            /^\d+\/\d+$/.test(v[c - 1]) &&
            /^\d+(?:\.\d+)?\(\d+(?:\.\d+)?,\d+(?:\.\d+)?\)$/.test(v[c])
        )
      )
    }
    const tail = attached ? [...scripts, ...group] : group
    if (
      !paired(record) ||
      !paired(previous) ||
      union(record)[3] >= union(tail)[1] ||
      group[0].baseline - record[0].baseline > group[0].height * 1.6 ||
      columns.some((c) => {
        const anchor = group.find((i) => i.text === 'P' && inside(columnRects[c], i))
        const value = record.find((i) => inside(columnRects[c], i))
        return !anchor || !value || Math.abs(anchor.rect[0] - value.rect[0]) > anchor.height * 0.1
      })
    )
      return []
    return [{ record, tail }]
  })
  if (candidates.length < 3) return
  for (const { record, tail } of candidates) {
    const split = splitOwnedSourceRow(rows, items, record, tail, [cuts[0], cuts.at(-1)])
    if (!split) continue
    for (const row of split.rows) row.numericRecord = true
    rows.splice(split.index, 1, ...split.rows)
    repairs.push('repeated-statistic-row-separated')
  }
}
