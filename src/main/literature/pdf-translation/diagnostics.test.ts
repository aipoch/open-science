import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { ApplicationCallerLeaseRegistry } from '../../caller-lifecycle'
import { initLogger, flushLogs } from '../../logger'
import { PdfTranslationOwner } from './index'
import { ProviderTextGenerationError } from '../../settings/provider-text-generation'
import { PdfTranslationWriter } from './writer'
import { extractPdfTranslationSource } from '../../../renderer/src/pages/workspace/previews/renderers/pdf-translation-extraction'
vi.mock('electron', () => ({ net: {} }))

it('persists safe translation reasons and PDF fallback measurements in the diagnostic log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-diagnostics-'))
  initLogger({ logDir: root, mirrorToConsole: false })
  const registry = new ApplicationCallerLeaseRegistry()
  const caller = registry.acquire({ leaseId: 'diagnostics', surface: 'electron' })
  const marker = 'PRIVATE_RESEARCH_MARKER'
  const run = vi.fn().mockResolvedValue({ text: '细胞增加。', stopReason: 'end_turn' })
  const owner = new PdfTranslationOwner({
    usage: { start: async () => async () => {}, recover: async () => {}, flush: async () => {} },
    captureTarget: async () => ({
      frameworkId: 'claude-code',
      providerId: 'private-provider',
      model: { kind: 'required', id: 'private-model' },
      reasoningEffort: 'default'
    }),
    runner: {
      run,
      supportsTarget: () => true,
      shutdown: async () => {},
      sweepStaleProfiles: async () => {}
    }
  })
  const source = `Cells increased 12. ${marker}`
  let loading: ReturnType<typeof getDocument> | undefined
  try {
    const { operationId } = await owner.begin(
      {
        resourceRequestKey: marker,
        fingerprint: marker,
        language: 'Chinese',
        glossary: [{ source: marker, target: marker }],
        sources: [source],
        sourceLocations: [{ pageNumbers: [2, 3], fragmentCount: 3, source: marker } as never]
      },
      caller.lease
    )
    await expect(
      owner.translate({ operationId, sourceIndex: 0, source }, caller.lease)
    ).rejects.toThrow('numeric values')
    run.mockRejectedValueOnce(new ProviderTextGenerationError('incomplete-output', marker))
    await expect(
      owner.translate({ operationId, sourceIndex: 0, source }, caller.lease)
    ).rejects.toThrow('not finish')
    run.mockRejectedValueOnce(new Error(`[provider-failure:network:0] ${marker}`))
    await expect(
      owner.translate({ operationId, sourceIndex: 0, source }, caller.lease)
    ).rejects.toThrow(marker)
    run.mockImplementationOnce(
      async ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )
    const cancelled = owner.translate({ operationId, sourceIndex: 0, source }, caller.lease)
    const rejected = expect(cancelled).rejects.toMatchObject({ code: 'cancelled' })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(4))
    owner.close(operationId, caller.lease)
    await rejected
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    pdf.addPage([300, 300]).drawText('A short sentence.', { font, size: 10, x: 30, y: 200 })
    const bytes = await pdf.save()
    loading = getDocument({ data: bytes.slice(), useSystemFonts: true })
    const { source: extracted } = await extractPdfTranslationSource({
      document: await loading.promise,
      resourceRequestKey: 'diagnostic-pdf',
      signal: caller.lease.signal
    })
    const output = await new PdfTranslationWriter(() =>
      resolve('resources/pdf-translation/worker.mjs')
    ).generateDetailed(
      {
        id: 'diagnostic-pdf',
        data: bytes,
        pages: extracted.pages,
        preserveUnsupported: true,
        units: extracted.units.map((unit) => ({
          ...unit,
          translation: '这是很长的译文。'.repeat(1000)
        }))
      },
      caller.lease
    )
    expect(output?.data).toBeInstanceOf(Uint8Array)
    expect(output?.layoutFailures).toEqual([
      { unitIndex: 0, code: 'overflow', phase: 'planning', pageNumbers: [1], fragmentCount: 1 }
    ])
    await flushLogs()
    const contents = await readFile(join(root, 'main.log'), 'utf8')
    expect(contents).not.toContain(marker)
    expect(contents).not.toContain('细胞增加')
    expect(contents).not.toContain('private-provider')
    const records = contents
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(records).toContainEqual(
      expect.objectContaining({
        scope: 'pdf-translation',
        msg: 'paragraph failed',
        data: expect.objectContaining({
          stage: 'translation',
          failureCode: 'incomplete-output',
          reasonCode: 'missing-numeric-literals',
          blockIndex: 0,
          attempt: 1,
          pageNumbers: [2, 3],
          fragmentCount: 3,
          missingNumericCount: 1
        })
      })
    )
    expect(records).toContainEqual(
      expect.objectContaining({
        msg: 'paragraph failed',
        data: expect.objectContaining({
          failureCode: 'incomplete-output',
          reasonCode: 'incomplete-output',
          missingNumericCount: 0,
          attempt: 2
        })
      })
    )
    expect(records).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        msg: 'paragraph failed',
        data: expect.objectContaining({ reasonCode: 'network', kind: 'network', attempt: 3 })
      })
    )
    expect(records).toContainEqual(
      expect.objectContaining({
        level: 'debug',
        msg: 'paragraph cancelled',
        data: expect.objectContaining({
          failureCode: 'cancelled',
          reasonCode: 'cancelled',
          attempt: 4
        })
      })
    )
    expect(records).toContainEqual(
      expect.objectContaining({
        scope: 'pdf-translation-pdf',
        msg: 'translated paragraphs retained their original layout',
        data: expect.objectContaining({
          retainedCount: 1,
          retained: [expect.objectContaining({ unitIndex: 0, code: 'overflow', pageNumbers: [1] })]
        })
      })
    )
    expect(records).toContainEqual(
      expect.objectContaining({
        msg: 'PDF generated',
        data: expect.objectContaining({
          generationMs: expect.any(Number),
          pdfiumSaveMs: expect.any(Number),
          workerHeapUsedBytes: expect.any(Number)
        })
      })
    )
    expect(records.filter((record) => record.msg === 'PDF generated')).toHaveLength(1)
    expect(records.some((record) => record.msg === 'PDF generation measurements')).toBe(false)
  } finally {
    await loading?.destroy()
    await owner.shutdown()
    registry.dispose()
    await flushLogs()
    await rm(root, { recursive: true, force: true })
  }
})

