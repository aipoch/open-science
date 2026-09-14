/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind, groupPageLines } from './literature-pdf-caption-group.mjs'
import { isUprightText } from './literature-pdf-orientation.mjs'

const isLegendHeading = (text) =>
  /^(?:figure\s+(?:legends|captions)|List of Figures)\s*$/i.test(text.trim())

// Accepted manuscripts can put all legends before a consecutive block of plates.
// Match only an explicit legend section, ordered 1..N, followed by exactly N
// text-free or explicitly numbered pages. Cropping still requires native graphic evidence.
export function matchFigureSequence(pages) {
  const heading = pages.findIndex((page) => page.lines.some((line) => isLegendHeading(line.text)))
  if (heading < 0) return new Map()
  const captions = []
  const repeatsCaption = (line, index) => {
    const expected = captions[index]?.lines[0]?.replace(/\s+/g, ' ').trim()
    const actual = line.text.replace(/\s+/g, ' ').trim()
    return (
      expected &&
      Math.min(expected.length, actual.length) >= 18 &&
      (expected.startsWith(actual) || actual.startsWith(expected))
    )
  }
  let lastLegend = heading
  let central = false
  for (let i = heading; i < pages.length && pages[i].lines.length; i++) {
    if (i > heading && pages[i].lines.some((l) => /^Table\s+\d+\s*[.:]/i.test(l.text))) break
    // A repeated standalone Figure 1 starts the numbered plates, not a
    // continuation of the final legend. Axis/diagram text belongs to that plate.
    if (
      i > heading &&
      captions.length >= 2 &&
      pages[i].lines.some(
        (l) => /^(?:Figure|Fig\.)\s*1\.?$/i.test(l.text.trim()) || repeatsCaption(l, 0)
      )
    )
      break
    lastLegend = i
    for (const line of pages[i].lines) {
      const number = /^(?:Figure|Fig\.)\s*(\d+)\s*[.:]\s*/i.exec(line.text)
      const illustration = /^Central Illustration\s*:/i.test(line.text)
      if (number || illustration) {
        if (central || (number && Number(number[1]) !== captions.length + 1)) return new Map()
        central = illustration
        captions.push({
          page: pages[i].pageNumber,
          endPage: pages[i].pageNumber,
          lines: [],
          rect: [line.x, line.y, line.right, line.bottom]
        })
      }
      const caption = captions.at(-1)
      if (!caption) continue
      caption.endPage = pages[i].pageNumber
      caption.lines.push(line.text)
      if (caption.page === pages[i].pageNumber) {
        caption.rect[2] = Math.max(caption.rect[2], line.right)
        caption.rect[3] = Math.max(caption.rect[3], line.bottom)
      }
    }
  }
  // Publishers may insert their numbered tables (including continuation notes)
  // between an explicit legend section and its text-free figure plates.
  let firstPlate = lastLegend + 1
  if (pages[firstPlate]?.lines.some((l) => /^Table\s+\d+\s*[.:]/i.test(l.text))) {
    while (firstPlate < pages.length && pages[firstPlate].lines.length) {
      if (pages[firstPlate].lines.some((l) => /^(?:Fig\.|Figure|Supplement)/i.test(l.text)))
        return new Map()
      firstPlate++
    }
  }
  const plates = []
  for (let i = firstPlate; i < pages.length; i++) {
    if (pages[i].lines.some((line) => isLegendHeading(line.text))) break
    const labels = pages[i].lines.filter(
      (l) => /^(?:Figure|Fig\.)\s*\d+\.?$/i.test(l.text.trim()) || repeatsCaption(l, plates.length)
    )
    if (
      pages[i].lines.length &&
      !(labels.length === 1 && Number(/\d+/.exec(labels[0].text)[0]) === plates.length + 1)
    )
      break
    plates.push(pages[i])
  }
  if (captions.length < 2 || plates.length !== captions.length) return new Map()
  return new Map(plates.map((page, i) => [page.pageNumber, captions[i]]))
}

export async function readFigureSequence(document) {
  const pages = []
  for (let number = 1; number <= document.numPages; number++) {
    const page = await document.getPage(number)
    try {
      const viewport = page.getViewport({ scale: 1 })
      const content = await page.getTextContent()
      const lines = content.items.flatMap((item) => {
        if (!('str' in item) || !item.str.trim() || !isUprightText(item, page.rotate)) return []
        const [x, y] = viewport.convertToViewportPoint(...item.transform.slice(4))
        if (
          (item.str.length > 20 || /^Downloaded from$/.test(item.str.trim())) &&
          (y < 30 || y > viewport.height * 0.97)
        )
          return []
        // Isolated line/page numbers occupy margins, not the legend sentence.
        if (
          /^\d+$/.test(item.str.trim()) &&
          (x < viewport.width * 0.1 ||
            x > viewport.width * 0.88 ||
            y < 45 ||
            y > viewport.height * 0.92)
        )
          return []
        return [
          {
            text: item.str,
            x,
            y: y - item.height,
            width: item.width,
            height: item.height,
            fontSize: item.height
          }
        ]
      })
      pages.push({ pageNumber: number, height: viewport.height, lines: groupPageLines({ lines }) })
    } finally {
      page.cleanup()
    }
  }
  // Short publisher footers can survive the stream filter. Require the same
  // text at the same bottom-margin position on three pages; keep figure numbers.
  const isFooter = (line, page) => line.y > page.height * 0.97 && !captionKind(line.text)
  const cleaned = pages.map((page) => ({
    ...page,
    lines: page.lines.filter(
      (line) =>
        !isFooter(line, page) ||
        pages.filter((other) =>
          other.lines.some(
            (candidate) =>
              candidate.text === line.text &&
              isFooter(candidate, other) &&
              Math.abs(candidate.bottom / other.height - line.bottom / page.height) <= 1 / 256
          )
        ).length < 3
    )
  }))
  return matchFigureSequence(cleaned)
}
