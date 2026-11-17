import type { PptxParagraph } from '../../../../../shared/pptx-edit'

const EMU_PER_PIXEL = 9525
export type TextInsets = { left: number; right: number; top: number; bottom: number }
export const DEFAULT_TEXT_INSETS: TextInsets = {
  left: 91440,
  right: 91440,
  top: 45720,
  bottom: 45720
}

// Measure at document scale rather than preview zoom. The browser handles mixed sizes,
// font weights, line breaks and wrapping; the result is written back into the PPTX frame.
export const measureTextFrame = (
  paragraphs: PptxParagraph[],
  maxWidthEmu: number,
  insets: TextInsets = DEFAULT_TEXT_INSETS
): { w: number; h: number } => {
  const box = document.createElement('div')
  Object.assign(box.style, {
    position: 'fixed',
    left: '-100000px',
    top: '0',
    visibility: 'hidden',
    width: 'max-content',
    maxWidth: `${Math.max(1, (maxWidthEmu - insets.left - insets.right) / EMU_PER_PIXEL)}px`,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    fontFamily: 'Arial, sans-serif',
    fontSize: '18pt',
    lineHeight: '1.2'
  })
  for (const paragraph of paragraphs) {
    const line = document.createElement('div')
    for (const run of paragraph.runs) {
      const span = document.createElement('span')
      span.textContent = run.text || '\u200b'
      span.style.fontSize = `${run.sizePt ?? 18}pt`
      if (run.fontFamily) span.style.fontFamily = run.fontFamily
      if (run.bold) span.style.fontWeight = 'bold'
      if (run.italic) span.style.fontStyle = 'italic'
      line.appendChild(span)
    }
    if (!line.childNodes.length) line.textContent = '\u200b'
    box.appendChild(line)
  }
  if (!box.childNodes.length) box.textContent = '\u200b'
  document.body.appendChild(box)
  try {
    const rect = box.getBoundingClientRect()
    return {
      w: Math.max(91440, Math.ceil(rect.width * EMU_PER_PIXEL) + insets.left + insets.right),
      h: Math.max(91440, Math.ceil(rect.height * EMU_PER_PIXEL) + insets.top + insets.bottom)
    }
  } finally {
    box.remove()
  }
}
