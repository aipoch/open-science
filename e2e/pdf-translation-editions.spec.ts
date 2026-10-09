import { createServer } from 'node:http'
import { expect } from '@playwright/test'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { Page } from 'playwright'
import { extractPdfTranslationSource } from '../src/renderer/src/pages/workspace/previews/renderers/pdf-translation-extraction'
import {
  getPdfTranslationLayoutSnapshot,
  rememberPdfTranslationExtraction
} from '../src/renderer/src/pages/workspace/previews/renderers/pdf-translation-snapshot'
import { literatureItemInputSchema } from '../src/shared/literature'
import type { PdfTranslationLayoutSnapshot } from '../src/shared/pdf-translation-snapshot'
import type {
  PdfTranslationBeginRequest,
  PdfTranslationCheckpoint,
  PdfTranslationCheckpointRequest,
  PdfTranslationEdition
} from '../src/shared/pdf-translation'
import { test } from './fixtures/electron-app'

const sources = ['Measurement 1 examines cell growth.', 'Measurement 2 examines cell growth.']
const translation = (source: string, model: string): string =>
  model === 'edition-japanese'
    ? `測定 ${source.match(/\d+/u)![0]} は細胞増殖を調べます。`
    : `测量 ${source.match(/\d+/u)![0]} 检查细胞生长。`
const read = (
  page: Page,
  source: PdfTranslationCheckpointRequest
): Promise<PdfTranslationCheckpoint | null> =>
  page.evaluate((source) => window.api.pdfTranslation!.readCheckpoint(source), source)
const list = (
  page: Page,
  source: PdfTranslationCheckpointRequest
): Promise<PdfTranslationEdition[]> =>
  page.evaluate((source) => window.api.pdfTranslation!.listEditions(source), source)
const select = (
  page: Page,
  source: PdfTranslationCheckpointRequest,
  translationId: string
): Promise<PdfTranslationCheckpoint> =>
  page.evaluate((request) => window.api.pdfTranslation!.selectEdition(request), {
    source,
    translationId
  })

async function importWorkspace(
  page: Page,
  bytes: number[],
  cwd: string,
  name: string
): Promise<{
  projectId: string
  sessionId: string
  sourceKind: 'upload-version'
  sourceFileId: string
  versionId: string
}> {
  return page.evaluate(
    async ({ bytes, cwd, name }) => {
      const project = await window.api.projects.create({ name })
      const sessionId = crypto.randomUUID()
      const now = Date.now()
      const session = await window.api.sessions.saveSession({
        id: sessionId,
        projectId: project.id,
        title: name,
        cwd,
        status: 'idle',
        createdAt: now,
        updatedAt: now,
        messages: []
      })
      const transferId = crypto.randomUUID()
      const chunk = new Uint8Array(bytes)
      await window.api.uploads.beginTransfer({
        transferId,
        name: `${name}.pdf`,
        mimeType: 'application/pdf',
        size: chunk.length
      })
      await window.api.uploads.appendTransfer({ transferId, offset: 0, chunk })
      const staged = await window.api.uploads.finishTransfer({ transferId })
      const [uploaded] = await window.api.uploads.finalizeSession({
        projectId: project.id,
        sessionId,
        attachments: [staged]
      })
      await window.api.sessions.saveSession({
        ...session,
        updatedAt: Date.now(),
        messages: [
          {
            id: crypto.randomUUID(),
            role: 'user',
            content: 'Use this PDF.',
            status: 'complete',
            eventIds: [],
            createdAt: now,
            updatedAt: now,
            uploads: [uploaded]
          }
        ]
      })
      if (!uploaded.versionId) throw new Error('Missing immutable Upload Version.')
      return {
        projectId: project.id,
        sessionId,
        sourceKind: 'upload-version' as const,
        sourceFileId: uploaded.id,
        versionId: uploaded.versionId
      }
    },
    { bytes, cwd, name }
  )
}

