import { fileURLToPath } from 'node:url'
export const pdfTranslationResourceDirectory = (): string =>
  fileURLToPath(new URL('../resources/', import.meta.url))
export const pdfTranslationWorkerPath = (): string =>
  fileURLToPath(new URL('../resources/worker.mjs', import.meta.url))
