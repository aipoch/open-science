import { fileURLToPath } from 'node:url'
import { createEngineAt } from './engine.js'
import type { PdfStructureEngine, PdfStructureEngineOptions } from './types.js'

export const createPdfStructureEngine = (options: PdfStructureEngineOptions): PdfStructureEngine =>
  createEngineAt(fileURLToPath(new URL('../resources/', import.meta.url)), options)
export { readWorkerResult } from './worker-result.js'
export { isPdfStructureResourceLimitError, PDF_STRUCTURE_RESOURCE_LIMIT_CODE } from './errors.js'
export type { PdfStructureResourceLimitError } from './errors.js'
export type {
  PdfStructureEngine,
  PdfStructureEngineOptions,
  PdfStructureOcr,
  PdfStructureProcessRuntime
} from './types.js'
