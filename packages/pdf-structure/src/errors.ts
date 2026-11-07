export const PDF_STRUCTURE_RESOURCE_LIMIT_CODE = 'PDF_RESOURCE_LIMIT'

export type PdfStructureResourceLimitError = Error & {
  code: typeof PDF_STRUCTURE_RESOURCE_LIMIT_CODE
}

export const isPdfStructureResourceLimitError = (
  error: unknown
): error is PdfStructureResourceLimitError =>
  error instanceof Error &&
  (error as Partial<PdfStructureResourceLimitError>).code === PDF_STRUCTURE_RESOURCE_LIMIT_CODE
