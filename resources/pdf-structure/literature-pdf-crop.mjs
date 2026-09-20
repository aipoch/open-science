/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { createCanvas } from '@napi-rs/canvas'

// Keep these limits aligned with the main-process worker and cache image boundaries.
const MAX_EDGE = 2400
const MAX_BYTES = 4 * 1024 ** 2

export const renderPdfCrop = async (page, rect, rotation = page.rotate) => {
  assert(rect.length === 4 && rect.every(Number.isFinite), 'Invalid PDF crop region.')
  const bounds = page.getViewport({ scale: 1, rotation })
  const left = Math.max(0, rect[0]),
    top = Math.max(0, rect[1]),
    width = Math.min(bounds.width, rect[2]) - left,
    height = Math.min(bounds.height, rect[3]) - top
  assert(width > 0 && height > 0, 'Empty PDF crop region.')
  let scale = Math.min(4, MAX_EDGE / Math.max(width, height))
  for (;;) {
    const canvas = createCanvas(
      Math.min(MAX_EDGE, Math.max(1, Math.ceil(width * scale))),
      Math.min(MAX_EDGE, Math.max(1, Math.ceil(height * scale)))
    )
    try {
      // Render vectors/text from the source PDF into only the crop-sized canvas. Enlarging the
      // inference page bitmap cannot recover its lost detail, especially on Retina displays.
      await page.render({
        canvasContext: canvas.getContext('2d'),
        viewport: page.getViewport({
          scale,
          rotation,
          offsetX: -left * scale,
          offsetY: -top * scale
        })
      }).promise
      const png = await canvas.encode('png')
      if (png.length <= MAX_BYTES) return png
      // Photographic/noisy regions may exceed the PNG byte budget even within the pixel limit.
      // Reduce resolution instead of failing extraction or dropping the figure.
      assert(canvas.width > 1 || canvas.height > 1, 'PDF crop exceeds image budget.')
      scale *= Math.min(0.8, Math.sqrt(MAX_BYTES / png.length) * 0.9)
    } finally {
      canvas.width = 1
      canvas.height = 1
    }
  }
}

