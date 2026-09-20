import { expect } from '@playwright/test'
import { PDFDocument, PDFDict, PDFName, PDFHexString } from 'pdf-lib'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from './fixtures/electron-app'
import { literatureItemInputSchema } from '../src/shared/literature'

test('imports external notes, preserves provenance through undo, and persists an empty annotated export', async ({
  app
}, testInfo) => {
  test.setTimeout(180_000)
  let page = await app.completeOnboarding()
  await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
  const directory = await app.createTestDirectory('native-pdf-annotations')
  const file = join(directory, 'native-notes.pdf')
  const pdf = await PDFDocument.create()
  const sheet = pdf.addPage([300, 1400])
  sheet.drawText('External evidence', { x: 20, y: 300, size: 14 })
  sheet.node.set(
    PDFName.of('Annots'),
    pdf.context.obj([
      pdf.context.register(
        pdf.context.obj({
          Type: 'Annot',
          Subtype: 'Highlight',
          Rect: [20, 296, 180, 316],
          QuadPoints: [20, 316, 180, 316, 20, 296, 180, 296],
          C: [1, 1, 0],
          Contents: PDFHexString.fromText('External highlight')
        })
      ),
      pdf.context.register(
        pdf.context.obj({
          Type: 'Annot',
          Subtype: 'Text',
          Rect: [20, 200, 40, 220],
          Contents: PDFHexString.fromText('External sticky note')
        })
      ),
      pdf.context.register(
        pdf.context.obj({ Type: 'Annot', Subtype: 'Sound', Rect: [200, 100, 220, 120] })
      )
    ])
  )
  await writeFile(file, await pdf.save())
  const reference = await page.evaluate(
    (item) => window.api.literature.transact({ kind: 'create-item', item }),
    literatureItemInputSchema.parse({
      itemType: 'journalArticle',
      title: 'Native annotation regression'
    })
  )
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  await page.getByRole('button', { name: 'All references', exact: true }).click()
  await page.getByText('Native annotation regression', { exact: true }).click()
  await page.locator('input[aria-label="Add PDF"]').setInputFiles(file)
  await expect(
    page.getByRole('button', { name: 'Preview native-notes.pdf', exact: true })
  ).toBeEnabled()
  const versionId = await page.evaluate(
    async (id) => (await window.api.literature.get(id))!.attachments[0].versions[0].id,
    reference.id
  )
  const snapshot = (): ReturnType<typeof page.evaluate> =>
    page.evaluate(
      (versionId) => window.api.pdfAnnotations.list({ literatureVersionId: versionId }),
      versionId
    )
  await expect.poll(snapshot).toMatchObject({
    total: 2,
    nativeImport: { unsupportedCount: 1, nativeRefs: [{ pageNumber: 1 }, { pageNumber: 1 }] }
  })
  await page.getByRole('button', { name: 'Preview native-notes.pdf', exact: true }).click()
  await page.getByRole('tab', { name: 'Notes & Annotations', exact: true }).click()
  const cards = page.locator('li[data-annotation-id]')
  await expect(cards).toHaveCount(2)
  await page.evaluate(async (versionId) => {
    const marks = await window.api.pdfAnnotations.list({ literatureVersionId: versionId })
    const tags = await window.api.tags.snapshot()
    await window.api.tags.setAssignment({
      tagId: tags.tags.find((tag) => tag.systemKey === 'favorite')!.id,
      resourceType: 'pdf.annotation',
      resourceId: marks.items.find((mark) => mark.externalSubtype === 'Text')!.id,
      assigned: true
    })
  }, versionId)
  await page.getByRole('button', { name: 'Close preview of native-notes.pdf', exact: true }).click()
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'Back to Home', exact: true }).click()
  await page.getByRole('button', { name: 'Model settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Tags', exact: true })
    .click()
  const taggedPdf = settings
    .locator('[data-slot="tag-resource-row"]')
    .filter({ hasText: 'native-notes.pdf' })
  await taggedPdf.click()
  const preview = page.locator('[data-slot="file-preview-dialog"]')
  await expect(preview).toBeVisible()
  await expect(page.getByRole('button', { name: 'Back to Home', exact: true })).toHaveCount(0)
  await expect(preview.locator('[data-pdf-bookmark-revealed="true"]')).toBeVisible()
  const pdfScroller = preview.getByRole('region', {
    name: 'native-notes.pdf scrollable preview',
    exact: true
  })
  await expect
    .poll(() => pdfScroller.evaluate((node) => node.scrollHeight - node.clientHeight))
    .toBeGreaterThan(100)
  const scrollBefore = await pdfScroller.evaluate((node) => node.scrollTop)
  await pdfScroller.hover({ position: { x: 100, y: 100 } })
  await page.mouse.wheel(0, scrollBefore > 100 ? -250 : 250)
  await expect.poll(() => pdfScroller.evaluate((node) => node.scrollTop)).not.toBe(scrollBefore)
  await preview.getByRole('tab', { name: 'Notes & Annotations', exact: true }).click()
  await preview.getByRole('button', { name: 'Add note', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Add document note', exact: true }).click()
  await preview.getByRole('button', { name: 'Add or remove Tags', exact: true }).click()
  await page.getByRole('option', { name: 'Favorites', exact: true }).click()
  await page.keyboard.press('Escape')
  const removeTag = preview
    .getByRole('group', { name: 'Tags', exact: true })
    .getByRole('button', { name: 'Remove Favorites from this resource', exact: true })
  await removeTag.locator('..').hover()
  await expect(removeTag).toHaveCSS('opacity', '1')
  const inset = await removeTag.evaluate((button) => {
    const badge = button.parentElement!.querySelector('span')!.getBoundingClientRect()
    const control = button.getBoundingClientRect()
    return (
      control.left >= badge.left &&
      control.right <= badge.right &&
      control.top >= badge.top &&
      control.bottom <= badge.bottom
    )
  })
  expect(inset).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('tag-inset-remove.png') })
  await removeTag.click()
  await expect(removeTag).toHaveCount(0)
  await preview.getByRole('button', { name: 'Cancel', exact: true }).click()
  await preview
    .getByRole('button', { name: 'Close preview of native-notes.pdf', exact: true })
    .click()
  await expect(taggedPdf).toBeVisible()
  await expect(taggedPdf).toBeFocused()
  await taggedPdf.click()
  await expect(preview.locator('[data-pdf-bookmark-revealed="true"]')).toBeVisible()
  await preview.getByRole('tab', { name: 'Notes & Annotations', exact: true }).click()
  await cards
    .filter({ hasText: 'External sticky note' })
    .getByRole('button', { name: 'Delete annotation', exact: true })
    .click()
  await expect(cards).toHaveCount(1)
  await page
    .getByRole('button', { name: 'Undo annotation change', exact: true })
    .filter({ visible: true })
    .click()
  await expect(cards).toHaveCount(2)
  await expect.poll(snapshot).toMatchObject({
    items: expect.arrayContaining([
      expect.objectContaining({
        origin: 'imported',
        externalSubtype: 'Text',
        note: 'External sticky note'
      })
    ])
  })
  await page
    .getByRole('button', { name: 'Redo annotation change', exact: true })
    .filter({ visible: true })
    .click()
  await expect(cards).toHaveCount(1)
  await cards.getByRole('button', { name: 'Delete annotation', exact: true }).click()
  await expect(cards).toHaveCount(0)
  const output = await app.configureSessionPackageDialogs() // Reuse the fixture's native save-dialog override.
  await page.locator('[data-testid="download-tooltip-trigger"]:visible').last().click()
  await page.getByRole('menuitem', { name: 'Download PDF with annotations', exact: true }).click()
  await expect
    .poll(async () =>
      readFile(output)
        .then((bytes) => bytes.subarray(0, 5).toString())
        .catch(() => '')
    )
    .toBe('%PDF-')
  const exported = await PDFDocument.load(await readFile(output))
  const types = exported
    .getPage(0)
    .node.Annots()!
    .asArray()
    .map((ref) => exported.context.lookup(ref, PDFDict).get(PDFName.of('Subtype'))?.toString())
  expect(types).toEqual(['/Sound'])
  await page.screenshot({ path: testInfo.outputPath('empty-notebook-export.png') })
  page = await app.restart()
  await expect.poll(snapshot).toMatchObject({
    total: 0,
    nativeImport: { nativeRefs: [{ pageNumber: 1 }, { pageNumber: 1 }] }
  })
})
