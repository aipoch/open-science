/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { nativeCaptionOwnedInlineFragments } from './literature-pdf-native-caption-script-order.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'

const finiteRect = (r) =>
  Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
const same = (a, b) => Math.abs(a - b) < 0.01

export function nativeRuledScriptCaptionIdentity(old, complete, page, rules, grouped) {
  if (
    old?.lines?.length !== 1 ||
    complete?.lines?.length < 2 ||
    complete.lines.length > 4 ||
    !finiteRect(old.rect) ||
    !finiteRect(complete.rect) ||
    old.page !== page.pageNumber ||
    complete.page !== old.page ||
    !/^Table\s+[A-Z]?\d+\s+\p{L}/u.test(old.lines[0]) ||
    !old.rect.slice(0, 3).every((v, i) => same(v, complete.rect[i])) ||
    complete.rect[3] <= old.rect[3] ||
    page.rotation !== 0 ||
    (page.renderRotation ?? 0) !== 0 ||
    page.invalidGraphicsBounds !== 0 ||
    !Array.isArray(grouped) ||
    grouped.length > 4096 ||
    !Array.isArray(rules) ||
    rules.some((r) => !Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite))
  )
    return false
  const first = grouped.filter(
    (r) =>
      r.text === old.lines[0] &&
      same(r.x, old.rect[0]) &&
      same(r.y, old.rect[1]) &&
      same(r.right, old.rect[2]) &&
      same(r.bottom, old.rect[3])
  )
  if (first.length !== 1 || !(first[0].fontSize > 0)) return false
  const em = first[0].fontSize,
    rows = grouped
      .filter(
        (r) =>
          r.x >= complete.rect[0] - 0.01 &&
          r.right <= complete.rect[2] + 0.01 &&
          r.y >= complete.rect[1] - 0.01 &&
          r.bottom <= complete.rect[3] + 0.01 &&
          Math.abs(r.fontSize - em) < em * 0.01
      )
      .sort((a, b) => a.y - b.y || a.x - b.x)
  if (
    rows.length !== complete.lines.length ||
    rows[0] !== first[0] ||
    !same(rows.at(-1).bottom, complete.rect[3]) ||
    !/[.!?]$/u.test(rows.at(-1).text.trim()) ||
    rows.some((r, i) => i && (r.y < rows[i - 1].bottom || r.y - rows[i - 1].y > em * 1.6))
  )
    return false
  const rebuilt = nativeCaptionOwnedInlineFragments(page, complete, rows, rules)
  if (
    !rebuilt ||
    JSON.stringify(rebuilt.lines) !== JSON.stringify(complete.lines) ||
    (rebuilt.rect && !rebuilt.rect.every((v, i) => same(v, complete.rect[i])))
  )
    return false
  const edges = joinHorizontalTableRules(rules),
    near = edges.filter(
      (r) =>
        r[1] >= complete.rect[3] &&
        r[1] - complete.rect[3] < em * 3 &&
        r[2] - r[0] > (complete.rect[2] - complete.rect[0]) * 0.5 &&
        Math.abs((r[0] + r[2] - complete.rect[0] - complete.rect[2]) / 2) < em
    )
  const openings = near.filter(
    (r) => !near.some((prior) => prior[1] < r[1] && same(prior[0], r[0]) && same(prior[2], r[2]))
  )
  if (openings.length !== 1) return false
  const opening = openings[0],
    rails = edges.filter(
      (r) => r[1] >= opening[1] && same(r[0], opening[0]) && same(r[2], opening[2])
    )
  if (
    rails.length !== 3 ||
    rails[1][1] - opening[1] < em * 0.5 ||
    rails[1][1] - opening[1] > em * 4 ||
    rails[2][1] - rails[1][1] < em * 3
  )
    return false
  return (
    grouped.filter(
      (r) =>
        r.y >= rails[1][1] &&
        r.bottom <= rails[2][1] &&
        r.x >= opening[0] &&
        r.right <= opening[2] &&
        /\d/u.test(r.text)
    ).length >= 3
  )
}
