/* eslint-disable @typescript-eslint/explicit-function-return-type */
const finite = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite)
const mathematical = (text) =>
  /^[\p{Script=Latin}\p{Script=Greek}\d\s()+−\-*/,.=^{}]+$/u.test(text) &&
  !(text.match(/[A-Za-z]{3,}/gu) ?? []).length

// Negative table evidence only: complete native bullets introduce displays
// below their titles. Every local rule must be one of the proved fraction bars.
export function hasNativeBulletFormulaList(table, items, rules) {
  const crop = table?.cropRect
  if (!finite(crop, 4) || !Array.isArray(items) || !Array.isArray(rules)) return false
  if (
    items.some(
      (i) => i.text?.trim() && (!finite(i.rect, 4) || !Number.isFinite(i.height) || i.height <= 0)
    )
  )
    return false
  const scope = items.filter(
    (i) =>
      i.text?.trim() &&
      i.rect[0] >= crop[0] - i.height &&
      i.rect[2] <= crop[2] + i.height &&
      i.rect[3] > crop[1] &&
      i.rect[1] < crop[3]
  )
  if (
    items.some(
      (i) =>
        i.text?.trim() &&
        i.rect[0] < crop[2] &&
        i.rect[2] > crop[0] &&
        i.rect[1] < crop[3] &&
        i.rect[3] > crop[1] &&
        !scope.includes(i)
    )
  )
    return false
  if (
    scope.some(
      (i) =>
        !i.horizontal ||
        i.sourceItem?.text !== i.text ||
        !Number.isSafeInteger(i.sourceItem.index) ||
        !Number.isFinite(i.baseline)
    )
  )
    return false
  const native = scope.sort((a, b) => a.sourceItem.index - b.sourceItem.index)
  if (
    !native.length ||
    new Set(native.map((i) => `${i.sourceItem.pageNumber}:${i.sourceItem.index}`)).size !==
      native.length
  )
    return false
  const bullets = native.filter((i) => i.text === '•')
  if (bullets.length < 2 || bullets.length > 6) return false
  const page = bullets[0].sourceItem.pageNumber,
    matchedRules = new Set()
  let firstLabel
  for (const [at, bullet] of bullets.entries()) {
    const start = native.indexOf(bullet),
      next = bullets[at + 1],
      end = next ? native.indexOf(next) : native.length,
      label = native[start + 1],
      formula = native.slice(start + 2, end),
      h = label?.height
    if (
      !label ||
      !h ||
      !/^[A-Z][a-z]+(?:[ -][a-z]+){1,6}$/u.test(label.text) ||
      label.sourceItem.index <= bullet.sourceItem.index ||
      Math.abs(label.baseline - bullet.baseline) > h * 0.02 ||
      bullet.height < h * 0.6 ||
      bullet.height > h ||
      label.rect[0] - bullet.rect[2] < h * 0.2 ||
      label.rect[0] - bullet.rect[2] > h ||
      formula.length < 5 ||
      formula.some(
        (i) =>
          i.sourceItem.pageNumber !== page ||
          !mathematical(i.text) ||
          i.rect[1] < label.baseline + h * 0.1 ||
          i.rect[3] > (next?.rect[1] ?? crop[3]) + h * 0.05
      )
    )
      return false
    if (
      firstLabel &&
      (Math.abs(label.rect[0] - firstLabel.rect[0]) > h * 0.05 ||
        Math.abs(bullet.rect[0] - bullets[0].rect[0]) > h * 0.05 ||
        Math.abs(h - firstLabel.height) > h * 0.01)
    )
      return false
    firstLabel ??= label
    const local = rules.flatMap((r, index) =>
      finite(r, 4) &&
      Math.max(r[0], r[2]) > crop[0] &&
      Math.min(r[0], r[2]) < crop[2] &&
      Math.max(r[1], r[3]) > label.baseline &&
      Math.min(r[1], r[3]) < (next?.rect[1] ?? crop[3])
        ? [{ r, index }]
        : []
    )
    if (local.length !== 2) return false
    local.sort((a, b) => a.r[0] - b.r[0])
    if (
      local.some(({ r }) => r[1] !== r[3] || r[2] - r[0] < h || r[2] - r[0] > h * 6) ||
      Math.abs(local[0].r[1] - local[1].r[1]) > h * 0.05 ||
      local[1].r[0] - local[0].r[2] < h * 0.5
    )
      return false
    const claimed = new Set()
    for (const { r, index } of local) {
      const under = formula.filter(
          (i) => i.rect[0] >= r[0] - h * 0.1 && i.rect[2] <= r[2] + h * 0.1
        ),
        numerator = under.filter((i) => i.baseline < r[1]),
        denominator = under.filter((i) => i.baseline > r[1]),
        bases = (group) => group.filter((i) => i.height >= h * 0.9)
      if (
        !numerator.length ||
        !denominator.length ||
        !bases(numerator).length ||
        !bases(denominator).length ||
        under.some(
          (i) => Math.abs(i.baseline - r[1]) > h * 2 || i.height < h * 0.6 || i.height > h * 1.01
        ) ||
        [numerator, denominator].some((group) => {
          const rows = bases(group)
          return rows.some((i) => Math.abs(i.baseline - rows[0].baseline) > h * 0.05)
        })
      )
        return false
      for (const item of under) claimed.add(item)
      matchedRules.add(index)
    }
    const operators = formula.filter((i) => !claimed.has(i))
    if (
      operators.length !== 1 ||
      !/^[+−-]$/u.test(operators[0].text) ||
      operators[0].rect[0] <= local[0].r[2] ||
      operators[0].rect[2] >= local[1].r[0]
    )
      return false
  }
  // A partially intersected preceding display may be inside the detector box;
  // it stays original prose/math instead of becoming a fabricated first row.
  const prefix = native.slice(0, native.indexOf(bullets[0]))
  if (prefix.some((i) => !mathematical(i.text) || i.sourceItem.pageNumber !== page)) return false
  for (const [index, r] of rules.entries()) {
    if (!finite(r, 4)) return false
    if (
      Math.max(r[0], r[2]) <= crop[0] ||
      Math.min(r[0], r[2]) >= crop[2] ||
      Math.max(r[1], r[3]) <= crop[1] ||
      Math.min(r[1], r[3]) >= crop[3] ||
      matchedRules.has(index)
    )
      continue
    if (
      !prefix.length ||
      r[1] !== r[3] ||
      r[1] >= bullets[0].rect[1] ||
      r[2] - r[0] > (crop[2] - crop[0]) * 0.4 ||
      !prefix.some(
        (i) =>
          i.baseline < r[1] + firstLabel.height &&
          i.rect[0] >= r[0] - firstLabel.height * 0.1 &&
          i.rect[2] <= r[2] + firstLabel.height * 0.1
      ) ||
      !prefix.some(
        (i) =>
          i.baseline > r[1] &&
          i.rect[0] >= r[0] - firstLabel.height * 0.1 &&
          i.rect[2] <= r[2] + firstLabel.height * 0.1
      )
    )
      return false
  }
  return true
}
