/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Group by ordinate before sorting segments horizontally. Tiny PDF rounding
// differences must not reorder the middle segment after the right segment.
export function joinHorizontalTableRules(rules, gap = 0.01) {
  const bands = []
  for (const rule of rules.filter((r) => r[1] === r[3]).sort((a, b) => a[1] - b[1])) {
    const last = bands.at(-1)
    if (last && Math.abs(last[0][1] - rule[1]) < 0.01) last.push(rule)
    else bands.push([rule])
  }
  return bands.flatMap((band) => {
    const joined = []
    for (const r of band.sort((a, b) => a[0] - b[0])) {
      const last = joined.at(-1)
      if (last && r[0] <= last[2] + gap) last[2] = Math.max(last[2], r[2])
      else joined.push([r[0], band[0][1], r[2], band[0][1]])
    }
    return joined
  })
}

export function clusterTableRulePositions(values) {
  const groups = []
  for (const value of [...new Set(values)].sort((a, b) => a - b)) {
    const last = groups.at(-1)
    if (last && value - last[0] <= 1) last.push(value)
    else groups.push([value])
  }
  return groups.map((g) => (g[0] + g.at(-1)) / 2)
}

// Fully drawn (1), absent (0), or incomplete (-1). Partial lines never
// authorize a merge; overlapping stroke segments count only once.
export function classifyTableRuleEdge(segments, axis, position, start, end) {
  const ranges = segments
    .filter((r) => Math.abs(r[axis] - position) < 1)
    .map((r) => [Math.max(start, r[1 - axis]), Math.min(end, r[3 - axis])])
    .filter(([a, b]) => b - a > 1)
    .sort((a, b) => a[0] - b[0])
  if (!ranges.length) return 0
  let covered = start
  for (const [a, b] of ranges) {
    if (a > covered + 1) return -1
    covered = Math.max(covered, b)
  }
  return covered >= end - 1 ? 1 : -1
}

// Row continuations must not cross an intervening horizontal rule. Endpoints
// stay open: a border on either source band belongs to that band's enclosure.
// This query does not imply full-width coverage or a mergeable missing edge.
export function hasHorizontalTableRuleBetween(rules, top, bottom) {
  return rules.some((rule) => rule[1] === rule[3] && rule[1] > top && rule[1] < bottom)
}
