/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  nativePageTextPacketInventory,
  createNativeFigurePaintCertificate,
  nativeFigurePaintCertificateData
} from './literature-pdf-figure-native-plot-labels.mjs'
import {
  retainNativeRecoveryInputs,
  nativeRecoveryOwnValues
} from './literature-pdf-native-figure-recovery-profile.mjs'

import { collectTableRules } from './literature-pdf-graphics.mjs'
import { nativeCompleteRuledRecordPaintCrop } from './literature-pdf-native-leaf-record-repair.mjs'

const witnesses = new WeakMap()

// This private certificate only distinguishes complete ruled paint from its
// worst-case miter envelope for the tuple withdrawal below. It grants no Source.
function nativeTuplePaintDisjoint(w, paint, box, scale) {
  const overlap = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
  if (
    !paint.pieces.some(
      (p) =>
        p.kind !== 'glyph' &&
        overlap(
          p.rect.map((v) => v * scale),
          box
        )
    )
  )
    return true
  if (!w.ruledTuplePaint) {
    const viewport = w.context.viewport,
      frame = [0, 0, viewport.width, viewport.height],
      bounds = new Map(),
      rules = collectTableRules(w.context.operators, viewport, bounds),
      graphics = [],
      identities = []
    for (const g of w.context.graphicsBounds) {
      if (g.kind !== 'path' || !Array.isArray(g.normalizedRect) || g.normalizedRect.length !== 4)
        return false
      const rect = g.normalizedRect.map((v, n) => v * (n % 2 ? viewport.height : viewport.width))
      graphics.push({ kind: g.kind, rect })
      identities.push({ kind: g.kind, rect, operationIndex: g.operationIndex })
    }
    const context = {
      ...w.context,
      rulePaintBounds: bounds,
      nativeEvidenceGraphics: graphics,
      nativePaintIdentityGraphics: identities
    }
    // Use the complete native packet's own advance bounds. Transport tokens may
    // have crossed an exact scale conversion; no Source or token is rewritten.
    const owned = w.packet.records.map(({ r, rect }) => ({ text: r.str, rect }))
    const full = nativeCompleteRuledRecordPaintCrop(frame, rules, rules, context, owned),
      boxes = rules.map((r) => bounds.get(r.join(',')))
    if (!full || full.some((v, n) => v !== frame[n]) || !w.unchanged()) return false
    const current = retainNativeRecoveryInputs([rules, graphics, identities, boxes])
    if (!current) return false
    w.ruledTuplePaint = { boxes, current }
  }
  const proof = w.ruledTuplePaint
  return (
    proof.current() &&
    w.unchanged() &&
    !proof.boxes.some((r) =>
      overlap(
        r.map((v) => v * scale),
        box
      )
    )
  )
}

export function createNativeTableFontRoleWitness(page, tokens, context) {
  try {
    const own = nativeRecoveryOwnValues(context)
    if (!own) return
    const unchanged = retainNativeRecoveryInputs([page, tokens, context], own.viewport)
    if (!unchanged) return
    const packet = nativePageTextPacketInventory(page, tokens, context, true)
    const paint = createNativeFigurePaintCertificate(page, tokens, context),
      paintData = nativeFigurePaintCertificateData(paint, page, tokens, context)
    if (!packet || !paintData || !unchanged()) return
    const witness = Object.freeze({})
    witnesses.set(witness, { page, tokens, context, packet, paint, unchanged })
    return witness
  } catch {
    return
  }
}
export function nativeTableFontRoleWitnessCurrent(witness) {
  try {
    const w = witnesses.get(witness)
    return (
      !!w &&
      w.unchanged() === true &&
      !!nativeFigurePaintCertificateData(w.paint, w.page, w.tokens, w.context)
    )
  } catch {
    return false
  }
}

