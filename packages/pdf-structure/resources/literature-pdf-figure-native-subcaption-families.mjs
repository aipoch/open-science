/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'

const valid = (r) =>
  Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
const compact = (s) => s.normalize('NFD').replace(/\s/gu, '')
const union = (rs) => [
  Math.min(...rs.map((r) => r[0])),
  Math.min(...rs.map((r) => r[1])),
  Math.max(...rs.map((r) => r[2])),
  Math.max(...rs.map((r) => r[3]))
]
const same = (a, b) => a?.length === b?.length && a.every((v, n) => Math.abs(v - b[n]) < 0.02)
const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]

// Shape ownership only: the caller supplies complete, retained native pixel
// certificate pieces. A BT packet may contain a subcaption and unrelated text;
// only complete original fonts, exactly closed by their visible glyph advances,
// may be selected from that packet. No Source authority is produced.
export function nativeSubcaptionFormFamilies(
  data,
  items,
  figure,
  captions,
  tokens,
  context,
  peers = []
) {
  if (
    !Array.isArray(data?.scopes) ||
    !Array.isArray(items) ||
    items.length > 16384 ||
    !Array.isArray(captions) ||
    !Array.isArray(tokens) ||
    !Array.isArray(peers) ||
    !Array.isArray(context?.content?.items) ||
    typeof context.viewport?.convertToViewportPoint !== 'function' ||
    !captions.includes(figure?.caption) ||
    items.some((p) => !valid(p.bound))
  )
    return
  const forms = data.scopes
    .filter(
      (s) =>
        s.op === OPS.paintFormXObjectBegin &&
        !data.scopes.some(
          (t) => t.op === OPS.paintFormXObjectBegin && t.begin < s.begin && t.end > s.end
        )
    )
    .sort((a, b) => a.begin - b.begin)
  if (
    forms.length < 4 ||
    forms.length > 12 ||
    forms.some(
      (s, n) =>
        !Number.isInteger(s.begin) ||
        !Number.isInteger(s.end) ||
        s.end <= s.begin ||
        (n && s.begin <= forms[n - 1].end)
    )
  )
    return
  const glyphs = items.filter((p) => p.kind === 'glyph'),
    matched = new Map(),
    used = new Set()
  const records = []
  for (const [index, raw] of context.content.items.entries()) {
    if (typeof raw.str !== 'string' || !raw.str.trim()) continue
    if (
      !Array.isArray(raw.transform) ||
      raw.transform.length !== 6 ||
      !raw.transform.every(Number.isFinite) ||
      !(raw.width > 0) ||
      !(raw.height > 0)
    )
      return
    const t = tableTextToken(raw, context.viewport, 0),
      origin = raw.sourceItem,
      claims = tokens.filter((t) => t.sourceItem?.index === index)
    if (
      !origin ||
      origin.pageNumber !== data.pageNumber ||
      origin.index !== index ||
      origin.text !== raw.str ||
      claims.length !== 1 ||
      claims[0].sourceItem.pageNumber !== data.pageNumber ||
      claims[0].sourceItem.text !== raw.str ||
      claims[0].text !== raw.str ||
      !same(claims[0].rect, t.rect)
    )
      return
    records.push({ raw, index, rect: t.rect, baseline: t.baseline, height: t.height })
  }
  const whole = (r) => {
    if (matched.has(r)) return matched.get(r)
    if (
      r.raw.transform[0] <= 0 ||
      r.raw.transform[3] <= 0 ||
      r.raw.transform[1] ||
      r.raw.transform[2]
    )
      return
    const parts = glyphs.filter(
      (p) =>
        p.fontName === r.raw.fontName &&
        p.advance?.length === 4 &&
        p.advance[0] >= r.rect[0] - 0.02 &&
        p.advance[2] <= r.rect[2] + 0.02 &&
        Math.abs(p.advance[1] - r.rect[1]) < 0.02 &&
        Math.abs(p.advance[3] - r.rect[3]) < 0.02
    )
    if (
      !parts.length ||
      compact(parts.map((p) => p.text).join('')) !== compact(r.raw.str) ||
      !same(union(parts.map((p) => p.advance)), r.rect) ||
      parts.some(
        (p) =>
          used.has(p) ||
          p.rendererSkipped ||
          p.fillAlpha !== 1 ||
          !Number.isInteger(p.packetBegin) ||
          !Number.isInteger(p.packetEnd) ||
          p.operationIndex <= p.packetBegin ||
          p.operationIndex >= p.packetEnd
      )
    )
      return
    for (const p of parts) used.add(p)
    matched.set(r, parts)
    return parts
  }
  const labels = records.filter((r) => /^\([a-l]\)\s+\S/u.test(r.raw.str)),
    groups = []
  if (labels.length !== forms.length) return
  for (const [n, scope] of forms.entries()) {
    const own = items.filter((p) => p.operationIndex > scope.begin && p.operationIndex < scope.end),
      body = own.length && union(own.map((p) => p.bound)),
      candidates = []
    if (
      !valid(body) ||
      !own.some((p) => p.kind === 'path') ||
      own.some((p) => !['glyph', 'path'].includes(p.kind))
    )
      return
    for (const r of labels) {
      const parts = whole(r)
      if (!parts) return
      if (
        parts.every(
          (p) =>
            p.operationIndex > scope.end && p.operationIndex < (forms[n + 1]?.begin ?? Infinity)
        ) &&
        r.rect[1] > body[3] - 2 &&
        r.rect[1] - body[3] < r.height * 2 &&
        r.rect[0] >= body[0] - 2 &&
        r.rect[2] <= body[2] + 2
      )
        candidates.push({ r, parts })
    }
    if (candidates.length !== 1) return
    const label = candidates[0],
      letter = label.r.raw.str[1]
    if (letter === 'a') groups.push([])
    const group = groups.at(-1)
    if (!group || letter !== String.fromCharCode(97 + group.length)) return
    group.push({ scope, own, body, label })
  }
  if (groups.length < 2 || groups.length > 6) return
  const families = []
  for (const group of groups) {
    const own = group.flatMap((g) => [...g.own, ...g.label.parts]),
      body = union(own.map((p) => p.bound)),
      em = group[0].label.r.height,
      eligible = captions.filter(
        (c) =>
          c.page === data.pageNumber &&
          valid(c.rect) &&
          c.rect[1] > body[3] &&
          c.rect[1] - body[3] < em * 3 &&
          body[0] >= c.rect[0] - em &&
          body[2] <= c.rect[2] + em
      )
    if (
      group.length < 2 ||
      group.length > 6 ||
      eligible.length !== 1 ||
      group.some(
        (g, n) =>
          Math.abs(g.label.r.baseline - group[0].label.r.baseline) > 0.02 ||
          Math.abs(g.label.r.height - em) > 0.02 ||
          (n && g.body[0] <= group[n - 1].body[2])
      ) ||
      Math.max(...group.map((g) => g.body[1])) >= Math.min(...group.map((g) => g.body[3]))
    )
      return
    const caption = eligible[0],
      fonts = records.filter(
        (r) =>
          r.rect[0] < caption.rect[2] &&
          r.rect[2] > caption.rect[0] &&
          r.rect[1] < caption.rect[3] &&
          r.rect[3] > caption.rect[1]
      ),
      cap = []
    if (
      !fonts.length ||
      fonts.some((r) =>
        r.rect.some((v, n) => (n < 2 ? v < caption.rect[n] - 0.02 : v > caption.rect[n] + 0.02))
      ) ||
      compact(fonts.map((r) => r.raw.str).join('')) !== compact(caption.lines.join(''))
    )
      return
    for (const r of fonts) {
      const parts = whole(r)
      if (!parts) return
      cap.push(...parts)
    }
    families.push({ caption, own, cap, body })
  }
  if (new Set(families.map((f) => f.caption)).size !== families.length) return
  const target = families.filter((f) => f.caption === figure.caption)
  if (target.length !== 1) return
  const own = target[0].own,
    excluded = families.filter((f) => f !== target[0]).flatMap((f) => [...f.own, ...f.cap]),
    exteriorPeers = []
  for (const peer of peers.filter((p) => p !== figure)) {
    const match = families.filter((f) => f !== target[0] && f.caption === peer.caption)
    if (
      match.length !== 1 ||
      !valid(peer.rect) ||
      !valid(match[0].body) ||
      !hit(peer.rect, match[0].body)
    )
      return
    exteriorPeers.push(peer)
  }
  return { own, excluded, exteriorPeers, kind: 'complete-native-multiple-subcaption-families' }
}
