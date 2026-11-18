/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { retainNativeRecoveryInputs } from './literature-pdf-native-figure-recovery-profile.mjs'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { getPdfCropRasterProtectionFromPng, renderPdfCrop } from './literature-pdf-crop.mjs'

const valid = (rect) =>
  Array.isArray(rect) &&
  rect.length === 4 &&
  rect.every(Number.isFinite) &&
  rect[0] < rect[2] &&
  rect[1] < rect[3]
const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const inside = (outer, inner) =>
  inner.every((value, axis) => (axis < 2 ? value >= outer[axis] : value <= outer[axis]))
const expand = (rect, padding) => rect.map((value, axis) => value + (axis < 2 ? -padding : padding))
const compact = (text) => text.normalize('NFKC').replace(/\s/gu, '')
const union = (a, b) =>
  a.map((value, axis) => (axis < 2 ? Math.min(value, b[axis]) : Math.max(value, b[axis])))
const unsupportedPaint = new Set([
  OPS.shadingFill,
  OPS.paintSolidColorImageMask,
  OPS.beginAnnotation,
  OPS.endAnnotation,
  OPS.stroke,
  OPS.closeStroke,
  OPS.fill,
  OPS.eoFill,
  OPS.fillStroke,
  OPS.eoFillStroke,
  OPS.closeFillStroke,
  OPS.closeEOFillStroke,
  OPS.rawFillPath,
  OPS.paintXObject
])
const textShows = new Set([
  OPS.showText,
  OPS.showSpacedText,
  OPS.nextLineShowText,
  OPS.nextLineSetSpacingShowText
])

// Use display-stream indices. The OPLIST intent can expand optimized images and
// therefore does not share indices with either recorded graphics or the filter.
function topLevelForms({ fnArray, argsArray }) {
  const forms = []
  let depth = 0,
    form
  for (const [i, op] of fnArray.entries()) {
    if (op === OPS.paintFormXObjectBegin) {
      if (depth++ === 0) form = { start: i, text: '' }
    } else if (op === OPS.paintFormXObjectEnd) {
      if (depth === 0) return
      if (--depth === 0) forms.push({ ...form, end: i })
    } else if (depth && textShows.has(op)) {
      if (op !== OPS.showText || !Array.isArray(argsArray[i]?.[0])) return
      for (const glyph of argsArray[i][0]) {
        if (typeof glyph === 'number') continue
        if (typeof glyph?.unicode !== 'string') return
        form.text += glyph.unicode
      }
    }
  }
  if (!depth) return forms.map((entry) => ({ ...entry, text: compact(entry.text) }))
}

function sourceSpan(items, tokens, forms) {
  const target = forms.map((form) => form.text).join('')
  if (target.length < 12) return
  const textItems = items.flatMap(({ str }, index) =>
    typeof str === 'string' && compact(str) ? [{ index, text: compact(str) }] : []
  )
  const stream = textItems.map((item) => item.text).join(''),
    first = stream.indexOf(target)
  if (first < 0 || stream.indexOf(target, first + 1) !== -1) return
  const end = first + target.length,
    owned = new Set()
  let offset = 0
  for (const item of textItems) {
    const next = offset + item.text.length
    if (offset < end && next > first) {
      if (offset < first || next > end) return
      owned.add(item.index)
    }
    offset = next
  }
  const mapped = tokens.filter((token) => owned.has(token.sourceItem?.index))
  if (
    mapped.length !== owned.size ||
    new Set(mapped.map((token) => token.sourceItem.index)).size !== owned.size ||
    mapped.some(
      (token) =>
        items[token.sourceItem.index].str !== token.sourceItem.text ||
        token.sourceItem.text !== token.text ||
        !valid(token.rect) ||
        !valid(token.nativeLabelRect)
    )
  )
    return
  return mapped
}

