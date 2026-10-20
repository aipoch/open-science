/* eslint-disable @typescript-eslint/explicit-function-return-type */
// One ordinary mathematical base can carry two independent native script
// lanes. Keep a continuous lower lane together when x sorting interleaves its
// fragments with a complete upper label; neither text nor anchors are changed.
export function orderNativeDualScriptLanes(line, anchors) {
  if (!Array.isArray(line) || line.length < 4 || !(anchors instanceof Map)) return
  const ordinary = line.filter((item) => !anchors.has(item))
  if (ordinary.length !== 1) return
  const base = ordinary[0],
    scripts = line.filter((item) => item !== base)
  if (!/^\p{L}$/u.test(base.text) || !base.horizontal || !(base.height > 0)) return
  if (
    line.some(
      (item) =>
        !item.horizontal ||
        !item.rect?.every(Number.isFinite) ||
        !Number.isFinite(item.baseline) ||
        !(item.height > 0)
    )
  )
    return
  if (scripts.some((item) => anchors.get(item) !== base || item.height >= base.height * 0.8)) return
  const upper = scripts.filter((item) => item.baseline < base.baseline),
    lower = scripts
      .filter((item) => item.baseline > base.baseline)
      .sort((a, b) => a.rect[0] - b.rect[0])
  if (
    upper.length !== 1 ||
    !/^\(\d+\)$/.test(upper[0].text) ||
    lower.length < 2 ||
    upper.length + lower.length !== scripts.length
  )
    return
  const h = base.height,
    u = upper[0],
    first = lower[0]
  if (
    base.baseline - u.baseline < h * 0.25 ||
    base.baseline - u.baseline > h * 0.8 ||
    first.baseline - base.baseline < h * 0.1 ||
    first.baseline - base.baseline > h * 0.5
  )
    return
  if (
    Math.abs(u.rect[0] - base.rect[2]) > h * 0.2 ||
    Math.abs(first.rect[0] - base.rect[2]) > h * 0.1 ||
    u.rect[3] >= Math.min(...lower.map((item) => item.rect[1]))
  )
    return
  if (
    lower.some(
      (item, n) =>
        Math.abs(item.baseline - first.baseline) > h * 0.02 ||
        Math.abs(item.height - first.height) > h * 0.02 ||
        (n &&
          (item.rect[0] - lower[n - 1].rect[2] < -h * 0.02 ||
            item.rect[0] - lower[n - 1].rect[2] >
              Math.min(item.height, lower[n - 1].height) * 0.15))
    )
  )
    return
  const upperFirst = line.indexOf(u) < Math.min(...lower.map((item) => line.indexOf(item)))
  return [base, ...(upperFirst ? [u, ...lower] : [...lower, u])]
}
