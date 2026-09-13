/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { groupPageLines } from './literature-pdf-caption-group.mjs'
import { isUprightText } from './literature-pdf-orientation.mjs'

// Accepted manuscripts can put all legends before a consecutive block of plates.
// Match only an explicit legend section, ordered 1..N, followed by exactly N
// text-free pages. The requested plate still needs recorded raster evidence.
export function matchFigureSequence(pages) {
  const heading = pages.findIndex((page) =>
    page.lines.some((line) =>
      /^(?:figure\s+(?:legends|captions)|List of Figures)\s*$/i.test(line.text.trim())
    )
  )
  if (heading < 0) return new Map()
  const captions = []
  let lastLegend = heading
  let central = false
  for (let i = heading; i < pages.length && pages[i].lines.length; i++) {
    if (i > heading && pages[i].lines.some((l) => /^Table\s+\d+\s*[.:]/i.test(l.text))) break
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
    const labels = pages[i].lines.filter((l) => /^(?:Figure|Fig\.)\s*\d+\.?$/i.test(l.text.trim()))
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
      pages.push({ pageNumber: number, lines: groupPageLines({ lines }) })
    } finally {
      page.cleanup()
    }
  }
  return matchFigureSequence(pages)
}