// This optional packet can only withdraw a model grid. It does not authorize
// cells, repair spans, change Source, or reuse a partial native text packet.
export function hasNativeFontRoleSections(proof, table, inventory, all, witness) {
  try {
    if (
      !all ||
      !nativeTableFontRoleWitnessCurrent(witness) ||
      table.grid.length < 6 ||
      table.grid[0].length < 3
    )
      return false
    const w = witnesses.get(witness),
      records = w.packet.records,
      byFont = new Map()
    let scale
    for (const f of all) {
      const s = f.sourceItem
      const matches = records.filter(
        (n) =>
          n.r.sourceItem?.pageNumber === s?.pageNumber &&
          n.r.sourceItem?.index === s?.index &&
          n.r.sourceItem?.text === s?.text &&
          n.r.str === f.text
      )
      if (matches.length !== 1 || s.text !== f.text) return false
      const n = matches[0],
        ratio = (f.rect[2] - f.rect[0]) / (n.rect[2] - n.rect[0])
      if (!Number.isFinite(ratio) || ratio <= 0) return false
      if (scale === undefined) scale = ratio
      if (
        Math.abs(ratio - scale) > scale * 0.00001 ||
        f.rect.some((v, i) => Math.abs(v - n.rect[i] * scale) > 0.02) ||
        Math.abs(f.height - n.r.height * scale) > 0.02
      )
        return false
      byFont.set(f, n.r.fontName)
    }
    const owners = proof.proved,
      cols = table.grid[0].length,
      slot = (r, c) => owners.find((p) => p.cell.row === r && p.cell.column === c),
      right = (r) =>
        owners.filter((p) => p.cell.row === r && p.cell.column > 0).flatMap((p) => p.fonts)
    if (
      table.cells.some(
        (c) => c.rowSpan !== 1 || (c.colSpan !== 1 && !(c.column === 0 && c.colSpan === cols))
      )
    )
      return false
    const sparse = owners.filter(
      (p) =>
        p.cell.column === 0 &&
        p.cell.row > 0 &&
        p.cell.row + 1 < table.grid.length &&
        p.fonts.length === 1 &&
        right(p.cell.row).length === 0
    )
    const anchors = []
    for (const p of sparse) {
      const f = p.fonts[0],
        next = slot(p.cell.row + 1, 0),
        peers = right(p.cell.row + 1)
      if (!next || !peers.length || !next.fonts.length) continue
      const body = next.fonts
        .filter((g) => Math.abs(g.height - f.height) < f.height * 0.01)
        .sort((a, b) => a.baseline - b.baseline)[0]
      if (!body || byFont.get(body) === byFont.get(f)) continue
      const gap = body.baseline - f.baseline
      if (
        gap < f.height * 1.1 ||
        gap > f.height * 2 ||
        Math.abs(body.rect[0] - f.rect[0]) > f.height * 0.01
      )
        continue
      const preceding = slot(p.cell.row - 1, 0)?.fonts.filter(
        (g) => byFont.get(g) === byFont.get(body) && Math.abs(g.height - f.height) < f.height * 0.01
      )
      anchors.push({
        f,
        body,
        gap,
        face: byFont.get(f),
        bodyFace: byFont.get(body),
        cell: p.cell,
        before: preceding?.length
          ? f.baseline - Math.max(...preceding.map((g) => g.baseline))
          : null
      })
    }
    // Two already independent full-width section roles can prove a single
    // swallowed terminal heading. Both neighbouring body gaps must repeat;
    // an isolated italic word or a wrapped line supplies no such template.
    const templatePaint = nativeFigurePaintCertificateData(w.paint, w.page, w.tokens, w.context)
    const independentTemplate = (a) => {
      const band = [table.cropRect[0], a.f.rect[1], table.cropRect[2], a.f.rect[3]]
      return (
        templatePaint &&
        !inventory.some(
          (f) =>
            f !== a.f &&
            f.text?.trim() &&
            f.rect[0] < band[2] &&
            f.rect[2] > band[0] &&
            f.rect[1] < band[3] &&
            f.rect[3] > band[1]
        ) &&
        nativeTuplePaintDisjoint(w, templatePaint, band, scale)
      )
    }
    const templates = anchors.filter(
      (a) =>
        a.cell.colSpan === cols &&
        a.before > 0 &&
        independentTemplate(a) &&
        anchors.some(
          (b) =>
            b !== a &&
            b.cell.colSpan === cols &&
            b.face === a.face &&
            b.bodyFace === a.bodyFace &&
            Math.abs(b.f.height - a.f.height) < a.f.height * 0.01 &&
            Math.abs(b.f.rect[0] - a.f.rect[0]) < a.f.height * 0.01 &&
            Math.abs(b.gap - a.gap) < a.f.height * 0.01 &&
            Math.abs(b.before - a.before) < a.f.height * 0.01
        )
    )
    const terminal = anchors.length !== 1
    if (
      terminal &&
      (templates.length < 2 ||
        templates.some(
          (b) =>
            b.face !== templates[0].face ||
            b.bodyFace !== templates[0].bodyFace ||
            Math.abs(b.gap - templates[0].gap) > b.f.height * 0.01 ||
            Math.abs(b.before - templates[0].before) > b.f.height * 0.01
        ))
    )
      return false
    const a = terminal ? templates[0] : anchors[0],
      h = a.f.height,
      matches = []
    for (const p of owners.filter(
      (p) =>
        p.cell.column === 0 &&
        p.cell.row > 0 &&
        p.cell.row + 1 < table.grid.length &&
        p.fonts.length > 1
    )) {
      const fs = [...p.fonts].sort((x, y) => x.baseline - y.baseline || x.rect[0] - y.rect[0]),
        tail = fs.at(-1),
        prior = fs.slice(0, -1),
        peers = right(p.cell.row),
        next = slot(p.cell.row + 1, 0),
        nextPeers = right(p.cell.row + 1)
      if (
        byFont.get(tail) !== a.face ||
        Math.abs(tail.height - h) > h * 0.01 ||
        Math.abs(tail.rect[0] - a.f.rect[0]) > h * 0.01 ||
        !prior.some((f) => byFont.get(f) === a.bodyFace) ||
        !peers.length ||
        !next?.fonts.length ||
        !nextPeers.length
      )
        continue
      if (
        terminal &&
        (p.cell.row + 2 !== table.grid.length ||
          Math.abs(
            tail.baseline -
              Math.max(
                ...prior.filter((f) => Math.abs(f.height - h) < h * 0.01).map((f) => f.baseline)
              ) -
              a.before
          ) >
            h * 0.01 ||
          owners
            .filter(
              (q) =>
                q.cell.column > 0 && (q.cell.row === p.cell.row || q.cell.row === p.cell.row + 1)
            )
            .some(
              (q) =>
                q.cell.colSpan !== 1 ||
                q.cell.rowSpan !== 1 ||
                !/^[\d,]+(?:[–−-][\d,]+)?$/u.test(q.cell.text)
            ))
      )
        continue
      // The distinct face occurs once, at the terminal native item. Other
      // same-face ink or a right-hand peer means emphasis/another real field.
      if (
        prior.some(
          (f) => byFont.get(f) === a.face && Math.abs(f.rect[0] - a.f.rect[0]) < h * 0.01
        ) ||
        [...prior, ...peers].some((f) => f.rect[3] > tail.rect[1] - h * 0.1)
      )
        continue
      const following = [...next.fonts].sort((x, y) => x.baseline - y.baseline)[0]
      if (
        byFont.get(following) !== a.bodyFace ||
        Math.abs(following.height - h) > h * 0.01 ||
        Math.abs(following.rect[0] - tail.rect[0]) > h * 0.01 ||
        Math.abs(following.baseline - tail.baseline - a.gap) > h * 0.01
      )
        continue
      const band = [table.cropRect[0], tail.rect[1], table.cropRect[2], tail.rect[3]]
      const paint = nativeFigurePaintCertificateData(w.paint, w.page, w.tokens, w.context)
      if (
        !paint ||
        paint.pieces.some(
          (p) =>
            p.kind !== 'glyph' &&
            p.rect[0] * scale < band[2] &&
            p.rect[2] * scale > band[0] &&
            p.rect[1] * scale < band[3] &&
            p.rect[3] * scale > band[1]
        )
      )
        continue
      if (
        inventory.some(
          (f) =>
            f !== tail &&
            f.text?.trim() &&
            f.rect[0] < band[2] &&
            f.rect[2] > band[0] &&
            f.rect[1] < band[3] &&
            f.rect[3] > band[1]
        )
      )
        continue
      matches.push(p)
    }
    return (
      (terminal ? matches.length === 1 : matches.length >= 2) &&
      nativeTableFontRoleWitnessCurrent(witness)
    )
  } catch {
    return false
  }
}

