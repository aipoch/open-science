/* eslint-disable @typescript-eslint/explicit-function-return-type */
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const rect = (l) => [l.x, l.y, l.x + l.width, l.y + l.height]
const valid = (r) =>
  Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
const overlap = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
const inside = (a, b) => b.every((v, i) => (i < 2 ? v >= a[i] - 0.01 : v <= a[i] + 0.01))
const compact = (s) => s.replace(/\s/gu, '')
const completePage = (page) =>
  page?.invalidGraphicsBounds === 0 &&
  Array.isArray(page.lines) &&
  page.lines.every(
    (line) => typeof line?.text === 'string' && valid(rect(line)) && line.fontSize > 0
  ) &&
  Array.isArray(page.graphicsBounds) &&
  page.graphicsBounds.every((g) => valid(g?.normalizedRect))
const completeCaptions = (captions) =>
  Array.isArray(captions) &&
  captions.every(
    (c) =>
      Array.isArray(c?.lines) && c.lines.every((line) => typeof line === 'string') && valid(c.rect)
  )
function inventory(page, content) {
  if (!Array.isArray(content?.items) || !content.styles) return
  const result = []
  for (const [index, i] of content.items.entries()) {
    if (typeof i?.str !== 'string' || !i.str.trim()) continue
    const t = i.transform,
      s = content.styles[i.fontName]
    if (
      !Array.isArray(t) ||
      t.length !== 6 ||
      !t.every(Number.isFinite) ||
      t[0] <= 0 ||
      t[1] !== 0 ||
      t[2] !== 0 ||
      t[3] <= 0 ||
      i.dir !== 'ltr' ||
      s?.vertical ||
      !Number.isFinite(s?.ascent) ||
      !(i.width > 0) ||
      !(i.height > 0) ||
      Math.abs(i.height - t[3]) > 1e-6
    )
      return
    const box = [t[4], page.height - t[5] - i.height, t[4] + i.width, page.height - t[5]]
    if (!valid(box)) return
    result.push({ index, text: i.str, font: i.fontName, height: i.height, rect: box })
  }
  return result
}
function fullLine(l, items, mixed = false) {
  const box = rect(l),
    parts = items.filter((i) => overlap(i.rect, box)).sort((a, b) => a.rect[0] - b.rect[0])
  if (
    !valid(box) ||
    !parts.length ||
    parts.some((i) => !inside(box, i.rect) || Math.abs(i.height - l.fontSize) > 0.01) ||
    (!mixed && new Set(parts.map((i) => i.font)).size !== 1) ||
    compact(parts.map((i) => i.text).join('')) !== compact(l.text)
  )
    return
  const nativeBox = [
    Math.min(...parts.map((i) => i.rect[0])),
    Math.min(...parts.map((i) => i.rect[1])),
    Math.max(...parts.map((i) => i.rect[2])),
    Math.max(...parts.map((i) => i.rect[3]))
  ]
  if (nativeBox.some((value, i) => Math.abs(value - box[i]) > 0.01)) return
  return parts
}
// Exclude only a source-complete continuation of the preceding page paragraph.
// This crop proof never changes text ownership or translation eligibility.
export function nativeCrossPageProse(page, bounds, caption, captions, current, previous) {
  if (
    !previous ||
    !completePage(page) ||
    !completePage(previous.previousPage) ||
    !completeCaptions(captions) ||
    !completeCaptions([caption]) ||
    !/^([a-f0-9]{64})$/i.test(previous.sourceSha256 ?? '') ||
    previous.currentPageNumber !== page.pageNumber ||
    !viewportMatches(previous.previousViewport, previous.previousPage) ||
    !viewportMatches(current?.viewport, page) ||
    !equal(current.graphicsBounds, page.graphicsBounds) ||
    previous.sourceSha256 !== current?.sourceSha256 ||
    page.pageNumber !== current.pageNumber ||
    previous.previousPage?.pageNumber !== page.pageNumber - 1 ||
    page.rotation !== 0 ||
    previous.previousPage.rotation !== 0 ||
    page.width !== previous.previousPage.width ||
    page.height !== previous.previousPage.height ||
    !valid(bounds) ||
    caption.page !== page.pageNumber ||
    !valid(caption.rect)
  )
    return
  const raw = previous.currentContent,
    old = current.content
  if (
    !Array.isArray(raw?.items) ||
    !raw.styles ||
    !old?.styles ||
    raw.items.length !== old?.items?.length
  )
    return
  const aliases = new Map(),
    reverse = new Map()
  for (let n = 0; n < raw.items.length; n++) {
    const a = raw.items[n],
      b = old.items[n]
    for (const key of ['str', 'width', 'height', 'dir', 'hasEOL', 'transform'])
      if (!equal(a[key], b[key])) return
    if (typeof a.str !== 'string') continue
    if (
      !equal(raw.styles[a.fontName], old.styles[b.fontName]) ||
      (aliases.has(a.fontName) && aliases.get(a.fontName) !== b.fontName) ||
      (reverse.has(b.fontName) && reverse.get(b.fontName) !== a.fontName)
    )
      return
    aliases.set(a.fontName, b.fontName)
    reverse.set(b.fontName, a.fontName)
  }
  const items = inventory(page, raw),
    before = inventory(previous.previousPage, previous.previousContent)
  if (!items || !before) return
  const images = page.graphicsBounds.filter(
    (g) =>
      g.kind === 'image' &&
      valid(g.normalizedRect) &&
      overlap(
        g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)),
        bounds
      )
  )
  if (images.length !== 1) return
  const image = images[0].normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
  if (
    [0, 1, 2].some((i) => Math.abs(image[i] - bounds[i]) > 0.01) ||
    bounds[3] > image[3] + 0.01 ||
    caption.rect[1] < bounds[3]
  )
    return
  const above = page.lines.filter((l) => l.text.trim() && l.y + l.height <= bounds[1])
  if (above.length !== 1) return
  const line = above[0],
    owned = fullLine(line, items),
    h = line.fontSize
  if (
    !owned ||
    !/^\p{Ll}/u.test(line.text.trim()) ||
    !/[.!?]$/.test(line.text.trim()) ||
    line.y >= page.height * 0.2 ||
    line.y + line.height >= bounds[1] ||
    captions.some((c) => c.page === page.pageNumber && overlap(c.rect, rect(line)))
  )
    return
  const title = /^(?:Figure|Fig\.?)\s*([0-9]+[A-Za-z]?)\b/i.exec(caption.lines.join(' '))
  if (!title) return
  if (
    captions.filter(
      (c) => c.page === page.pageNumber && /^(?:Figure|Fig\.?)\s*\d+/i.test(c.lines.join(' '))
    ).length !== 1
  )
    return
  const capline = {
    x: caption.rect[0],
    y: caption.rect[1],
    width: caption.rect[2] - caption.rect[0],
    height: caption.rect[3] - caption.rect[1],
    fontSize: caption.rect[3] - caption.rect[1],
    text: caption.lines.join('')
  }
  if (!fullLine(capline, items, true)) return
  const footers = previous.previousPage.lines.filter(
    (l) =>
      l.y > previous.previousPage.height * 0.9 && folio(l.text, previous) && fullLine(l, before)
  )
  const last = previous.previousPage.lines
    .filter((l) => l.text.trim() && !footers.includes(l))
    .sort((a, b) => a.y - b.y)
    .slice(-2)
  if (
    last.length !== 2 ||
    last[0].y < previous.previousPage.height * 0.65 ||
    last.some(
      (l) =>
        l.width < 0.85 * (bounds[2] - bounds[0]) ||
        Math.abs(l.fontSize - h) > 0.01 ||
        Math.abs(l.x - line.x) > h * 0.1
    ) ||
    /[.!?:;]$/.test(last[1].text.trim()) ||
    last[1].y - last[0].y - last[0].height < 0 ||
    last[1].y - last[0].y - last[0].height > h * 0.8
  )
    return
  const prior = last.map((l) => fullLine(l, before))
  if (
    prior.some((p) => !p) ||
    prior.flat().some((i) => i.font !== owned[0].font) ||
    !equal(previous.previousContent.styles[owned[0].font], raw.styles[owned[0].font])
  )
    return
  if (
    !new RegExp('\\b(?:Figure|Fig\\.?)\\s*' + title[1] + '\\b', 'i').test(
      last.map((l) => l.text).join(' ')
    )
  )
    return
  if (
    captions.some(
      (c) =>
        c.page === previous.previousPage.pageNumber && last.some((l) => overlap(c.rect, rect(l)))
    )
  )
    return
  const previousOwned = prior.flat(),
    footerOwned = footers.flatMap((l) => fullLine(l, before))
  if (
    before.some(
      (i) => i.rect[3] > last[0].y && !previousOwned.includes(i) && !footerOwned.includes(i)
    )
  )
    return
  if (
    previous.previousPage.graphicsBounds.some((g) => {
      const r = g.normalizedRect.map(
        (v, i) => v * (i % 2 ? previous.previousPage.height : previous.previousPage.width)
      )
      return r[3] > last[0].y && r[1] < previous.previousPage.height * 0.9
    })
  )
    return
  const corridor = [
    Math.min(line.x, bounds[0]),
    line.y,
    Math.max(line.x + line.width, bounds[2]),
    bounds[1]
  ]
  if (items.some((i) => overlap(i.rect, corridor) && !owned.includes(i))) return
  if (
    page.graphicsBounds.some((g) =>
      overlap(
        g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)),
        corridor
      )
    )
  )
    return
  return {
    line,
    sourceItems: owned.map((i) => ({ pageNumber: page.pageNumber, index: i.index, text: i.text })),
    previousSourceItems: prior
      .flat()
      .map((i) => ({ pageNumber: previous.previousPage.pageNumber, index: i.index, text: i.text }))
  }
}

