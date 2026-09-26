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
  sheet.drawText('Selection placement', { x: 20, y: 1340, size: 14 })
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
  await app.setMainWindowSize(1440, 960)
  await page.getByRole('tab', { name: 'Original PDF', exact: true }).click()
  const selectableText = page.locator('.textLayer span').filter({ hasText: 'Selection placement' })
  await expect(selectableText).toBeVisible()
  const textBox = (await selectableText.boundingBox())!
  await page.mouse.move(textBox.x + 1, textBox.y + textBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(textBox.x + textBox.width - 1, textBox.y + textBox.height / 2, { steps: 8 })
  await page.mouse.up()
  const selectionToolbar = page.locator('[data-selection-action-menu]')
  await expect(selectionToolbar).toBeVisible()
  // Read the fixed anchor rather than its short entrance animation transform.
  const toolbarTop = await selectionToolbar.evaluate((element) => parseFloat(element.style.top))
  await selectionToolbar.getByRole('button', { name: 'Annotate', exact: true }).click()
  const annotationEditor = page.locator('.annotation-popover').filter({
    has: page.getByRole('button', { name: 'Save annotation', exact: true })
  })
  await expect(annotationEditor).toBeVisible()
  await expect
    .poll(async () => Math.abs((await annotationEditor.boundingBox())!.y - toolbarTop))
    .toBeLessThanOrEqual(1)
  await page.screenshot({ path: testInfo.outputPath('annotation-editor-replaces-selection.png') })
  await annotationEditor.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Show notes sidebar', exact: true }).click()
  const notesSidebar = page.locator('[data-pdf-notes-sidebar="true"]')
  await expect(notesSidebar).toBeVisible()
  await expect(notesSidebar.locator('[data-annotation-id]')).toHaveCount(2)
  await expect(notesSidebar.locator('[data-annotation-page-group="1"]')).toBeVisible()
  const originalView = page.locator('[data-pdf-original-view]')
  expect((await originalView.boundingBox())!.width).toBeGreaterThanOrEqual(752)
  // The compact header must center the tag trigger and source/edit/delete actions on one row.
  const firstCard = notesSidebar.locator('[data-annotation-id]').first()
  const headerCenters = await Promise.all(
    ['Add tag', 'Show annotation source', 'Edit annotation note', 'Delete annotation'].map(
      async (name) => {
        const box = (await firstCard.getByRole('button', { name, exact: true }).boundingBox())!
        return box.y + box.height / 2
      }
    )
  )
  expect(Math.max(...headerCenters) - Math.min(...headerCenters)).toBeLessThanOrEqual(1)
  await notesSidebar
    .getByRole('button', { name: 'Show annotation source', exact: true })
    .first()
    .click()
  await expect(originalView.locator('[data-pdf-bookmark-revealed="true"]')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('notes-sidebar-wide.png') })
  await page.getByRole('button', { name: 'Show navigation', exact: true }).click()
  await expect(notesSidebar).toBeVisible()
  const toolbar = page.getByRole('tablist', { name: 'PDF reading mode' })
  await expect(
    toolbar.getByRole('button', { name: 'Hide notes sidebar', exact: true })
  ).toBeEnabled()
  await toolbar.getByRole('button', { name: 'Hide notes sidebar', exact: true }).click()
  await toolbar.getByRole('button', { name: 'Show notes sidebar', exact: true }).click()
  await expect(notesSidebar).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('notes-and-navigation-sidebars.png') })
  await toolbar.getByRole('button', { name: 'Hide navigation', exact: true }).click()
  const resizeNotes = notesSidebar.getByRole('separator', { name: 'Resize notes sidebar' })
  await resizeNotes.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(resizeNotes).toHaveAttribute('aria-valuenow', '336')
  const handle = (await resizeNotes.boundingBox())!
  const handleX = handle.x + handle.width / 2
  const handleY = handle.y + handle.height / 2
  await page.mouse.move(handleX, handleY)
  await page.mouse.down()
  await page.mouse.move(handleX - 32, handleY, { steps: 4 })
  await page.mouse.up()
  await expect(resizeNotes).toHaveAttribute('aria-valuenow', '368')
  await notesSidebar.getByRole('button', { name: 'Current page', exact: true }).click()
  await notesSidebar.getByRole('button', { name: 'Add note', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Add page note', exact: true }).click()
  await notesSidebar
    .getByPlaceholder('Add a private note')
    .fill('Sidebar draft survives layout changes')
  await app.setMainWindowSize(1100, 960)
  await expect(page.getByRole('button', { name: 'Show notes sidebar', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Show notes sidebar', exact: true })).toBeDisabled()
  await expect(notesSidebar).toHaveCount(0)
  await page.getByRole('tab', { name: 'Notes & Annotations', exact: true }).click()
  await expect(page.getByPlaceholder('Add a private note')).toHaveValue(
    'Sidebar draft survives layout changes'
  )
  await page.getByRole('tab', { name: 'Original PDF', exact: true }).click()
  await app.setMainWindowSize(1440, 960)
  await expect(notesSidebar.getByPlaceholder('Add a private note')).toHaveValue(
    'Sidebar draft survives layout changes'
  )
  await notesSidebar.getByRole('button', { name: 'Open full notes view', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Notes & Annotations', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await expect(page.getByPlaceholder('Add a private note')).toHaveValue(
    'Sidebar draft survives layout changes'
  )
  await page.getByRole('tab', { name: 'Original PDF', exact: true }).click()
  await notesSidebar.getByRole('button', { name: 'Cancel', exact: true }).click()
  await notesSidebar.getByRole('button', { name: 'Hide notes sidebar', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Show notes sidebar', exact: true })).toBeFocused()
  await app.setMainWindowSize(1280, 960)
  await page.getByRole('tab', { name: 'Notes & Annotations', exact: true }).click()
  await page.evaluate(async (versionId) => {
    const marks = await window.api.pdfAnnotations.list({ literatureVersionId: versionId })
    const tags = await window.api.tags.snapshot()
    await window.api.tags.setAssignment({
      tagId: tags.tags.find((tag) => 'systemKey' in tag && tag.systemKey === 'favorite')!.id,
      resourceType: 'pdf.annotation',
      resourceId: marks.items.find((mark) => mark.externalSubtype === 'Text')!.id,
      assigned: true
    })
  }, versionId)
  await page.getByRole('button', { name: 'Close preview of native-notes.pdf', exact: true }).click()
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'Back to Home', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
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
  await app.setMainWindowSize(660, 900)
  await app.setMainWindowZoomFactor(2)
  await page.screenshot({ path: testInfo.outputPath('notes-tabs-narrow.png') })
  const extraTags = Array.from({ length: 6 }, (_, index) => `Research topic ${index + 1}`)
  await page.evaluate(async (names) => {
    for (const name of names)
      await window.api.tags.create({ name, iconKey: 'tag', colorKey: 'blue' })
  }, extraTags)
  await preview.getByRole('button', { name: 'Add note', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Add page note', exact: true }).click()
  const saveNote = preview.getByRole('button', { name: 'Save', exact: true })
  const saveBeforeTags = await saveNote.boundingBox()
  await preview.getByRole('button', { name: 'Add or remove Tags', exact: true }).click()
  await page.getByRole('option', { name: 'Favorites', exact: true }).click()
  for (const name of extraTags) await page.getByRole('option', { name, exact: true }).click()
  expect(await saveNote.boundingBox()).toEqual(saveBeforeTags)
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
  const selectedTags = removeTag.locator('../..')
  expect(await selectedTags.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true)
  const saveAfterTags = await saveNote.boundingBox()
  expect(saveAfterTags).toEqual(saveBeforeTags)
  await app.setMainWindowZoomFactor(1)
  await app.setMainWindowSize(1280, 960)
  await page.screenshot({ path: testInfo.outputPath('tag-editor-wide.png') })
  await removeTag.locator('..').hover()
  await removeTag.click()
  await expect(removeTag).toHaveCount(0)
  await preview.getByRole('button', { name: 'Cancel', exact: true }).click()
  await preview
    .getByRole('button', { name: 'Close preview of native-notes.pdf', exact: true })
    .click()
  await expect(taggedPdf).toBeVisible()
  await expect(taggedPdf).toBeFocused()
  await settings.getByRole('button', { name: 'Close settings', exact: true }).click()
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  const globalSearch = page.getByRole('dialog', { name: 'Global search', exact: true })
  await page.evaluate(async (versionId) => {
    const { items } = await window.api.pdfAnnotations.list({ literatureVersionId: versionId })
    await window.api.pdfAnnotations.create({
      id: 'search-document-note',
      literatureVersionId: versionId,
      kind: 'document-note',
      note: 'Document-wide search regression',
      tagIds: [],
      target: {
        source: items[0].target.source,
        selector: { kind: 'document-note', coordinateVersion: 1 }
      }
    })
  }, versionId)
  await globalSearch
    .getByRole('combobox', { name: 'Global search' })
    .fill('Document-wide search regression')
  const documentNoteResult = globalSearch.getByRole('listbox').getByRole('option')
  await expect(documentNoteResult).toHaveCount(1)
  await documentNoteResult.click()
  await globalSearch.getByRole('button', { name: 'Show annotation source', exact: true }).click()
  await expect(
    preview.getByRole('tab', { name: 'Notes & Annotations', exact: true })
  ).toHaveAttribute('aria-selected', 'true')
  const documentNoteCard = preview.locator('[data-annotation-id="search-document-note"]')
  // Focus is applied by the reveal listener immediately before it acknowledges success.
  await expect(documentNoteCard).toBeFocused()
  await expect(
    page.getByText('The exact annotation location could not be found.', { exact: true })
  ).toHaveCount(0)
  await documentNoteCard.getByRole('button', { name: 'Delete annotation', exact: true }).click()
  await preview
    .getByRole('button', { name: 'Close preview of native-notes.pdf', exact: true })
    .click()
  await globalSearch.getByRole('combobox', { name: 'Global search' }).fill('External sticky note')
  await globalSearch.locator('[data-category="library"]').click()
  const noteResult = globalSearch.getByRole('listbox').getByRole('option')
  await expect(noteResult).toHaveCount(1)
  await expect(noteResult).toContainText('Notes & Annotations')
  await expect(noteResult).toContainText('native-notes.pdf')
  await noteResult.click()
  await expect(preview).toBeHidden()
  const noteDetails = globalSearch.getByTestId('global-search-detail')
  await expect(noteDetails).toHaveAttribute('data-open', 'true')
  await expect(noteDetails.getByRole('region', { name: 'Notes', exact: true })).toContainText(
    'External sticky note'
  )
  await expect(noteDetails.getByRole('heading', { name: 'native-notes.pdf' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('search-note-detail.png') })
  const showNoteSource = noteDetails.getByRole('button', { name: 'Show annotation source' })
  await showNoteSource.click()
  await expect(preview).toBeVisible()
  await expect(preview.locator('[data-pdf-bookmark-revealed="true"]')).toBeVisible()
  await preview
    .getByRole('button', { name: 'Close preview of native-notes.pdf', exact: true })
    .click()
  await expect(noteResult).toBeVisible()
  await expect(showNoteSource).toBeFocused()
  await expect(noteDetails).toHaveAttribute('data-open', 'true')
  await noteResult.dblclick()
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