// Scanned articles expose one page-sized image, not individual chart objects.
// Recover aligned connected plot frames only beneath an explicit OCR figure label.
// ponytail: unframed scanned illustrations need layout/OCR inference; abstain here.
export const recoverScannedFigures = async (page, geometry) => {
  if (
    !geometry.graphicsBounds.some(
      ({ kind, normalizedRect: r }) => kind === 'image' && (r[2] - r[0]) * (r[3] - r[1]) > 0.9
    )
  )
    return []
  const labels = geometry.lines.filter((l) => /^(?:Figure|Fig\.)$/.test(l.text.trim()))
  if (!labels.length) return []
  const candidates = labels.flatMap((label) => {
    const number = geometry.lines.find(
      (l) =>
        /^\d+$/.test(l.text.trim()) &&
        l.x >= label.x + label.width &&
        l.x - label.x - label.width < label.fontSize &&
        Math.abs(l.y - label.y) < label.fontSize * 0.6
    )
    if (!number) return []
    const title = geometry.lines.find(
      (l) =>
        l.x > number.x + number.width &&
        l.x - number.x - number.width < label.fontSize * 1.5 &&
        Math.abs(l.y - number.y) < label.fontSize * 0.6 &&
        l.text.length > 30
    )
    if (!title) return []
    const lines = [title]
    for (const line of geometry.lines
      .filter(
        (l) =>
          l !== label &&
          l !== number &&
          l.y > title.y &&
          Math.abs(l.x - label.x) < label.fontSize &&
          l.x + l.width <= title.x + title.width + label.fontSize
      )
      .sort((a, b) => a.y - b.y)) {
      if (line.y - lines.at(-1).y > label.fontSize * 1.6 || line.text.length < 25) break
      lines.push(line)
    }
    return [{ label, number, lines }]
  })
  if (!candidates.length) return []
  const scale = Math.min(1.5, 1600 / Math.max(geometry.width, geometry.height))
  const viewport = page.getViewport({ scale, rotation: geometry.renderRotation ?? page.rotate })
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
  try {
    const context = canvas.getContext('2d')
    await page.render({ canvasContext: context, viewport }).promise
    const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height)
    const seen = new Uint8Array(width * height),
      queue = new Int32Array(width * height),
      frames = []
    for (let start = 0; start < seen.length; start++) {
      if (
        seen[start] ||
        data[start * 4] > 130 ||
        data[start * 4 + 1] > 130 ||
        data[start * 4 + 2] > 130
      )
        continue
      let head = 0,
        tail = 1,
        left = width,
        top = height,
        right = 0,
        bottom = 0
      queue[0] = start
      seen[start] = 1
      while (head < tail) {
        const index = queue[head++],
          x = index % width,
          y = Math.floor(index / width)
        left = Math.min(left, x)
        right = Math.max(right, x)
        top = Math.min(top, y)
        bottom = Math.max(bottom, y)
        for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy++)
          for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx++) {
            const n = yy * width + xx
            if (
              !seen[n] &&
              data[n * 4] <= 130 &&
              data[n * 4 + 1] <= 130 &&
              data[n * 4 + 2] <= 130
            ) {
              seen[n] = 1
              queue[tail++] = n
            }
          }
      }
      const w = right - left,
        h = bottom - top,
        density = tail / (w * h)
      if (
        w > width * 0.15 &&
        h > height * 0.06 &&
        w / h > 0.8 &&
        w / h < 3 &&
        density > 0.01 &&
        density < 0.2
      )
        frames.push([left / scale, top / scale, right / scale, bottom / scale])
    }
    return candidates.flatMap(({ label, number, lines }) => {
      const captionTop = Math.min(label.y, number.y, lines[0].y),
        right = Math.max(...lines.map((l) => l.x + l.width))
      const nearby = frames
        .filter(
          (r) =>
            r[0] >= label.x - label.fontSize &&
            r[2] <= right + label.fontSize &&
            r[3] < captionTop &&
            captionTop - r[3] < geometry.height * 0.45
        )
        .sort((a, b) => a[1] - b[1])
      if (
        nearby.length < 2 ||
        nearby.length > 4 ||
        captionTop - nearby.at(-1)[3] > label.fontSize * 3 ||
        nearby.some(
          (r, i) =>
            i &&
            (Math.abs(r[0] - nearby[0][0]) > label.fontSize ||
              Math.abs(r[2] - nearby[0][2]) > label.fontSize ||
              r[1] - nearby[i - 1][3] > label.fontSize * 4 ||
              r[1] <= nearby[i - 1][3])
        )
      )
        return []
      const top = nearby[0][1] - label.fontSize * 2,
        left = label.x - label.fontSize
      if (
        geometry.lines.some(
          (l) =>
            l.y > top &&
            l.y < nearby.at(-1)[3] &&
            l.x >= left &&
            l.x + l.width <= right + label.fontSize &&
            (l.text.match(/[a-z]/gi)?.length ?? 0) > 35
        )
      )
        return []
      const bounds = [width, height, 0, 0]
      for (
        let y = Math.max(0, Math.floor(top * scale));
        y < Math.min(height, Math.floor((captionTop - 3) * scale));
        y++
      )
        for (
          let x = Math.max(0, Math.floor(left * scale));
          x < Math.min(width, Math.ceil((right + label.fontSize) * scale));
          x++
        ) {
          const i = (y * width + x) * 4
          if (data[i] < 150 && data[i + 1] < 150 && data[i + 2] < 150) {
            bounds[0] = Math.min(bounds[0], x)
            bounds[1] = Math.min(bounds[1], y)
            bounds[2] = Math.max(bounds[2], x + 1)
            bounds[3] = Math.max(bounds[3], y + 1)
          }
        }
      return [
        {
          rect: bounds.map((v) => v / scale),
          graphicsCount: nearby.length,
          caption: {
            page: geometry.pageNumber,
            rect: [label.x, captionTop, right, Math.max(...lines.map((l) => l.y + l.height))],
            lines: [
              `${label.text} ${number.text} ${lines[0].text}`,
              ...lines.slice(1).map((l) => l.text)
            ]
          }
        }
      ]
    })
  } finally {
    canvas.width = 1
    canvas.height = 1
  }
}
