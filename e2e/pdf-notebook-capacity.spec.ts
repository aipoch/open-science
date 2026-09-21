import { expect } from '@playwright/test'
import { PDFDocument } from 'pdf-lib'
import { dirname, join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { test } from './fixtures/electron-app'
import { createProjectDbClient } from '../src/main/projects/prisma-client'
import { literatureItemInputSchema } from '../src/shared/literature'

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
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  await page.getByRole('button', { name: 'All references', exact: true }).click()
  await page.getByText('Notebook capacity', { exact: true }).click()
  await page.locator('input[aria-label="Add PDF"]').setInputFiles(path)
  const preview = page.getByRole('button', { name: 'Preview capacity.pdf', exact: true })
  await expect(preview).toBeEnabled()
  // The fixture owns this isolated database; production/user data is never touched.
  const db = createProjectDbClient(join(dirname(directory), 'storage'))
  const results: unknown[] = []
  try {
    const version = await db.literatureAttachmentVersion.findFirstOrThrow()
    for (const count of (process.env.PDF_NOTES_COUNTS ?? '500,2000,10000').split(',').map(Number)) {
      await db.pdfAnnotation.deleteMany()
      for (let start = 0; start < count; start += 250) {
        await db.pdfAnnotation.createMany({
          data: Array.from({ length: Math.min(250, count - start) }, (_, offset) => {
            const n = start + offset
            const exact = `Evidence ${n}: a representative quoted passage for notebook capacity testing.`
            return {
              id: `capacity-${n}`,
              sourceKind: 'literature-attachment-version',
              sourceFileId: version.attachmentId,
              versionId: version.id,
              checksum: version.checksum,
              name: 'capacity.pdf',
              path: `literature-attachment-version:${version.id}`,
              kind: 'highlight',
              color: 'yellow',
              note: `Study note ${n}: compare this evidence against the reported outcome.`,
              selectorJson: JSON.stringify({
                version: 1,
                selector: {
                  kind: 'text',
                  pageNumber: (n % 100) + 1,
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
      const started = performance.now()
      await page.getByRole('tab', { name: 'Notes & Annotations', exact: true }).click()
      await expect(page.locator('[data-annotation-id]').first()).toBeVisible({ timeout: 90_000 })
      const readyMs = Math.round(performance.now() - started)
      const mounted = await page.locator('[data-annotation-id]').count()
      expect(mounted).toBe(Math.min(100, count))
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
      results.push({
        count,
        readyMs,
        searchMs,
        sidebarMs,
        mounted,
        domNodes,
        currentPageMounted: await page
          .locator('[data-pdf-notes-sidebar] [data-annotation-id]')
          .count()
      })
      await page.getByRole('button', { name: 'Close preview of capacity.pdf', exact: true }).click()
    }
  } finally {
    await db.$disconnect()
    await writeFile(testInfo.outputPath('notebook-capacity.json'), JSON.stringify(results, null, 2))
  }
})
