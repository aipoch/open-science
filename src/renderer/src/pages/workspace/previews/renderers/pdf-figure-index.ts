import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'

export type PdfLinkDestination = Readonly<{ pageNumber: number; x: number; y: number }>

type TextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>
type TextRun = { text: string; x: number; y: number; width: number; height: number }

/** Panels refer to their parent figure. Compound and separately named series stay unresolved. */
export function figureReferenceKey(reference: string): string | undefined {
  const match = /^(?:Fig(?:ure)?\.?|图|圖)\s*(S?\d+)(?:[a-z]|\s*\([a-z]\))?$/iu.exec(
    reference.trim()
  )
  return match ? `figure:${match[1].toLowerCase()}` : undefined
}

export function endsWithFigureSeriesQualifier(text: string): boolean {
  return /(?:\bSupplementary|\bSupplemental|\bExtended[ \t]+Data|\bSupporting(?:[ \t]+Information)?|补充|補充|扩展数据|擴展資料)[ \t]*$/iu.test(
    text
  )
}

function captionRows(content: TextContent): TextRun[][] {
  const runs: TextRun[] = content.items.flatMap((item) => {
    if (!('str' in item) || !item.str.trim() || item.dir !== 'ltr') return []
    const [a, b, c, d, x, y] = item.transform
    const height = item.height || d
    if (
      ![a, b, c, d, x, y, item.width, height].every(Number.isFinite) ||
      a <= 0 ||
      d <= 0 ||
      Math.abs(b) > 0.01 ||
      Math.abs(c) > 0.01 ||
      item.width <= 0 ||
      height <= 0
    )
      return []
    return [{ text: item.str, x, y, width: item.width, height }]
  })
  runs.sort((a, b) => b.y - a.y || a.x - b.x)
  const rows: TextRun[][] = []
  for (const run of runs) {
    const row = rows.at(-1)
    if (row && Math.abs(row[0].y - run.y) <= Math.min(row[0].height, run.height) * 0.3)
      row.push(run)
    else rows.push([run])
  }
  return rows.flatMap((row) => {
    row.sort((a, b) => a.x - b.x)
    const segments: TextRun[][] = []
    for (const run of row) {
      const segment = segments.at(-1)
      const prior = segment?.at(-1)
      // Do not combine independent columns into a caption or borrow their label prefix.
      if (prior && run.x - prior.x - prior.width <= Math.max(prior.height, run.height) * 2)
        segment!.push(run)
      else segments.push([run])
    }
    return segments
  })
}

function rowText(row: TextRun[]): string {
  let text = ''
  let prior: TextRun | undefined
  for (const run of row) {
    if (prior && run.x - prior.x - prior.width > run.height * 0.1 && !text.endsWith(' '))
      text += ' '
    text += run.text
    prior = run
  }
  return text.trim()
}

// Extracted figures already have a caption role. Raw page text needs an explicit
// delimiter and description to distinguish a caption from a sentence starting "Figure 3".
export function figureCaptionKey(
  text: string,
  source: 'page-text' | 'extracted'
): string | undefined {
  const match = /^(?:Fig(?:ure)?\.?|图|圖)\s*(S?\d+)([\s\S]*)$/iu.exec(text.trim())
  if (!match) return undefined
  const tail = match[2]
  const description = /^\s*[.:：．。|]\s*(\S[\s\S]*)$/u.exec(tail)?.[1]
  if (source === 'page-text' && !description) return undefined
  if (tail && !/^[\s.:：．。|]/u.test(tail)) return undefined
  if (
    /^[.．]\d/u.test(tail) ||
    /^\s*(?:\([a-z]\)|[-–—/,，&]|(?:and\b|or\b|至|到|和|与|與|及)\s*S?\d)/iu.test(tail)
  )
    return undefined
  if (source === 'page-text' && description && /^[\d,，&–—-]/u.test(description)) return undefined
  return `figure:${match[1].toLowerCase()}`
}

/** Scan text only, releasing the event loop between pages and retaining no page text. */
export async function buildPdfFigureIndex(
  document: PDFDocumentProxy,
  signal: AbortSignal
): Promise<ReadonlyMap<string, PdfLinkDestination>> {
  const index = new Map<string, PdfLinkDestination>()
  const ambiguous = new Set<string>()
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    signal.throwIfAborted()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    signal.throwIfAborted()
    const page = await document.getPage(pageNumber)
    signal.throwIfAborted()
    const content = await page.getTextContent()
    signal.throwIfAborted()
    const viewport = page.getViewport({ scale: 1 })
    const rows = captionRows(content)
    for (const [i, row] of rows.entries()) {
      const key = figureCaptionKey(rowText(row), 'page-text')
      if (!key || ambiguous.has(key)) continue
      const first = row[0]
      // A wrapped series name belongs to the next line only within the same column.
      let preceding: TextRun[] | undefined
      for (let j = i - 1; j >= 0; j--) {
        const above = rows[j][0]
        if (above.y - first.y > first.height * 2) break
        if (above.y > first.y && Math.abs(above.x - first.x) <= first.height * 2) {
          preceding = rows[j]
          break
        }
      }
      if (preceding && endsWithFigureSeriesQualifier(rowText(preceding))) continue
      if (index.has(key)) {
        index.delete(key)
        ambiguous.add(key)
        continue
      }
      const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([
        first.x,
        first.y,
        first.x + first.width,
        first.y + first.height
      ])
      const x = Math.min(x1, x2) / viewport.width
      const y = Math.min(y1, y2) / viewport.height
      // Cropped-out labels cannot identify a visible destination.
      if (x < 0 || x > 1 || y < 0 || y > 1 || !Number.isFinite(x + y)) continue
      index.set(key, { pageNumber, x, y })
    }
  }
  return index
}