function viewportMatches(viewport, page) {
  return (
    page &&
    viewport?.scale === 1 &&
    viewport.rotation === 0 &&
    viewport.width === page.width &&
    viewport.height === page.height &&
    equal(viewport.transform, [1, 0, 0, -1, 0, page.height])
  )
}
function folio(text, evidence) {
  const label = evidence.previousPageLabel ?? String(evidence.previousPage.pageNumber),
    m = /^(\d+)(?:\s*\/\s*(\d+))?$/.exec(text.trim())
  return (
    m &&
    m[1] === label &&
    (!m[2] ||
      (Number.isSafeInteger(evidence.documentPageCount) &&
        evidence.documentPageCount >= evidence.currentPageNumber &&
        Number(m[2]) === evidence.documentPageCount))
  )
}

// Only a narrow qualifying page may request one extra adjacent text inventory.
export function needsPreviousFigureProse(page, captions) {
  if (
    !completePage(page) ||
    !completeCaptions(captions) ||
    page.pageNumber <= 1 ||
    page.rotation !== 0
  )
    return false
  const images = page.graphicsBounds.filter((g) => g.kind === 'image' && valid(g.normalizedRect))
  const own = captions.filter(
    (c) => c.page === page.pageNumber && /^(?:Figure|Fig\.?)\s*\d+/i.test(c.lines.join(' '))
  )
  if (images.length !== 1 || own.length !== 1) return false
  const top = images[0].normalizedRect[1] * page.height,
    above = page.lines.filter((l) => l.text.trim() && l.y + l.height <= top)
  return (
    above.length === 1 &&
    above[0].y < page.height * 0.2 &&
    /^\p{Ll}/u.test(above[0].text.trim()) &&
    /[.!?]$/.test(above[0].text.trim()) &&
    own[0].rect[1] > top
  )
}