async function inkRect(png, rect, page) {
  const raster = getPdfCropRasterProtectionFromPng(png, rect, page)
  if (!raster) return
  const image = await loadImage(png),
    canvas = createCanvas(image.width, image.height)
  try {
    const ctx = canvas.getContext('2d')
    ctx.drawImage(image, 0, 0)
    const data = ctx.getImageData(0, 0, image.width, image.height).data
    let left = image.width,
      top = image.height,
      right = -1,
      bottom = -1
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const i = 4 * (y * image.width + x)
        if (data[i + 3] !== 255) return
        if (data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255) continue
        left = Math.min(left, x)
        top = Math.min(top, y)
        right = Math.max(right, x)
        bottom = y
      }
    }
    if (
      left < 2 ||
      top < 2 ||
      right >= image.width - 2 ||
      bottom >= image.height - 2 ||
      right <= left ||
      bottom <= top
    )
      return
    return [
      rect[0] + left / raster.scaleUpper,
      rect[1] + top / raster.scaleUpper,
      rect[0] + (right + 1) / raster.scaleLower,
      rect[1] + (bottom + 1) / raster.scaleLower
    ]
  } finally {
    canvas.width = canvas.height = 1
  }
}

function independentCaptionedForm(page, figure, caption, peers, forms, graphics, items, tokens) {
  const ordinal = (c) => /^(?:fig\.?|figure)\s+([1-9]\d*)[.:]?\s/iu.exec(c?.lines?.[0] ?? '')?.[1]
  if (figure.reason || forms.length !== 2 || peers.length !== 1) return
  const [peer] = peers
  if (
    peer.reason ||
    peer.issue ||
    peer.sourceItems?.length ||
    peer.parts ||
    peer.cropRects ||
    peer.headerRaster ||
    peer.formCropRaster ||
    !valid(peer.rect) ||
    !valid(peer.caption?.rect) ||
    caption.page !== page.pageNumber ||
    peer.caption.page !== caption.page ||
    !ordinal(caption) ||
    !ordinal(peer.caption) ||
    ordinal(caption) === ordinal(peer.caption)
  )
    return
  const groups = forms.map((form) => {
    const marks = graphics.filter(({ i }) => i > form.start && i < form.end)
    const source = sourceSpan(items, tokens, [form])
    if (!source?.length || marks.length < 3 || marks.some(({ kind }) => kind !== 'path')) return
    return {
      form,
      body: [...marks.map(({ rect }) => rect), ...source.map((t) => t.nativeLabelRect)].reduce(
        union
      )
    }
  })
  if (
    groups.some((g) => !g) ||
    graphics.some(({ i }) => !forms.some(({ start, end }) => i > start && i < end))
  )
    return
  const ordered = groups.sort((a, b) => a.body[0] - b.body[0]),
    [left, right] = ordered.map(({ body }) => body),
    gap = right[0] - left[2],
    caps = [
      { caption, rect: figure.rect, own: true },
      { caption: peer.caption, rect: peer.rect, own: false }
    ].sort((a, b) => a.caption.rect[0] - b.caption.rect[0])
  if (
    gap <= 4 ||
    left[1] >= right[3] ||
    right[1] >= left[3] ||
    caps[0].caption.rect[2] >= caps[1].caption.rect[0] ||
    !caps.every(({ caption: c, rect }, n) => {
      const body = ordered[n].body,
        center = (body[0] + body[2]) / 2,
        captionEm = Math.max(
          0,
          ...tokens.filter((t) => hit(t.rect, c.rect)).map((t) => t.rect[3] - t.rect[1])
        )
      return (
        center > c.rect[0] &&
        center < c.rect[2] &&
        body[3] < c.rect[1] &&
        c.rect[1] - body[3] < captionEm * 3 &&
        hit(rect, body)
      )
    })
  )
    return
  return { form: ordered[caps.findIndex(({ own }) => own)].form, peer, gap }
}

