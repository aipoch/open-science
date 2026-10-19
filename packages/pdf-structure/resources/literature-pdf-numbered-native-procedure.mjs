/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { groupPageLines } from './literature-pdf-caption-group.mjs'

// Dot steps require their own complete I/O/Procedure frame. An inset title
// alone cannot turn a numbered paragraph or an input list into pseudocode.
function findInsetDotProcedure(page, title, titles, lines, rules) {
  const frames = rules.flatMap((top) => {
    if (
      top[2] - top[0] < page.width * 0.65 ||
      title.x < top[0] ||
      title.x - top[0] > title.fontSize * 1.2 ||
      title.right > top[2] ||
      Math.abs(top[1] - title.y) > title.fontSize
    )
      return []
    const aligned = rules
      .filter(
        (r) => Math.abs(r[0] - top[0]) < 1e-8 && Math.abs(r[2] - top[2]) < 1e-8 && r[1] >= top[1]
      )
      .sort((a, b) => a[1] - b[1])
    if (aligned.length !== 3 || aligned[0] !== top) return []
    const [, divider, bottom] = aligned,
      rect = [top[0] - 2, Math.min(top[1], title.y) - 2, top[2] + 2, bottom[3] + 2]
    if (
      divider[1] <= title.bottom ||
      divider[1] - title.bottom > title.fontSize ||
      bottom[1] <= divider[3] + title.fontSize * 4 ||
      rect[0] < 0 ||
      rect[1] < 0 ||
      rect[2] > page.width ||
      rect[3] > page.height
    )
      return []
    const inside = page.lines.filter(
      (l) =>
        l.text.trim() &&
        l.x < rect[2] &&
        l.x + l.width > rect[0] &&
        l.y < rect[3] &&
        l.y + l.height > rect[1]
    )
    if (
      !inside.length ||
      inside.some(
        (l) =>
          ![l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite) ||
          l.height <= 0 ||
          l.width < 0 ||
          (l.width === 0 &&
            (!/^\p{M}+$/u.test(l.text) ||
              inside.filter(
                (base) =>
                  /^\p{L}$/u.test(base.text) &&
                  base.width > 0 &&
                  base.x < l.x &&
                  base.x + base.width > l.x &&
                  base.y >= l.y &&
                  base.y < l.y + l.height &&
                  base.y + base.height >= l.y + l.height &&
                  l.fontSize >= base.fontSize * 0.6 &&
                  l.fontSize <= base.fontSize &&
                  base.y - l.y < base.fontSize * 0.4
              ).length !== 1)) ||
          l.fontSize <= 0 ||
          l.x < rect[0] ||
          l.y < rect[1] ||
          l.x + l.width > rect[2] ||
          l.y + l.height > rect[3]
      ) ||
      titles.filter((l) => l.y >= rect[1] && l.bottom <= rect[3]).length !== 1
    )
      return []
    // Quantized path bounds can overlap a full native font's ascender box.
    // Its complete baseline must follow the divider; the crop above still
    // owns every whole native font without clipping or enlarging its bounds.
    const body = lines.filter(
        (l) =>
          l.y > title.bottom &&
          l.bottom > divider[3] &&
          l.bottom <= rect[3] &&
          l.x >= rect[0] &&
          l.right <= rect[2]
      ),
      inputs = body.filter((l) => /^Inputs?\s*:/i.test(l.text)),
      outputs = body.filter((l) => /^Outputs?\s*:/i.test(l.text)),
      procedures = body.filter((l) => /^Procedure\s*:\s*$/i.test(l.text))
    if (
      inputs.length !== 1 ||
      outputs.length !== 1 ||
      procedures.length !== 1 ||
      inputs[0].bottom >= outputs[0].y ||
      outputs[0].bottom >= procedures[0].y
    )
      return []
    const steps = body.filter((l) => /^\d+\.\s+\p{L}/u.test(l.text))
    if (
      steps.length < 3 ||
      steps.length > 32 ||
      steps.some(
        (l, n) =>
          Number(l.text.match(/^(\d+)\./u)[1]) !== n + 1 ||
          l.y <= procedures[0].bottom ||
          (n && l.y <= steps[n - 1].bottom)
      )
    )
      return []
    return [
      {
        caption: {
          page: page.pageNumber,
          lines: [title.text],
          rect: [title.x, title.y, title.right, title.bottom]
        },
        rect
      }
    ]
  })
  return frames.length === 1 ? frames : []
}

