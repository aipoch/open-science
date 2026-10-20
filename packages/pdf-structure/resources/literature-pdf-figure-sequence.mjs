/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  captionKind,
  groupPageLines,
  excludePdfLineNumbers
} from './literature-pdf-caption-group.mjs'
import { isUprightText } from './literature-pdf-orientation.mjs'

const isLegendHeading = (text) =>
  /^(?:figure\s+(?:legends|captions)|List of Figures)\s*:?\s*$/i.test(text.trim())

export const isPlateProseHeading = (text) =>
  /^(?:Highlights|Key points)\s*:?\s*$/i.test(text.trim())

// A complete plate image already owns its embedded axes and vector labels.
// Outside proof watermarks and running headers must not widen that image's crop.
// Native panel letters just above the image still belong to the plate.
export function rasterPlateRect(page) {
  const images = page.graphicsBounds.filter(
    (g) =>
      g.kind === 'image' &&
      (g.normalizedRect[2] - g.normalizedRect[0]) * (g.normalizedRect[3] - g.normalizedRect[1]) >
        0.03
  )
  if (!images.length) return
  const rects = images.map((g) =>
    g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
  )
  const imageRect = [
    Math.min(...rects.map((r) => r[0])),
    Math.min(...rects.map((r) => r[1])),
    Math.max(...rects.map((r) => r[2])),
    Math.max(...rects.map((r) => r[3]))
  ]
  const labels = page.lines
    .filter((l) => {
      if (captionKind(l.text) || isPlateProseHeading(l.text)) return false
      const r = [l.x, l.y, l.x + l.width, l.y + l.height]
      const inside =
        r[0] >= imageRect[0] - l.height &&
        r[2] <= imageRect[2] + l.height &&
        r[1] >= imageRect[1] - l.height &&
        r[3] <= imageRect[3] + l.height
      const panel =
        /^\(?[A-Z]\)?$/.test(l.text.trim()) &&
        r[0] >= imageRect[0] &&
        r[2] <= imageRect[2] &&
        r[3] <= imageRect[1] &&
        imageRect[1] - r[3] <= l.height * 4
      return inside || panel
    })
    .map((l) => [l.x, l.y, l.x + l.width, l.y + l.height])
  const parts = [imageRect, ...labels]
  return [
    Math.min(...parts.map((r) => r[0])),
    Math.min(...parts.map((r) => r[1])),
    Math.max(...parts.map((r) => r[2])),
    Math.max(...parts.map((r) => r[3]))
  ]
}

// Manuscript page numbers can sit well inside the nominal bottom margin.
// Require a consecutive sequence at the same position on at least three pages;
// a chart tick or isolated measurement cannot establish a running footer.
const withoutRunningNumbers = (pages) =>
  pages.map((page) => ({
    ...page,
    lines: page.lines.filter((line) => {
      if (!/^\d+$/.test(line.text.trim()) || !(line.y > page.height * 0.8)) return true
      const offset = Number(line.text) - page.pageNumber
      return (
        pages.filter((peer) =>
          peer.lines.some(
            (candidate) =>
              /^\d+$/.test(candidate.text.trim()) &&
              Number(candidate.text) - peer.pageNumber === offset &&
              Math.abs(candidate.y / peer.height - line.y / page.height) < 1 / 256 &&
              Math.abs(candidate.x / peer.width - line.x / page.width) < 1 / 256
          )
        ).length < 3
      )
    })
  }))

const hasNumberedLegends = (page) => {
  const labels = page.lines.filter((l) => /^(?:Figure|Fig\.)\s*\d+\s*[.:]\s+/.test(l.text))
  return (
    labels.length >= 2 &&
    labels.length <= 6 &&
    labels.every((l, n) => Number(/\d+/.exec(l.text)[0]) === n + 1 && l.text.length > 40)
  )
}