it('returns every native layout failure while keeping diagnostic logs sampled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-layout-report-'))
  initLogger({ logDir: root, mirrorToConsole: false })
  const registry = new ApplicationCallerLeaseRegistry()
  const caller = registry.acquire({ leaseId: 'all-layout-reports', surface: 'electron' })
  try {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const units = Array.from({ length: 22 }, (_, index) => {
      pdf.addPage([300, 300]).drawText('A short sentence.', { font, size: 10, x: 30, y: 200 })
      return {
        source: 'A short sentence.',
        translation: '这是很长的译文。'.repeat(1000),
        fragments: [{ pageNumber: index + 1, rect: { x: 0.1, y: 0.29, width: 0.65, height: 0.06 } }]
      }
    })
    const result = await new PdfTranslationWriter(() =>
      resolve('resources/pdf-translation/worker.mjs')
    ).generateDetailed(
      {
        id: 'all-layout-reports',
        data: await pdf.save(),
        preserveUnsupported: true,
        pages: units.map(() => ({ width: 300, height: 300 })),
        units
      },
      caller.lease
    )
    expect(result?.layoutFailures).toHaveLength(22)
    expect(result?.layoutFailures.map((failure) => failure.unitIndex)).toEqual(
      units.map((_, index) => index)
    )
    expect(result?.layoutFailures.at(-1)).toMatchObject({
      unitIndex: 21,
      code: 'overflow',
      pageNumbers: [22]
    })
    await flushLogs()
    const records = (await readFile(join(root, 'main.log'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const retained = records.find(
      (record) => record.msg === 'translated paragraphs retained their original layout'
    ).data
    expect(retained.retainedCount).toBe(22)
    expect(retained.retained).toHaveLength(20)
  } finally {
    registry.dispose()
    await flushLogs()
    await rm(root, { recursive: true, force: true })
  }
})
