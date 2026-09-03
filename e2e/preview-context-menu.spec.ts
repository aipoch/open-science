import { expect } from '@playwright/test'
import { realpath, writeFile } from 'node:fs/promises'
import type { Page } from 'playwright'

import { test } from './fixtures/electron-app'

const PROJECT_NAME = 'Preview context menu journey'
const TEXT_FILE_NAME = 'context-menu.txt'
const HTML_FILE_NAME = 'context-menu.html'
const PDF_FILE_NAME = 'context-menu.pdf'

const blankPdf = (): Buffer => {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources << >> >>\nendobj\n',
    '4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n'
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((object) => {
    const offset = Buffer.byteLength(pdf)
    pdf += object
    return offset
  })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}

const createProject = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill(PROJECT_NAME)
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()
}

const openLocalBrowserAt = async (page: Page, directory: string): Promise<void> => {
  const canonicalDirectory = await realpath(directory)
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await page.getByRole('button', { name: 'Filter project files' }).click()
  // The machine row uses the host name as its accessible label; it follows the fixed Artifact rows
  // and is the final radio option in a fresh isolated E2E profile.
  await page
    .getByRole('menu', { name: 'Filter project files' })
    .getByRole('menuitemradio')
    .last()
    .click()
  const browser = page.getByLabel('Local file browser')
  await expect(browser).toBeVisible()
  const contents = browser.getByRole('listbox', { name: 'Directory contents' })
  await expect(contents).toBeVisible()
  const address = browser.getByLabel('Directory path')
  await address.fill(canonicalDirectory)
  await address.press('Enter')
  await expect(address).toHaveValue(canonicalDirectory)
  await expect(contents).toBeVisible()
}

const openLocalFile = async (page: Page, name: string): Promise<void> => {
  await page
    .getByRole('listbox', { name: 'Directory contents' })
    .getByRole('button')
    .filter({ hasText: name })
    .click()
  await expect(page.getByRole('tab').filter({ hasText: name })).toHaveAttribute(
    'aria-selected',
    'true'
  )
}

const expectContentMenu = async (page: Page, expectedActions: readonly string[]): Promise<void> => {
  const menu = page.getByTestId('preview-content-context-menu')
  await expect(menu).toBeVisible()
  for (const action of expectedActions)
    await expect(menu.getByText(action, { exact: true })).toBeVisible()
}

