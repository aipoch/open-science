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
    const controls = content.filter((line) => /^(?:for|if|while)\b/i.test(line.text))
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
    if (!(io && ordinals.length >= 2) && !loops && !headed && !routine && !numberedLoop) return []
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
