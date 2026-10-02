/* eslint-disable @typescript-eslint/explicit-function-return-type */
const valid = (item) =>
  item.horizontal &&
  item.rect?.length === 4 &&
  item.rect.every(Number.isFinite) &&
  item.rect[2] > item.rect[0] &&
  item.rect[3] > item.rect[1] &&
  Number.isFinite(item.height) &&
  item.height > 0 &&
  Number.isFinite(item.baseline)
const overlap = (a, b) =>
  Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
  Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
const sameEdge = (a, b) => Math.abs(a[0] - b[0]) < 0.1 && Math.abs(a[2] - b[2]) < 0.1
const tableCaption = (caption) => /^Table\s+\d+[.: ]/i.test(caption.lines?.[0] ?? '')

function captionProof(items, captions, rules, bounds, fused = false) {
  const candidates = []
  for (const caption of captions.filter(tableCaption)) {
    const ems = items
      .filter(
        (i) =>
          valid(i) &&
          i.rect[1] >= caption.rect[1] &&
          i.rect[1] <= caption.rect[1] + i.height * 0.1 &&
          overlap(i.rect, caption.rect) > 0
      )
      .map((i) => i.height)
      .sort((a, b) => a - b)
    const em = ems[Math.floor(ems.length / 2)]
    if (!(em > 0)) continue
    const full = rules.filter(
      (r) =>
        r.length === 4 &&
        r.every(Number.isFinite) &&
        r[1] === r[3] &&
        r[2] - r[0] >= (bounds[2] - bounds[0]) * 0.95 &&
        Math.abs(r[0] - bounds[0]) <= em &&
        Math.abs(r[2] - bounds[2]) <= em
    )
    const endings = full.filter(
      (r) =>
        r[1] < caption.rect[1] &&
        caption.rect[1] - r[1] <= em * 0.2 &&
        Math.abs(r[1] - bounds[3]) <= em * 2
    )
    if (endings.length !== 1) continue
    const closing = endings[0]
    const ink = items.filter(
      (i) =>
        valid(i) &&
        i.rect[0] >= closing[0] - 0.01 &&
        i.rect[2] <= closing[2] + 0.01 &&
        i.rect[3] <= closing[1] &&
        i.rect[1] >= bounds[1]
    )
    if (!ink.length) continue
    const first = Math.min(...ink.map((i) => i.rect[1]))
    const openings = full.filter(
      (r) => sameEdge(r, closing) && r[1] <= first && first - r[1] < em && r[1] >= bounds[1] - em
    )
    if (openings.length !== 1) continue
    const opening = openings[0]
    if (
      full.filter((r) => sameEdge(r, closing) && r[1] > opening[1] && r[1] < closing[1]).length !==
      1
    )
      continue
    const frame = [closing[0], opening[1], closing[2], closing[1]]
    const body = items.filter((i) => overlap(i.rect, frame) > 0)
    const scope = items.filter(
      (i) =>
        valid(i) &&
        i.rect[0] >= caption.rect[0] - 0.01 &&
        i.rect[2] <= caption.rect[2] + 0.01 &&
        i.rect[1] >= caption.rect[1] - em * 0.3 &&
        i.rect[3] <= caption.rect[3] + 0.01
    )
    const pairs = []
    for (const hat of scope.filter((i) => i.text === 'ˆ')) {
      const owners = scope.filter(
        (base) =>
          base !== hat &&
          (fused
            ? /^\p{L}\p{Ll}(?:\([^)]{1,12}\))?[,\s.]/u.test(base.text)
            : /^\p{L}$/u.test(base.text)) &&
          Math.abs(base.height - hat.height) <= em * 0.15 &&
          (base.baseline - hat.baseline) / em >= 0.15 &&
          (base.baseline - hat.baseline) / em <= 0.35 &&
          (hat.rect[0] + hat.rect[2]) / 2 >= base.rect[0] &&
          (hat.rect[0] + hat.rect[2]) / 2 <= (fused ? base.rect[0] + em : base.rect[2]) &&
          hat.rect[2] - hat.rect[0] < em * 0.7
      )
      if (owners.length !== 1) return
      pairs.push({ hat, base: owners[0] })
    }
    const crossed = pairs.filter(
      ({ hat, base }) =>
        hat.rect[1] < closing[1] &&
        hat.rect[3] > closing[1] &&
        base.rect[1] >= closing[1] &&
        hat.rect[1] >= closing[1] - em * 0.25 &&
        hat.baseline > closing[1] + em * 0.5
    )
    if (
      crossed.length < 3 ||
      new Set(pairs.map((p) => p.base)).size !== pairs.length ||
      crossed.some((p) => Math.abs(p.base.baseline - crossed[0].base.baseline) > em * 0.01)
    )
      continue
    const excluded = new Set(crossed.map((p) => p.hat))
    const bodyTokens = body.filter((i) => !excluded.has(i))
    if (
      bodyTokens.some(
        (i) =>
          !valid(i) ||
          i.rect[1] < opening[1] ||
          i.rect[3] > closing[1] ||
          i.rect[0] < closing[0] - 0.01 ||
          i.rect[2] > closing[2] + 0.01
      ) ||
      new Set(bodyTokens.map((i) => i.rect.join(','))).size !== bodyTokens.length ||
      new Set(bodyTokens.map((i) => Math.round(i.baseline / em))).size < 4
    )
      continue
    if (
      items.some(
        (i) =>
          !excluded.has(i) &&
          i.rect[0] < closing[2] &&
          i.rect[2] > closing[0] &&
          i.rect[1] < closing[1] &&
          i.rect[3] > closing[1]
      )
    )
      continue
    candidates.push({
      caption,
      tokens: excluded,
      closing,
      bodyTokens: new Set(bodyTokens),
      pairs,
      scope
    })
  }
  return candidates.length === 1 ? candidates[0] : undefined
}