// A complete vector-grid Form can have unrelated column prose just above it.
// Match the enclosing PDF paint operation before examining the raster top.
function vectorGridLeadingProseForm(forms, graphics, items, tokens, published, caption) {
  if (!/^Figure\s+[1-9]\d*[.:]/iu.test(caption.lines?.[0] ?? '') || forms.length > 8) return
  const matching = forms.filter((form) => {
    const paths = graphics.filter(({ i }) => i > form.start && i < form.end)
    if (
      paths.length < 12 ||
      paths.some(({ kind, rect }) => kind !== 'path' || !inside(published, rect))
    )
      return false
    const source = sourceSpan(items, tokens, [form])
    if (!source?.length) return false
    const bounds = union(
      paths.map(({ rect }) => rect).reduce(union),
      source.map((t) => t.nativeLabelRect).reduce(union)
    )
    const prose = tokens.filter(
      (t) =>
        t.horizontal &&
        !source.includes(t) &&
        hit(published, t.nativeLabelRect) &&
        t.nativeLabelRect[3] < bounds[1] &&
        t.nativeLabelRect[2] - t.nativeLabelRect[0] > (published[2] - published[0]) / 3 &&
        (t.text.match(/\p{L}+/gu)?.length ?? 0) >= 5
    )
    if (prose.length !== 2 || bounds[3] >= caption.rect[1]) return false
    const [prior, tail] = prose.sort((a, b) => a.baseline - b.baseline)
    return (
      prior.nativeLabelRect[1] < published[1] &&
      tail.nativeLabelRect[1] > published[1] &&
      /^\p{Ll}[\p{L} ,’'-]+\.$/u.test(tail.text.trim()) &&
      Math.abs(prior.rect[0] - tail.rect[0]) < 0.02 &&
      Math.abs(prior.height - tail.height) < 0.02 &&
      tail.baseline - prior.baseline > tail.height &&
      tail.baseline - prior.baseline < tail.height * 1.5
    )
  })
  if (matching.length === 1) return matching[0]
}

export async function nativeFormSourceCrop(
  page,
  figure,
  caption,
  published,
  tokens,
  context,
  exclusions,
  nativePage,
  peers = []
) {
  try {
    const vectorGrid = figure.reason === 'native-vector-table-grid'
    if (
      !context ||
      !valid(published) ||
      !valid(caption?.rect) ||
      !valid(figure.rect) ||
      (figure.reason && figure.reason !== 'native-raster-vector-strip' && !vectorGrid) ||
      (figure.issue && !(vectorGrid && figure.issue === figure.reason)) ||
      figure.sourceItems?.length ||
      figure.parts ||
      figure.cropRects ||
      figure.headerRaster ||
      figure.formCropRaster ||
      page.invalidGraphicsBounds !== 0
    )
      return
    const { operators } = context,
      forms = topLevelForms(operators)
    if (
      !forms?.length ||
      (!vectorGrid && forms.length !== (figure.reason === 'native-raster-vector-strip' ? 1 : 2)) ||
      forms.some((form) => !form.text) ||
      operators.fnArray.some((op) => unsupportedPaint.has(op))
    )
      return
    const graphics = context.graphicsBounds.map((graphic) => ({
        i: graphic.operationIndex,
        kind: graphic.kind,
        rect: graphic.normalizedRect.map(
          (value, axis) => value * (axis % 2 ? page.height : page.width)
        )
      })),
      independent = independentCaptionedForm(
        page,
        figure,
        caption,
        peers,
        forms,
        graphics,
        context.content.items,
        tokens
      ),
      grid =
        vectorGrid &&
        vectorGridLeadingProseForm(
          forms,
          graphics,
          context.content.items,
          tokens,
          published,
          caption
        ),
      selected = grid ? [grid] : independent ? [independent.form] : forms,
      isOwned = (i) => selected.some(({ start, end }) => i > start && i < end),
      ownedGraphics = graphics.filter(({ i }) => isOwned(i)),
      source = sourceSpan(context.content.items, tokens, selected),
      nearby = independent
        ? exclusions.filter((rect) => rect !== independent.peer.rect)
        : exclusions
    if (
      (vectorGrid && !grid) ||
      !source ||
      ownedGraphics.length < 3 ||
      selected.some(
        ({ start, end }) =>
          !ownedGraphics.some(({ i, rect }) => i > start && i < end && hit(rect, figure.rect))
      )
    )
      return
    const external = tokens.filter((token) => !source.includes(token)),
      missing = source.some((token) => !inside(published, token.nativeLabelRect)),
      contaminated = external.some(
        (token) => valid(token.nativeLabelRect) && hit(published, token.nativeLabelRect)
      )
    if (figure.reason === 'native-raster-vector-strip' ? !missing : !contaminated) return
    const formRects = selected.map(({ start, end }) =>
      ownedGraphics
        .filter(({ i }) => i > start && i < end)
        .map(({ rect }) => rect)
        .reduce(union)
    )
    if (selected.length === 2) {
      const [left, right] = formRects.toSorted((a, b) => a[0] - b[0])
      if (left[2] > right[0] || left[1] >= right[3] || right[1] >= left[3]) return
    }
    const labelRects = source.flatMap((token) => [token.rect, token.nativeLabelRect]),
      owned = [...ownedGraphics.map(({ rect }) => rect), ...labelRects].reduce(union),
      witness = expand(
        owned,
        Math.min(
          6 + Math.max(page.width, page.height) / 256,
          independent ? independent.gap / 2 : Infinity
        )
      ),
      pageRect = [0, 0, page.width, page.height]
    if (
      !inside(pageRect, witness) ||
      (caption.rect[3] > owned[1] && caption.rect[1] < owned[3]) ||
      graphics.some(({ i, rect }) => !isOwned(i) && hit(rect, witness)) ||
      nearby.some((rect) => valid(rect) && hit(witness, rect))
    )
      return
    // Preserve all graphics state. Filtering only foreign text lets an actual
    // crop distinguish paint from conservative advance and recorded boxes.
    const paintKeys = ['operators', 'graphicsBounds', 'content', 'viewport'],
      paintInputs = paintKeys.map((key) => context[key]),
      unchanged = retainNativeRecoveryInputs(
        [
          page,
          figure,
          caption,
          published,
          tokens,
          exclusions,
          peers,
          ...(independent || grid ? paintInputs : [context])
        ],
        context.viewport
      )
    if (!unchanged) return
    const current = () =>
      unchanged() &&
      (!(independent || grid) ||
        paintKeys.every((key, index) => context[key] === paintInputs[index]))
    const filtered = {
      getViewport: (options) => nativePage.getViewport(options),
      render: (options) => {
        const task = nativePage.render({
          ...options,
          operationsFilter: (i) => !textShows.has(operators.fnArray[i]) || isOwned(i)
        })
        return {
          promise: task.promise.then(() => {
            const display = task._internalRenderTask?.operatorList
            if (
              !display ||
              display.fnArray.length !== operators.fnArray.length ||
              display.fnArray.some((op, index) => op !== operators.fnArray[index]) ||
              JSON.stringify(topLevelForms(display)) !== JSON.stringify(forms)
            )
              throw Error('Native figure display changed.')
          })
        }
      }
    }
    const witnessPng = await renderPdfCrop(filtered, witness, page.renderRotation),
      ink = await inkRect(witnessPng, witness, page)
    if (!ink || !current()) return
    const rect = grid
      ? [published[0], ink[1] - 0.75, published[2], published[3]]
      : expand(ink, 0.75)
    if (
      (grid ? !(rect[1] > published[1] && inside(rect, ink)) : !inside(witness, rect)) ||
      nearby.some((other) => valid(other) && hit(rect, other)) ||
      (missing &&
        !source.some(
          (token) => hit(rect, token.nativeLabelRect) && !inside(published, token.nativeLabelRect)
        )) ||
      (contaminated &&
        external.some((token) => valid(token.nativeLabelRect) && hit(rect, token.nativeLabelRect)))
    )
      return
    const normal = await renderPdfCrop(nativePage, rect, page.renderRotation),
      isolated = await renderPdfCrop(filtered, rect, page.renderRotation)
    if (!normal.equals(isolated) || !(await inkRect(normal, rect, page))) return
    if (!current()) return
    return { rect, png: normal, current }
  } catch {
    return
  }
}
