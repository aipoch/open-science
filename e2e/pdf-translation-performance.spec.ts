import { createServer } from 'node:http'
import { cpus, loadavg, totalmem } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect } from '@playwright/test'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { createCanvas } from '@napi-rs/canvas'
import { test } from './fixtures/electron-app'
import { createProjectDbClient } from '../src/main/projects/prisma-client'
import { literatureItemInputSchema } from '../src/shared/literature'

// Opt-in: built Electron, real renderer/parser/IPC/checkpoint/PDFium worker, isolated fixture roots.
// A deterministic localhost provider measures orchestration/storage/rendering, not model quality.
// OPEN_SCIENCE_PDF_PERF=1 npx playwright test e2e/pdf-translation-performance.spec.ts --workers=1 --retries=0
const enabled = process.env.OPEN_SCIENCE_PDF_PERF === '1'
const pageCount = Number(process.env.OPEN_SCIENCE_PDF_PERF_PAGES ?? 24)
if (!Number.isSafeInteger(pageCount) || pageCount < 2 || pageCount > 100)
  throw new Error('OPEN_SCIENCE_PDF_PERF_PAGES must be an integer from 2 to 100.')
const blocksPerPage = 8
const imageHeavy = process.env.OPEN_SCIENCE_PDF_PERF_IMAGES === '1'
const invalidBatchAt =
  process.env.OPEN_SCIENCE_PDF_PERF_INVALID_BATCH_AT === undefined
    ? undefined
    : Number(process.env.OPEN_SCIENCE_PDF_PERF_INVALID_BATCH_AT)
if (
  invalidBatchAt !== undefined &&
  (!Number.isSafeInteger(invalidBatchAt) ||
    invalidBatchAt < 0 ||
    invalidBatchAt >= pageCount * blocksPerPage ||
    invalidBatchAt % 4 !== 0)
)
  throw new Error(
    'OPEN_SCIENCE_PDF_PERF_INVALID_BATCH_AT must identify an existing four-paragraph batch start.'
  )
const providerLatenciesMs = [55, 25, 45, 35]
const stats = (
  values: number[]
): { count: number; sum: number; p50: number; p95: number; max: number } => {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    count: values.length,
    sum: values.reduce((sum, value) => sum + value, 0),
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0,
    max: sorted.at(-1) ?? 0
  }
}

const readPdfDiagnostics = async (
  path: string,
  since = 0
): Promise<ReturnType<typeof JSON.parse>[]> =>
  (await readFile(path, 'utf8')).split('\n').flatMap((line) => {
    try {
      const entry = JSON.parse(line)
      return String(entry.scope ?? entry.tag ?? entry.module ?? '').startsWith('pdf-translation') &&
        Date.parse(entry.t) >= since
        ? [entry]
        : []
    } catch {
      return []
    }
  })

test.skip(!enabled, 'Opt-in local PDF performance profile.')