const citedPanelLetters = (text) => {
  const cited = new Set()
  for (const [, contents] of text.matchAll(/\(([^()]*)\)/g)) {
    const list = contents.trim()
    // Only complete letter lists count as panel references, not parenthetical
    // prose or units. Expand ranges before checking exact page coverage.
    if (
      !/^[A-Z](?:\s*[-–—]\s*[A-Z])?(?:(?:\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*)[A-Z](?:\s*[-–—]\s*[A-Z])?)*$/.test(
        list
      )
    )
      continue
    for (const [, first, last = first] of list.matchAll(/([A-Z])(?:\s*[-–—]\s*([A-Z]))?/g)) {
      if (last < first) return
      for (let code = first.charCodeAt(0); code <= last.charCodeAt(0); code++)
        cited.add(String.fromCharCode(code))
    }
  }
  return [...cited].sort()
}

// Accepted manuscripts can put all legends before a consecutive block of plates.
// Match only an explicit legend section, ordered 1..N, followed by exactly N
// text-free or explicitly numbered pages. Cropping still requires native graphic evidence.
export function matchFigureSequence(pages) {
  pages = withoutRunningNumbers(pages)
  const heading = pages.findIndex(
    (page) =>
      page.lines.some((line) => isLegendHeading(line.text)) ||
      (Number.isFinite(page.width) &&
        page.graphicCount === 0 &&
        hasNumberedLegends(page) &&
        /^(?:Figure|Fig\.)\s*1\s*[.:]\s+/.test(page.lines[0]?.text))
  )
  if (heading < 0) return new Map()
  const implicit = !pages[heading].lines.some((line) => isLegendHeading(line.text))
  // Appended drawing exports can use a different page size and contain native
  // axis/node labels. Require the explicit legend section, a changed page box,
  // several graphics and no prose-length lines; the final sequence must be exact.
  const isExportedPlate = (page) =>
    Number.isFinite(page.width) &&
    Number.isFinite(pages[heading].width) &&
    (Math.abs(page.width - pages[heading].width) > 12 ||
      Math.abs(page.height - pages[heading].height) > 12) &&
    page.graphicCount >= 3 &&
    page.lines.every((l) => l.text.length < 100 && !captionKind(l.text)) &&
    page.lines.reduce((sum, l) => sum + l.text.length, 0) < 1500
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
  legends: for (let i = heading; i < pages.length && pages[i].lines.length; i++) {
    if (i > heading && isExportedPlate(pages[i])) break
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
    const headingLine =
      i === heading ? pages[i].lines.findIndex((l) => isLegendHeading(l.text)) : -1
    for (const line of pages[i].lines.slice(headingLine + 1)) {
      if (
        captions.length >= 2 &&
        /^(?:Supplement(?:ary)?\s+(?:Figure|Fig\.)|Authors?[’']?\s+disclosures?)/i.test(line.text)
      )
        break legends
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
  const groups = []
  const labelPattern = /^(?:Figure|Fig\.)\s*(\d+)([A-Z])?\.?$/i
  for (let i = firstPlate; i < pages.length; i++) {
    if (pages[i].lines.some((line) => isLegendHeading(line.text))) break
    const proseStart = pages[i].lines.findIndex((l) => isPlateProseHeading(l.text))
    if (proseStart === 0) break
    const lines = proseStart >= 0 ? pages[i].lines.slice(0, proseStart) : pages[i].lines
    const labels = lines.filter(
      (l) => labelPattern.test(l.text.trim()) || repeatsCaption(l, groups.length)
    )
    const label = labels.length === 1 ? labelPattern.exec(labels[0].text.trim()) : undefined
    const standalone = !implicit && lines.filter((l) => /^\([A-Z]\)$/.test(l.text.trim()))
    const letter = standalone?.length === 1 ? standalone[0].text.trim()[1] : undefined
    const number = letter
      ? letter === 'A'
        ? groups.length + 1
        : groups.length
      : label
        ? Number(label[1])
        : groups.length + 1
    const panel = label?.[2]?.toUpperCase() ?? letter
    if (letter) {
      // An upper Fig. 1 can trail the preceding plate while (A) starts Fig. 2.
      // The end of a panel group can instead carry its own figure number.
      if (
        pages[i].graphicCount < 1 ||
        labels.length > 1 ||
        (label &&
          Number(label[1]) !== number &&
          !(letter === 'A' && Number(label[1]) === number - 1 && labels[0].y < standalone[0].y)) ||
        lines.some((l) => !labels.includes(l) && !standalone.includes(l))
      )
        return new Map()
    } else if (lines.length && !isExportedPlate(pages[i]) && labels.length !== 1) break
    if (panel) {
      if (!letter && (!label || pages[i].graphicCount < 1 || lines.length !== 1)) return new Map()
      if (number === groups.length + 1 && panel === 'A') groups.push([])
      const group = groups[number - 1]
      if (number !== groups.length || !group || panel !== String.fromCharCode(65 + group.length))
        return new Map()
      group.push(panel)
    } else {
      if (number !== groups.length + 1) break
      groups.push([])
    }
    plates.push({ page: pages[i], caption: number - 1 })
  }
  if (captions.length < 2 || groups.length !== captions.length) return new Map()
  // Without a section title, require independently exported page boxes and at
  // least two matching native plate numbers. At most one image-only plate may
  // take the sole remaining position in that exact sequence.
  if (
    implicit &&
    (plates.length !== captions.length ||
      plates.some(
        ({ page }) =>
          !Number.isFinite(page.width) ||
          page.graphicCount < 1 ||
          (Math.abs(page.width - pages[heading].width) <= 12 &&
            Math.abs(page.height - pages[heading].height) <= 12)
      ) ||
      plates.filter(({ page, caption }) =>
        page.lines.some((l) => Number(labelPattern.exec(l.text.trim())?.[1]) === caption + 1)
      ).length < Math.max(2, plates.length - 1))
  )
    return new Map()
  for (const [index, panels] of groups.entries()) {
    if (!panels.length) continue
    // Panel pages must exactly cover the explicit panel references in their
    // legend. A missing or duplicated page must not shift later associations.
    const cited = citedPanelLetters(captions[index].lines.join(' '))
    if (!cited || panels.length < 2 || panels.join('') !== cited.join('')) return new Map()
  }
  return new Map(plates.map(({ page, caption }) => [page.pageNumber, captions[caption]]))
}

export async function readFigureSequence(document) {
  const pages = []
  for (let number = 1; number <= document.numPages; number++) {
    const page = await document.getPage(number)
    try {
      const viewport = page.getViewport({ scale: 1 })
      const content = excludePdfLineNumbers(await page.getTextContent(), viewport)
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
          /^(?:\d+|\[\d+\])$/.test(item.str.trim()) &&
          (x < viewport.width * 0.1 ||
            x > viewport.width * 0.88 ||
            y < 45 ||
            y > viewport.height * 0.92 ||
            (/^\[\d+\]$/.test(item.str.trim()) && y > viewport.height * 0.9))
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
      const grouped = groupPageLines({ lines })
      const afterLegends = pages.some(
        (p) => p.lines.some((l) => isLegendHeading(l.text)) || hasNumberedLegends(p)
      )
      const graphicCount =
        afterLegends && page.getOperatorList
          ? (await page.getOperatorList()).fnArray.filter(
              (op) => op === OPS.constructPath || op === OPS.paintImageXObject
            ).length
          : 0
      pages.push({
        pageNumber: number,
        width: viewport.width,
        height: viewport.height,
        graphicCount,
        lines: grouped
      })
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
        !(
          isFooter(line, page) ||
          (line.y < page.height * 0.08 && line.text.length > 30 && !captionKind(line.text))
        ) ||
        pages.filter((other) =>
          other.lines.some(
            (candidate) =>
              candidate.text === line.text &&
              (isFooter(candidate, other) || candidate.y < other.height * 0.08) &&
              Math.abs(candidate.bottom / other.height - line.bottom / page.height) <= 1 / 256
          )
        ).length < 3
    )
  }))
  return matchFigureSequence(cleaned)
}