// Coordinates are source viewport units (the caller uses scale 1.5). Only the
// original caption-owned hat objects are excluded; table source/crops stay intact.
export function proveNativeCaptionRaisedGlyphOwnership(table, tokens, captions, rules) {
  if (!table.cropRect?.every(Number.isFinite)) return
  return captionProof(tokens, captions, rules, table.cropRect)
}

// Caption geometry is viewport scale 1. Keep its original rectangle above the
// native closing rule: accent font boxes remain private ownership evidence.
export function recoverNativeRaisedCaptionFragments(page, caption, rules) {
  const items = page.lines.map((line) => ({
    text: line.text,
    rect: [line.x, line.y, line.x + line.width, line.y + line.height],
    baseline: line.y + line.fontSize,
    height: line.fontSize,
    horizontal: true,
    line
  }))
  const closing = rules.filter(
    (r) =>
      r[1] === r[3] &&
      r[1] < caption.rect[1] &&
      caption.rect[1] - r[1] < (caption.rect[3] - caption.rect[1]) * 0.1 &&
      r[0] <= caption.rect[0] &&
      r[2] >= caption.rect[2]
  )
  if (closing.length !== 1) return
  const preceding = rules
    .filter((r) => r[1] === r[3] && sameEdge(r, closing[0]) && r[1] < closing[0][1])
    .sort((a, b) => b[1] - a[1])
  if (preceding.length < 2) return
  const proof = captionProof(
    items,
    [caption],
    rules,
    [closing[0][0], preceding[1][1], closing[0][2], closing[0][1]],
    true
  )
  if (!proof) return
  const hats = new Set(proof.pairs.map((p) => p.hat))
  return proof.scope
    .filter((i) => !hats.has(i))
    .map((item) => {
      const pair = proof.pairs.find((p) => p.base === item)
      return pair ? { ...item.line, text: pair.hat.text + item.line.text } : item.line
    })
}