test('opens positioned shared preview actions from DOM, HTML, PDF, and Office content', async ({
  app
}) => {
  const localRoot = await app.createTestDirectory('preview-context-menu-files')
  await writeFile(`${localRoot}/${TEXT_FILE_NAME}`, 'Local context menu fixture.', 'utf8')
  await writeFile(
    `${localRoot}/${HTML_FILE_NAME}`,
    '<!doctype html><html><body><main style="position:fixed;inset:0"><h1>Local HTML context menu fixture</h1><p data-preview-context-menu-passthrough>Local native context area</p></main></body></html>',
    'utf8'
  )
  await writeFile(`${localRoot}/${PDF_FILE_NAME}`, blankPdf())

  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await createProject(page)
  await openLocalBrowserAt(page, localRoot)

  await openLocalFile(page, TEXT_FILE_NAME)
  const contentRegion = page.getByTestId('preview-file-content-region')
  await contentRegion.click({ button: 'right', position: { x: 80, y: 80 } })
  await expectContentMenu(page, ['Copy path', 'Download', 'Save as artifact'])
  await page.getByTestId('preview-content-context-menu').getByText('Copy path').click()
  await page.getByRole('button', { name: 'More actions' }).click()
  await expect(page.getByRole('menu').getByText('Copied', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')

  const localTab = page.getByRole('tab').filter({ hasText: TEXT_FILE_NAME })
  await localTab.click({ button: 'right' })
  const tabMenu = page.getByTestId('preview-tab-context-menu')
  await expect(tabMenu.getByText('Close', { exact: true })).toBeVisible()
  await expect(tabMenu.getByText('Copy path', { exact: true })).toBeVisible()
  await expect(tabMenu.getByText('Download', { exact: true })).toBeVisible()
  await expect(tabMenu.getByText('Save as artifact', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')

  const previewResizeHandle = page.getByRole('separator', { name: 'Resize right panel' })
  const previewResizeHandleBounds = await previewResizeHandle.boundingBox()
  expect(previewResizeHandleBounds).not.toBeNull()
  await page.mouse.move(
    previewResizeHandleBounds!.x + previewResizeHandleBounds!.width / 2,
    previewResizeHandleBounds!.y + previewResizeHandleBounds!.height / 2
  )
  await page.mouse.down()
  await page.mouse.move(previewResizeHandleBounds!.x - 400, previewResizeHandleBounds!.y + 20)
  await page.mouse.up()

  await page.getByRole('tab', { name: 'Files' }).click()
  await openLocalFile(page, HTML_FILE_NAME)
  await app.setMainWindowZoomFactor(1.25)
  try {
    const localHtmlFrame = page.frameLocator(`iframe[title="Preview of ${HTML_FILE_NAME}"]`)
    await expect(
      localHtmlFrame.getByRole('heading', { name: 'Local HTML context menu fixture' })
    ).toBeVisible()
    await localHtmlFrame
      .getByText('Local native context area', { exact: true })
      .click({ button: 'right' })
    await page.waitForTimeout(300)
    await expect(page.getByTestId('preview-content-context-menu')).toBeHidden()

    const localHtmlHeading = localHtmlFrame.getByRole('heading', {
      name: 'Local HTML context menu fixture'
    })
    const frameClick = { x: 8, y: 10 }
    const localHtmlHeadingBounds = await localHtmlHeading.boundingBox()
    expect(localHtmlHeadingBounds).not.toBeNull()
    await localHtmlHeading.click({ button: 'right', position: frameClick })
    await expectContentMenu(page, ['Copy path', 'Download', 'Save as artifact'])
    const menuBounds = await page.getByTestId('preview-content-context-menu').boundingBox()
    expect(menuBounds).not.toBeNull()
    expect(
      Math.abs(menuBounds!.x - (localHtmlHeadingBounds!.x + frameClick.x))
    ).toBeLessThanOrEqual(1)
    expect(
      Math.abs(menuBounds!.y - (localHtmlHeadingBounds!.y + frameClick.y))
    ).toBeLessThanOrEqual(1)
    await page.keyboard.press('Escape')

    await localHtmlFrame.locator('body').evaluate(() => {
      window.location.hash = 'results'
    })
    await expect
      .poll(() => localHtmlFrame.locator('body').evaluate(() => location.hash))
      .toBe('#results')
    await localHtmlHeading.click({ button: 'right', position: frameClick })
    await expectContentMenu(page, ['Copy path', 'Download', 'Save as artifact'])
    await page.keyboard.press('Escape')
  } finally {
    await app.setMainWindowZoomFactor(1)
  }

  await page.getByRole('tab', { name: 'Files' }).click()
  await openLocalFile(page, PDF_FILE_NAME)
  const pdfRegion = page.getByRole('region', { name: `${PDF_FILE_NAME} scrollable preview` })
  const pdfPageClick = { x: 200, y: 160 }
  await expect(pdfRegion).toBeVisible()
  await pdfRegion.click({ button: 'right', position: pdfPageClick })
  const pdfMenu = page.getByTestId('preview-content-context-menu')
  await expect(pdfMenu.getByRole('menuitem')).toHaveText([
    'Copy path',
    'Save as artifact',
    'Open full screen preview',
    'Download',
    'Close'
  ])
  await pdfMenu.getByText('Open full screen preview', { exact: true }).click()
  await expect(page.getByRole('dialog', { name: `Preview ${PDF_FILE_NAME}` })).toBeVisible()

  await pdfRegion.click({ button: 'right', position: pdfPageClick })
  await expect(page.getByTestId('preview-content-context-menu')).not.toContainText(
    'Open full screen preview'
  )
  await page.getByTestId('preview-content-context-menu').getByText('Close', { exact: true }).click()
  await expect(page.getByRole('dialog', { name: `Preview ${PDF_FILE_NAME}` })).toBeHidden()
  await expect(page.getByRole('tab').filter({ hasText: PDF_FILE_NAME })).toBeVisible()

  await pdfRegion.click({ button: 'right', position: pdfPageClick })
  await page.getByTestId('preview-content-context-menu').getByText('Close', { exact: true }).click()
  await expect(page.getByRole('tab').filter({ hasText: PDF_FILE_NAME })).toBeHidden()

  await page
    .getByRole('textbox', { name: 'Ask anything' })
    .fill('Create preview context menu artifacts.')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(
    page.getByText('Preview context menu artifacts created.', { exact: true })
  ).toBeVisible({
    timeout: 90_000
  })

  await page.getByRole('button', { name: `Preview generated file ${HTML_FILE_NAME}` }).click()
  const managedHtmlFrame = page.frameLocator(`iframe[title="Preview of ${HTML_FILE_NAME}"]`)
  await expect(
    managedHtmlFrame.getByRole('heading', { name: 'HTML context menu fixture' })
  ).toBeVisible()
  const managedPassthrough = managedHtmlFrame.getByText('Managed native context area', {
    exact: true
  })
  await expect(managedPassthrough).toHaveAttribute('data-preview-context-menu-passthrough', '')
  await managedPassthrough.click({
    button: 'right'
  })
  await page.waitForTimeout(300)
  await expect(page.getByTestId('preview-content-context-menu')).toBeHidden()
  await managedHtmlFrame
    .getByRole('heading', { name: 'HTML context menu fixture' })
    .click({ button: 'right' })
  await expectContentMenu(page, ['Provenance', 'View in context'])
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Preview generated file context-menu.docx' }).click()
  const officeHost = page.locator('[data-office-preview-state="ready"]')
  await expect(officeHost).toBeVisible({ timeout: 90_000 })
  const officeFrame = page.frameLocator('iframe[data-office-preview-frame]')
  const officePassthrough = officeFrame.getByText('Office native context area', { exact: true })
  await officeFrame.locator('body').evaluate((body) => {
    const target = document.createElement('div')
    target.dataset.previewContextMenuPassthrough = ''
    target.textContent = 'Office native context area'
    body.prepend(target)
  })
  await officePassthrough.click({ button: 'right' })
  await page.waitForTimeout(300)
  await expect(page.getByTestId('preview-content-context-menu')).toBeHidden()
  await officePassthrough.evaluate((target) => target.remove())
  await officeFrame.locator('body').click({ button: 'right', position: { x: 40, y: 40 } })
  await expectContentMenu(page, ['Provenance', 'View in context'])
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Preview generated file context-menu.xlsx' }).click()
  const spreadsheetHost = page.locator('[data-office-preview-state="ready"]')
  await expect(spreadsheetHost).toBeVisible({ timeout: 90_000 })
  const spreadsheetFrame = page.frameLocator('iframe[data-office-preview-frame]')
  const spreadsheet = spreadsheetFrame.locator('.excel-wrapper')
  await expect(spreadsheet).toBeVisible({ timeout: 90_000 })
  const spreadsheetBounds = await spreadsheet.boundingBox()
  expect(spreadsheetBounds).not.toBeNull()
  const spreadsheetClick = { x: 140, y: 90 }
  await spreadsheet.click({ button: 'right', position: spreadsheetClick })
  await expectContentMenu(page, ['Provenance', 'View in context'])
  const spreadsheetMenuBounds = await page.getByTestId('preview-content-context-menu').boundingBox()
  expect(spreadsheetMenuBounds).not.toBeNull()
  expect(
    Math.abs(spreadsheetMenuBounds!.x - (spreadsheetBounds!.x + spreadsheetClick.x))
  ).toBeLessThanOrEqual(2)
  expect(
    Math.abs(spreadsheetMenuBounds!.y - (spreadsheetBounds!.y + spreadsheetClick.y))
  ).toBeLessThanOrEqual(2)
})
