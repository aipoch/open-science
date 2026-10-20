import { fileURLToPath } from 'node:url'
import { createEngineAt } from './engine.js'
import type { PdfStructureEngine, PdfStructureEngineOptions } from './types.js'

export const createPdfStructureEngine = (options: PdfStructureEngineOptions): PdfStructureEngine =>
  createEngineAt(fileURLToPath(new URL('../resources/', import.meta.url)), options)
export { readWorkerResult } from './worker-result.js'
export type {
  PdfStructureEngine,
  PdfStructureEngineOptions,
  PdfStructureProcessRuntime
} from './types.js'
