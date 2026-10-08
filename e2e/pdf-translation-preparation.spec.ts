import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { expect } from '@playwright/test'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PdfStructureCache } from '../src/main/literature/pdf-structure/cache'
import { createPdfStructureEngine } from '../src/main/literature/pdf-structure/engine'
import { literatureItemInputSchema } from '../src/shared/literature'
import type { PdfStructureResult } from '../src/shared/pdf-structure'
import { test } from './fixtures/electron-app'

function textPdf(pageCount = 2): Buffer {
  const streams = [
    'BT /F1 12 Tf 40 740 Td (Text preparation sample.) Tj 0 -90 Td (Table label) Tj 300 0 Td (12.5) Tj ET',
    'BT /F1 12 Tf 40 740 Td (Second page source.) Tj ET'
  ]
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, i) => `${i + 3} 0 R`).join(' ')}] /Count ${pageCount} >>`,
    ...Array.from(
      { length: pageCount },
      (_, i) =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${pageCount + 3} 0 R >> >> /Contents ${pageCount + 4 + Math.min(i, 1)} 0 R >>`
    ),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...streams.map(
      (stream) => `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
    )
  ]
  let body = '%PDF-1.4\n'
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(body)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const offset = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`
  return Buffer.from(body)
}

test('prepares a Library PDF through real IPC and cached table provenance', async ({
  app
}, testInfo) => {
  test.setTimeout(180_000)
  await app.page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
  let page = await app.completeOnboarding()
  const modelBefore = await page.evaluate(() => window.api.localModels.getSnapshot())
  const bytes = textPdf()
  const item = literatureItemInputSchema.parse({
    itemType: 'journalArticle',
    title: 'PDF preparation acceptance'
  })
  const imported = await page.evaluate(
    async ({ item, bytes }) => {
      const created = await window.api.literature.transact({ kind: 'create-item', item })
      const chunk = new Uint8Array(bytes),
        transferId = crypto.randomUUID()
      await window.api.uploads.beginTransfer({
        transferId,
        name: 'preparation.pdf',
        mimeType: 'application/pdf',
        size: chunk.length
      })
      await window.api.uploads.appendTransfer({ transferId, offset: 0, chunk })
      const attachment = await window.api.uploads.finishTransfer({ transferId })
      return window.api.literature.importPdf({ itemId: created.id, attachment })
    },
    { item, bytes: [...bytes] }
  )
  const version = imported.item.attachments[0].versions[0]
  const { dataRoot } = await page.evaluate(() => window.api.storage.getInfo())
  const { profile } = await app.captureBrandState()
  const fixtureRelative = relative(dirname(profile), dataRoot)
  expect(isAbsolute(fixtureRelative) || fixtureRelative.startsWith('..')).toBe(false)
  const recipe = await createPdfStructureEngine(
    join(process.cwd(), 'resources/pdf-structure')
  ).describe()
  const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true })
  let result: PdfStructureResult
  try {
    const document = await loading.promise,
      content = await (await document.getPage(1)).getTextContent()
    const tableItems = content.items.flatMap((item, index) =>
      'str' in item && ['Table label', '12.5'].includes(item.str) ? [{ item, index }] : []
    )
    expect(tableItems).toHaveLength(2)
    result = {
      schemaVersion: 1,
      extractionId: 'prepared-table',
      engineFingerprint: recipe.fingerprint,
      sourceChecksum: createHash('sha256').update(bytes).digest('hex'),
      sourceSizeBytes: bytes.length,
      pageCount: 2,
      requestedPages: [1],
      processedPages: [1],
      pages: [{ page: 1, width: 612, height: 792, rotation: 0 }],
      thumbnails: [],
      navigation: [],
      issues: [],
      elements: [
        {
          id: 'table',
          kind: 'table',
          regions: [{ page: 1, x: 40 / 612, y: 130 / 792, width: 340 / 612, height: 12 / 792 }],
          issues: [],
          table: {
            rowCount: 1,
            columnCount: 2,
            unassignedText: [],
            issues: [],
            cells: tableItems.map(({ item, index }, column) => ({
              row: 0,
              column,
              rowSpan: 1,
              columnSpan: 1,
              text: item.str,
              sourceItems: [{ pageNumber: 1, index, text: item.str }],
              regions: [
                {
                  page: 1,
                  x: item.transform[4] / 612,
                  y: (792 - item.transform[5] - item.height) / 792,
                  width: item.width / 612,
                  height: item.height / 792
                }
              ]
            }))
          }
        }
      ]
    }
  } finally {
    await loading.destroy()
  }
  const cache = new PdfStructureCache({ dataRoot: () => dataRoot })
  await cache.publish(result, new Map(), new AbortController().signal)
  const cached = await page.evaluate(
    (attachmentVersionId) => window.api.pdfStructure.readCached({ attachmentVersionId, page: 1 }),
    version.id
  )
  expect(cached?.extractionId).toBe(result.extractionId)
  const library = async (): Promise<void> => {
    await page.getByRole('button', { name: 'Library', exact: true }).click()
    await page.getByRole('button', { name: 'All references', exact: true }).click()
  }
  const prepare = async (separate: boolean): Promise<void> => {
    await page.getByRole('button', { name: 'Preview preparation.pdf', exact: true }).click()
    await page.getByRole('button', { name: 'Full-text translation', exact: true }).click()
    const report = page.locator('[data-pdf-preparation]')
    await expect(
      report.getByRole('button', { name: 'Prepare full text', exact: true })
    ).toBeVisible()
    await expect(report.getByRole('status')).toHaveCount(0)
    await report.getByRole('button', { name: 'Prepare full text', exact: true }).click()
    await expect(report.getByRole('status')).toHaveText('Full text prepared')
    await report.getByRole('button', { name: 'Full-text preparation', exact: true }).click()
    // Without table provenance the isolated numeric label remains a separate native region.
    await expect(report.locator('dd')).toHaveText(['2', '4', '4', '0', separate ? '2' : '1'])
    const information = report.locator('[data-pdf-preparation-info]')
    await information.hover()
    await expect(page.getByRole('tooltip')).toContainText(
      'not translation completeness or accuracy.'
    )
    await report.getByRole('button', { name: 'Full-text preparation', exact: true }).hover()
    await expect(page.getByRole('group', { name: 'PDF rendition' })).toHaveCount(0)
  }
  const close = async (): Promise<void> => {
    await page
      .getByRole('button', { name: 'Close preview of preparation.pdf', exact: true })
      .click()
    await expect(page.locator('[data-pdf-preview-root]')).toHaveCount(0)
  }
  await library()
  await prepare(true)
  const translationPanel = page.locator('[data-pdf-translation-sidebar]')
  const modelPicker = translationPanel.getByRole('combobox', { name: 'Translation method' })
  await modelPicker.click()
  await expect(page.getByRole('listbox')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('translation-model-picker.png') })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await expect(translationPanel).toBeVisible()
  await expect(modelPicker).toBeFocused()
  await modelPicker.click()
  await page.getByRole('option', { name: 'Agent', exact: true }).click()
  await expect(translationPanel).toContainText('Main model:')
  await page.screenshot({ path: testInfo.outputPath('translation-model-details.png') })
  const settings = translationPanel.getByRole('button', {
    name: 'Translation settings',
    exact: true
  })
  await settings.click()
  await expect(modelPicker).toBeHidden()
  await settings.click()
  await expect(modelPicker).toBeVisible()

  await translationPanel.getByLabel('Target language', { exact: true }).fill('Chinese')
  await translationPanel
    .locator('button')
    .filter({ hasText: /^Translation glossary$/ })
    .click()
  await translationPanel.getByRole('button', { name: 'Add term', exact: true }).click()
  await translationPanel.getByLabel('Source term 1', { exact: true }).fill('cell')
  await translationPanel.getByLabel('Preferred translation 1', { exact: true }).fill('细胞')
  await translationPanel.getByRole('button', { name: 'Close translation', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Full-text translation', exact: true })
  ).toBeFocused()
  await page.getByRole('button', { name: 'Show navigation', exact: true }).first().click()
  await expect(page.locator('#pdf-navigation-sidebar')).not.toContainText('Translation settings')
  await page.getByRole('button', { name: 'Full-text translation', exact: true }).click()
  await expect(translationPanel.getByLabel('Target language', { exact: true })).toHaveValue(
    'Chinese'
  )
  await expect(translationPanel.getByLabel('Preferred translation 1', { exact: true })).toHaveValue(
    '细胞'
  )
  await translationPanel.getByLabel('Target language', { exact: true }).press('Escape')
  await expect(translationPanel).toBeHidden()
  await page.getByRole('button', { name: 'Full-text translation', exact: true }).click()
  await page.screenshot({ path: testInfo.outputPath('prepared-cached-table.png') })
  await page.getByRole('button', { name: 'Show notes sidebar', exact: true }).click()
  await expect(translationPanel).toBeHidden()
  await expect(page.locator('[data-pdf-notes-sidebar]')).toBeVisible()
  await page.getByRole('button', { name: 'Full-text translation', exact: true }).click()
  await expect(translationPanel).toBeVisible()
  await expect(page.locator('[data-pdf-notes-sidebar]')).toHaveCount(0)
  const reader = page.locator('[data-pdf-preview-root]')
  for (const width of [320, 375, 414, 768]) {
    await reader.evaluate((element, width) => {
      element.style.width = `${width}px`
      element.style.maxWidth = `${width}px`
    }, width)
    await expect.poll(async () => reader.evaluate((element) => element.clientWidth)).toBe(width)
    await expect(
      translationPanel.getByRole('button', { name: 'Close translation', exact: true })
    ).toBeVisible()
    const translationEntry = page.getByRole('button', {
      name: 'Full-text translation',
      exact: true
    })
    const entryBounds = await translationEntry.boundingBox()
    const notesBounds = await page
      .getByRole('button', { name: 'Show notes sidebar', exact: true })
      .boundingBox()
    expect(await translationEntry.textContent()).toBe('')
    expect(entryBounds!.width).toBe(notesBounds!.width)
    expect(entryBounds!.x + entryBounds!.width).toBeLessThanOrEqual(notesBounds!.x)
    expect(entryBounds!.y).toBe(notesBounds!.y)
    const bounds = await reader.boundingBox()
    const panelBounds = await translationPanel.boundingBox()
    expect(panelBounds!.x).toBeGreaterThanOrEqual(bounds!.x)
    expect(panelBounds!.x + panelBounds!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1)
    expect(
      await translationPanel.evaluate((element) => element.scrollWidth <= element.clientWidth)
    ).toBe(true)
    await expect(page.locator('#pdf-navigation-sidebar')).toHaveCount(0)
    await reader.screenshot({ path: testInfo.outputPath(`translation-sidebar-${width}.png`) })
    await translationPanel.getByRole('button', { name: 'Close translation', exact: true }).click()
    await expect(translationPanel).toBeHidden()
    await page.getByRole('button', { name: 'Full-text translation', exact: true }).click()
    await expect(translationPanel).toBeVisible()
  }
  await reader.evaluate((element) => {
    element.style.removeProperty('width')
    element.style.removeProperty('max-width')
  })

  // Removing optional cache data must not mutate an already published source snapshot.
  expect((await cache.clear()).retained).toEqual([])
  await expect(page.locator('[data-pdf-preparation] dd')).toHaveText(['2', '4', '4', '0', '2'])
  await close()
  await prepare(false)
  await page.screenshot({ path: testInfo.outputPath('prepared-without-cache.png') })
  await close()

  // A different PDF's structurally valid cache must not be admitted for this attachment.
  await cache.publish(
    { ...result, sourceChecksum: 'd'.repeat(64) },
    new Map(),
    new AbortController().signal
  )
  expect(
    await page.evaluate(
      (attachmentVersionId) => window.api.pdfStructure.readCached({ attachmentVersionId, page: 1 }),
      version.id
    )
  ).toBeUndefined()
  await prepare(false)
  await close()
  expect((await cache.clear()).retained).toEqual([])
  await cache.publish(result, new Map(), new AbortController().signal)

  // Disk provenance survives restart; document-scoped preparation must start afresh.
  page = await app.restart()
  await library()
  await prepare(true)
  const modelAfter = await page.evaluate(() => window.api.localModels.getSnapshot())
  expect(modelAfter.availability).toBe(modelBefore.availability)
  expect(modelAfter.installedRevision).toBe(modelBefore.installedRevision)
  await page.screenshot({ path: testInfo.outputPath('prepared-after-restart.png') })
  await close()
})