// Repeated category labels, each followed in the native stream by a distinct
// setting and its value, establish separate records rather than wrapped prose.
// Require two complete groups and every peer; only withdraw the model grid.
export function hasNativeRepeatedCategoryRecords(proof, table, inventory, all, witness) {
  try {
    if (
      !all ||
      !nativeTableFontRoleWitnessCurrent(witness) ||
      table.grid.length < 3 ||
      table.grid[0].length !== 3 ||
      table.cells.some((c) => c.rowSpan !== 1 || c.colSpan !== 1)
    )
      return false
    const w = witnesses.get(witness),
      native = new Map(),
      bound = new Map()
    for (const n of w.packet.records) {
      const key = n.r.sourceItem?.pageNumber + ':' + n.r.sourceItem?.index
      if (native.has(key)) return false
      native.set(key, n)
    }
    let scale
    for (const f of all) {
      const s = f.sourceItem,
        n = native.get(s?.pageNumber + ':' + s?.index)
      if (
        !n ||
        s.pageNumber !== w.context.pageNumber ||
        s.text !== f.text ||
        n.r.str !== f.text ||
        n.r.sourceItem.text !== f.text
      )
        return false
      const ratio = (f.rect[2] - f.rect[0]) / (n.rect[2] - n.rect[0])
      if (!Number.isFinite(ratio) || ratio <= 0) return false
      scale ??= ratio
      if (
        Math.abs(ratio - scale) > scale * 0.00001 ||
        f.rect.some((v, i) => Math.abs(v - n.rect[i] * scale) > 0.02) ||
        Math.abs(f.height - n.r.height * scale) > 0.02
      )
        return false
      bound.set(f, n)
    }
    const owners = proof.proved,
      slot = (r, c) => owners.find((p) => p.cell.row === r && p.cell.column === c),
      box = (fs) => [
        Math.min(...fs.map((f) => f.rect[0])),
        Math.min(...fs.map((f) => f.rect[1])),
        Math.max(...fs.map((f) => f.rect[2])),
        Math.max(...fs.map((f) => f.rect[3]))
      ],
      overlap = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
      paint = nativeFigurePaintCertificateData(w.paint, w.page, w.tokens, w.context)
    if (
      !paint ||
      owners.some(
        (p) =>
          p.cell.sourceItems?.length !== p.fonts.length ||
          p.cell.sourceRects?.length !== p.fonts.length ||
          p.fonts.some((f, index) => {
            const origin = p.cell.sourceItems[index],
              sourceRect = p.cell.sourceRects[index]
            return (
              origin.pageNumber !== f.sourceItem.pageNumber ||
              origin.index !== f.sourceItem.index ||
              origin.text !== f.text ||
              !Array.isArray(sourceRect) ||
              sourceRect.length !== 4 ||
              sourceRect.some((value, axis) => value !== f.rect[axis])
            )
          })
      ) ||
      ![0, 1, 2].every((c) => slot(0, c)?.fonts.length && /\p{L}{2}/u.test(slot(0, c).cell.text))
    )
      return false
    const groups = []
    for (let row = 1; row < table.grid.length; row++) {
      const ps = [0, 1, 2].map((c) => slot(row, c))
      if (ps.some((p) => !p?.fonts.length)) return false
      const component = ps.flatMap((p) => p.fonts),
        componentBox = box(component)
      if (
        inventory.some(
          (f) => f.text?.trim() && !component.includes(f) && overlap(f.rect, componentBox)
        )
      )
        return false
      const labels = [...ps[0].fonts].sort((a, b) => a.baseline - b.baseline),
        h = labels[0].height,
        face = bound.get(labels[0]).r.fontName
      if (
        labels.length < 3 ||
        !/^\p{L}[\p{L} -]*$/u.test(labels[0].text) ||
        labels.some(
          (f, n) =>
            f.text !== labels[0].text ||
            bound.get(f).r.fontName !== face ||
            Math.abs(f.height - h) > h * 0.001 ||
            Math.abs(f.rect[0] - labels[0].rect[0]) > h * 0.001 ||
            (n &&
              (f.baseline - labels[n - 1].baseline < h * 0.9 ||
                f.baseline - labels[n - 1].baseline > h * 2))
        )
      )
        return false
      const records = labels.map((f) => [[f], [], []])
      for (let c = 1; c < 3; c++)
        for (const f of ps[c].fonts) {
          const matches = labels.flatMap((l, n) =>
            Math.abs(f.baseline - l.baseline) < h * 0.65 ? [n] : []
          )
          if (matches.length !== 1) return false
          records[matches[0]][c].push(f)
        }
      const settings = []
      for (let n = 0; n < records.length; n++) {
        const lanes = records[n]
        if (
          lanes
            .slice(1)
            .some(
              (fs) =>
                !fs.length ||
                !fs.some(
                  (f) =>
                    Math.abs(f.height - h) < h * 0.001 &&
                    Math.abs(f.baseline - labels[n].baseline) < h * 0.001
                )
            )
        )
          return false
        lanes.forEach((fs) => fs.sort((a, b) => a.sourceItem.index - b.sourceItem.index))
        const stream = lanes.flat(),
          domain = box(stream)
        if (
          stream.some((f, i) => i && f.sourceItem.index <= stream[i - 1].sourceItem.index) ||
          (n + 1 < labels.length &&
            stream.at(-1).sourceItem.index >= labels[n + 1].sourceItem.index) ||
          lanes.some(
            (fs, c) =>
              c &&
              Math.min(...fs.map((f) => f.rect[0])) <=
                Math.max(...lanes[c - 1].map((f) => f.rect[2]))
          ) ||
          !nativeTuplePaintDisjoint(w, paint, domain, scale)
        )
          return false
        settings.push(JSON.stringify(lanes[1].map((f) => f.text)))
      }
      if (new Set(settings).size !== settings.length) return false
      groups.push(labels[0].text)
    }
    return new Set(groups).size >= 2 && nativeTableFontRoleWitnessCurrent(witness)
  } catch {
    return false
  }
}