for (const concurrency of [1, 2, 4] as const) {
  test(`profiles built PDF translation at ${concurrency}x with ${pageCount} pages`, async ({
    app
  }, testInfo) => {
    test.setTimeout(900_000)
    const hostLoadAverageAtStart = loadavg()
    await app.page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
    await app.completeOnboarding()
    await app.configureFakeAgent()
    await app.beginResourceProfile({
      sampleIntervalMs: 250,
      outputRoot: testInfo.outputPath('resources')
    })
    let page = app.page
    const root = await page.evaluate(async () => (await window.api.storage.getInfo()).dataRoot)
    // The fixture owns this temporary root; never use the user's dev or production database.
    expect(root).toContain('open-science-electron-e2e-')
    expect(root).toContain('profile-data')
    const configRoot = join(dirname(root), 'storage')
    const client = createProjectDbClient(configRoot)
    const databaseBytes = async (): Promise<{
      main: number
      wal: number
      shm: number
      total: number
    }> => {
      const entries = await Promise.all(
        ['', '-wal', '-shm'].map((suffix) =>
          stat(join(configRoot, `open-science.db${suffix}`))
            .then((value) => value.size)
            .catch(() => 0)
        )
      )
      return {
        main: entries[0],
        wal: entries[1],
        shm: entries[2],
        total: entries.reduce((a, b) => a + b, 0)
      }
    }
    const requests: Array<{ units: number; durationMs: number; bodyBytes: number }> = []
    let inFlight = 0
    let maxInFlight = 0
    let injectedBatchFailure = false
    const server = createServer(async (request, response) => {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404).end()
        return
      }
      const started = performance.now()
      let body = ''
      for await (const chunk of request) body += chunk
      const payload = JSON.parse(body)
      const input = JSON.parse(payload.messages[1].content)
      const units = input.units ?? [{ source: input.source }]
      const translate = (source: string): string => {
        const id = source.match(/Measurement\s+(\d+)/u)?.[1]
        if (!id) throw new Error('Unexpected performance fixture block.')
        return `测量 ${id}：检测受控实验室培养物中的细胞生长。该方案比较生物学变化，并记录稳定条件下可重复的结果。`
      }
      const sequence = requests.length
      requests.push({ units: units.length, durationMs: 0, bodyBytes: Buffer.byteLength(body) })
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      // Parallel responses finish out of order; persistence/display must retain source order.
      await new Promise((resolve) => setTimeout(resolve, providerLatenciesMs[sequence % 4]))
      const rejectBatch =
        invalidBatchAt !== undefined &&
        input.units &&
        !injectedBatchFailure &&
        input.units[0].sourceIndex === invalidBatchAt
      if (rejectBatch) injectedBatchFailure = true
      const content = rejectBatch
        ? '[]'
        : input.units
          ? JSON.stringify(
              units.map((unit: { sourceIndex: number; source: string }) => ({
                sourceIndex: unit.sourceIndex,
                translation: translate(unit.source)
              }))
            )
          : translate(input.source)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          usage: { prompt_tokens: 100 * units.length, completion_tokens: 60 * units.length },
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }]
        })
      )
      requests[sequence].durationMs = performance.now() - started
      inFlight--
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing local provider port.')
    let profile: Awaited<ReturnType<typeof app.finishResourceProfile>> | undefined
    try {
      await page.evaluate(async (port) => {
        await window.api.settings.upsertProvider({
          type: 'custom',
          name: 'Local PDF performance provider',
          model: 'pdf-perf',
          apiEndpoints: ['openai'],
          baseUrl: `http://127.0.0.1:${port}`
        })
      }, address.port)
      const pdf = await PDFDocument.create()
      const font = await pdf.embedFont(StandardFonts.Helvetica)
      for (let index = 0; index < pageCount; index++) {
        const sheet = pdf.addPage([612, 792])
        if (imageHeavy) {
          const canvas = createCanvas(256, 256)
          const context = canvas.getContext('2d')
          const pixels = context.createImageData(256, 256)
          let seed = index + 1
          for (let offset = 0; offset < pixels.data.length; offset += 4) {
            for (let color = 0; color < 3; color++) {
              seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
              pixels.data[offset + color] = seed >>> 24
            }
            pixels.data[offset + 3] = 255
          }
          context.putImageData(pixels, 0, 0)
          const image = await pdf.embedPng(canvas.toBuffer('image/png'))
          sheet.drawImage(image, { x: 40, y: 30, width: 240, height: 150 })
          canvas.width = 1
          canvas.height = 1
        }
        for (let block = 0; block < blocksPerPage; block++) {
          const id = index * blocksPerPage + block + 1
          const lines = [
            `Measurement ${id} examines cell growth in`,
            'controlled laboratory cultures. The protocol',
            'compares biological changes and records',
            'reproducible results under stable conditions.'
          ]
          lines.forEach((line, offset) =>
            sheet.drawText(line, {
              font,
              size: 10.5,
              x: block < 4 ? 40 : 322,
              y: 720 - (block % 4) * 155 - offset * 13
            })
          )
        }
      }
      const bytes = await pdf.save()
      await writeFile(testInfo.outputPath('source.pdf'), Buffer.from(bytes))
      const item = literatureItemInputSchema.parse({
        itemType: 'journalArticle',
        title: `PDF performance ${concurrency}x`
      })
      const transferId = randomUUID()
      const itemId = await page.evaluate(
        async ({ item, size, transferId }) => {
          const created = await window.api.literature.transact({ kind: 'create-item', item })
          await window.api.uploads.beginTransfer({
            transferId,
            name: 'performance.pdf',
            mimeType: 'application/pdf',
            size
          })
          return created.id
        },
        { item, size: bytes.length, transferId }
      )
      // Bound test-to-renderer transport too: a single multi-MB number[] inflates the heap and
      // would measure the harness instead of the actual chunked upload path.
      for (let offset = 0; offset < bytes.length; offset += 256 * 1024)
        await page.evaluate(
          async ({ transferId, offset, bytes }) => {
            await window.api.uploads.appendTransfer({
              transferId,
              offset,
              chunk: new Uint8Array(bytes)
            })
          },
          { transferId, offset, bytes: [...bytes.subarray(offset, offset + 256 * 1024)] }
        )
      const attachmentVersionId = await page.evaluate(
        async ({ itemId, transferId }) => {
          const attachment = await window.api.uploads.finishTransfer({ transferId })
          const receipt = await window.api.literature.importPdf({ itemId, attachment })
          return receipt.item.attachments[0].versions[0].id
        },
        { itemId, transferId }
      )
      await page.getByRole('button', { name: 'Library', exact: true }).click()
      await page.getByRole('button', { name: 'All references', exact: true }).click()
      await page.getByRole('button', { name: 'Preview performance.pdf', exact: true }).click()
      await page.getByRole('button', { name: 'Full-text translation', exact: true }).click()
      const panel = page.locator('[data-pdf-translation-sidebar]')
      await app.markResourceProfilePhase('prepare')
      const prepareStarted = performance.now()
      await panel.getByRole('button', { name: 'Prepare full text', exact: true }).click()
      await expect(panel).toContainText('Full text prepared', { timeout: 120_000 })
      const preparationMs = performance.now() - prepareStarted
      await panel.getByRole('combobox', { name: 'Translation method' }).click()
      await page.getByRole('option', { name: 'Direct API', exact: true }).click()
      await panel.getByRole('combobox', { name: 'Model', exact: true }).click()
      await page
        .getByRole('option', { name: 'pdf-perf · Local PDF performance provider', exact: true })
        .click()
      await panel.getByLabel('Target language', { exact: true }).fill('Chinese')
      if (concurrency > 1) {
        await panel.getByRole('button', { name: 'Advanced', exact: true }).click()
        await panel.getByRole('combobox', { name: 'Concurrent translations' }).click()
        await page.getByRole('option', { name: `${concurrency}x`, exact: true }).click()
      }
      const beforeDatabase = await databaseBytes()
      await app.markResourceProfilePhase('translate-and-refresh')
      const translationStarted = performance.now()
      await panel.getByRole('button', { name: 'Translate document', exact: true }).click()
      await expect(panel.getByRole('button', { name: 'New translation', exact: true })).toBeVisible(
        { timeout: 300_000 }
      )
      const translationMs = performance.now() - translationStarted
      await expect(
        panel.getByRole('button', { name: 'View translated PDF', exact: true })
      ).toBeEnabled({ timeout: 120_000 })
      await panel.getByRole('button', { name: 'View translated PDF', exact: true }).click()
      await expect(
        page.locator('[data-pdf-translated-page]').first().locator('canvas')
      ).toBeVisible()
      await expect(page.locator('[data-pdf-translated-page]').first()).toContainText('测量')
      const lastPage = page.locator(`[data-page-number="${pageCount}"] [data-pdf-translated-page]`)
      await lastPage.scrollIntoViewIfNeeded()
      await expect(lastPage).toContainText(`测量 ${pageCount * blocksPerPage}`, {
        timeout: 120_000
      })
      const readyMs = performance.now() - translationStarted
      await page.screenshot({ path: testInfo.outputPath('translated-last-page.png') })
      await app.sampleResourceProfileNow()
      const checkpointReadStarted = performance.now()
      const initialRead = await page.evaluate(async (id) => {
        const started = performance.now()
        const checkpoint = await window.api.pdfTranslation!.readCheckpoint(id)
        return { checkpoint, elapsedMs: performance.now() - started }
      }, attachmentVersionId)
      const checkpointReadMs = [performance.now() - checkpointReadStarted]
      const checkpoint = initialRead.checkpoint
      const rendererReadMs = [initialRead.elapsedMs]
      for (let read = 0; read < 2; read++) {
        const started = performance.now()
        const result = await page.evaluate(async (id) => {
          const started = performance.now()
          const checkpoint = await window.api.pdfTranslation!.readCheckpoint(id)
          return { checkpoint, elapsedMs: performance.now() - started }
        }, attachmentVersionId)
        checkpointReadMs.push(performance.now() - started)
        rendererReadMs.push(result.elapsedMs)
      }
      expect(checkpoint?.sources).toHaveLength(pageCount * blocksPerPage)
      expect(checkpoint?.translations).toHaveLength(pageCount * blocksPerPage)
      expect(checkpoint?.failedSourceIndices ?? []).toEqual([])
      expect(checkpoint?.layoutSnapshot).toBeDefined()
      const sourceOrder = checkpoint!.sources.map((value) =>
        Number(value.match(/Measurement\s+(\d+)/u)?.[1])
      )
      expect(
        checkpoint!.translations.map((value) => Number(value.match(/测量\s*(\d+)/u)?.[1]))
      ).toEqual(sourceOrder)
      expect(injectedBatchFailure).toBe(invalidBatchAt !== undefined)
      expect(requests.length).toBe(
        Math.ceil((pageCount * blocksPerPage) / 4) + (injectedBatchFailure ? 4 : 0)
      )
      expect(maxInFlight).toBe(concurrency)
      const rows = await client.$queryRawUnsafe<
        Array<{ blocks: number; translationBytes: number }>
      >(
        'SELECT COUNT(*) AS blocks, COALESCE(SUM(LENGTH(CAST(translation AS BLOB))), 0) AS translationBytes FROM PdfTranslationBlock'
      )
      const parent = await client.$queryRawUnsafe<
        Array<{ snapshotBytes: number; layoutSnapshotBytes: number }>
      >(
        'SELECT LENGTH(CAST(payloadJson AS BLOB)) AS snapshotBytes, COALESCE(LENGTH(CAST(layoutSnapshotJson AS BLOB)), 0) AS layoutSnapshotBytes FROM PdfTranslation'
      )
      expect(Number(rows[0].blocks)).toBe(pageCount * blocksPerPage)
      const afterDatabase = await databaseBytes()
      // Measure the actual expanded list, not just the settings/summary sidebar.
      const reviewToggle = panel.getByRole('button', {
        name: `Translation ${pageCount * blocksPerPage}`,
        exact: true
      })
      if ((await reviewToggle.getAttribute('aria-pressed')) === 'true') await reviewToggle.click()
      const collapsedElements = await panel.locator('*').count()
      const expandStarted = performance.now()
      await reviewToggle.click()
      const paragraphButtons = panel.getByRole('button', { name: /^Page \d+ · #\d+/u })
      await expect(paragraphButtons).toHaveCount(pageCount * blocksPerPage)
      const sidebarExpandMs = performance.now() - expandStarted
      const expandedElements = await panel.locator('*').count()
      await panel.getByRole('button', { name: 'Search translation', exact: true }).click()
      const searchStarted = performance.now()
      await panel.locator('[data-translation-search]').fill(`测量 ${pageCount * blocksPerPage}：`)
      await expect(paragraphButtons).toHaveCount(1)
      await expect(paragraphButtons).toContainText(`测量 ${pageCount * blocksPerPage}：`)
      const sidebarSearchMs = performance.now() - searchStarted
      await paragraphButtons.focus()
      await paragraphButtons.press('Enter')
      await expect(paragraphButtons).toHaveAttribute('aria-expanded', 'true')
      await expect(paragraphButtons).toBeFocused()
      const detailsId = await paragraphButtons.getAttribute('aria-controls')
      expect(detailsId).toBeTruthy()
      expect(await page.evaluate((id) => Boolean(document.getElementById(id!)), detailsId)).toBe(
        true
      )
      await paragraphButtons.press('Space')
      await expect(paragraphButtons).toHaveAttribute('aria-expanded', 'false')
      await expect(paragraphButtons).toBeFocused()
      await page.screenshot({ path: testInfo.outputPath('sidebar-last-paragraph.png') })
      await app.markResourceProfilePhase('settled')
      await page.waitForTimeout(1000)
      await app.sampleResourceProfileNow()
      profile = await app.finishResourceProfile()
      const logPath = await app.captureMainLog(`pdf-performance-${concurrency}x.log`)
      const diagnostics = await readPdfDiagnostics(logPath)
      const finalPdf = diagnostics.filter((entry) => entry.msg === 'PDF generated').at(-1)
      expect(finalPdf?.data.unitCount).toBe(pageCount * blocksPerPage)
      const generations = diagnostics.filter((entry) => entry.msg === 'PDF generated')
      expect(generations.length).toBeGreaterThan(0)
      expect(generations.every((entry) => entry.data.retainedCount === 0)).toBe(true)
      const report = {
        version: 1,
        measuredAt: new Date().toISOString(),
        environment: {
          platform: process.platform,
          architecture: process.arch,
          cpu: cpus()[0]?.model,
          totalMemoryBytes: totalmem(),
          node: process.version,
          hostLoadAverageAtStart,
          hostLoadAverageAtEnd: loadavg(),
          mainBuildSha256: createHash('sha256')
            .update(await readFile('out/main/index.js'))
            .digest('hex')
        },
        scope:
          'Built Electron with real renderer, parser, IPC, checkpoint and PDFium worker; synthetic two-column PDF with eight short paragraphs per page and optional image payloads; deterministic localhost provider, not real model latency/quality.',
        fixture: {
          pages: pageCount,
          imageHeavy,
          blocks: pageCount * blocksPerPage,
          pdfBytes: bytes.length,
          concurrency,
          invalidBatchAt,
          providerLatencyMs: providerLatenciesMs
        },
        timing: { preparationMs, translationMs, translatedPdfReadyMs: readyMs },
        sidebar: {
          collapsedElements,
          expandedElements,
          expandMs: sidebarExpandMs,
          lastParagraphSearchMs: sidebarSearchMs
        },
        provider: {
          requestCount: requests.length,
          maxInFlight,
          requestDurationMs: stats(requests.map((value) => value.durationMs)),
          requestBodyBytes: stats(requests.map((value) => value.bodyBytes)),
          requestedUnits: requests.reduce((sum, value) => sum + value.units, 0)
        },
        checkpoint: {
          rows: Number(rows[0].blocks),
          translationBytes: Number(rows[0].translationBytes),
          snapshotBytes: Number(parent[0].snapshotBytes),
          layoutSnapshotBytes: Number(parent[0].layoutSnapshotBytes),
          beforeDatabase,
          afterDatabase,
          deltaDatabaseBytes: afterDatabase.total - beforeDatabase.total,
          readPayloadBytes: Buffer.byteLength(JSON.stringify(checkpoint)),
          readMs: stats(checkpointReadMs),
          rendererReadMs: stats(rendererReadMs),
          readTimingScope:
            'Both metrics sample the same three reads. readMs retains the Node-to-Playwright round trip including full checkpoint transfer. rendererReadMs measures awaiting the application readCheckpoint API inside the renderer, including application IPC but excluding Playwright result transfer; it is not database-only latency.'
        },
        resources: profile.summary,
        diagnostics
      }
      const reportPath = testInfo.outputPath('pdf-performance.json')
      await writeFile(reportPath, JSON.stringify(report, null, 2))
      // Freeze the original profile before recovery, which independently measures cache loading,
      // validation and (for the damaged-cache case) regeneration.
      await client.$disconnect()
      let cacheKey = ''
      await expect
        .poll(
          async () => {
            const published = (
              await readPdfDiagnostics(
                await app.captureMainLog(`pdf-performance-cache-published-${concurrency}x.log`)
              )
            )
              .filter(
                (entry) =>
                  entry.msg === 'PDF cache published' &&
                  entry.data?.checkpointKey === checkpoint!.key &&
                  entry.data?.unitCount === pageCount * blocksPerPage
              )
              .at(-1)
            cacheKey = published?.data.cacheKey ?? ''
            return Boolean(published)
          },
          { timeout: 120_000 }
        )
        .toBe(true)
      expect(cacheKey).toMatch(/^[a-f0-9]{64}$/u)
      const cachePath = join(root, 'literature', 'pdf-translation-cache', `${cacheKey}.pdfcache`)
      expect((await lstat(cachePath)).isFile()).toBe(true)
      const recovery: Array<{
        mode: 'preview-reopen' | 'app-restart' | 'corrupt-cache'
        restartMs?: number
        textReadyMs: number
        translatedPdfReadyMs: number
        firstTranslatedPagePaintedMs: number
        checkpointKey: string
        pinnedLayoutPreserved: boolean
        modelRequestDelta: number
        cacheHits: number
        cachePublications: number
        pdfGenerations: number
        checkpointReads: Array<{
          storageMs: number
          decodeMs: number
          sourceCount: number
          blockCount: number
          payloadChars: number
          layoutSnapshotChars: number
        }>
      }> = []
      const modelRequestsBeforeRecovery = requests.length
      for (const mode of ['preview-reopen', 'app-restart', 'corrupt-cache'] as const) {
        await page
          .getByRole('button', { name: 'Close preview of performance.pdf', exact: true })
          .click()
        await expect(page.locator('[data-pdf-preview-root]')).toHaveCount(0)
        if (mode === 'corrupt-cache') {
          // This exact file is inside the already-checked isolated fixture root. Refuse symlinks.
          expect((await lstat(cachePath)).isFile()).toBe(true)
          await writeFile(cachePath, 'Deliberately damaged PDF cache for isolated E2E recovery.')
        }
        let restartMs: number | undefined
        if (mode === 'app-restart') {
          const restartStarted = performance.now()
          page = await app.restart()
          restartMs = performance.now() - restartStarted
          const references = page.getByRole('button', { name: 'All references', exact: true })
          if (!(await references.isVisible()))
            await page.getByRole('button', { name: 'Library', exact: true }).click()
          await references.click()
        }
        const reopenWallStarted = Date.now()
        const reopenStarted = performance.now()
        await page.getByRole('button', { name: 'Preview performance.pdf', exact: true }).click()
        await page
          .getByRole('button', { name: /^(Full-text translation|View translation)$/ })
          .click()
        const restoredPanel = page.locator('[data-pdf-translation-sidebar]')
        const viewPdf = restoredPanel.getByRole('button', {
          name: 'View translated PDF',
          exact: true
        })
        const [textReadyMs, translatedPdfReadyMs] = await Promise.all([
          (async (): Promise<number> => {
            const review = restoredPanel.getByRole('button', {
              name: `Translation ${pageCount * blocksPerPage}`,
              exact: true
            })
            await expect(review).toBeVisible({ timeout: 120_000 })
            if ((await review.getAttribute('aria-pressed')) !== 'true') await review.click()
            const firstParagraph = restoredPanel.getByRole('button', { name: /^Page \d+ · #1\b/u })
            await expect(firstParagraph).toContainText(checkpoint!.translations[0], {
              timeout: 120_000
            })
            await expect(firstParagraph).toBeVisible()
            return performance.now() - reopenStarted
          })(),
          (async (): Promise<number> => {
            await expect(viewPdf).toBeEnabled({ timeout: 120_000 })
            return performance.now() - reopenStarted
          })()
        ])
        await expect(restoredPanel).not.toContainText('Could not prepare full text')
        await viewPdf.click()
        const firstPageContainer = page.locator('[data-page-number="1"]').first()
        await firstPageContainer.scrollIntoViewIfNeeded()
        const firstPage = firstPageContainer.locator('[data-pdf-translated-page]')
        await expect(firstPage.locator('[data-pdf-page-ready="true"]')).toBeVisible({
          timeout: 120_000
        })
        await expect(firstPage).toContainText(`测量 ${sourceOrder[0]}`)
        const firstTranslatedPagePaintedMs = performance.now() - reopenStarted
        const restoredLastPage = page.locator(
          `[data-page-number="${pageCount}"] [data-pdf-translated-page]`
        )
        await restoredLastPage.scrollIntoViewIfNeeded()
        await expect(restoredLastPage).toContainText(`测量 ${pageCount * blocksPerPage}`, {
          timeout: 120_000
        })
        const recoveryLogName = `pdf-performance-recovery-${concurrency}x-${mode}.log`
        await expect
          .poll(
            async () =>
              (
                await readPdfDiagnostics(
                  await app.captureMainLog(recoveryLogName),
                  reopenWallStarted
                )
              ).some(
                (entry) =>
                  entry.msg ===
                    (mode === 'corrupt-cache' ? 'PDF cache published' : 'PDF cache hit') &&
                  entry.data?.checkpointKey === checkpoint!.key &&
                  entry.data?.cacheKey === cacheKey &&
                  entry.data?.unitCount === pageCount * blocksPerPage
              ),
            { timeout: 120_000 }
          )
          .toBe(true)
        // Capture UI-driven checkpoint work before the explicit verification IPC below.
        // Main storage/decode timings are a breakdown, not renderer-to-main round-trip latency.
        const recoveryLogPath = await app.captureMainLog(recoveryLogName)
        const recoveryDiagnostics = await readPdfDiagnostics(recoveryLogPath, reopenWallStarted)
        const cacheHits = recoveryDiagnostics.filter(
          (entry) => entry.msg === 'PDF cache hit'
        ).length
        const cachePublications = recoveryDiagnostics.filter(
          (entry) => entry.msg === 'PDF cache published'
        ).length
        const pdfGenerations = recoveryDiagnostics.filter(
          (entry) => entry.msg === 'PDF generated'
        ).length
        if (mode === 'corrupt-cache') {
          expect(cacheHits).toBe(0)
          expect(pdfGenerations).toBeGreaterThan(0)
          expect(cachePublications).toBeGreaterThan(0)
          expect((await stat(cachePath)).size).toBeGreaterThan(1024)
        } else {
          expect(cacheHits).toBeGreaterThan(0)
          expect(pdfGenerations).toBe(0)
        }
        const checkpointReads = recoveryDiagnostics.flatMap((entry) =>
          entry.msg === 'checkpoint restored' && entry.data?.stage === 'checkpoint-read'
            ? [
                {
                  storageMs: entry.data.storageMs,
                  decodeMs: entry.data.decodeMs,
                  sourceCount: entry.data.sourceCount,
                  blockCount: entry.data.blockCount,
                  payloadChars: entry.data.payloadChars,
                  layoutSnapshotChars: entry.data.layoutSnapshotChars
                }
              ]
            : []
        )
        const restored = await page.evaluate(
          (id) => window.api.pdfTranslation!.readCheckpoint(id),
          attachmentVersionId
        )
        expect(restored?.key).toBe(checkpoint!.key)
        expect(restored?.layoutSnapshot).toEqual(checkpoint!.layoutSnapshot)
        expect(restored?.translations).toEqual(checkpoint!.translations)
        expect(restored?.translatedSourceIndices).toEqual(checkpoint!.translatedSourceIndices)
        expect(requests).toHaveLength(modelRequestsBeforeRecovery)
        recovery.push({
          mode,
          ...(restartMs === undefined ? {} : { restartMs }),
          textReadyMs,
          translatedPdfReadyMs,
          firstTranslatedPagePaintedMs,
          checkpointKey: restored!.key,
          pinnedLayoutPreserved: true,
          modelRequestDelta: requests.length - modelRequestsBeforeRecovery,
          cacheHits,
          cachePublications,
          pdfGenerations,
          checkpointReads
        })
        await page.screenshot({ path: testInfo.outputPath(`recovery-${mode}.png`) })
        await writeFile(
          reportPath,
          JSON.stringify(
            {
              ...report,
              recoveryScope:
                'Elapsed from clicking the same attachment preview, after the initial complete PDF cache publication. Text ready means the first saved paragraph is visible; PDF ready means the fully validated PDF view is enabled, observed independently. First page painted additionally includes switching views. Last-page readability and cache log assertions follow these timers. Restart startup time is separate. The corrupt-cache case measures regeneration after damaging only the fixture cache file. Checkpoint storage/decode samples are main-process measurements (storage includes its lease wait but excludes source authority checks), not IPC round-trip latency. Original timings, resources, provider statistics and diagnostics exclude recovery.',
              recovery
            },
            null,
            2
          )
        )
        await testInfo.attach(`recovery-${mode}-diagnostics`, {
          path: recoveryLogPath,
          contentType: 'text/plain'
        })
      }
      await testInfo.attach('pdf-performance', {
        path: reportPath,
        contentType: 'application/json'
      })
      await testInfo.attach('pdf-diagnostics', { path: logPath, contentType: 'text/plain' })
      console.log(`PDF performance ${concurrency}x: ${reportPath}`)
    } finally {
      await client.$disconnect()
      if (!profile) await app.finishResourceProfile().catch(() => undefined)
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
}