async function importLiterature(page: Page, bytes: number[], name: string): Promise<string> {
  return page.evaluate(
    async ({ bytes, name, item }) => {
      const created = await window.api.literature.transact({ kind: 'create-item', item })
      const transferId = crypto.randomUUID()
      const chunk = new Uint8Array(bytes)
      await window.api.uploads.beginTransfer({
        transferId,
        name,
        mimeType: 'application/pdf',
        size: chunk.length
      })
      await window.api.uploads.appendTransfer({ transferId, offset: 0, chunk })
      const attachment = await window.api.uploads.finishTransfer({ transferId })
      const receipt = await window.api.literature.importPdf({ itemId: created.id, attachment })
      return receipt.item.attachments[0].versions[0].id
    },
    {
      bytes,
      name,
      item: literatureItemInputSchema.parse({ itemType: 'journalArticle', title: name })
    }
  )
}

test('shares PDF editions across independent projects and Literature after owner deletion and restart', async ({
  app
}, testInfo) => {
  test.setTimeout(180_000)
  await app.page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  const requests: { source: string; model: string }[] = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const payload = JSON.parse(body)
    const { source } = JSON.parse(payload.messages[1].content)
    requests.push({ source, model: payload.model })
    response.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        usage: { prompt_tokens: 80, completion_tokens: 12 },
        choices: [
          {
            finish_reason: 'stop',
            message: { role: 'assistant', content: translation(source, payload.model) }
          }
        ]
      })
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture provider port.')
    const providerIds = await page.evaluate(async (port) => {
      const ids: Record<string, string> = {}
      for (const model of ['edition-chinese', 'edition-japanese', 'edition-chinese-revised']) {
        const snapshot = await window.api.settings.upsertProvider({
          type: 'custom',
          name: model,
          model,
          apiEndpoints: ['openai'],
          baseUrl: `http://127.0.0.1:${port}`
        })
        ids[model] = snapshot.providers.find((provider) => provider.name === model)!.id
      }
      return ids
    }, address.port)
    const pdf = await PDFDocument.create()
    pdf.setTitle('One scientific paper')
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    for (const source of sources)
      pdf.addPage([612, 792]).drawText(source, { font, x: 40, y: 710, size: 12 })
    // Save once: independent imports have identical bytes but different names and owner IDs.
    const bytes = [...(await pdf.save())]
    const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true })
    let snapshot: PdfTranslationLayoutSnapshot
    try {
      const extraction = await extractPdfTranslationSource({
        document: await loading.promise,
        resourceRequestKey: 'edition-fixture',
        signal: new AbortController().signal
      })
      expect(extraction.source.units.map((unit) => unit.source)).toEqual(sources)
      rememberPdfTranslationExtraction(extraction)
      snapshot = getPdfTranslationLayoutSnapshot(extraction.source)!
    } finally {
      await loading.destroy()
    }
    const first = await importWorkspace(
      page,
      bytes,
      await app.createTestDirectory('edition-project-a'),
      'First edition owner'
    )
    const second = await importWorkspace(
      page,
      bytes,
      await app.createTestDirectory('edition-project-b'),
      'Independent second copy'
    )
    expect(first.projectId).not.toBe(second.projectId)
    expect(first.versionId).not.toBe(second.versionId)
    const libraryId = await importLiterature(page, bytes, 'library-editions.pdf')
    const resolved = await page.evaluate(
      (request) => window.api.bookmarks.resolvePdfSource(request),
      first
    )
    if (!resolved.ok) throw new Error('First Workspace PDF did not resolve.')
    const workspace = resolved.source
    const configurations = [
      {
        language: 'Chinese',
        modelId: 'edition-chinese',
        glossary: [{ source: 'cell', target: '细胞' }],
        concurrency: 1
      },
      {
        language: 'Japanese',
        modelId: 'edition-japanese',
        glossary: [{ source: 'cell', target: '細胞' }],
        concurrency: 4
      },
      {
        language: 'Chinese',
        modelId: 'edition-chinese-revised',
        glossary: [{ source: 'cell growth', target: '细胞生长' }],
        concurrency: 2
      }
    ] as const
    const saved: PdfTranslationCheckpoint[] = []
    for (const configuration of configurations) {
      const providerId = providerIds[configuration.modelId]
      const input: PdfTranslationBeginRequest = {
        resourceRequestKey: first.versionId,
        documentSource: workspace,
        fingerprint: snapshot.fingerprint,
        targetId: 'api',
        apiModel: { providerId, modelId: configuration.modelId },
        language: configuration.language,
        glossary: configuration.glossary,
        concurrency: configuration.concurrency,
        sources,
        batchShortSources: false,
        layoutSnapshot: {
          ...snapshot,
          // Keep real source geometry and PDF.js identity, with distinguishable edition unit IDs.
          units: snapshot.units.map((unit) => ({
            ...unit,
            id: `${configuration.modelId}-${unit.id}`
          }))
        }
      }
      const operation = await page.evaluate(
        (request) => window.api.pdfTranslation!.begin(request),
        input
      )
      expect(
        await page.evaluate((request) => window.api.pdfTranslation!.translate(request), {
          operationId: operation.operationId,
          sourceIndex: 0,
          source: sources[0]
        })
      ).toBe(translation(sources[0], configuration.modelId))
      await page.evaluate(
        (operationId) => window.api.pdfTranslation!.close({ operationId }),
        operation.operationId
      )
      const checkpoint = (await read(page, workspace))!
      expect(checkpoint).toMatchObject({
        language: configuration.language,
        glossary: configuration.glossary,
        concurrency: configuration.concurrency,
        model: { mode: 'api', providerId, modelId: configuration.modelId },
        layoutSnapshot: input.layoutSnapshot,
        translations: [translation(sources[0], configuration.modelId)],
        translatedSourceIndices: [0]
      })
      saved.push(checkpoint)
    }
    expect(new Set(saved.map((checkpoint) => checkpoint.key)).size).toBe(3)
    expect(requests).toHaveLength(3)

    // No translation lookup or preview has opened the second Project or Literature copy.
    // Their common content identity must retain editions even when the original owner is deleted.
    expect(
      await page.evaluate((id) => window.api.projects.delete({ id }), first.projectId)
    ).toEqual({
      status: 'deleted'
    })
    const next = await page.evaluate(
      (request) => window.api.bookmarks.resolvePdfSource(request),
      second
    )
    if (!next.ok) throw new Error('Second Workspace PDF did not resolve after owner deletion.')
    expect(next.source.checksum).toBe(workspace.checksum)
    for (const source of [next.source, libraryId]) {
      const editions = await list(page, source)
      expect(editions).toHaveLength(3)
      expect(editions.map((edition) => edition.key).sort()).toEqual(
        saved.map((checkpoint) => checkpoint.key).sort()
      )
      for (const checkpoint of saved) {
        const edition = editions.find((edition) => edition.key === checkpoint.key)!
        expect(edition).toMatchObject({
          language: checkpoint.language,
          glossary: checkpoint.glossary,
          concurrency: checkpoint.concurrency,
          model: checkpoint.model
        })
        const selected = await select(page, source, edition.id)
        expect(selected).toMatchObject({
          key: checkpoint.key,
          language: checkpoint.language,
          glossary: checkpoint.glossary,
          concurrency: checkpoint.concurrency,
          model: checkpoint.model,
          translations: checkpoint.translations,
          translatedSourceIndices: checkpoint.translatedSourceIndices,
          layoutSnapshot: checkpoint.layoutSnapshot
        })
        expect((await read(page, source))?.key).toEqual(editions[0].key)
      }
    }
    const editions = await list(page, libraryId)
    const japanese = editions.find((edition) => edition.language === 'Japanese')!
    await select(page, libraryId, japanese.id)
    page = await app.restart()
    expect((await read(page, libraryId))?.key).toEqual(editions[0].key)
    expect((await list(page, next.source)).map((edition) => edition.key).sort()).toEqual(
      saved.map((checkpoint) => checkpoint.key).sort()
    )
    expect(requests).toHaveLength(3)

    await page.getByRole('button', { name: 'Library', exact: true }).click()
    await page.getByRole('button', { name: 'All references', exact: true }).click()
    await page.getByRole('button', { name: 'Preview library-editions.pdf', exact: true }).click()
    await expect(page.locator('[data-pdf-preview-root]')).toBeVisible()
    await page.getByRole('button', { name: /^(Full-text translation|View translation)$/ }).click()
    const panel = page.locator('[data-pdf-translation-sidebar]')
    const picker = panel.getByRole('combobox', { name: 'Saved translations', exact: true })
    await expect(picker).toContainText('edition-chinese-revised')
    await picker.click()
    await page.getByRole('option', { name: /Japanese · edition-japanese/ }).click()
    await expect(picker).toContainText('Japanese')
    await expect(
      panel.getByRole('button', { name: 'Continue translation', exact: true })
    ).toBeEnabled()
    await expect(panel).not.toContainText('Could not prepare full text')
    await panel.getByRole('button', { name: '1 Translated', exact: true }).click()
    await expect(panel).toContainText(translation(sources[0], 'edition-japanese'))
    await picker.click()
    await page.getByRole('option', { name: /Chinese · edition-chinese-revised/ }).click()
    await expect(picker).toContainText('edition-chinese-revised')
    expect((await read(page, libraryId))?.key).toBe(saved[2].key)
    await expect(
      panel.getByRole('button', { name: 'Continue translation', exact: true })
    ).toBeEnabled()
    await expect(panel).not.toContainText('Could not prepare full text')
    await panel.getByRole('button', { name: '1 Translated', exact: true }).click()
    await expect(panel).toContainText(translation(sources[0], 'edition-chinese-revised'))
    await panel.getByRole('button', { name: 'Saved translation parameters', exact: true }).click()
    const parameters = page.getByRole('dialog', {
      name: 'Saved translation parameters',
      exact: true
    })
    await expect(parameters).toContainText('edition-chinese-revised')
    await expect(parameters).toContainText('cell growth → 细胞生长')
    await expect(parameters).toContainText('Concurrent translations')
    await expect(parameters).toContainText('2')
    expect(requests).toHaveLength(3)
    await page.keyboard.press('Escape')
    await page.screenshot({ path: testInfo.outputPath('shared-pdf-edition-picker.png') })
    const readable = panel.getByText(translation(sources[0], 'edition-chinese-revised'), {
      exact: true
    })
    await readable.scrollIntoViewIfNeeded()
    await expect(readable).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('shared-pdf-edition-text.png') })

    await panel.getByRole('button', { name: /^Translation settings(?: |$)/ }).click()
    await panel.getByRole('button', { name: 'New translation', exact: true }).click()
    const newTranslation = page.getByRole('dialog', { name: 'New translation', exact: true })
    const language = newTranslation.getByRole('combobox', { name: 'Target language', exact: true })
    await language.fill('Arabic')
    const unavailable =
      'This target language is not supported for translated PDFs. Choose a supported language.'
    await expect(
      newTranslation.getByRole('button', { name: 'Translate document', exact: true })
    ).toBeDisabled()
    await newTranslation.getByRole('group', { name: unavailable, exact: true }).focus()
    await expect(page.getByRole('tooltip')).toContainText(unavailable)
    await page.screenshot({ path: testInfo.outputPath('unsupported-language-preflight.png') })
    expect(requests).toHaveLength(3)
    await language.fill('Chinese')
    await expect(
      newTranslation.getByRole('button', { name: 'Translate document', exact: true })
    ).toBeEnabled()
    await newTranslation.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect((await read(page, libraryId))?.key).toBe(saved[2].key)

    // A matching PDF title is not a content identity: different bytes get no editions.
    const different = await PDFDocument.load(new Uint8Array(bytes))
    different.getPages()[0].drawText('Different scientific result.', { x: 40, y: 650, size: 12 })
    const otherId = await importLiterature(page, [...(await different.save())], 'same-title.pdf')
    expect(await list(page, otherId)).toEqual([])
    expect(await read(page, otherId)).toBeNull()
    await testInfo.attach('shared-pdf-editions', {
      body: JSON.stringify({ requests, editions, defaultKey: editions[0].key }),
      contentType: 'application/json'
    })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
