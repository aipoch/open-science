import { createServer, type ServerResponse } from 'node:http'
import { basename, dirname } from 'node:path'
import { expect } from '@playwright/test'
import type { Page } from 'playwright'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { createProjectDbClient } from '../src/main/projects/prisma-client'
import { literatureItemInputSchema } from '../src/shared/literature'
import type {
  PdfTranslationBeginRequest,
  PdfTranslationBeginResult,
  PdfTranslationCheckpoint,
  PdfTranslationRunResult
} from '../src/shared/pdf-translation'
import { test } from './fixtures/electron-app'

// Real built main/preload/IPC/SQLite with a deterministic local provider. These tests
// measure recovery semantics, not model quality. Every database belongs to the fixture.
const sources = [
  'Measurement 1 examines cell growth.',
  'Measurement 2 examines cell growth.',
  'Measurement 3 examines cell growth.'
]
const translation = (source: string): string => `测量 ${source.match(/\d+/u)![0]} 检查细胞生长。`
const begin = (
  page: Page,
  request: PdfTranslationBeginRequest
): Promise<PdfTranslationBeginResult> =>
  page.evaluate((request) => window.api.pdfTranslation!.begin(request), request)
const translate = (
  page: Page,
  operationId: string,
  sourceIndex: number
): Promise<PdfTranslationRunResult> =>
  page.evaluate((request) => window.api.pdfTranslation!.translate(request), {
    operationId,
    sourceIndex,
    source: sources[sourceIndex]
  })
const read = (page: Page, id: string): Promise<PdfTranslationCheckpoint | null> =>
  page.evaluate((id) => window.api.pdfTranslation!.readCheckpoint(id), id)
const close = (page: Page, operationId: string): Promise<void> =>
  page.evaluate((operationId) => window.api.pdfTranslation!.close({ operationId }), operationId)

async function importDocument(page: Page, name: string): Promise<string> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(name)
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (const source of sources)
    pdf.addPage([612, 792]).drawText(source, { font, x: 40, y: 710, size: 12 })
  return page.evaluate(
    async ({ item, bytes, name }) => {
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
      item: literatureItemInputSchema.parse({ itemType: 'journalArticle', title: name }),
      bytes: [...(await pdf.save())],
      name
    }
  )
}

