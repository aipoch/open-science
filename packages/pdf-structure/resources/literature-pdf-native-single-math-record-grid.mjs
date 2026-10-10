/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import { hasUniqueRecordTokens } from './literature-pdf-source-records.mjs'

// One complete mathematical record has no peer records. A double native
// opening, header/body divider and closing, three source header groups and
// uniquely anchored script pairs establish its fields without model cuts.
export function recoverNativeSingleMathRecordGrid(table, items, captions, rules) {
  const crop = table.cropRect
  if (!crop?.every(Number.isFinite)) return
  const near = items.filter(
    (i) =>
      i.text?.trim() &&
      i.rect[0] < crop[2] &&
      i.rect[2] > crop[0] &&
      i.rect[1] < crop[3] &&
      i.rect[3] > crop[1]
  )
  if (!near.length) return
  const h = near.map((i) => i.height).sort((a, b) => b - a)[0]
  if (!(h > 0) || !Number.isFinite(h)) return
  const full = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r.every(Number.isFinite) &&
        r[1] >= crop[1] - h &&
        r[1] <= crop[3] + h &&
        Math.abs(r[0] - crop[0]) < h &&
        r[2] - r[0] >= (crop[2] - crop[0]) * 0.85 &&
        r[2] - r[0] <= (crop[2] - crop[0]) * 1.15
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length !== 4 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.05 || Math.abs(r[2] - full[0][2]) > 0.05)
  )
    return
  const [opening, second, divider, closing] = full
  if (
    second[1] - opening[1] < h * 0.05 ||
    second[1] - opening[1] > h * 0.3 ||
    divider[1] - second[1] < h ||
    divider[1] - second[1] > h * 3 ||
    closing[1] - divider[1] < h ||
    closing[1] - divider[1] > h * 2.5
  )
    return
  const page = Number(/^page-(\d+)-/.exec(table.id ?? '')?.[1])
  if (
    captions.filter(
      (c) =>
        c.page === page &&
        captionKind(c.lines?.[0]) === 'table' &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0] &&
        c.rect[3] <= opening[1] &&
        opening[1] - c.rect[3] < h * 3
    ).length !== 1
  )
    return
  const source = items.filter(
    (i) =>
      i.text?.trim() &&
      i.rect[0] < opening[2] &&
      i.rect[2] > opening[0] &&
      i.rect[1] < closing[1] &&
      i.rect[3] > opening[1]
  )
  if (
    source.some(
      (i) =>
        i.horizontal === false ||
        !Number.isFinite(i.baseline) ||
        !Number.isFinite(i.height) ||
        i.rect.length !== 4 ||
        !i.rect.every(Number.isFinite) ||
        i.rect[2] <= i.rect[0] ||
        i.rect[3] <= i.rect[1] ||
        i.rect[0] < opening[0] ||
        i.rect[2] > opening[2] ||
        i.rect[1] < opening[1] ||
        i.rect[3] > closing[1] ||
        !(Math.abs(i.height - h) < h * 0.04 || (i.height >= h * 0.55 && i.height <= h * 0.75))
    )
  )
    return
  const header = source.filter((i) => i.rect[3] < divider[1]),
    body = source.filter((i) => i.rect[1] > divider[1])
  if (header.length + body.length !== source.length || !header.length || !body.length) return
  const normalHeader = header
    .filter((i) => Math.abs(i.height - h) < h * 0.04)
    .sort((a, b) => a.rect[0] - b.rect[0])
  const normalBody = body.filter((i) => Math.abs(i.height - h) < h * 0.04)
  if (
    !normalHeader.length ||
    !normalBody.length ||
    normalHeader.some((i) => Math.abs(i.baseline - normalHeader[0].baseline) > h * 0.04) ||
    normalBody.some((i) => Math.abs(i.baseline - normalBody[0].baseline) > h * 0.04)
  )
    return
  const groups = []
  for (const i of [...header].sort((a, b) => a.rect[0] - b.rect[0])) {
    const last = groups.at(-1)
    if (last && i.rect[0] - Math.max(...last.map((p) => p.rect[2])) <= h * 0.75) last.push(i)
    else groups.push([i])
  }
  if (groups.length !== 3 || groups.some((g) => !g.some((i) => Math.abs(i.height - h) < h * 0.04)))
    return
  const bodyGroups = []
  for (const i of [...body].sort((a, b) => a.rect[0] - b.rect[0])) {
    const last = bodyGroups.at(-1)
    if (last && i.rect[0] - Math.max(...last.map((p) => p.rect[2])) <= h * 0.75) last.push(i)
    else bodyGroups.push([i])
  }
  if (bodyGroups.length !== 3) return
  const rough = [
      opening[0],
      ...bodyGroups
        .slice(1)
        .map(
          (g, n) =>
            (Math.max(...bodyGroups[n].map((i) => i.rect[2])) +
              Math.min(...g.map((i) => i.rect[0]))) /
            2
        ),
      opening[2]
    ],
    cuts = [opening[0]]
  for (let n = 1; n < 3; n++) {
    const left = source.filter(
      (i) =>
        (i.rect[0] + i.rect[2]) / 2 < rough[n] &&
        (n === 1 || (i.rect[0] + i.rect[2]) / 2 >= rough[n - 1])
    )
    const right = source.filter(
      (i) =>
        (i.rect[0] + i.rect[2]) / 2 >= rough[n] &&
        (n === 2 || (i.rect[0] + i.rect[2]) / 2 < rough[n + 1])
    )
    const a = Math.max(...left.map((i) => i.rect[2])),
      b = Math.min(...right.map((i) => i.rect[0]))
    if (b - a < h * 0.3) return
    cuts.push((a + b) / 2)
  }
  cuts.push(opening[2])
  const lane = (i) => cuts.slice(1).findIndex((x, n) => i.rect[0] >= cuts[n] && i.rect[2] <= x)
  if (
    source.some((i) => lane(i) < 0) ||
    [0, 1, 2].some((n) => !normalBody.some((i) => lane(i) === n))
  )
    return
  for (const row of [header, body]) {
    const bases = row.filter((i) => Math.abs(i.height - h) < h * 0.04),
      scripts = row.filter((i) => i.height < h * 0.8)
    for (const s of scripts) {
      const parents = bases.filter(
        (a) =>
          lane(a) === lane(s) &&
          Math.abs(s.rect[0] - a.rect[2]) < h * 0.03 &&
          Math.abs(s.baseline - a.baseline) > h * 0.1 &&
          Math.abs(s.baseline - a.baseline) < h * 0.7
      )
      // A sign and its adjacent digits belong to one script baseline; only
      // its first source fragment touches the unique normal-sized anchor.
      if (parents.length === 1) continue
      if (parents.length > 1) return
      const predecessors = scripts.filter(
        (a) =>
          a !== s &&
          lane(a) === lane(s) &&
          Math.abs(a.baseline - s.baseline) < h * 0.02 &&
          Math.abs(s.rect[0] - a.rect[2]) < h * 0.03
      )
      if (predecessors.length !== 1) return
      let first = predecessors[0],
        visited = new Set([s])
      while (
        bases.filter(
          (a) =>
            lane(a) === lane(first) &&
            Math.abs(first.rect[0] - a.rect[2]) < h * 0.03 &&
            Math.abs(first.baseline - a.baseline) > h * 0.1 &&
            Math.abs(first.baseline - a.baseline) < h * 0.7
        ).length !== 1
      ) {
        if (
          bases.filter(
            (a) =>
              lane(a) === lane(first) &&
              Math.abs(first.rect[0] - a.rect[2]) < h * 0.03 &&
              Math.abs(first.baseline - a.baseline) > h * 0.1 &&
              Math.abs(first.baseline - a.baseline) < h * 0.7
          ).length > 1
        )
          return
        if (visited.has(first)) return
        visited.add(first)
        const prev = scripts.filter(
          (a) =>
            a !== first &&
            lane(a) === lane(first) &&
            Math.abs(a.baseline - first.baseline) < h * 0.02 &&
            Math.abs(first.rect[0] - a.rect[2]) < h * 0.03
        )
        if (prev.length !== 1) return
        first = prev[0]
      }
    }
  }
  const scriptPairs = [1, 2].every((n) => {
    const scripts = body.filter((i) => i.height < h * 0.8 && lane(i) === n),
      base = normalBody.find(
        (i) => lane(i) === n && scripts.some((s) => Math.abs(s.rect[0] - i.rect[2]) < h * 0.03)
      )
    return (
      base &&
      scripts.some((s) => s.baseline < base.baseline && /^\+/.test(s.text)) &&
      scripts.some((s) => s.baseline > base.baseline && /^[−-]/.test(s.text))
    )
  })
  if (!scriptPairs || !hasUniqueRecordTokens(source, [header, body])) return
  const rect = [
    Math.min(crop[0], opening[0] - 0.5),
    Math.min(crop[1], opening[1] - 0.5),
    Math.max(crop[2], opening[2] + 0.5),
    crop[3]
  ]
  return {
    cropRect: rect,
    rows: [
      [rect[0], rect[1], rect[2], divider[1]],
      [rect[0], divider[1], rect[2], rect[3]]
    ],
    columns: cuts
      .slice(1)
      .map((x, n) => [n ? cuts[n] : rect[0], rect[1], n === 2 ? rect[2] : x, rect[3]]),
    headerRows: [0],
    spans: [],
    completeSpans: true,
    ownedTokens: new Set(source),
    preservePhysicalRows: true,
    repair: 'native-body-records-recovered'
  }
}
