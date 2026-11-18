export { applyOperations, type PptxApplyResult } from './apply'
export type { ChartOutline } from './charts'
export { PptxEditError, type PptxEditErrorCode } from './errors'
export {
  PPTX_EDIT_MAX_IMAGE_BASE64_CHARS,
  PPTX_EDIT_MAX_OPERATIONS,
  pptxOperationSchema,
  pptxOperationsSchema,
  type PptxOperation,
  type PptxParagraph
} from './operations'
export { readOutline, type DeckOutline, type ShapeOutline, type SlideOutline } from './outline'
export {
  diffPptxOutlines,
  type PptxOutlineDiff,
  type PptxSlideChange,
  type PptxSlideDiff
} from './diff'