// A complete additive expression is not a set of independent table values.
// Only withdraw a grid that actually splits one native operator from its operand;
// this does not rebuild the expression or assign any additional Source.
export function hasNativeContinuousPolynomialCut(proof, table, inventory, all, witness) {
  try {
    if (!all || table.caption || !nativeTableFontRoleWitnessCurrent(witness)) return false
    const rows = table.grid.length,
      columns = table.grid[0]?.length,
      owners = [...proof.proved].sort(
        (a, b) => a.cell.row - b.cell.row || a.cell.column - b.cell.column
      )
    if (
      rows < 3 ||
      columns < 2 ||
      owners.length !== rows * columns ||
      owners.some(
        (p, n) =>
          p.cell.row !== Math.floor(n / columns) ||
          p.cell.column !== n % columns ||
          p.cell.rowSpan !== 1 ||
          p.cell.colSpan !== 1 ||
          !p.fonts.length
      )
    )
      return false
    const w = witnesses.get(witness),
      records = new Map(),
      bound = new Map(),
      owned = new Map(),
      stream = owners.flatMap((p) => p.fonts),
      h = Math.max(...all.map((f) => f.height))
    for (const n of w.packet.records) {
      const key = n.r.sourceItem?.pageNumber + ':' + n.r.sourceItem?.index
      if (records.has(key)) return false
      records.set(key, n)
    }
    let scale,
      previous = -1
    for (const p of owners)
      for (const f of p.fonts) {
        const s = f.sourceItem,
          n = records.get(s?.pageNumber + ':' + s?.index)
        if (
          !n ||
          s.pageNumber !== w.context.pageNumber ||
          s.index <= previous ||
          s.text !== f.text ||
          n.r.str !== f.text ||
          n.r.sourceItem.text !== f.text
        )
          return false
        previous = s.index
        const ratio = (f.rect[2] - f.rect[0]) / (n.rect[2] - n.rect[0])
        if (!Number.isFinite(ratio) || ratio <= 0) return false
        if (scale === undefined) scale = ratio
        if (
          Math.abs(ratio - scale) > scale * 0.00001 ||
          f.rect.some((v, i) => Math.abs(v - n.rect[i] * scale) > 0.02) ||
          Math.abs(f.height - n.r.height * scale) > 0.02
        )
          return false
        bound.set(f, n)
        owned.set(f, p)
      }
    // Keep the actual page inventory complete. Whitespace may separate native
    // records; another nonempty Source in this chain must never be hidden.
    const indexes = new Set(stream.map((f) => f.sourceItem.index))
    for (let i = stream[0].sourceItem.index; i <= stream.at(-1).sourceItem.index; i++) {
      const original = w.context.content.items[i]
      if (!original || typeof original.str !== 'string' || (original.str.trim() && !indexes.has(i)))
        return false
    }
    const box = [
        Math.min(...all.map((f) => f.rect[0])),
        Math.min(...all.map((f) => f.rect[1])),
        Math.max(...all.map((f) => f.rect[2])),
        Math.max(...all.map((f) => f.rect[3]))
      ],
      touches = (r) => r[0] < box[2] && r[2] > box[0] && r[1] < box[3] && r[3] > box[1],
      paint = nativeFigurePaintCertificateData(w.paint, w.page, w.tokens, w.context)
    if (
      !paint ||
      inventory.some((f) => f.text?.trim() && !owned.has(f) && touches(f.rect)) ||
      paint.pieces.some((p) => p.kind !== 'glyph' && touches(p.rect.map((v) => v * scale)))
    )
      return false
    const baselines = []
    for (let row = 0; row < rows; row++) {
      const fonts = owners.filter((p) => p.cell.row === row).flatMap((p) => p.fonts),
        main = fonts.filter((f) => Math.abs(f.height - h) < h * 0.01)
      if (!main.length || main.some((f) => Math.abs(f.baseline - main[0].baseline) > h * 0.005))
        return false
      baselines.push(main[0].baseline)
    }
    // Native display-math rows reserve extra room for raised powers. Each
    // actual row must be separate; equal leading is not a text-ownership fact.
    if (
      baselines.some(
        (b, r) => r && (b - baselines[r - 1] < h * 1.2 || b - baselines[r - 1] > h * 2.2)
      )
    )
      return false
    const isMain = (f) =>
        Math.abs(f.height - h) < h * 0.01 &&
        Math.abs(f.baseline - baselines[owned.get(f).cell.row]) < h * 0.005,
      isScript = (f) =>
        f.height >= h * 0.65 &&
        f.height <= h * 0.8 &&
        baselines[owned.get(f).cell.row] - f.baseline > h * 0.2 &&
        baselines[owned.get(f).cell.row] - f.baseline < h * 0.7
    let at = 0,
      terms = 0,
      symbol,
      symbolFace,
      cut = false
    const integer = (f) => f && isMain(f) && /^(?:[1-9]\d*|[1-9]\d{0,2}(?: \d{3})+)$/u.test(f.text),
      token = (s) => stream[at]?.text === s && isMain(stream[at])
    while (at < stream.length && !token('=')) {
      const termStart = at
      let operator
      if (stream[at] && /^[+−-]$/u.test(stream[at].text) && isMain(stream[at]))
        operator = stream[at++]
      else if (terms) return false
      const coefficient = stream[at++]
      if (!integer(coefficient)) return false
      const row = owned.get(coefficient).cell.row
      if (operator && owned.get(operator) !== owned.get(coefficient)) {
        const left = owned.get(operator),
          right = owned.get(coefficient),
          gap = coefficient.rect[0] - operator.rect[2]
        if (
          left.cell.row !== row ||
          left.cell.column + 1 !== right.cell.column ||
          left.fonts.at(-1) !== operator ||
          right.fonts[0] !== coefficient ||
          gap < 0 ||
          gap > h * 0.5 ||
          Math.abs(operator.baseline - coefficient.baseline) > h * 0.005
        )
          return false
        cut = true
      }
      let factors = 0
      while (stream[at] && /^\p{L}$/u.test(stream[at].text) && isMain(stream[at])) {
        const f = stream[at++],
          face = bound.get(f).r.fontName
        if (owned.get(f).cell.row !== row) return false
        if (symbol === undefined) {
          symbol = f.text
          symbolFace = face
        }
        if (f.text !== symbol || face !== symbolFace || !token('(')) return false
        at++
        if (!stream[at] || !isMain(stream[at]) || !/^[1-9]\d*$/u.test(stream[at].text)) return false
        at++
        while (token(',')) {
          at++
          if (!stream[at] || !isMain(stream[at]) || !/^[1-9]\d*$/u.test(stream[at].text))
            return false
          at++
        }
        if (!token(')')) return false
        const close = stream[at++]
        if (stream[at] && isScript(stream[at])) {
          const exponent = stream[at++]
          if (
            !/^(?:[2-9]|[1-9]\d+)$/u.test(exponent.text) ||
            owned.get(exponent).cell.row !== row ||
            exponent.rect[0] < close.rect[2] - h * 0.01 ||
            exponent.rect[0] - close.rect[2] > h * 0.2
          )
            return false
        }
        factors++
      }
      if (!factors || stream.slice(termStart, at).some((f) => owned.get(f).cell.row !== row))
        return false
      terms++
    }
    if (!cut || terms !== owners.length - 1 || !token('=')) return false
    const terminal = owned.get(stream[at])
    at++
    if (!token('0') || owned.get(stream[at]) !== terminal) return false
    at++
    if (token('.')) {
      if (owned.get(stream[at]) !== terminal) return false
      at++
    }
    return (
      at === stream.length &&
      terminal === owners.at(-1) &&
      terminal.fonts[0].text === '=' &&
      nativeTableFontRoleWitnessCurrent(witness)
    )
  } catch {
    return false
  }
}