// Some publishers use a numbered algorithm frame for a short straight-line
// routine without colons, step numbers, or loop controls. Keep this proof
// separate from the established I/O/loop recognizers: the complete native
// three-rule frame and the ordered assignment/return body are required.
function findStraightLineProcedure(page, title, titles, lines, rules) {
  const finiteRules = rules.filter(
    (rule) =>
      rule.length === 4 &&
      rule.every(Number.isFinite) &&
      rule[2] > rule[0] &&
      rule[3] >= rule[1] &&
      rule[2] - rule[0] >= page.width * 0.65 &&
      rule[3] - rule[1] <= page.height / 64
  )
  const frames = finiteRules.flatMap((top) => {
    if (Math.abs(top[1] - title.y) > title.fontSize || title.x < top[0] || title.right > top[2])
      return []
    const aligned = finiteRules
      .filter(
        (rule) =>
          Math.abs(rule[0] - top[0]) <= 1 && Math.abs(rule[2] - top[2]) <= 1 && rule[1] >= top[1]
      )
      .sort((a, b) => a[1] - b[1])
    if (aligned.length !== 3 || aligned[0] !== top) return []
    const [, divider, bottom] = aligned
    if (
      divider[1] <= title.bottom ||
      divider[1] - title.bottom > title.fontSize * 1.6 ||
      bottom[1] <= divider[3] + title.fontSize * 2 ||
      bottom[1] >= page.height - title.fontSize * 2
    )
      return []
    const rect = [top[0] - 2, top[1] - 2, top[2] + 2, bottom[3] + 2]
    if (rect[0] < 0 || rect[1] < 0 || rect[2] > page.width || rect[3] > page.height) return []
    if (
      titles.filter(
        (candidate) => candidate !== title && candidate.y >= rect[1] && candidate.bottom <= rect[3]
      ).length
    )
      return []
    const intersecting = lines.filter(
      (line) =>
        line.text.trim() &&
        line.x < rect[2] &&
        line.right > rect[0] &&
        line.y < rect[3] &&
        line.bottom > rect[1]
    )
    if (
      !intersecting.length ||
      intersecting.some(
        (line) =>
          ![line.x, line.y, line.right, line.bottom, line.fontSize].every(Number.isFinite) ||
          line.right <= line.x ||
          line.bottom <= line.y ||
          line.x < rect[0] ||
          line.right > rect[2] ||
          line.y < rect[1] ||
          line.bottom > rect[3]
      )
    )
      return []
    const body = lines
      .filter(
        (line) =>
          // Quantized divider paint can overlap the input font's ascender;
          // require its baseline region to start below the divider itself.
          line.y > divider[1] + title.fontSize * 0.2 &&
          line.bottom <= bottom[1] + title.fontSize * 0.2 &&
          line.x >= rect[0] &&
          line.right <= rect[2]
      )
      .sort((a, b) => a.y - b.y || a.x - b.x)
    const input = body[0]
    if (
      !input ||
      !/^input\b/i.test(input.text.trim()) ||
      input.x - rect[0] > title.fontSize * 1.2 ||
      /:/.test(input.text)
    )
      return []
    const assignments = body.filter((line) =>
      /^(?:where\s+)?[\p{L}][\p{L}\d_']*(?:\s*[\p{S}\p{M}*⋆])*\s*←/u.test(line.text.trim())
    )
    const continuations = body.filter((line) => /^←/.test(line.text.trim()))
    const primary = assignments.filter((line) => !/^where\s+/i.test(line.text.trim()))
    const subordinate = assignments.filter((line) => /^where\s+/i.test(line.text.trim()))
    const returns = body.filter((line) => /^return\b/i.test(line.text.trim()))
    if (
      primary.length < 2 ||
      primary.length > 8 ||
      subordinate.length > 1 ||
      returns.length !== 1 ||
      assignments.some((line) => line.y >= returns[0].y) ||
      primary.some(
        (line, index) => index > 0 && Math.abs(line.x - primary[index - 1].x) > title.fontSize * 0.3
      ) ||
      returns[0].x - primary[0].x > title.fontSize * 0.3 ||
      primary[0].y <= input.bottom ||
      returns[0].y <= primary.at(-1).bottom
    )
      return []
    if (
      continuations.some(
        (line) =>
          !assignments.some(
            (owner) =>
              owner.y < line.y &&
              line.y - owner.y <= title.fontSize * 1.8 &&
              line.x >= owner.x &&
              line.x - owner.x <= title.fontSize * 2.5
          )
      )
    )
      return []
    const allowed = new Set([input, ...assignments, ...continuations, ...returns])
    const fragments = body.filter((line) => !allowed.has(line))
    if (
      fragments.some(
        (line) =>
          !assignments.some(
            (owner) =>
              line.y >= owner.y - title.fontSize * 0.8 &&
              line.bottom <= owner.bottom + title.fontSize * 0.8 &&
              line.fontSize <= owner.fontSize &&
              (line.x >= owner.x - title.fontSize * 0.5 ||
                Math.abs(line.y - owner.y) <= title.fontSize * 0.3)
          )
      )
    )
      return []
    return [
      {
        caption: {
          page: page.pageNumber,
          lines: [title.text],
          rect: [title.x, title.y, title.right, title.bottom]
        },
        rect
      }
    ]
  })
  return frames.length === 1 ? frames : []
}

// Explicit numbered closures are a separate grammar from the input/return forms.
// The ordinal gutter stays fixed even when the statements themselves are nested.
function hasClosedNumberedBody(page, title, titles, lines, aligned, top, bottom, ordinals) {
  if (
    ordinals.length < 4 ||
    ordinals.some(
      (line, n) =>
        Number(line.text.match(/^(\d+)\s*:/)[1]) !== n + 1 || (n && line.y <= ordinals[n - 1].y)
    )
  )
    return false
  const gutter = new Map()
  for (const line of ordinals) {
    // Two-digit labels can extend left of one-digit labels. Compare like-width
    // ordinal labels, without estimating their glyph widths from a string ratio.
    const digits = line.text.match(/^\d+/)[0].length
    if (gutter.has(digits) && Math.abs(line.x - gutter.get(digits)) > line.fontSize * 0.2)
      return false
    gutter.set(digits, line.x)
  }
  const dividers = aligned.filter(
    (rule) =>
      rule !== top &&
      rule !== bottom &&
      rule[1] > title.bottom &&
      rule[1] < ordinals[0].bottom &&
      Math.abs(rule[2] - bottom[2]) <= 8
  )
  if (dividers.length !== 1) return false
  const rect = [top[0] - 2, Math.min(top[1], title.y) - 2, top[2] + 2, bottom[3] + 2]
  if (
    titles.some(
      (other) =>
        other !== title &&
        other.x < rect[2] &&
        other.right > rect[0] &&
        other.y < rect[3] &&
        other.bottom > rect[1]
    )
  )
    return false
  if (
    page.lines.some(
      (line) =>
        line.text.trim() &&
        line.x < rect[2] &&
        line.x + line.width > rect[0] &&
        line.y < rect[3] &&
        line.y + line.height > rect[1] &&
        (line.x < rect[0] ||
          line.x + line.width > rect[2] ||
          line.y < rect[1] ||
          line.y + line.height > rect[3])
    )
  )
    return false
  const body = lines.filter(
    (line) =>
      line.y > title.bottom && line.y < bottom[3] && line.x >= rect[0] && line.right <= rect[2]
  )
  // Detached scripts and math fragments retain their native pixels. A separate
  // unnumbered paragraph is not evidence for a numbered step merely by proximity.
  if (
    body.some(
      (line) =>
        !ordinals.includes(line) &&
        (!ordinals.some((step) => line.y < step.bottom && line.bottom > step.y) ||
          (!/^▷/.test(line.text) && /\p{L}{3,}\s+\p{L}{3,}\s+\p{L}{3,}/u.test(line.text)))
    )
  )
    return false
  const stack = []
  let loops = 0
  for (const line of ordinals) {
    const text = line.text
      .replace(/^\d+\s*:\s*/, '')
      .split('▷')[0]
      .trim()
    const open = /^(for|while)\b.+\bdo$/i.exec(text) ?? /^(if)\b.+\bthen$/i.exec(text)
    if (open) {
      stack.push({ kind: open[1].toLowerCase(), body: false, alternate: false })
      continue
    }
    if (/^else$/i.test(text)) {
      const current = stack.at(-1)
      if (current?.kind !== 'if' || !current.body || current.alternate) return false
      current.alternate = true
      current.body = false
      continue
    }
    const close = /^end\s+(for|while|if)$/i.exec(text)
    if (close) {
      const current = stack.pop()
      if (!current?.body || current.kind !== close[1].toLowerCase()) return false
      if (current.kind !== 'if') loops++
      if (stack.length) stack.at(-1).body = true
      continue
    }
    if (!text || /^(?:for|while|if|else|end)\b/i.test(text)) return false
    if (stack.length) stack.at(-1).body = true
  }
  return loops > 0 && stack.length === 0
}

// Complete labelled native rules own the pseudocode; keep its original image.
export function findAlgorithmCandidates(page, nativeRules = []) {
  const lines = groupPageLines(page)
  const titles = lines.filter((line) => /^Algorithm\s+(?:[A-Z]\.)?\d+\b/i.test(line.text))
  const rules = (page.graphicsBounds ?? [])
    .filter((graphic) => graphic.kind === 'path')
    .map((graphic) => graphic.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
    .filter((r) => r[3] - r[1] <= page.height / 64 && r[2] - r[0] > (r[3] - r[1]) * 15)
  // Existing exact operator rules avoid letting a quantized closing band
  // borrow the independent footer. Legacy branches retain their own bounds.
  const insetRules = nativeRules.length
    ? nativeRules.filter(
        (r) => r.length === 4 && r.every(Number.isFinite) && r[1] === r[3] && r[2] > r[0]
      )
    : rules
  return titles.flatMap((title) => {
    const inset = findInsetDotProcedure(page, title, titles, lines, insetRules)
    if (inset.length) return inset
    const straightLine = findStraightLineProcedure(page, title, titles, lines, insetRules)
    if (straightLine.length) return straightLine
    const aligned = rules.filter((r) => Math.abs(r[0] - title.x) <= 8 && r[2] >= title.right - 4)
    const top = aligned
      .filter((r) => Math.abs(r[1] - title.y) <= title.fontSize)
      .sort((a, b) => Math.abs(a[1] - title.y) - Math.abs(b[1] - title.y))[0]
    if (!top) return []
    const nextTitle = titles.find((line) => line.y > title.y && Math.abs(line.x - title.x) <= 8)
    const bottom = aligned
      .filter(
        (r) =>
          r[1] > title.bottom + title.fontSize * 4 &&
          r[1] < (nextTitle?.y ?? page.height) &&
          Math.abs(r[2] - top[2]) <= 8
      )
      .sort((a, b) => a[1] - b[1])[0]
    if (!bottom) return []
    const content = lines.filter(
      (line) =>
        line.y > title.y &&
        line.bottom <= bottom[3] &&
        line.x >= top[0] - 4 &&
        line.right <= top[2] + 4
    )
    const io = content.some((line) => /^(?:Require|Ensure|Inputs?|Outputs?)\s*:/i.test(line.text))
    const ordinals = content.filter((line) => /^\d+\s*:/.test(line.text))
    const controls = content.filter(
      (line) =>
        /^(?:for|if|while)\b/i.test(line.text) &&
        // Native math can split a statement before an inline "for" quantifier.
        // A control begins its own baseline; a preceding same-font fragment
        // on that baseline owns the trailing phrase as statement content.
        !content.some(
          (other) =>
            other !== line &&
            other.right <= line.x &&
            Math.abs(other.y - line.y) <= line.fontSize * 0.2 &&
            Math.abs(other.fontSize - line.fontSize) <= line.fontSize * 0.15
        )
    )
    const closes = content.filter((line) => /^end\s+(?:for|if|while)\b/i.test(line.text))
    // A labelled native frame can use indented loop controls instead of line
    // numbers. Require both the input/output anchor and matching closures.
    const closedLoop = controls.some(
      (line) =>
        /^(?:for|while)\b/i.test(line.text) &&
        closes.some(
          (close) =>
            close.y > line.y &&
            Math.abs(close.x - line.x) <= line.fontSize * 0.2 &&
            close.text.match(/^end\s+(for|if|while)\b/i)[1].toLowerCase() ===
              line.text.match(/^(for|if|while)\b/i)[1].toLowerCase()
        )
    )
    const loops =
      io &&
      closedLoop &&
      controls.length >= 2 &&
      controls.every((line) => {
        const kind = line.text.match(/^(for|if|while)\b/i)[1].toLowerCase()
        const explicit = closes.some(
          (close) =>
            close.y > line.y &&
            Math.abs(close.x - line.x) <= line.fontSize * 0.2 &&
            close.text.match(/^end\s+(for|if|while)\b/i)[1].toLowerCase() === kind
        )
        if (explicit) return true
        // An indented conditional may close by dedenting inside its explicitly
        // closed loop. Both a real body and subsequent dedent are required.
        if (kind !== 'if') return false
        const following = content.filter(
          (other) => other.y > line.y && other.fontSize >= line.fontSize * 0.85
        )
        const first = following[0]
        return (
          first?.x >= line.x + line.fontSize * 0.5 &&
          following.some((other) => other.y > first.y && other.x <= line.x + line.fontSize * 0.2)
        )
      })
    const steps = content.filter((line) => /^Step\s+\d+\s*:/i.test(line.text))
    // Explicit consecutive Step headings with initialization/termination are
    // another source form. Ordinary numbered paragraphs and Listing stay out.
    const headed =
      steps.length >= 2 &&
      steps.every(
        (line, index) =>
          Number(line.text.match(/^Step\s+(\d+)\s*:/i)[1]) === index + 1 &&
          Math.abs(line.x - steps[0].x) <= line.fontSize * 0.2
      ) &&
      content.some((line) => /^(?:Initialization\s*:|Stop if\b|Otherwise\b)/i.test(line.text))
    // A formally labelled routine can declare its parameters in a function
    // signature instead of Require/Input. Prove an ordered numbered body and
    // its terminating return; a boxed paragraph or a bare title is insufficient.
    const routine =
      ordinals.length >= 3 &&
      ordinals.every((line, index) => Number(line.text.match(/^(\d+)\s*:/)[1]) === index + 1) &&
      ordinals.some((line) => /^\d+\s*:\s*function\b/i.test(line.text)) &&
      ordinals.some((line) => /^\d+\s*:\s*return\b/i.test(line.text))
    // A short numbered loop can declare its inputs in the title and return
    // after assignment steps, without Require or explicit end-for lines.
    // Its separate title/body rule and complete consecutive body are required.
    const numberedLoop =
      /\([^()]+\)\s*$/.test(title.text) &&
      ordinals.length >= 4 &&
      ordinals.every(
        (line, index) =>
          Number(line.text.match(/^(\d+)\s*:/)[1]) === index + 1 &&
          Math.abs(line.x - ordinals[0].x) <= line.fontSize * 0.2
      ) &&
      /^1\s*:\s*(?:for|while)\b.+\bdo\s*$/i.test(ordinals[0].text) &&
      /^\d+\s*:\s*return\b/i.test(ordinals.at(-1).text) &&
      ordinals.slice(1, -1).every((line) => /←/.test(line.text)) &&
      aligned.some(
        (rule) =>
          rule !== top &&
          rule[1] > title.bottom &&
          rule[1] < ordinals[0].bottom &&
          Math.abs(rule[2] - bottom[2]) <= 8
      )
    if (
      !(io && ordinals.length >= 2) &&
      !loops &&
      !headed &&
      !routine &&
      !numberedLoop &&
      !hasClosedNumberedBody(page, title, titles, lines, aligned, top, bottom, ordinals)
    )
      return []
    const titleTails = content.filter(
      (l) =>
        /[-–]$/.test(title.text) &&
        /^[a-z]/.test(l.text) &&
        Math.abs(l.x - title.x) <= 0.1 &&
        Math.abs(l.fontSize - title.fontSize) <= 0.1 &&
        l.y - title.y <= title.fontSize * 1.6 &&
        l.right <= title.right &&
        !/:/.test(l.text)
    )
    const titleLines = titleTails.length === 1 ? [title, titleTails[0]] : [title]
    return [
      {
        caption: {
          page: page.pageNumber,
          lines: titleLines.map((l) => l.text),
          rect: [title.x, title.y, title.right, titleLines.at(-1).bottom]
        },
        rect: [
          Math.max(0, top[0] - 2),
          Math.max(0, Math.min(top[1], title.y) - 2),
          Math.min(page.width, top[2] + 2),
          Math.min(page.height, bottom[3] + 2)
        ]
      }
    ]
  })
}
