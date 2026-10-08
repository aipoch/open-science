import { Worker } from 'node:worker_threads'
import { z } from 'zod'
import { createLogger, diagnosticErrorFields } from '../../logger'

const log = createLogger('pdf-translation-pdf')
const measurement = z.number().finite().nonnegative()
const workerDiagnostics = z.object({
  generationMs: measurement,
  pdfiumSaveMs: measurement,
  formLabelsMs: measurement,
  mergeMs: measurement,
  mergeSaveMs: measurement,
  workerHeapUsedBytes: measurement,
  workerExternalBytes: measurement,
  retainedCount: z.number().int().min(0).max(10000),
  retained: z
    .array(
      z.object({
        unitIndex: z.number().int().min(0).max(9999),
        code: z.enum([
          'annotations',
          'overflow',
          'unsupported-layout',
          'source-mismatch',
          'multi-region',
          'font'
        ]),
        phase: z.enum(['planning', 'ownership', 'glyphs']),
        pageNumbers: z.array(z.number().int().min(1).max(500)).max(500),
        fragmentCount: z.number().int().min(0).max(10000)
      })
    )
    .max(20)
})
import {
  PdfGenerationError,
  isPdfGenerationFailure,
  type PdfGenerationFailure,
  pdfTranslationLayoutFailureSchema,
  type PdfTranslationPdfResult,
  type PdfTranslationPdfRequest
} from '../../../shared/pdf-translation'
import type { ApplicationCallerLease } from '../../application-command-router'

// One bounded worker per request. Input/output are memory-only; no cache or source-file writes.
export class PdfTranslationWriter {
  private readonly active = new Map<
    string,
    { caller: ApplicationCallerLease; cancel: () => void }
  >()
  constructor(private readonly entry: () => string) {}

  async generate(
    input: PdfTranslationPdfRequest,
    caller: ApplicationCallerLease
  ): Promise<Uint8Array | null> {
    return (await this.generateDetailed(input, caller))?.data ?? null
  }

  async generateDetailed(
    input: PdfTranslationPdfRequest,
    caller: ApplicationCallerLease
  ): Promise<PdfTranslationPdfResult | null> {
    const startedAt = performance.now()
    caller.signal.throwIfAborted()
    if (!caller.isCurrent() || !this.valid(input)) {
      log.warn('PDF generation admission rejected', {
        stage: 'pdf-generation',
        failureCode: 'invalid-input'
      })
      throw new PdfGenerationError({ code: 'invalid-input' })
    }
    if (this.active.size >= 2 || this.active.has(input.id)) {
      log.warn('PDF generation admission rejected', {
        requestId: input.id,
        stage: 'pdf-generation',
        failureCode: 'busy'
      })
      throw new PdfGenerationError({ code: 'busy' })
    }
    let worker: Worker
    try {
      worker = new Worker(this.entry(), {
        workerData: input,
        resourceLimits: { maxOldGenerationSizeMb: 256 }
      })
    } catch (error) {
      log.warn('PDF worker could not start', {
        requestId: input.id,
        stage: 'pdf-generation',
        failureCode: 'worker-failed',
        ...diagnosticErrorFields(error)
      })
      throw new PdfGenerationError({ code: 'worker-failed' })
    }
    return new Promise((resolve, reject) => {
      let layoutFailures: PdfTranslationPdfResult['layoutFailures'] = []
      let measurements: Omit<z.infer<typeof workerDiagnostics>, 'retained'> | undefined
      let settled = false
      const finish = (data: Uint8Array | null, failure?: PdfGenerationFailure): void => {
        if (settled) return
        settled = true
        const fields = {
          requestId: input.id,
          stage: 'pdf-generation',
          durationMs: performance.now() - startedAt,
          inputBytes: input.data.byteLength,
          baselineBytes: input.incremental?.data.byteLength ?? 0,
          outputBytes: data?.byteLength ?? 0,
          pageCount: input.pages.length,
          changedPageCount: input.incremental?.pageNumbers.length ?? input.pages.length,
          unitCount: input.units.length,
          ...measurements,
          ...(failure ?? {})
        }
        if (failure) log.warn('PDF generation failed', fields)
        else log.info(data ? 'PDF generated' : 'PDF generation cancelled', fields)
        clearTimeout(timer)
        caller.signal.removeEventListener('abort', cancel)
        // Keep the slot occupied until the worker actually releases its WASM allocation.
        void worker
          .terminate()
          .catch(() => undefined)
          .finally(() => {
            this.active.delete(input.id)
            if (failure && caller.isCurrent()) reject(new PdfGenerationError(failure))
            else resolve(caller.isCurrent() && data ? { data, layoutFailures } : null)
          })
      }
      const cancel = (): void => finish(null)
      const timer = setTimeout(() => finish(null, { code: 'timeout' }), 60000)
      this.active.set(input.id, { caller, cancel })
      caller.signal.addEventListener('abort', cancel, { once: true })
      worker.once('message', (value) => {
        const reports = z
          .array(
            pdfTranslationLayoutFailureSchema.extend({
              unitIndex: z
                .number()
                .int()
                .min(0)
                .max(input.units.length - 1)
            })
          )
          .max(input.units.length)
          .safeParse(value?.layoutFailures ?? [])
        if (!reports.success) {
          finish(null, { code: 'worker-failed' })
          return
        }
        layoutFailures = reports.data

        const diagnostic = workerDiagnostics.safeParse(value?.diagnostics)
        if (diagnostic.success) {
          const { retained, ...metrics } = diagnostic.data
          measurements = metrics
          if (metrics.retainedCount)
            log.warn('translated paragraphs retained their original layout', {
              requestId: input.id,
              stage: 'pdf-layout',
              retainedCount: metrics.retainedCount,
              sampledCount: retained.length,
              retained
            })
        }
        const data = value?.data ?? value
        if (data instanceof Uint8Array && data.byteLength > 0 && data.byteLength <= 64 * 1024 ** 2)
          finish(data)
        else
          finish(
            null,
            isPdfGenerationFailure(value?.failure) ? value.failure : { code: 'worker-failed' }
          )
      })
      const failed = (): void => finish(null, { code: 'worker-failed' })
      worker.once('error', failed)
      worker.once('exit', failed)
      if (caller.signal.aborted) cancel()
    })
  }

