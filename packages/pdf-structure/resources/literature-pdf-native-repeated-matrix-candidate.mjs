/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { area, intersection, union } from './literature-pdf-page-geometry.mjs'
// Source coordinates are viewport units. This proves a complete table image;
// overlapping native panel frames do not supply inferred cell boundaries.
export function nativeRepeatedMatrixCandidate(items, rules, captions, width, height) {
  if (
    ![width, height].every((v) => Number.isFinite(v) && v > 0) ||
    items.some((t) => ![...t.rect, t.baseline, t.height].every(Number.isFinite)) ||
    rules.some((r) => !r.every(Number.isFinite))
  )
    return
  const titles = captions.filter((c) => /^Table\s+\d+[.:]\s/.test(c.lines[0]))
  if (titles.length !== 1) return
  const caption = titles[0],
    native = items.filter((t) => t.horizontal && t.height > 0 && area(t.rect) > 0),
    numeric = (t) => /^[−+-]?\d+(?:\.\d+)?$/.test(t.text.trim()),
    center = (t) => (t.rect[0] + t.rect[2]) / 2,
    horizontal = rules.filter((r) => r[1] === r[3] && r[2] - r[0] > 60 && r[1] > caption.rect[3]),
    panels = []
  for (const opening of horizontal) {
    const same = horizontal
      .filter(
        (r) =>
          Math.abs(r[0] - opening[0]) < 0.01 &&
          Math.abs(r[2] - opening[2]) < 0.01 &&
          r[1] > opening[1]
      )
      .sort((a, b) => a[1] - b[1])
    if (same.length !== 2) continue
    const [divider, closing] = same
    const stubs = rules.filter(
      (r) =>
        r[0] === r[2] &&
        r[0] > opening[0] &&
        r[0] < opening[0] + (opening[2] - opening[0]) * 0.25 &&
        r[1] >= opening[1] &&
        r[3] <= closing[1]
    )
    if (stubs.length < 5 || stubs.some((r) => Math.abs(r[0] - stubs[0][0]) > 0.01)) continue
    const stub = stubs[0][0],
      head = native.filter(
        (t) =>
          numeric(t) &&
          t.rect[0] > stub &&
          t.rect[2] < opening[2] &&
          t.baseline > opening[1] &&
          t.baseline < divider[1]
      )
    if (head.length < 3 || head.length > 8) continue
    head.sort((a, b) => center(a) - center(b))
    const em = head[0].height,
      centers = head.map(center)
    if (
      head.some(
        (t) => Math.abs(t.height - em) > 0.01 || Math.abs(t.baseline - head[0].baseline) > 0.01
      ) ||
      Math.abs(divider[1] - opening[1] - em) > em * 0.3 ||
      centers
        .slice(1)
        .some((v, i) => Math.abs(v - centers[i] - (centers[1] - centers[0])) > em * 0.1)
    )
      continue
    const label = native.filter(
      (t) =>
        t.rect[0] >= opening[0] &&
        t.rect[2] <= stub &&
        t.baseline > opening[1] &&
        t.baseline < divider[1]
    )
    if (
      label.length < 1 ||
      label.length > 4 ||
      !label.every(
        (t) =>
          /^[\p{L}\\/]+$/u.test(t.text.trim()) && Math.abs(t.baseline - head[0].baseline) < 0.01
      )
    )
      continue
    const records = native.filter(
      (t) =>
        numeric(t) &&
        t.baseline > divider[1] &&
        t.baseline < closing[1] &&
        ((t.rect[0] >= opening[0] && t.rect[2] < stub) ||
          centers.some((c) => Math.abs(center(t) - c) < em * 0.05))
    )
    const baselines = records
      .map((t) => t.baseline)
      .sort((a, b) => a - b)
      .reduce((rows, b) => {
        if (!rows.some((v) => Math.abs(v - b) < 0.01)) rows.push(b)
        return rows
      }, [])
    if (
      baselines.length < 4 ||
      baselines.length > 8 ||
      records.length !== baselines.length * (head.length + 1) ||
      baselines.some((b) => {
        const row = records.filter((t) => Math.abs(t.baseline - b) < 0.01)
        return (
          row.length !== head.length + 1 ||
          row.filter((t) => t.rect[2] < stub).length !== 1 ||
          centers.some(
            (c) => row.filter((t) => Math.abs(center(t) - c) < em * 0.05).length !== 1
          ) ||
          row.some((t) => Math.abs(t.height - em) > 0.01)
        )
      }) ||
      baselines.slice(1).some((b, i) => Math.abs(b - baselines[i] - em) > em * 0.25)
    )
      continue
    const stem = [...stubs].sort((a, b) => a[1] - b[1])
    if (
      Math.abs(stem[0][1] - opening[1]) > em * 0.05 ||
      Math.abs(stem.at(-1)[3] - closing[1]) > em * 0.05 ||
      stem.slice(1).some((r, i) => Math.abs(r[1] - stem[i][3]) > em * 0.1)
    )
      continue
    const parent = native.filter(
      (t) =>
        t.rect[0] >= opening[0] &&
        t.rect[2] <= opening[2] &&
        t.baseline <= opening[1] &&
        opening[1] - t.baseline < em * 2
    )
    if (
      parent.length !== 3 ||
      !/^\p{L}$/u.test(parent[0].text) ||
      parent[1].text !== '=' ||
      !/^\d+$/.test(parent[2].text) ||
      parent.some((t) => Math.abs(t.baseline - parent[0].baseline) > 0.01)
    )
      continue
    panels.push({
      rect: [opening[0], Math.min(...parent.map((t) => t.rect[1])), opening[2], closing[1] + 0.5],
      opening,
      divider,
      closing,
      owned: [...parent, ...label, ...head, ...records]
    })
  }
  if (panels.length < 3 || panels.length > 8) return
  const first = panels[0],
    w = first.rect[2] - first.rect[0],
    h = first.closing[1] - first.opening[1]
  if (
    panels.some(
      (p) =>
        Math.abs(p.rect[2] - p.rect[0] - w) > 0.01 ||
        Math.abs(p.closing[1] - p.opening[1] - h) > 0.2
    )
  )
    return
  const owned = panels.flatMap((p) => p.owned)
  if (new Set(owned).size !== owned.length) return
  const rect = union(panels.map((p) => p.rect))
  if (
    rect[1] - caption.rect[3] > owned[0].height * 2 ||
    rect[0] < 0 ||
    rect[2] > width ||
    rect[3] > height ||
    native.some((t) => intersection(t.rect, rect) / area(t.rect) > 0.5 && !owned.includes(t))
  )
    return
  return { rect, caption, panels }
}
