import type { PptxParagraph } from '../../../../../shared/pptx-edit'

export type TextRun = PptxParagraph['runs'][number]
export type TextFormat = Omit<TextRun, 'text' | 'sourceRun'>
export const paragraphsText = (paragraphs: PptxParagraph[]): string =>
  paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('\n')

export const formatTextRange = (
  paragraphs: PptxParagraph[],
  start: number,
  end: number,
  format: TextFormat
): PptxParagraph[] => {
  let offset = 0
  return paragraphs.map((paragraph) => {
    const runs = paragraph.runs.flatMap((run) => {
      const left = Math.max(0, start - offset)
      const right = Math.min(run.text.length, end - offset)
      offset += run.text.length
      if (left >= right) return [run]
      return [
        ...(left ? [{ ...run, text: run.text.slice(0, left) }] : []),
        { ...run, ...format, text: run.text.slice(left, right) },
        ...(right < run.text.length ? [{ ...run, text: run.text.slice(right) }] : [])
      ]
    })
    offset += 1
    return { runs }
  })
}

// Keep formatting outside the edited range, including when typing or pasting new paragraphs.
export const replaceText = (paragraphs: PptxParagraph[], value: string): PptxParagraph[] => {
  const old = paragraphsText(paragraphs)
  let start = 0
  while (start < old.length && start < value.length && old[start] === value[start]) start++
  let end = old.length
  let nextEnd = value.length
  while (end > start && nextEnd > start && old[end - 1] === value[nextEnd - 1]) {
    end--
    nextEnd--
  }
  const chars: TextRun[] = []
  paragraphs.forEach((p, i) => {
    if (i) chars.push({ text: '\n' })
    p.runs.forEach((run) => {
      for (let j = 0; j < run.text.length; j++) chars.push({ ...run, text: run.text[j]! })
    })
  })
  const style = chars[start > 0 ? start - 1 : start] ?? { text: '' }
  chars.splice(
    start,
    end - start,
    ...value
      .slice(start, nextEnd)
      .split('')
      .map((text) => ({ ...style, text }))
  )
  const result: PptxParagraph[] = [{ runs: [] }]
  chars.forEach((run) => {
    if (run.text === '\n') {
      result.push({ runs: [] })
      return
    }
    const runs = result[result.length - 1]!.runs
    const last = runs[runs.length - 1]
    const format = { ...run, text: '' }
    const lastFormat = { ...last, text: '' }
    if (last && JSON.stringify(format) === JSON.stringify(lastFormat)) last.text += run.text
    else runs.push({ ...run })
  })
  return result
}

export const selectedTextRuns = (
  paragraphs: PptxParagraph[],
  start: number,
  end: number
): TextRun[] => {
  let offset = 0
  return paragraphs.flatMap((p) => {
    const runs = p.runs.filter((r) => {
      const hit = offset < end && offset + r.text.length > start
      offset += r.text.length
      return hit
    })
    offset++
    return runs
  })
}
