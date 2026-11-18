export type PptxEditErrorCode =
  | 'INVALID_PACKAGE'
  | 'INVALID_XML'
  | 'INVALID_OPERATION'
  | 'SLIDE_NOT_FOUND'
  | 'SHAPE_NOT_FOUND'
  | 'UNSUPPORTED_SHAPE'
  | 'OUTPUT_TOO_LARGE'

export class PptxEditError extends Error {
  readonly code: PptxEditErrorCode

  constructor(code: PptxEditErrorCode, message: string) {
    super(message)
    this.name = 'PptxEditError'
    this.code = code
  }
}
