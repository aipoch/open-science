import { literatureItemInputSchema } from '@aipoch/literature-library/contracts'
import { expect, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { open, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { createProjectDbClient } from '../src/main/projects/prisma-client'
import { PrismaClient } from '@prisma/client'
import { PdfAnnotationRepository } from '../src/main/pdf-annotations/repository'
import {
  PDF_ANNOTATION_LIMITS,
  type ListPdfAnnotationsRequest
} from '../src/shared/pdf-annotations'
import { test } from './fixtures/electron-app'
import { openAllReferences } from './fixtures/library'

// Arm the probe before Playwright acts. Start on the actual input event, stop on a
// renderer frame meeting the condition; exclude locator auto-waits and driver IPC.
async function armReaderProbe(
  page: Page,
  operation: 'open' | 'zoom' | 'search',
  goal = ''
): Promise<void> {
  await page.evaluate(
    ({ operation, goal }) => {
      performance.clearMarks('reader:start')
      performance.clearMarks('reader:first')
      performance.clearMarks('reader:text')
      performance.clearMarks('reader:end')
      for (const key of ['acquired', 'loaded', 'paint', 'range'])
        performance.clearMarks('reader:' + key)
      const row = (): Element | null => document.querySelector('[data-pdf-page-number="1"]')
      const width = row()?.querySelector('canvas')?.width ?? 0
      if (operation === 'open') {
        const library = (
          window as unknown as { pdfjsLib?: Pick<typeof import('pdfjs-dist'), 'getDocument'> }
        ).pdfjsLib
        if (library) {
          const original = library.getDocument
          library.getDocument = (options) => {
            library.getDocument = original
            performance.mark('reader:acquired')
            if (typeof options === 'object' && options && 'range' in options && options.range) {
              const transport = options.range,
                request = transport.requestDataRange.bind(transport)
              transport.requestDataRange = (begin, end) => {
                performance.mark('reader:range', { detail: end - begin })
                return request(begin, end)
              }
            }
            const task = original(options)
            void task.promise.then(
              (doc) => {
                performance.mark('reader:loaded')
                const getPage = doc.getPage.bind(doc),
                  seen = new WeakSet()
                doc.getPage = async (number) => {
                  const p = await getPage(number)
                  if (number === 1 && !seen.has(p)) {
                    seen.add(p)
                    const render = p.render.bind(p)
                    p.render = (params) => {
                      const painting = render(params)
                      if (params.canvas?.closest('[data-pdf-page-number="1"]'))
                        void painting.promise.then(
                          () => performance.mark('reader:paint'),
                          () => {}
                        )
                      return painting
                    }
                  }
                  return p
                }
              },
              () => {}
            )
            return task
          }
        }
      }
      document.addEventListener(
        operation === 'search' ? 'input' : 'click',
        () => {
          performance.mark('reader:start')
          const frame = (): void => {
            const pageOne = row()
            const status =
              document.querySelector('input[type=search][data-preview-escape-boundary]')
                ?.nextElementSibling?.textContent ?? ''
            const painted = pageOne?.getAttribute('data-pdf-page-ready') === 'true'
            if (
              operation === 'open' &&
              painted &&
              !performance.getEntriesByName('reader:first').length
            )
              performance.mark('reader:first')
            if (
              operation === 'open' &&
              pageOne?.querySelector('.textLayer')?.textContent?.includes('Reader sample') &&
              !performance.getEntriesByName('reader:text').length
            )
              performance.mark('reader:text')
            if (
              operation === 'search' &&
              /^1\/[1-9]/u.test(status) &&
              !performance.getEntriesByName('reader:first').length
            )
              performance.mark('reader:first')
            const done =
              operation === 'open'
                ? painted && performance.getEntriesByName('reader:text').length
                : operation === 'zoom'
                  ? painted &&
                    (pageOne?.querySelector('canvas')?.width ?? 0) > width &&
                    performance
                      .getEntriesByName('reader:paint')
                      .some(
                        (e) =>
                          e.startTime >= performance.getEntriesByName('reader:start')[0].startTime
                      )
                  : status === goal
            if (done) performance.mark('reader:end')
            else if (
              performance.now() - performance.getEntriesByName('reader:start')[0].startTime <
              15000
            )
              requestAnimationFrame(frame)
          }
          requestAnimationFrame(frame)
        },
        { capture: true, once: true }
      )
    },
    { operation, goal }
  )
}

type ReaderTiming = {
  totalMs: number
  firstMs: number | null
  textMs: number | null
  acquiredMs: number | null
  loadedMs: number | null
  paintMs: number | null
  ranges: number
  rangeBytes: number
}

async function readerTiming(page: Page): Promise<ReaderTiming> {
  const probe = await page.waitForFunction(
    () => {
      const time = (key: string): number | undefined =>
        performance.getEntriesByName('reader:' + key)[0]?.startTime
      const start = time('start'),
        end = time('end')
      if (start === undefined || end === undefined) return false
      const elapsed = (key: string): number | null => {
        const value = time(key)
        return value === undefined ? null : Math.round(value - start)
      }
      const ranges = performance.getEntriesByName('reader:range') as PerformanceMark[]
      return {
        totalMs: Math.round(end - start),
        firstMs: elapsed('first'),
        textMs: elapsed('text'),
        acquiredMs: elapsed('acquired'),
        loadedMs: elapsed('loaded'),
        paintMs: elapsed('paint'),
        ranges: ranges.length,
        rangeBytes: ranges.reduce((acc, e) => acc + Number(e.detail), 0)
      }
    },
    undefined,
    { timeout: 18000 }
  )
  try {
    const timing = await probe.jsonValue()
    if (!timing) throw new Error('Reader probe returned before the observed frame.')
    return timing
  } finally {
    await probe.dispose()
  }
}

test('profiles repeated PDF opens, zoom and cold/warm reader searches', async ({
  app
}, testInfo) => {
  test.skip(process.env.PDF_READER_BENCHMARK !== '1', 'Opt-in PDF reader benchmark')
  test.setTimeout(180_000)
  const page = await app.completeOnboarding()
  await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
  await app.setMainWindowSize(1440, 960)
  const pdf = await PDFDocument.create()
  pdf.setCreationDate(new Date(0))
  pdf.setModificationDate(new Date(0))
  const pages = 96
  for (let n = 1; n <= pages; n++) {
    const sheet = pdf.addPage([612, 792])
    sheet.drawText(`Reader sample ${n}`, { x: 40, y: 720, size: 16 })
    for (let i = 0; i < 12; i++) {
      sheet.drawText('Methods and results.', { x: 40, y: 680 - i * 22, size: 11 })
      sheet.drawText('Evidence and analysis.', { x: 320, y: 680 - i * 22, size: 11 })
    }
    if (n === pages) sheet.drawText('Terminal marker.', { x: 40, y: 180, size: 12 })
  }
  const bytes = Buffer.from(await pdf.save())
  const path = join(await app.createTestDirectory('reader-profile'), 'reader-profile.pdf')
  await writeFile(path, bytes)
  await page.evaluate(
    (item) => window.api.literature.transact({ kind: 'create-item', item }),
    literatureItemInputSchema.parse({ itemType: 'journalArticle', title: 'Reader benchmark' })
  )
  await openAllReferences(page)
  await page.getByText('Reader benchmark', { exact: true }).click()
  await page.locator('input[aria-label="Add files"]').setInputFiles(path)
  const preview = page.getByRole('button', { name: 'Preview reader-profile.pdf', exact: true })
  const rows = []
  for (let round = 0; round < 7; round++) {
    await armReaderProbe(page, 'open')
    await preview.click()
    const open = await readerTiming(page)
    const view = page.getByRole('group', { name: 'PDF view controls' })
    await armReaderProbe(page, 'zoom')
    await view.getByRole('button', { name: 'Zoom in', exact: true }).click()
    const zoom = await readerTiming(page)
    await view.getByRole('button', { name: 'Reset zoom', exact: true }).click()
    await page
      .locator('[data-pdf-preview-root]')
      .getByRole('button', { name: 'Search', exact: true })
      .click()
    const input = page.getByRole('searchbox', { name: 'Search document' })
    const scan = async (query: string, goal: string): Promise<ReaderTiming> => {
      await armReaderProbe(page, 'search', goal)
      await input.fill(query)
      return readerTiming(page)
    }
    const coldSearch = await scan('Reader sample', `1/${pages}`)
    const warmSearch = await scan('Terminal marker', '1/1')
    await expect(page.locator(`[data-pdf-page-number="${pages}"] .textLayer`)).toContainText(
      'Terminal marker'
    )
    const warmCommon = await scan('Methods', `1/${12 * pages}`)
    await page
      .getByRole('button', { name: 'Close preview of reader-profile.pdf', exact: true })
      .click()
    await expect(page.locator('[data-pdf-preview-root]')).toHaveCount(0)
    rows.push({ round, open, zoom, coldSearch, warmSearch, warmCommon })
  }
  await writeFile(
    testInfo.outputPath('reader.json'),
    JSON.stringify(
      {
        pages,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        rows
      },
      null,
      2
    )
  )
})

test('profiles alternating text and scanned PDFs across viewport changes and close', async ({
  app
}, testInfo) => {
  test.skip(process.env.PDF_LIFETIME_BENCHMARK !== '1', 'Opt-in PDF lifetime benchmark')
  test.setTimeout(180_000)
  await app.completeOnboarding()
  await app.page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
  await app.beginResourceProfile({
    sampleIntervalMs: 250,
    outputRoot: testInfo.outputPath('resources')
  })
  const page = app.page
  await app.setMainWindowSize(1440, 960)
  await page.evaluate(
    (item) => window.api.literature.transact({ kind: 'create-item', item }),
    literatureItemInputSchema.parse({ itemType: 'journalArticle', title: 'Reader lifetime' })
  )
  await openAllReferences(page)
  await page.getByText('Reader lifetime', { exact: true }).click()
  const { createCanvas } = await import('@napi-rs/canvas')
  const canvas = createCanvas(420, 160),
    context = canvas.getContext('2d')
  context.fillStyle = 'white'
  context.fillRect(0, 0, 420, 160)
  context.fillStyle = 'black'
  context.font = '30px sans-serif'
  context.fillText('Scanned evidence', 15, 90)
  const directory = await app.createTestDirectory('reader-lifetime')
  for (const kind of ['text', 'scan']) {
    const pdf = await PDFDocument.create()
    pdf.setCreationDate(new Date(0))
    pdf.setModificationDate(new Date(0))
    const png = kind === 'scan' ? await pdf.embedPng(canvas.toBuffer('image/png')) : undefined
    for (let n = 1; n <= 12; n++) {
      const sheet = pdf.addPage([612, 792])
      if (png) sheet.drawImage(png, { x: 0, y: 0, width: 612, height: 792 })
      else sheet.drawText(`Reading evidence page ${n}.`, { x: 40, y: 710, size: 16 })
    }
    const file = join(directory, `${kind}.pdf`)
    await writeFile(file, await pdf.save())
    await page.locator('input[aria-label="Add files"]').setInputFiles(file)
    await expect(
      page.getByRole('button', { name: `Preview ${kind}.pdf`, exact: true })
    ).toBeEnabled()
  }
  const workerBaseline = page.workers().length
  const fixed = process.env.PDF_LIFETIME_FIXED === '1'
  const idleMs = fixed ? 4000 : 750
  const rounds = fixed ? 20 : 10
  const cdp = fixed ? await page.context().newCDPSession(page) : undefined
  if (cdp) await cdp.send('Performance.enable')
  const rows = []
  for (let i = 0; i < rounds; i++) {
    const kind = i % 2 === 0 ? 'text' : 'scan',
      zoom = fixed || i < 5 ? 1 : 1.25
    await app.setMainWindowZoomFactor(zoom)
    await app.markResourceProfilePhase(`open-${i}`)
    await page.getByRole('button', { name: `Preview ${kind}.pdf`, exact: true }).click()
    const region = page.getByRole('region', { name: `${kind}.pdf scrollable preview`, exact: true })
    for (const number of [1, 6, 3]) {
      const row = region.locator(`[data-pdf-page-number="${number}"]`)
      await row.scrollIntoViewIfNeeded()
      await expect(row).toHaveAttribute('data-pdf-page-ready', 'true')
      if (kind === 'text')
        await expect(row.locator('.textLayer')).toContainText(`Reading evidence page ${number}.`)
      else {
        await expect(row).not.toContainText('Reading evidence')
        const hasInk = await row.locator('canvas').evaluate((paint: HTMLCanvasElement) => {
          const thumbnail = document.createElement('canvas')
          thumbnail.width = 96
          thumbnail.height = 96
          const ctx = thumbnail.getContext('2d')!
          ctx.drawImage(paint, 0, 0, 96, 96)
          return ctx.getImageData(0, 0, 96, 96).data.some((v, j) => j % 4 === 0 && v < 200)
        })
        expect(hasInk).toBe(true)
      }
    }
    await page.getByRole('button', { name: `Close preview of ${kind}.pdf`, exact: true }).click()
    await expect(region).toHaveCount(0)
    await expect.poll(() => page.workers().length).toBeLessThanOrEqual(workerBaseline)
    // Give every close the same idle sampling window, not a readiness assertion.
    await app.markResourceProfilePhase(`closed-${i}`)
    await new Promise((resolve) => setTimeout(resolve, idleMs))
    await app.sampleResourceProfileNow()
    // Compare retained heaps only at matched even-cycle checkpoints, after RSS sampling.
    let retained
    if (cdp && [3, 11, 19].includes(i)) {
      await cdp.send('HeapProfiler.collectGarbage')
      const { metrics } = await cdp.send('Performance.getMetrics')
      retained = {
        usedHeapBytes: metrics.find(({ name }) => name === 'JSHeapUsedSize')?.value,
        dom: await cdp.send('Memory.getDOMCounters')
      }
    }
    rows.push({ i, kind, zoom, workers: page.workers().length, retained })
  }
  if (cdp && process.env.PDF_LIFETIME_SNAPSHOT === '1') {
    const file = await open(testInfo.outputPath('closed.heapsnapshot'), 'wx', 0o600)
    try {
      cdp.on('HeapProfiler.addHeapSnapshotChunk', ({ chunk }) => {
        writeFileSync(file.fd, chunk)
      })
      await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
    } finally {
      await file.close()
    }
  }
  await cdp?.detach()
  const profile = await app.finishResourceProfile()
  await writeFile(
    testInfo.outputPath('lifetime.json'),
    JSON.stringify({ workerBaseline, idleMs, rows, summary: profile.summary }, null, 2)
  )
})

// Opt in: production Electron reader + SQLite + IPC. Seed costs are excluded from UI timings.
test('measures large notebooks in the full reader and sidebar', async ({ app }, testInfo) => {
  test.skip(process.env.PDF_NOTES_BENCHMARK !== '1', 'Opt-in desktop capacity benchmark')
  test.setTimeout(240_000)
  const page = await app.completeOnboarding()
  await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
  const directory = await app.createTestDirectory('notebook-capacity')
  const path = join(directory, 'capacity.pdf')
  const pdf = await PDFDocument.create()
  for (let n = 0; n < 100; n++) pdf.addPage().drawText(`Evidence on page ${n + 1}`)
  await writeFile(path, await pdf.save())
  await page.evaluate(
    (item) => window.api.literature.transact({ kind: 'create-item', item }),
    literatureItemInputSchema.parse({ itemType: 'journalArticle', title: 'Notebook capacity' })
  )
  await openAllReferences(page)
  await page.getByText('Notebook capacity', { exact: true }).click()
  await page.locator('input[aria-label="Add files"]').setInputFiles(path)
  const preview = page.getByRole('button', { name: 'Preview capacity.pdf', exact: true })
  await expect(preview).toBeEnabled()
  // The fixture owns this isolated database; production/user data is never touched.
  const db = createProjectDbClient(join(dirname(directory), 'storage'))
  const results: unknown[] = []
  try {
    const version = await db.literatureAttachmentVersion.findFirstOrThrow()
    const binding = await db.pdfAnnotationSourceBinding.findFirstOrThrow({
      where: { versionId: version.id }
    })
    for (const count of (process.env.PDF_NOTES_COUNTS ?? '500,2000,10000').split(',').map(Number)) {
      await db.pdfAnnotation.deleteMany()
      for (let start = 0; start < count; start += 250) {
        await db.pdfAnnotation.createMany({
          data: Array.from({ length: Math.min(250, count - start) }, (_, offset) => {
            const n = start + offset
            const exact = `Evidence ${n}: a representative quoted passage for notebook capacity testing.`
            return {
              id: `capacity-${n}`,
              documentId: binding.documentId,
              sourceKind: 'literature-attachment-version',
              sourceFileId: version.attachmentId,
              versionId: version.id,
              checksum: version.checksum,
              name: 'capacity.pdf',
              createdAt: new Date(1_700_000_000_000 + n * 1_000),
              path: `literature-attachment-version:${version.id}`,
              kind: 'highlight',
              color: 'yellow',
              note: `Study note ${n}: compare this evidence against the reported outcome.`,
              selectorJson: JSON.stringify({
                version: 1,
                selector: {
                  kind: 'text',
                  pageNumber: 100 - (n % 100),
                  pageRotation: 0,
                  coordinateVersion: 1,
                  extractorVersion: 'capacity',
                  exact,
                  position: { start: 0, end: exact.length },
                  quads: [{ x: 0.1, y: 0.2, width: 0.4, height: 0.03 }]
                }
              })
            }
          })
        })
      }
      await app.setMainWindowSize(1440, 960)
      await preview.click()
      await expect(
        page.getByRole('status').filter({ hasText: 'PDF annotations are unavailable' })
      ).toHaveCount(0)
      await page.evaluate(() => {
        const startMark = 'notes:tab-click'
        const firstMark = 'notes:first-visible'
        const completeMark = 'notes:export-ready'
        for (const mark of [startMark, firstMark, completeMark]) performance.clearMarks(mark)
        const panel = '[data-pdf-notebook-view][role="tabpanel"]:not([aria-hidden="true"])'
        document.addEventListener(
          'click',
          () => {
            performance.mark(startMark)
            const frame = (): void => {
              const notes = document.querySelector(panel)
              const cards = Array.from(
                notes?.querySelectorAll<HTMLElement>('[data-annotation-id]') ?? []
              )
              const exportButton = notes?.querySelector<HTMLButtonElement>(
                'button[aria-label="Export notes"]'
              )
              if (
                cards[0]?.getClientRects().length &&
                !performance.getEntriesByName(firstMark).length
              )
                performance.mark(firstMark, {
                  detail: {
                    prefix: Boolean(cards[0].closest('[data-pdf-notes-initial-page]')),
                    exportDisabled: exportButton?.disabled === true,
                    ids: cards.map((card) => card.dataset.annotationId)
                  }
                })
              if (exportButton && !exportButton.disabled && exportButton.getClientRects().length) {
                performance.mark(completeMark)
                return
              }
              if (performance.now() - performance.getEntriesByName(startMark)[0].startTime < 90_000)
                requestAnimationFrame(frame)
            }
            requestAnimationFrame(frame)
          },
          { capture: true, once: true }
        )
      })
      const started = performance.now()
      await page.getByRole('tab', { name: 'Notes & Annotations', exact: true }).click()
      await expect(page.locator('[data-annotation-id]').first()).toBeVisible({ timeout: 90_000 })
      const readyMs = Math.round(performance.now() - started)
      const mounted = await page.locator('[data-annotation-id]').count()
      expect(mounted).toBe(Math.min(100, count))
      const expectedIds = Array.from({ length: count }, (_, n) => n)
        .sort((a, b) => (b % 100) - (a % 100) || a - b)
        .slice(0, 100)
        .map((n) => `capacity-${n}`)
      const notes = page.getByRole('tabpanel', { name: 'Notes & Annotations' })
      const ids = (): Promise<(string | null)[]> =>
        notes
          .locator('[data-annotation-id]')
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-annotation-id')))
      expect(await ids()).toEqual(expectedIds)
      await expect(notes.getByRole('button', { name: 'Export notes', exact: true })).toBeEnabled()
      expect(await ids()).toEqual(expectedIds)
      const probe = await page.waitForFunction(() => {
        const start = performance.getEntriesByName('notes:tab-click')[0]
        const first = performance.getEntriesByName('notes:first-visible')[0] as
          PerformanceMark | undefined
        const ready = performance.getEntriesByName('notes:export-ready')[0]
        if (!start || !first || !ready) return false
        const detail = first.detail as { prefix: boolean; exportDisabled: boolean; ids: string[] }
        return {
          firstVisibleMs: Math.round(first.startTime - start.startTime),
          exportReadyMs: Math.round(ready.startTime - start.startTime),
          ...detail
        }
      })
      const frame = await probe.jsonValue()
      await probe.dispose()
      if (!frame) throw new Error('Missing notebook timing marks.')
      expect(frame.ids).toEqual(expectedIds)
      if (count < 1_000 || count > 20_000 || process.env.PDF_NOTES_EXPECT_PREFIX === '0')
        expect(frame.prefix).toBe(false)
      else if (process.env.PDF_NOTES_EXPECT_PREFIX === '1') expect(frame.prefix).toBe(true)
      if (frame.prefix) {
        expect(frame.exportDisabled).toBe(true)
        expect(frame.exportReadyMs).toBeGreaterThan(frame.firstVisibleMs)
      }
      const searchStarted = performance.now()
      const search = await page.evaluate(
        (last) =>
          window.api.literature.search({
            scope: 'global-search',
            entryKind: 'note',
            query: `Study note ${last}:`,
            limit: 20
          }),
        count - 1
      )
      const searchMs = Math.round(performance.now() - searchStarted)
      expect(search.totalCount).toBe(1)
      const domNodes = await page.locator('*').count()
      await page.getByRole('tab', { name: 'Original PDF', exact: true }).click()
      const sidebarStart = performance.now()
      await page.getByRole('button', { name: 'Show notes sidebar', exact: true }).click()
      await expect(
        page.locator('[data-pdf-notes-sidebar] [data-annotation-id]').first()
      ).toBeVisible()
      const sidebarMs = Math.round(performance.now() - sidebarStart)
      await page.getByRole('button', { name: 'Current page', exact: true }).click()
      await expect(
        page.locator('[data-pdf-notes-sidebar] [data-annotation-id]').first()
      ).toBeVisible()
      const currentPageMounted = await page
        .locator('[data-pdf-notes-sidebar] [data-annotation-id]')
        .count()
      let profile
      if (process.env.PDF_NOTES_PROFILE === '1') {
        const warmStart = performance.now()
        await page.getByRole('tab', { name: 'Notes & Annotations', exact: true }).click()
        await expect(
          page
            .getByRole('tabpanel', { name: 'Notes & Annotations' })
            .locator('[data-annotation-id]')
            .first()
        ).toBeVisible()
        const warmTabMs = Math.round(performance.now() - warmStart)
        // Independent, warm probes after UI timing: these are not additive parts of readyMs.
        const scope = { literatureVersionId: version.id, limit: PDF_ANNOTATION_LIMITS.pageSize }
        const repository = new PdfAnnotationRepository(async () => db)
        let cursor: ListPdfAnnotationsRequest['cursor']
        let pageCount = 0,
          rowCount = 0
        const repoStart = performance.now()
        do {
          const slice = await repository.list({ ...scope, cursor })
          rowCount += slice.items.length
          pageCount++
          cursor = slice.nextCursor
        } while (cursor)
        const repositoryMs = Math.round(performance.now() - repoStart)
        expect(rowCount).toBe(count)
        const rendererApiMs = await page.evaluate(
          async ({ scope, count }) => {
            let cursor: ListPdfAnnotationsRequest['cursor'],
              read = 0
            const started = performance.now()
            do {
              const slice = await window.api.pdfAnnotations.list({ ...scope, cursor })
              read += slice.items.length
              cursor = slice.nextCursor
            } while (cursor)
            if (read !== count) throw new Error('Incomplete PDF annotation scan')
            return Math.round(performance.now() - started)
          },
          { scope, count }
        )
        const observed = new PrismaClient({
          datasources: {
            db: {
              url: `file:${join(dirname(directory), 'storage', 'open-science.db')}?connection_limit=1`
            }
          },
          log: [{ emit: 'event', level: 'query' }]
        })
        let sqlStatements = 0
        observed.$on('query', () => {
          sqlStatements++
        })
        try {
          const slice = await new PdfAnnotationRepository(async () => observed).list(scope)
          expect(slice.items).toHaveLength(Math.min(count, scope.limit))
        } finally {
          await observed.$disconnect()
        }
        profile = {
          warmTabMs,
          repositoryMs,
          rendererApiMs,
          pageCount,
          rowCount,
          firstPageSqlStatements: sqlStatements
        }
      }
      results.push({
        count,
        readyMs,
        firstVisibleMs: frame.firstVisibleMs,
        exportReadyMs: frame.exportReadyMs,
        initialReadingPageObserved: frame.prefix,
        searchMs,
        sidebarMs,
        mounted,
        domNodes,
        currentPageMounted,
        profile
      })
      await page.getByRole('button', { name: 'Close preview of capacity.pdf', exact: true }).click()
    }
  } finally {
    await db.$disconnect()
    await writeFile(testInfo.outputPath('notebook-capacity.json'), JSON.stringify(results, null, 2))
  }
})
