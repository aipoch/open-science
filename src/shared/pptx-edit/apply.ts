import { setChartText } from './charts'
import { EditContext } from './context'
import { readPresentation } from './deck'
import { PptxEditError } from './errors'
import { pptxOperationsSchema, type PptxOperation } from './operations'
import { loadPackage, savePackage } from './package'
import { replaceImage } from './images'
import { addTextbox, deleteShape, setFrame, setText } from './shapes'
import { addSlide, deleteSlide, duplicateSlide, moveSlide, setNotes } from './slides'
import { setTableCellText } from './tables'

export type PptxApplyResult = {
  bytes: Uint8Array
  summary: string
  slideCount: number
}

const run = (ctx: EditContext, op: PptxOperation): void => {
  switch (op.op) {
    case 'setText':
      return setText(ctx, op)
    case 'setFrame':
      return setFrame(ctx, op)
    case 'addTextbox':
      return addTextbox(ctx, op)
    case 'deleteShape':
      return deleteShape(ctx, op)
    case 'addSlide':
      return addSlide(ctx, op)
    case 'deleteSlide':
      return deleteSlide(ctx, op)
    case 'moveSlide':
      return moveSlide(ctx, op)
    case 'duplicateSlide':
      return duplicateSlide(ctx, op)
    case 'replaceImage':
      return replaceImage(ctx, op)
    case 'setNotes':
      return setNotes(ctx, op)
    case 'setTableCellText':
      return setTableCellText(ctx, op)
    case 'setChartText':
      return setChartText(ctx, op)
  }
}

const syncSlideCount = (ctx: EditContext, count: number): void => {
  if (!ctx.has('docProps/app.xml')) return
  const node = Array.from(ctx.doc('docProps/app.xml').getElementsByTagName('*')).find(
    (el) => el.localName === 'Slides'
  )
  if (node && node.textContent !== String(count)) {
    ctx.edit('docProps/app.xml')
    node.textContent = String(count)
  }
}

const summarize = (operations: PptxOperation[]): string => {
  const counts = new Map<string, number>()
  for (const op of operations) counts.set(op.op, (counts.get(op.op) ?? 0) + 1)
  return Array.from(counts, ([name, count]) => (count > 1 ? `${name} x${count}` : name)).join(', ')
}

export const applyOperations = (bytes: Uint8Array, input: unknown): PptxApplyResult => {
  const parsed = pptxOperationsSchema.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new PptxEditError(
      'INVALID_OPERATION',
      `Invalid operation at ${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'unknown'}`
    )
  }
  const ctx = new EditContext(loadPackage(bytes))
  for (const op of parsed.data) run(ctx, op)
  const slideCount = readPresentation(ctx).slides.length
  syncSlideCount(ctx, slideCount)
  ctx.flush()
  return { bytes: savePackage(ctx.pkg), summary: summarize(parsed.data), slideCount }
}