// Complete native numeric tuples on separate label baselines are independent
// record candidates even when one model row owns all of them. This only
// requests conservative review; it never invents a row or changes any Source.
export function hasNativeAlignedTupleRecords(proof, table, inventory, all, witness) {
  try {
    if (
      !all ||
      !nativeTableFontRoleWitnessCurrent(witness) ||
      table.grid.length < 4 ||
      table.grid[0].length < 3 ||
      table.issues?.some((issue) => issue !== 'unassigned-source-text')
    )
      return false
    const w = witnesses.get(witness),
      native = new Map(),
      bound = new Map()
    for (const n of w.packet.records) {
      const key = n.r.sourceItem?.pageNumber + ':' + n.r.sourceItem?.index
      if (native.has(key)) return false
      native.set(key, n)
    }
    let scale
    for (const f of all) {
      const s = f.sourceItem,
        n = native.get(s?.pageNumber + ':' + s?.index)
      if (
        !n ||
        s.pageNumber !== w.context.pageNumber ||
        s.text !== f.text ||
        n.r.str !== f.text ||
        n.r.sourceItem.text !== f.text
      )
        return false
      const ratio = (f.rect[2] - f.rect[0]) / (n.rect[2] - n.rect[0])
      if (!Number.isFinite(ratio) || ratio <= 0) return false
      scale ??= ratio
      if (
        Math.abs(ratio - scale) > scale * 0.00001 ||
        f.rect.some((v, i) => Math.abs(v - n.rect[i] * scale) > 0.02) ||
        Math.abs(f.height - n.r.height * scale) > 0.02
      )
        return false
      bound.set(f, n)
    }
    const paint = nativeFigurePaintCertificateData(w.paint, w.page, w.tokens, w.context)
    if (!paint) return false
    const union = (fonts) => [
        Math.min(...fonts.map((f) => f.rect[0])),
        Math.min(...fonts.map((f) => f.rect[1])),
        Math.max(...fonts.map((f) => f.rect[2])),
        Math.max(...fonts.map((f) => f.rect[3]))
      ],
      overlap = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
      number = '[+−-]?(?:(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?|\\.\\d+)',
      tuple = new RegExp('^' + number + '\\(' + number + '%?\\)$', 'u'),
      labels = /^[\p{L}][\p{L}\p{M} '\u2019-]{0,63}$/u,
      owners = proof.proved,
      cols = table.grid[0].length,
      slot = (r, c) => owners.find((p) => p.cell.row === r && p.cell.column === c),
      whole = (p) => p && p.cell.rowSpan === 1 && p.cell.colSpan === 1,
      text = (line) =>
        [...line]
          .sort((a, b) => a.rect[0] - b.rect[0])
          .map((f) => f.text)
          .join(''),
      face = (f) => bound.get(f).r.fontName,
      h = Math.max(...all.map((f) => f.height)),
      lines = (p) => {
        if (
          !whole(p) ||
          p.fonts.some((f) => Math.abs(f.height - h) > h * 0.001 || face(f) !== face(p.fonts[0]))
        )
          return
        const grouped = []
        for (const f of [...p.fonts].sort(
          (a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]
        )) {
          const previous = grouped.at(-1)
          if (previous && Math.abs(previous[0].baseline - f.baseline) < h * 0.001) previous.push(f)
          else grouped.push([f])
        }
        return grouped
      }
    if (
      !Array.from({ length: cols }, (_, c) => slot(0, c)).every(
        (p) => whole(p) && /\p{L}/u.test(p.cell.text)
      )
    )
      return false
    const candidates = []
    for (const labelColumn of [0, 1]) {
      if (cols - labelColumn - 1 < 2) continue
      const ordinary = [],
        multi = []
      for (let row = 1; row < table.grid.length; row++) {
        const ps = Array.from({ length: cols - labelColumn }, (_, c) => slot(row, c + labelColumn))
        if (ps.some((p) => !whole(p))) continue
        const ls = ps.map(lines)
        if (
          ls.some((l) => !l?.length) ||
          ls.some((l) => l.length !== ls[0].length) ||
          ls[0].some((l) => l.length !== 1 || !labels.test(text(l)))
        )
          continue
        const count = ls[0].length
        if (
          count > 4 ||
          ls
            .slice(1)
            .some((l) =>
              l.some(
                (line, n) =>
                  !tuple.test(text(line).replace(/\s/gu, '')) ||
                  line.some((f) => Math.abs(f.baseline - ls[0][n][0].baseline) > h * 0.001)
              )
            )
        )
          continue
        const fonts = ps.flatMap((p) => p.fonts),
          box = union(fonts)
        if (
          ls.some(
            (l, c) =>
              c &&
              Math.max(...ls[c - 1].flat().map((f) => f.rect[2])) >=
                Math.min(...l.flat().map((f) => f.rect[0]))
          )
        )
          continue
        const stream = Array.from({ length: count }, (_, n) => ls.flatMap((l) => l[n])).flat()
        if (stream.some((f, n) => n && f.sourceItem.index <= stream[n - 1].sourceItem.index))
          continue
        const prefixOwner = labelColumn === 0 ? undefined : slot(row, 0),
          prefix = prefixOwner?.fonts ?? []
        if (
          (prefixOwner && !whole(prefixOwner)) ||
          prefix.length > 1 ||
          prefix.some(
            (f) =>
              f.rect[2] >= box[0] ||
              Math.abs(f.height - h) > h * 0.001 ||
              f.baseline < ls[0][0][0].baseline ||
              f.baseline > ls[0].at(-1)[0].baseline
          )
        )
          continue
        if (count === 1) {
          ordinary.push({ ps, ls })
          continue
        }
        const gaps = ls[0].slice(1).map((l, n) => l[0].baseline - ls[0][n][0].baseline)
        if (gaps.some((gap) => gap <= h || gap > h * 2 || Math.abs(gap - gaps[0]) > h * 0.001))
          continue
        const component = [...fonts, ...prefix]
        if (
          inventory.some((f) => f.text?.trim() && !component.includes(f) && overlap(f.rect, box)) ||
          !nativeTuplePaintDisjoint(w, paint, box, scale)
        )
          continue
        multi.push({ row, labelColumn, ps, ls, box })
      }
      for (const m of multi) {
        const signatures = m.ls[0].map((l) => text(l) + ':' + face(l[0]))
        if (new Set(signatures).size !== signatures.length) continue
        const repeated = signatures.every((s) =>
          ordinary.some((o) => text(o.ls[0][0]) + ':' + face(o.ls[0][0][0]) === s)
        )
        const grouped =
          labelColumn === 1 &&
          slot(m.row, 0)?.fonts.length === 1 &&
          multi.some(
            (other) =>
              other !== m &&
              slot(other.row, 0)?.fonts.length === 1 &&
              slot(other.row, 0).cell.text !== slot(m.row, 0).cell.text
          )
        if (repeated || grouped) candidates.push(m)
      }
    }
    return candidates.length > 0 && nativeTableFontRoleWitnessCurrent(witness)
  } catch {
    return false
  }
}