test('cancels preparation and closes an active Library PDF without retaining its report', async ({
  app
}, testInfo) => {
  await app.page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
  const page = await app.completeOnboarding()
  const item = literatureItemInputSchema.parse({
    itemType: 'journalArticle',
    title: 'Cancellation acceptance'
  })
  // Real page reads yield between pages; enough pages keep cancellation observable without
  // replacing PDF.js, slowing IPC, or introducing a production test hook.
  await page.evaluate(
    async ({ item, bytes }) => {
      const { id } = await window.api.literature.transact({ kind: 'create-item', item })
      const chunk = new Uint8Array(bytes),
        transferId = crypto.randomUUID()
      await window.api.uploads.beginTransfer({
        transferId,
        name: 'long-preparation.pdf',
        mimeType: 'application/pdf',
        size: chunk.length
      })
      await window.api.uploads.appendTransfer({ transferId, offset: 0, chunk })
      const attachment = await window.api.uploads.finishTransfer({ transferId })
      await window.api.literature.importPdf({ itemId: id, attachment })
    },
    { item, bytes: [...textPdf(240)] }
  )
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  await page.getByRole('button', { name: 'All references', exact: true }).click()
  await page.getByRole('button', { name: 'Preview long-preparation.pdf', exact: true }).click()
  await page.getByRole('button', { name: 'Full-text translation', exact: true }).click()
  const report = page.locator('[data-pdf-preparation]')
  const idleFrame = await report
    .getByRole('button', { name: 'Prepare full text', exact: true })
    .evaluate((button) => {
      const body = button.parentElement!,
        card = body.parentElement!,
        style = getComputedStyle(card),
        bounds = card.getBoundingClientRect()
      return {
        left: bounds.left,
        width: bounds.width,
        border: style.borderWidth,
        radius: style.borderRadius,
        bottomPadding: parseFloat(getComputedStyle(body).paddingBottom)
      }
    })
  await report.getByRole('button', { name: 'Prepare full text', exact: true }).click()
  await expect(report.getByRole('progressbar')).toBeVisible()
  const runningFrame = await report.getByRole('progressbar').evaluate((progress) => {
    const body = progress.parentElement!,
      card = body.parentElement!,
      style = getComputedStyle(card),
      bounds = card.getBoundingClientRect(),
      cancel = body.querySelector('button')!.getBoundingClientRect()
    return {
      left: bounds.left,
      width: bounds.width,
      border: style.borderWidth,
      radius: style.borderRadius,
      bottomPadding: parseFloat(getComputedStyle(body).paddingBottom),
      cancelBottomGap: bounds.bottom - cancel.bottom,
      cancelWidth: cancel.width,
      progressWidth: progress.getBoundingClientRect().width
    }
  })
  expect(runningFrame.left).toBeCloseTo(idleFrame.left, 0)
  expect(runningFrame.width).toBeCloseTo(idleFrame.width, 0)
  expect(runningFrame.border).toBe(idleFrame.border)
  expect(runningFrame.radius).toBe(idleFrame.radius)
  expect(runningFrame.bottomPadding).toBe(idleFrame.bottomPadding)
  expect(runningFrame.cancelBottomGap).toBeGreaterThanOrEqual(idleFrame.bottomPadding)
  expect(runningFrame.cancelWidth).toBeCloseTo(runningFrame.progressWidth, 0)
  await page.screenshot({ path: testInfo.outputPath('preparation-running.png') })
  await report.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(report.getByRole('status')).toHaveText('Full-text preparation cancelled.')
  await expect(report.locator('dd')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('preparation-cancelled.png') })
  await report.getByRole('button', { name: 'Prepare full text', exact: true }).click()
  await expect(report.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
  await page
    .getByRole('button', { name: 'Close preview of long-preparation.pdf', exact: true })
    .click()
  await expect(page.locator('[data-pdf-preview-root]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Preview long-preparation.pdf', exact: true }).click()
  await page.getByRole('button', { name: 'Full-text translation', exact: true }).click()
  await expect(report.getByRole('button', { name: 'Prepare full text', exact: true })).toBeVisible()
  await expect(report.getByRole('status')).toHaveCount(0)
  await expect(
    page.getByRole('region', { name: 'long-preparation.pdf scrollable preview' })
  ).toContainText('Text preparation sample.')
  await page
    .getByRole('button', { name: 'Close preview of long-preparation.pdf', exact: true })
    .click()
})