test('reuses a managed Workspace PDF translation in Literature without repeating model requests', async ({
  app
}, testInfo) => {
  test.setTimeout(180000)
  await app.page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  const cwd = await app.createTestDirectory('translation-shared-source')
  const requests: string[] = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const source = JSON.parse(JSON.parse(body).messages[1].content).source as string
    requests.push(source)
    response.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        usage: { prompt_tokens: 80, completion_tokens: 12 },
        choices: [
          { finish_reason: 'stop', message: { role: 'assistant', content: translation(source) } }
        ]
      })
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture provider port.')
    const providerId = await page.evaluate(async (port) => {
      const snapshot = await window.api.settings.upsertProvider({
        type: 'custom',
        name: 'Shared PDF test provider',
        model: 'shared-pdf-test',
        apiEndpoints: ['openai'],
        baseUrl: `http://127.0.0.1:${port}`
      })
      return snapshot.providers.find((provider) => provider.name === 'Shared PDF test provider')!.id
    }, address.port)
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    for (const source of sources)
      pdf.addPage([612, 792]).drawText(source, { font, x: 40, y: 710, size: 12 })
    // Both transfers use these exact bytes, including identical PDF metadata.
    const bytes = [...(await pdf.save())]
    const workspace = await page.evaluate(
      async ({ bytes, cwd }) => {
        const project = await window.api.projects.create({ name: 'Shared PDF translation' })
        const sessionId = crypto.randomUUID()
        const now = Date.now()
        const session = await window.api.sessions.saveSession({
          id: sessionId,
          projectId: project.id,
          title: 'PDF owner',
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
          name: 'shared-workspace.pdf',
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
        if (!uploaded.versionId) throw new Error('Missing managed Upload Version.')
        const resolved = await window.api.bookmarks.resolvePdfSource({
          projectId: project.id,
          sessionId,
          sourceKind: 'upload-version',
          sourceFileId: uploaded.id,
          versionId: uploaded.versionId
        })
        if (!resolved.ok) throw new Error('Managed Workspace PDF did not resolve.')
        return resolved.source
      },
      { bytes, cwd }
    )
    const input: PdfTranslationBeginRequest = {
      resourceRequestKey: 'shared-workspace',
      documentSource: workspace,
      fingerprint: 'shared-source-fixture-v1',
      targetId: 'api',
      apiModel: { providerId, modelId: 'shared-pdf-test' },
      language: 'Chinese',
      glossary: [],
      sources,
      batchShortSources: false,
      layoutSnapshot: {
        version: 1,
        parserVersion: 'shared-source-fixture-parser',
        fingerprint: 'shared-source-fixture-v1',
        pages: sources.map(() => ({ width: 612, height: 792 })),
        units: sources.map((source, index) => ({
          id: `saved-${index}`,
          source,
          fragments: [
            {
              pageNumber: index + 1,
              rect: { x: 0.05, y: 0.05, width: 0.8, height: 0.1 },
              items: [{ index: 0, text: source }]
            }
          ]
        })),
        coverage: {
          pageCount: 3,
          textItemCount: 3,
          includedItemCount: 3,
          excludedItemCount: 0,
          pagesWithoutText: [],
          exclusions: [],
          warnings: []
        }
      }
    }
    const operation = await begin(page, input)
    expect(await translate(page, operation.operationId, 0)).toBe(translation(sources[0]))
    await close(page, operation.operationId)
    const saved = (await page.evaluate(
      (source) => window.api.pdfTranslation!.readCheckpoint(source),
      workspace
    ))!
    expect(saved.layoutSnapshot).toEqual(input.layoutSnapshot)
    const libraryId = await page.evaluate(
      async ({ bytes, item }) => {
        const created = await window.api.literature.transact({ kind: 'create-item', item })
        const transferId = crypto.randomUUID(),
          chunk = new Uint8Array(bytes)
        await window.api.uploads.beginTransfer({
          transferId,
          name: 'shared-library.pdf',
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
        item: literatureItemInputSchema.parse({
          itemType: 'journalArticle',
          title: 'Shared PDF translation'
        })
      }
    )
    await page.getByRole('button', { name: 'Library', exact: true }).click()
    await page.getByRole('button', { name: 'All references', exact: true }).click()
    await page.getByRole('button', { name: 'Preview shared-library.pdf', exact: true }).click()
    await expect(page.locator('[data-pdf-preview-root]')).toBeVisible()
    const adopted = (await read(page, libraryId))!
    expect(adopted).toMatchObject({
      key: saved.key,
      revision: saved.revision,
      checksum: workspace.checksum,
      attachmentVersionId: libraryId,
      translations: saved.translations,
      layoutSnapshot: saved.layoutSnapshot
    })
    expect(adopted.documentSource).toBeUndefined()
    expect(requests).toEqual([sources[0]])
    // A built-app restart must load the same pinned layout through the new access path.
    page = await app.restart()
    const restored = (await read(page, libraryId))!
    expect(restored).toEqual(adopted)
    expect(requests).toEqual([sources[0]])
    const resumed = await begin(page, {
      ...input,
      documentSource: undefined,
      attachmentVersionId: libraryId,
      resourceRequestKey: libraryId,
      checkpoint: { key: restored.key, revision: restored.revision }
    })
    expect(await translate(page, resumed.operationId, 0)).toBe(translation(sources[0]))
    expect(requests).toEqual([sources[0]])
    expect(await translate(page, resumed.operationId, 1)).toBe(translation(sources[1]))
    await close(page, resumed.operationId)
    const continued = (await page.evaluate(
      (source) => window.api.pdfTranslation!.readCheckpoint(source),
      workspace
    ))!
    expect(continued).toMatchObject({
      key: saved.key,
      documentSource: workspace,
      translations: sources.slice(0, 2).map(translation),
      translatedSourceIndices: [0, 1],
      layoutSnapshot: saved.layoutSnapshot
    })
    expect(requests).toEqual(sources.slice(0, 2))
    await testInfo.attach('shared-source-request-counts', {
      body: JSON.stringify({ requests, checkpointKey: saved.key }),
      contentType: 'application/json'
    })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

for (const scenario of [
  'force-exit',
  'multiwindow',
  'write-failure',
  'network-restart',
  'retry-restart',
  'cancel-restart'
] as const) {
  test(`preserves PDF translation checkpoints through ${scenario}`, async ({ app }, testInfo) => {
    test.setTimeout(120000)
    await app.page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
    await app.completeOnboarding()
    let page = await app.configureFakeAgent()
    const requests: string[] = []
    const held: ServerResponse[] = []
    let holdThird = scenario === 'force-exit'
    let recoveryPending = true
    const respond = (response: ServerResponse, content: string): void => {
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          usage: { prompt_tokens: 80, completion_tokens: 12 },
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }]
        })
      )
    }
    const server = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      const payload = JSON.parse(body)
      const input = JSON.parse(payload.messages[1].content)
      requests.push(input.source)
      if (recoveryPending && input.source === sources[1] && scenario === 'network-restart') {
        response.destroy()
        return
      }
      if (recoveryPending && input.source === sources[1] && scenario === 'retry-restart') {
        respond(response, '检查细胞生长。')
        return
      }
      if (recoveryPending && input.source === sources[1] && scenario === 'cancel-restart') {
        held.push(response)
        return
      }
      if (
        (holdThird && input.source === sources[2]) ||
        (scenario === 'multiwindow' && input.source === sources[1])
      ) {
        held.push(response)
        return
      }
      const content =
        scenario === 'force-exit' && input.source === sources[1]
          ? '检查细胞生长。' // Deliberately missing required 2: persisted paragraph failure.
          : translation(input.source)
      respond(response, content)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture provider port.')
    const providerId = await page.evaluate(async (port) => {
      const snapshot = await window.api.settings.upsertProvider({
        type: 'custom',
        name: 'Recovery test provider',
        model: 'recovery-test',
        apiEndpoints: ['openai'],
        baseUrl: `http://127.0.0.1:${port}`
      })
      return snapshot.providers.find((provider) => provider.name === 'Recovery test provider')!.id
    }, address.port)
    const document = await importDocument(page, 'recovery-a.pdf')
    const input: PdfTranslationBeginRequest = {
      resourceRequestKey: document,
      attachmentVersionId: document,
      fingerprint: 'recovery-fixture-v1',
      targetId: 'api',
      apiModel: { providerId, modelId: 'recovery-test' },
      language: 'Chinese',
      glossary: [],
      sources,
      layoutSnapshot: {
        version: 1,
        parserVersion: 'recovery-fixture-parser',
        fingerprint: 'recovery-fixture-v1',
        pages: sources.map(() => ({ width: 612, height: 792 })),
        units: sources.map((source, index) => ({
          id: `saved-unit-${index}`,
          source,
          fragments: [
            {
              pageNumber: index + 1,
              rect: { x: 0.05, y: 0.05, width: 0.8, height: 0.1 },
              items: [{ index: 0, text: source }]
            }
          ]
        })),
        coverage: {
          pageCount: 3,
          textItemCount: 3,
          includedItemCount: 3,
          excludedItemCount: 0,
          pagesWithoutText: [],
          exclusions: [],
          warnings: []
        }
      },
      batchShortSources: false,
      sourceLocations: sources.map((_, index) => ({ pageNumbers: [index + 1], fragmentCount: 1 }))
    }
    let client: ReturnType<typeof createProjectDbClient> | undefined
    try {
      const first = await begin(page, input)
      expect(await translate(page, first.operationId, 0)).toBe(translation(sources[0]))
      const savedFirst = (await read(page, document))!
      expect(savedFirst.translations).toEqual([translation(sources[0])])
      expect(savedFirst.layoutSnapshot).toEqual(input.layoutSnapshot)
      if (
        scenario === 'network-restart' ||
        scenario === 'retry-restart' ||
        scenario === 'cancel-restart'
      ) {
        if (scenario === 'network-restart') {
          await expect(translate(page, first.operationId, 1)).rejects.toThrow()
        } else if (scenario === 'retry-restart') {
          expect(await translate(page, first.operationId, 1)).toMatchObject({
            failure: 'incomplete-output'
          })
        } else {
          const pending = translate(page, first.operationId, 1)
          await expect.poll(() => held.length).toBe(1)
          await close(page, first.operationId)
          expect(await pending).toMatchObject({ failure: 'cancelled' })
        }
        const interrupted = (await read(page, document))!
        expect(interrupted.translatedSourceIndices).toEqual([0])
        if (scenario === 'cancel-restart') expect(interrupted.failures ?? []).toEqual([])
        else
          expect(interrupted.failures).toMatchObject([
            { sourceIndex: 1, disposition: 'retryable', pageNumbers: [2] }
          ])
        const attemptsBeforeRestart = requests.filter((source) => source === sources[1]).length
        page = await app.restartAfterCrash({ force: true })
        recoveryPending = false
        const restored = (await read(page, document))!
        expect(restored.translations).toEqual(interrupted.translations)
        expect(restored.failures).toEqual(interrupted.failures)
        const resumed = await begin(page, {
          ...input,
          checkpoint: { key: restored.key, revision: restored.revision }
        })
        expect(await translate(page, resumed.operationId, 0)).toBe(translation(sources[0]))
        expect(await translate(page, resumed.operationId, 1)).toBe(translation(sources[1]))
        expect(await translate(page, resumed.operationId, 2)).toBe(translation(sources[2]))
        const complete = (await read(page, document))!
        expect(complete.translatedSourceIndices).toEqual([0, 1, 2])
        expect(complete.failedSourceIndices ?? []).toEqual([])
        expect(complete.failures ?? []).toEqual([])
        expect(requests.filter((source) => source === sources[0])).toHaveLength(1)
        expect(requests.filter((source) => source === sources[1])).toHaveLength(
          attemptsBeforeRestart + 1
        )
        await close(page, resumed.operationId)
      } else if (scenario === 'force-exit') {
        expect(await translate(page, first.operationId, 1)).toMatchObject({
          failure: 'incomplete-output'
        })
        await page.evaluate((request) => window.api.pdfTranslation!.skip(request), {
          operationId: first.operationId,
          sourceIndex: 1,
          source: sources[1]
        })
        const beforeCrash = (await read(page, document))!
        expect(beforeCrash.failures).toEqual([
          {
            sourceIndex: 1,
            disposition: 'skipped',
            reasonCode: 'missing-numeric-literals',
            pageNumbers: [2],
            attempts: 1
          }
        ])
        // Catch the expected renderer disconnection before force-killing the process tree.
        const inFlight = translate(page, first.operationId, 2).catch(() => undefined)
        await expect.poll(() => held.length).toBe(1)
        page = await app.restartAfterCrash({ force: true })
        expect((await read(page, document))!.layoutSnapshot).toEqual(input.layoutSnapshot)
        await inFlight
        holdThird = false
        const restored = (await read(page, document))!
        expect(restored.translations).toEqual(beforeCrash.translations)
        expect(restored.failures).toEqual(beforeCrash.failures)
        const resumed = await begin(page, {
          ...input,
          checkpoint: { key: restored.key, revision: restored.revision }
        })
        expect(await translate(page, resumed.operationId, 0)).toBe(translation(sources[0]))
        expect(requests.filter((source) => source === sources[0])).toHaveLength(1)
        expect(await translate(page, resumed.operationId, 2)).toBe(translation(sources[2]))
        const done = (await read(page, document))!
        expect(done.translatedSourceIndices).toEqual([0, 2])
        expect(done.translations).toEqual([translation(sources[0]), translation(sources[2])])
        expect(done.failures).toEqual(beforeCrash.failures)
        // Uncommitted in-flight requests can repeat after a process crash; committed ones cannot.
        expect(requests.filter((source) => source === sources[2])).toHaveLength(2)
        await close(page, resumed.operationId)
      } else if (scenario === 'multiwindow') {
        const secondPage = await app.openAdditionalRenderer()
        const otherDocument = await importDocument(secondPage, 'recovery-b.pdf')
        const second = await begin(secondPage, {
          ...input,
          resourceRequestKey: otherDocument,
          attachmentVersionId: otherDocument
        })
        // Two real renderer leases write separate documents concurrently.
        const pending = translate(page, first.operationId, 1)
        await expect.poll(() => held.length).toBe(1)
        expect(await translate(secondPage, second.operationId, 0)).toBe(translation(sources[0]))
        await secondPage.evaluate((request) => window.api.pdfTranslation!.skip(request), {
          operationId: second.operationId,
          sourceIndex: 1,
          source: sources[1]
        })
        expect((await read(page, otherDocument))!.failures).toEqual([
          {
            sourceIndex: 1,
            disposition: 'skipped',
            reasonCode: 'skipped',
            pageNumbers: [2],
            attempts: 0
          }
        ])
        expect((await read(secondPage, document))!.failures ?? []).toEqual([])
        await page.getByRole('button', { name: 'Library', exact: true }).click()
        await page.getByRole('button', { name: 'All references', exact: true }).click()
        for (const name of ['recovery-a.pdf', 'recovery-b.pdf', 'recovery-a.pdf']) {
          await page.getByRole('button', { name: `Preview ${name}`, exact: true }).click()
          await expect(page.locator('[data-pdf-preview-root]')).toBeVisible()
          await page.getByRole('button', { name: `Close preview of ${name}`, exact: true }).click()
        }
        expect((await read(secondPage, document))!.translations).toEqual([translation(sources[0])])
        expect((await read(page, otherDocument))!.translations).toEqual([translation(sources[0])])
        // The active immutable source is owned by the first renderer. A second window
        // must be rejected before it can issue a duplicate model request.
        await expect(
          begin(secondPage, {
            ...input,
            checkpoint: { key: savedFirst.key, revision: savedFirst.revision }
          })
        ).rejects.toThrow('document-busy')
        expect(requests.filter((source) => source === sources[1])).toHaveLength(1)
        respond(held[0], translation(sources[1]))
        expect(await pending).toBe(translation(sources[1]))
        expect((await read(page, document))!.translations).toHaveLength(2)
        await close(page, first.operationId)
        await close(secondPage, second.operationId)
        const current = (await read(secondPage, document))!
        const resumed = await begin(secondPage, {
          ...input,
          checkpoint: { key: current.key, revision: current.revision }
        })
        const count = requests.length
        expect(await translate(secondPage, resumed.operationId, 0)).toBe(translation(sources[0]))
        expect(await translate(secondPage, resumed.operationId, 1)).toBe(translation(sources[1]))
        expect(requests).toHaveLength(count)
        await close(secondPage, resumed.operationId)
      } else {
        const dataRoot = await page.evaluate(
          async () => (await window.api.storage.getInfo()).dataRoot
        )
        expect(dataRoot).toContain('open-science-electron-e2e-')
        expect(basename(dirname(dataRoot))).toBe('storage')
        client = createProjectDbClient(dirname(dataRoot))
        // Real SQLite transaction failure, not a mocked IPC response. The previous commit survives.
        await client.$executeRawUnsafe(
          "CREATE TRIGGER recovery_fail_write BEFORE INSERT ON PdfTranslationBlock WHEN NEW.sourceIndex = 1 BEGIN SELECT RAISE(ABORT, 'synthetic checkpoint write failure'); END"
        )
        await expect(translate(page, first.operationId, 1)).rejects.toThrow('checkpoint-failed')
        expect((await read(page, document))!.translations).toEqual(savedFirst.translations)
        expect((await read(page, document))!.failures ?? []).toEqual([])
        await client.$executeRawUnsafe('DROP TRIGGER recovery_fail_write')
        await client.$disconnect()
        client = undefined
        await close(page, first.operationId)
        page = await app.restart()
        const restored = (await read(page, document))!
        const resumed = await begin(page, {
          ...input,
          checkpoint: { key: restored.key, revision: restored.revision }
        })
        expect(await translate(page, resumed.operationId, 0)).toBe(translation(sources[0]))
        expect(await translate(page, resumed.operationId, 1)).toBe(translation(sources[1]))
        expect(requests.filter((source) => source === sources[0])).toHaveLength(1)
        expect(requests.filter((source) => source === sources[1])).toHaveLength(2)
        expect((await read(page, document))!.translations).toEqual([
          translation(sources[0]),
          translation(sources[1])
        ])
        await close(page, resumed.operationId)
      }
      await testInfo.attach('recovery-request-counts', {
        body: JSON.stringify({
          scenario,
          requests: sources.map((source, sourceIndex) => ({
            sourceIndex,
            count: requests.filter((request) => request === source).length
          }))
        }),
        contentType: 'application/json'
      })
    } finally {
      await client
        ?.$executeRawUnsafe('DROP TRIGGER IF EXISTS recovery_fail_write')
        .catch(() => undefined)
      await client?.$disconnect()
      for (const response of held) response.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
}