  cancel(id: string, caller: ApplicationCallerLease): void {
    const operation = this.active.get(id)
    if (operation?.caller === caller) operation.cancel()
  }

  valid(input: PdfTranslationPdfRequest): boolean {
    if (
      !input ||
      (input.incremental !== undefined &&
        (!input.incremental || typeof input.incremental !== 'object')) ||
      (input.preserveUnsupported !== undefined && typeof input.preserveUnsupported !== 'boolean') ||
      typeof input.id !== 'string' ||
      !/^[\w-]{1,64}$/.test(input.id) ||
      !(input.data instanceof Uint8Array) ||
      !input.data.byteLength ||
      input.data.byteLength > 64 * 1024 ** 2 ||
      !Array.isArray(input.pages) ||
      !input.pages.length ||
      input.pages.length > 500 ||
      !input.pages.every(
        (p) => p && [p.width, p.height].every((n) => Number.isFinite(n) && n > 0 && n <= 14400)
      ) ||
      !Array.isArray(input.units) ||
      !input.units.length ||
      input.units.length > 10000
    )
      return false
    if (input.incremental) {
      const { data, pageNumbers } = input.incremental
      if (
        !(data instanceof Uint8Array) ||
        !data.byteLength ||
        data.byteLength > 64 * 1024 ** 2 ||
        !Array.isArray(pageNumbers) ||
        !pageNumbers.length ||
        pageNumbers.length > input.pages.length ||
        new Set(pageNumbers).size !== pageNumbers.length ||
        !pageNumbers.every(
          (page) => Number.isInteger(page) && page >= 1 && page <= input.pages.length
        )
      )
        return false
      const changed = new Set(pageNumbers)
      // A joined paragraph must be repainted as a whole, including its other pages.
      if (
        input.units.some(
          (unit) =>
            Array.isArray(unit?.fragments) &&
            unit.fragments.some(
              (fragment: PdfTranslationPdfRequest['units'][number]['fragments'][number]) =>
                fragment && changed.has(fragment.pageNumber)
            ) &&
            unit.fragments.some(
              (fragment: PdfTranslationPdfRequest['units'][number]['fragments'][number]) =>
                !fragment || !changed.has(fragment.pageNumber)
            )
        )
      )
        return false
    }
    let characters = 0
    let fragments = 0
    return input.units.every((unit) => {
      if (
        !unit ||
        typeof unit.source !== 'string' ||
        !unit.source.trim() ||
        typeof unit.translation !== 'string' ||
        !unit.translation.trim() ||
        unit.source.length > 100000 ||
        unit.translation.length > 100000 ||
        !Array.isArray(unit.fragments)
      )
        return false
      characters += unit.source.length + unit.translation.length
      fragments += unit.fragments.length
      return (
        characters <= 2_000_000 &&
        fragments <= 10000 &&
        unit.fragments.length > 0 &&
        unit.fragments.length <= 500 &&
        unit.fragments.every(
          (f: PdfTranslationPdfRequest['units'][number]['fragments'][number]) =>
            f &&
            Number.isInteger(f.pageNumber) &&
            f.pageNumber >= 1 &&
            f.pageNumber <= input.pages.length &&
            f.rect &&
            [f.rect.x, f.rect.y, f.rect.width, f.rect.height].every(Number.isFinite) &&
            f.rect.x >= 0 &&
            f.rect.y >= 0 &&
            f.rect.width > 0 &&
            f.rect.height > 0 &&
            f.rect.x + f.rect.width <= 1 &&
            f.rect.y + f.rect.height <= 1
        )
      )
    })
  }
}
