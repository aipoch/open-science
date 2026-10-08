/* eslint-disable @typescript-eslint/explicit-function-return-type -- Shared renderer/worker geometry helper. */
// Resolve compact inline fractions only when two equally small tiers straddle
// a body baseline and the numerator is centered over a connected denominator.
// The worker must additionally prove/preserve the original dividing rule.
export const resolveInlineFractions = (items, bodyBaseline, bodyFont) => {
  const result = []
  const used = new Set()
  for (const numerator of items) {
    const rise = numerator.baseline - bodyBaseline
    if (
      !/^(?:\d{1,3}|[A-Za-z\p{Script=Greek}])$/u.test(numerator.text.trim()) ||
      numerator.fontSize >= bodyFont * 0.85 ||
      rise < bodyFont * 0.2 ||
      rise > bodyFont * 0.7 ||
      items.some(
        (base) =>
          base.fontSize >= bodyFont * 0.9 &&
          // PDF text runs may combine a separator with the following base.
          // Its adjacent upper/lower scripts still belong to that single letter.
          (/^(?:[,;]\s*)?[A-Za-z\p{Script=Greek}]$/u.test(base.text.trim()) ||
            // A norm's closing delimiter also owns adjacent upper/lower scripts.
            // Require its matching opener and a native variable between them;
            // a lone vertical bar beside a real fraction is not enough.
            (/^[‖∥]$/u.test(base.text.trim()) &&
              items.some(
                (open) =>
                  open.text.trim() === base.text.trim() &&
                  open.i < base.i &&
                  open.bounds[2] < base.bounds[0] &&
                  base.bounds[0] - open.bounds[2] < bodyFont * 4 &&
                  Math.abs(open.fontSize - bodyFont) < bodyFont * 0.1 &&
                  Math.abs(open.baseline - bodyBaseline) < bodyFont * 0.15 &&
                  items.some(
                    (operand) =>
                      operand.i > open.i &&
                      operand.i < base.i &&
                      /^[A-Za-z\p{Script=Greek}]{1,4}$/u.test(operand.text.trim()) &&
                      operand.bounds[0] >= open.bounds[2] - bodyFont * 0.05 &&
                      operand.bounds[2] <= base.bounds[0] + bodyFont * 0.05 &&
                      Math.abs(operand.fontSize - bodyFont) < bodyFont * 0.1 &&
                      Math.abs(operand.baseline - bodyBaseline) < bodyFont * 0.15
                  )
              ))) &&
          Math.abs(base.baseline - bodyBaseline) < bodyFont * 0.15 &&
          numerator.bounds[0] - base.bounds[2] >= -bodyFont * 0.1 &&
          numerator.bounds[0] - base.bounds[2] < bodyFont * 0.5
      )
    )
      continue
    const candidates = items
      .filter(
        (item) =>
          item.i !== numerator.i &&
          !used.has(item.i) &&
          Math.abs(item.fontSize - numerator.fontSize) < bodyFont * 0.05 &&
          bodyBaseline - item.baseline >= bodyFont * 0.2 &&
          bodyBaseline - item.baseline <= bodyFont * 0.7 &&
          /^[\dA-Za-z\p{Script=Greek}+−*/().=\s-]+$/u.test(item.text)
      )
      .sort((a, b) => a.bounds[0] - b.bounds[0])
    const groups = []
    for (const item of candidates) {
      const group = groups.at(-1),
        previous = group?.at(-1)
      if (
        !previous ||
        Math.abs(previous.baseline - item.baseline) > bodyFont * 0.05 ||
        item.bounds[0] - previous.bounds[2] > bodyFont * 0.3
      )
        groups.push([item])
      else group.push(item)
    }
    const denominators = groups.filter((group) => {
      const left = group[0].bounds[0],
        right = group.at(-1).bounds[2]
      const text = group
        .map((item) => item.text)
        .join('')
        .replace(/\s/gu, '')
      return (
        // Advance boxes and native glyph ink differ slightly in side bearings;
        // PDF matrices also round. Allow only a small fraction of the body font.
        ((left <= numerator.bounds[0] + bodyFont * 0.05 &&
          right >= numerator.bounds[2] - bodyFont * 0.05) ||
          (left >= numerator.bounds[0] - bodyFont * 0.05 &&
            right <= numerator.bounds[2] + bodyFont * 0.05)) &&
        Math.abs((left + right - numerator.bounds[0] - numerator.bounds[2]) / 2) < bodyFont * 0.3 &&
        (/^\d/u.test(numerator.text.trim())
          ? /[+−*/=-]/u.test(text) ||
            /^\d{1,4}$/u.test(text) ||
            (numerator.text.trim() === '1' && /^[A-Za-z\p{Script=Greek}]$/u.test(text))
          : /^\d{1,4}$/u.test(text) ||
            /^[A-Za-z\p{Script=Greek}]{1,12}$/u.test(text) ||
            /^[A-Za-z\p{Script=Greek}][+−-]\d{1,3}$/u.test(text)) &&
        [...text].reduce(
          (depth, char) => depth + Number(char === '(') - Number(char === ')'),
          0
        ) === 0
      )
    })
    if (denominators.length !== 1) continue
    const denominator = denominators[0],
      members = [numerator, ...denominator]
    // A letter over an integer must also be a serial native pair. Otherwise
    // table columns and matrix subscripts can borrow an unrelated numeric row.
    // Check after geometric ambiguity, so extra overlapping tiers stay rejected.
    if (
      /^[A-Za-z\p{Script=Greek}]$/u.test(numerator.text.trim()) &&
      /^\d{1,4}$/u.test(
        denominator
          .map((item) => item.text)
          .join('')
          .replace(/\s/gu, '')
      ) &&
      (denominator[0].i <= numerator.i ||
        items.some((part) => part.i > numerator.i && part.i < denominator[0].i && part.text.trim()))
    )
      continue
    if (members.some((item) => used.has(item.i))) continue
    for (const item of members) used.add(item.i)
    const denominatorText = denominator
      .map((item) => item.text)
      .join('')
      .replace(/\s/gu, '')
    result.push({
      indices: members.map((item) => item.i),
      label:
        numerator.text.trim() +
        '/' +
        (/^[\dA-Za-z\p{Script=Greek}]+$/u.test(denominatorText)
          ? denominatorText
          : '(' + denominatorText + ')'),
      numerator: numerator.i,
      denominator: denominator.map((item) => item.i),
      bounds: [
        Math.min(...members.map((item) => item.bounds[0])),
        Math.min(...members.map((item) => item.bounds[1])),
        Math.max(...members.map((item) => item.bounds[2])),
        Math.max(...members.map((item) => item.bounds[3]))
      ]
    })
  }
  return result
}
