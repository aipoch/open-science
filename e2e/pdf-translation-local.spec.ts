import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { expect } from '@playwright/test'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { PDF_TRANSLATION_MODEL_REVISIONS } from '../src/main/local-models/catalog'
import { createProjectDbClient } from '../src/main/projects/prisma-client'
import { literatureItemInputSchema } from '../src/shared/literature'
import type {
  PdfTranslationBeginRequest,
  PdfTranslationCheckpoint
} from '../src/shared/pdf-translation'
import { test } from './fixtures/electron-app'

// Opt-in local ONNX inference. Cached assets enter the normal install staging directory;
// production installation verifies every size/hash before publishing its receipt.
// No provider, user profile, credentials, or model download is used by this test.
const modelRoot = process.env.OPEN_SCIENCE_PDF_LOCAL_MODEL_DIR
const sources = ['The sky is blue.', 'Water is a liquid.']

test.skip(!modelRoot, 'Set OPEN_SCIENCE_PDF_LOCAL_MODEL_DIR to the cached Qwen ONNX model.')
test('runs local ONNX translation, cancellation and checkpoint recovery in built Electron', async ({
  app
}, testInfo) => {
  test.setTimeout(300_000)
  let page = await app.completeOnboarding()
  const work = await app.createTestDirectory('local-translation')
  const client = createProjectDbClient(join(dirname(work), 'storage'))
  const revision = PDF_TRANSLATION_MODEL_REVISIONS[0]
  const dataRoot = await page.evaluate(async () => (await window.api.storage.getInfo()).dataRoot)
  const fixtureRelative = relative(dirname(work), dataRoot)
  expect(isAbsolute(fixtureRelative) || fixtureRelative.startsWith('..')).toBe(false)
  const staging = join(dataRoot, 'models', 'pdf-translation', 'staging', revision.revision)
  const elapsed: Record<string, number> = {}
  try {
    expect(
      await page.evaluate(() => window.api.localModels.getSnapshot('pdf-translation'))
    ).toMatchObject({ availability: 'notInstalled', inUse: false })
    await mkdir(staging, { recursive: true })
    for (const asset of revision.assets) {
      const file = asset.file.endsWith('.onnx') ? join('onnx', asset.file) : asset.file
      await copyFile(resolve(modelRoot!, file), join(staging, asset.file))
    }
    const installStarted = performance.now()
    await page.evaluate(() => window.api.localModels.install('pdf-translation'))
    await expect
      .poll(async () => page.evaluate(() => window.api.localModels.getSnapshot('pdf-translation')))
      .toMatchObject({ availability: 'ready', installedRevision: revision.revision, inUse: false })
    elapsed.installMs = performance.now() - installStarted

    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    for (const source of sources)
      pdf.addPage([612, 792]).drawText(source, { font, x: 40, y: 710, size: 12 })
    const attachmentVersionId = await page.evaluate(
      async ({ bytes, item }) => {
        const created = await window.api.literature.transact({ kind: 'create-item', item })
        const transferId = crypto.randomUUID()
        const chunk = new Uint8Array(bytes)
        await window.api.uploads.beginTransfer({
          transferId,
          name: 'local-translation.pdf',
          mimeType: 'application/pdf',
          size: chunk.length
        })
        await window.api.uploads.appendTransfer({ transferId, offset: 0, chunk })
        const attachment = await window.api.uploads.finishTransfer({ transferId })
        const imported = await window.api.literature.importPdf({ itemId: created.id, attachment })
        return imported.item.attachments[0].versions[0].id
      },
      {
        bytes: [...(await pdf.save())],
        item: literatureItemInputSchema.parse({
          itemType: 'journalArticle',
          title: 'Local ONNX translation lifecycle'
        })
      }
    )
    const request: PdfTranslationBeginRequest = {
      resourceRequestKey: attachmentVersionId,
      attachmentVersionId,
      fingerprint: 'local-onnx-smoke-v1',
      targetId: 'local',
      language: 'Chinese',
      glossary: [],
      batchShortSources: false,
      sources
    }
    const operation = await page.evaluate(
      (request) => window.api.pdfTranslation!.begin(request),
      request
    )
    expect(operation.model).toMatchObject({ frameworkId: 'local-onnx', mode: 'local' })
    const started = performance.now()
    const first = await page.evaluate((request) => window.api.pdfTranslation!.translate(request), {
      operationId: operation.operationId,
      sourceIndex: 0,
      source: sources[0]
    })
    elapsed.firstInferenceMs = performance.now() - started
    expect(typeof first).toBe('string')
    expect(first).not.toBe('')
    const readCheckpoint = (): Promise<PdfTranslationCheckpoint | null> =>
      page.evaluate((id) => window.api.pdfTranslation!.readCheckpoint(id), attachmentVersionId)
    const saved = (await readCheckpoint())!
    expect(saved.translations).toEqual([first])
    expect(saved.model).toMatchObject({ mode: 'local', frameworkId: 'local-onnx' })

    const interrupted = page.evaluate((request) => window.api.pdfTranslation!.translate(request), {
      operationId: operation.operationId,
      sourceIndex: 1,
      source: sources[1]
    })
    // A durable attempt means execution has started, rather than cancelling an idle operation.
    await expect
      .poll(() => client.pdfTranslationUsage.count({ where: { status: 'started' } }))
      .toBe(1)
    await page.evaluate(
      (operationId) => window.api.pdfTranslation!.close({ operationId }),
      operation.operationId
    )
    expect(await interrupted).toMatchObject({ failure: 'cancelled' })
    expect((await readCheckpoint())!.translations).toEqual([first])
    await expect
      .poll(() => page.evaluate(() => window.api.localModels.getSnapshot('pdf-translation')))
      .toMatchObject({ availability: 'ready', inUse: false })

    page = await app.restart()
    const restored = (await readCheckpoint())!
    expect(restored.translations).toEqual([first])
    const resumed = await page.evaluate((request) => window.api.pdfTranslation!.begin(request), {
      ...request,
      checkpoint: { key: restored.key, revision: restored.revision }
    })
    const beforeReplay = await client.pdfTranslationUsage.count()
    const replay = await page.evaluate((request) => window.api.pdfTranslation!.translate(request), {
      operationId: resumed.operationId,
      sourceIndex: 0,
      source: sources[0]
    })
    expect(replay).toBe(first)
    expect(await client.pdfTranslationUsage.count()).toBe(beforeReplay)
    const resumeStarted = performance.now()
    const second = await page.evaluate((request) => window.api.pdfTranslation!.translate(request), {
      operationId: resumed.operationId,
      sourceIndex: 1,
      source: sources[1]
    })
    elapsed.resumedInferenceMs = performance.now() - resumeStarted
    expect(typeof second).toBe('string')
    expect(second).not.toBe('')
    await page.evaluate(
      (operationId) => window.api.pdfTranslation!.close({ operationId }),
      resumed.operationId
    )
    expect((await readCheckpoint())!.translations).toEqual([first, second])
    const usage = await client.pdfTranslationUsage.findMany({
      select: { frameworkId: true, providerId: true, sourceIndex: true, status: true },
      orderBy: { occurredAt: 'asc' }
    })
    expect(
      usage.every((row) => row.frameworkId === 'local-onnx' && row.providerId === 'local-onnx')
    ).toBe(true)
    expect(usage.map(({ sourceIndex, status }) => ({ sourceIndex, status }))).toEqual([
      { sourceIndex: 0, status: 'completed' },
      { sourceIndex: 1, status: 'interrupted' },
      { sourceIndex: 1, status: 'completed' }
    ])
    await expect
      .poll(() => page.evaluate(() => window.api.localModels.getSnapshot('pdf-translation')))
      .toMatchObject({ inUse: false })
    await page.evaluate(() => window.api.localModels.remove('pdf-translation'))
    expect(
      await page.evaluate(() => window.api.localModels.getSnapshot('pdf-translation'))
    ).toMatchObject({ availability: 'notInstalled', hasFiles: false, inUse: false })
    expect((await readCheckpoint())!.translations).toEqual([first, second])
    const evidencePath = testInfo.outputPath('local-onnx-lifecycle.json')
    await writeFile(
      evidencePath,
      JSON.stringify(
        {
          runtime: 'Electron + ONNX WebAssembly (CPU, one thread)',
          revision: revision.revision,
          elapsed,
          translations: [first, second],
          usage
        },
        null,
        2
      )
    )
    await testInfo.attach('local-onnx-lifecycle.json', {
      path: evidencePath,
      contentType: 'application/json'
    })
  } finally {
    await client.$disconnect()
  }
})
