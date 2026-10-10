/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { recoverClosedCellGrid } from './literature-pdf-ruled-column-grid.mjs'

const sameSet = (items, set) => set?.size === items.length && items.every((i) => set.has(i))
const plain = (runs) =>
  runs
    .map((r) => r.text)
    .join('')
    .replace(/\s/gu, '')
const finiteToken = (i) =>
  Number.isFinite(i.baseline) &&
  Number.isFinite(i.height) &&
  i.height > 0 &&
  i.rect?.length === 4 &&
  i.rect.every(Number.isFinite) &&
  i.rect[0] < i.rect[2] &&
  i.rect[1] < i.rect[3]
function physicalOwner(grid, item) {
  const x = (item.rect[0] + item.rect[2]) / 2,
    y = (item.rect[1] + item.rect[3]) / 2,
    rows = grid.rows.flatMap((r, n) => (y >= r[1] && y < r[3] ? [n] : [])),
    columns = grid.columns.flatMap((c, n) => (x >= c[0] && x < c[2] ? [n] : []))
  return rows.length === 1 && columns.length === 1 ? `${rows[0]}:${columns[0]}` : undefined
}

// A complete native closed grid establishes the physical owner independently
// of model cells. Observations contain original showText glyphs and advances.
export function proveNativeClosedMathOrder(table, tokens, captions, rules, observedRuns = []) {
  if (
    tokens.some((i) => !finiteToken(i)) ||
    rules.some((r) => r.length !== 4 || !r.every(Number.isFinite))
  )
    return
  const grid = recoverClosedCellGrid(table, tokens, captions, rules)
  if (!grid?.ownedTokens) return
  const cells = new Map()
  for (const token of grid.ownedTokens) {
    const owner = physicalOwner(grid, token)
    if (!owner) return
    if (!cells.has(owner)) cells.set(owner, [])
    cells.get(owner).push(token)
  }
  const delimiters = [],
    scriptPairs = []
  for (const run of observedRuns) {
    if (
      !run.rect?.every(Number.isFinite) ||
      run.gaps?.some(
        (g) => !Number.isFinite(g.left) || !Number.isFinite(g.right) || g.left >= g.right
      )
    )
      continue
    if (
      !/^\(\s*\)$/.test(run.text) ||
      run.gaps?.length !== 1 ||
      new Set(run.glyphRuns).size !== 1 ||
      run.literalGlyphs?.join('') !== '()'
    )
      continue
    const parents = tokens.filter(
      (t) =>
        grid.ownedTokens.has(t) &&
        t.text === run.text &&
        t.rect.every((v, n) => Math.abs(v - run.rect[n]) < 1e-8)
    )
    if (parents.length !== 1) continue
    const parent = parents[0],
      own = cells.get(physicalOwner(grid, parent)),
      gap = run.gaps[0],
      inner = own.filter(
        (t) =>
          t !== parent &&
          t.horizontal &&
          /^\p{L}$/u.test(t.text) &&
          t.rect[0] >= gap.left &&
          t.rect[2] <= gap.right &&
          Math.abs(t.baseline - parent.baseline) <= t.height * 0.1
      )
    if (inner.length !== 1) continue
    delimiters.push({
      parent,
      inner: inner[0],
      gap,
      tokens: new Set(own),
      nativeLiteralGlyphs: true
    })
  }
  for (const own of cells.values()) {
    if (own.length !== 2) continue
    const sorted = [...own].sort((a, b) => b.height - a.height),
      [base, script] = sorted,
      gap = (script.rect[0] - base.rect[2]) / base.height,
      rise = (base.baseline - script.baseline) / base.height,
      ratio = script.height / base.height
    if (
      !base.horizontal ||
      !script.horizontal ||
      !/^\d$/.test(base.text) ||
      !/^\p{L}$/u.test(script.text) ||
      gap < 0.35 ||
      gap > 0.45 ||
      rise < 0.2 ||
      rise > 0.5 ||
      ratio < 0.55 ||
      ratio > 0.75
    )
      continue
    scriptPairs.push({ base, script, tokens: new Set(own) })
  }
  return delimiters.length || scriptPairs.length
    ? { ownedTokens: grid.ownedTokens, delimiters, scriptPairs }
    : undefined
}

// Render only an exact source-owner set; assignments, sourceRects and crops stay
// unchanged. Literal character balance prevents any inferred math character.
export function recoverNativeClosedMathRuns(items, runs, proof) {
  if (!proof || !items.every((i) => finiteToken(i) && proof.ownedTokens?.has(i))) return
  const scripted = proof.scriptPairs?.filter((p) => sameSet(items, p.tokens)) ?? []
  if (scripted.length === 1) {
    const { base, script } = scripted[0],
      gap = (script.rect[0] - base.rect[2]) / base.height,
      rise = (base.baseline - script.baseline) / base.height,
      ratio = script.height / base.height
    if (
      items.length !== 2 ||
      !/^\d$/.test(base.text) ||
      !/^\p{L}$/u.test(script.text) ||
      !items.includes(base) ||
      !items.includes(script) ||
      !base.horizontal ||
      !script.horizontal ||
      gap < 0.35 ||
      gap > 0.45 ||
      rise < 0.2 ||
      rise > 0.5 ||
      ratio < 0.55 ||
      ratio > 0.75 ||
      plain(runs).split('').sort().join('') !==
        [base.text, script.text].join('').split('').sort().join('')
    )
      return
    return [
      { text: base.text, position: 'normal' },
      { text: script.text, position: 'superscript' }
    ]
  }
  if (scripted.length) return
  const pairs = proof.delimiters?.filter((p) => sameSet(items, p.tokens)) ?? []
  if (pairs.length !== 1) return
  const p = pairs[0],
    { parent, inner, gap } = p
  if (
    !p.nativeLiteralGlyphs ||
    !Number.isFinite(gap.left) ||
    !Number.isFinite(gap.right) ||
    gap.left >= gap.right ||
    !parent.horizontal ||
    !inner.horizontal ||
    !(parent.height > 0) ||
    inner.height / parent.height < 0.6 ||
    inner.height / parent.height > 1 ||
    !/^\(\s*\)$/.test(parent.text) ||
    !/^\p{L}$/u.test(inner.text) ||
    !items.includes(parent) ||
    !items.includes(inner) ||
    inner.rect[0] < gap.left ||
    inner.rect[2] > gap.right ||
    Math.abs(inner.baseline - parent.baseline) > inner.height * 0.1 ||
    items.some(
      (i) =>
        i !== parent &&
        i !== inner &&
        i.rect[0] < gap.right &&
        i.rect[2] > gap.left &&
        i.rect[1] < parent.rect[3] &&
        i.rect[3] > parent.rect[1]
    )
  )
    return
  const needle = new RegExp('\\(\\s*\\)\\s*' + inner.text, 'gu'),
    matches = runs.flatMap((r, n) =>
      r.position === 'normal' ? [...r.text.matchAll(needle)].map((m) => ({ n, m })) : []
    )
  if (matches.length !== 1) return
  const { n, m } = matches[0],
    next = runs.map((r) => ({ ...r }))
  next[n].text =
    next[n].text.slice(0, m.index) +
    '(' +
    inner.text +
    ')' +
    next[n].text.slice(m.index + m[0].length)
  if (plain(next).split('').sort().join('') !== plain(runs).split('').sort().join('')) return
  return next
}
