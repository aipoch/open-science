import { expect } from '@playwright/test'
import type { FileViewerSearchProvider } from '@file-viewer/core'

import { test } from './fixtures/electron-app'

test('finds offscreen cells across XLSX and XLS worksheets', async ({ app }) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await page.getByRole('button', { name: 'New project' }).click()
  const projectDialog = page.getByRole('dialog', { name: 'New project' })
  await projectDialog.getByLabel('Name').fill('Spreadsheet search feasibility')
  await projectDialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()

  await page
    .getByRole('textbox', { name: 'Ask anything' })
    .fill('Create spreadsheet search fixture.')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('Spreadsheet search fixture created.', { exact: true })).toBeVisible({
    timeout: 90_000
  })
  await page
    .getByRole('button', { name: 'Preview generated file search-feasibility.xlsx', exact: true })
    .click()

  const frame = page.frameLocator('iframe[data-office-preview-frame]')
  const spreadsheet = frame.locator('.excel-wrapper')
  await expect(spreadsheet).toBeVisible({ timeout: 90_000 })
  await expect(spreadsheet.locator('.table-wrapper')).toBeVisible()
  const search = await spreadsheet.evaluate(async (root) => {
    const provider = (
      root as HTMLElement & { __flyfishViewerSearchProvider?: FileViewerSearchProvider }
    ).__flyfishViewerSearchProvider
    if (!provider) throw new Error('Spreadsheet search provider was not registered')
    const state = await provider.search('Needle')
    return {
      total: state.total,
      current: state.current?.anchor?.label,
      labels: state.matches.map((match) => match.anchor?.label)
    }
  })
  expect(search).toEqual({
    total: 2,
    current: 'Deep!A551',
    labels: ['Deep!A551', 'Other!A2']
  })
  await expect(spreadsheet.locator('.sheet-tab.active')).toHaveText('Deep')

  const next = await spreadsheet.evaluate(async (root) => {
    const provider = (
      root as HTMLElement & { __flyfishViewerSearchProvider?: FileViewerSearchProvider }
    ).__flyfishViewerSearchProvider!
    const state = await provider.next!()
    return state.current?.anchor?.label
  })
  expect(next).toBe('Other!A2')
  await expect(spreadsheet.locator('.sheet-tab.active')).toHaveText('Other')

  const wrapped = await spreadsheet.evaluate(async (root) => {
    const provider = (
      root as HTMLElement & { __flyfishViewerSearchProvider?: FileViewerSearchProvider }
    ).__flyfishViewerSearchProvider!
    const state = await provider.next!()
    return state.current?.anchor?.label
  })
  expect(wrapped).toBe('Deep!A551')
  await expect(spreadsheet.locator('.sheet-tab.active')).toHaveText('Deep')
  await expect(spreadsheet.locator('.error')).toBeHidden()

  const find = spreadsheet.getByRole('button', { name: 'Find', exact: true })
  await expect(find.locator('svg')).toBeVisible()
  const zoomInBounds = await spreadsheet.getByRole('button', { name: 'Zoom in' }).boundingBox()
  const findBounds = await find.boundingBox()
  expect(zoomInBounds).not.toBeNull()
  expect(findBounds).not.toBeNull()
  expect(zoomInBounds!.x).toBeLessThan(findBounds!.x)
  expect(findBounds!.x - zoomInBounds!.x - zoomInBounds!.width).toBeLessThan(20)
  expect(Math.abs(zoomInBounds!.y - findBounds!.y)).toBeLessThan(2)
  await find.click()
  const query = spreadsheet.getByRole('searchbox', { name: 'Find' })
  await expect(query).toBeFocused()
  await query.fill('CaseProbe')
  await expect(spreadsheet.locator('.spreadsheet-review-find-count')).toHaveText('1 / 3')
  const matchCase = spreadsheet.getByRole('button', { name: 'Match case' })
  const wholeWord = spreadsheet.getByRole('button', { name: 'Whole word' })
  await matchCase.click()
  await expect(matchCase).toHaveAttribute('aria-pressed', 'true')
  await expect(spreadsheet.locator('.spreadsheet-review-find-count')).toHaveText('1 / 2')
  await wholeWord.click()
  await expect(wholeWord).toHaveAttribute('aria-pressed', 'true')
  await expect(spreadsheet.locator('.spreadsheet-review-find-count')).toHaveText('1 / 1')
  await matchCase.click()
  await wholeWord.click()
  await query.fill('Needle')
  await expect
    .poll(() =>
      spreadsheet.evaluate(
        (root) =>
          (
            root as HTMLElement & { __flyfishViewerSearchProvider?: FileViewerSearchProvider }
          ).__flyfishViewerSearchProvider?.getState?.().query
      )
    )
    .toBe('Needle')
  await expect(spreadsheet.locator('.spreadsheet-review-find-count')).toHaveText('1 / 2')
  await spreadsheet.getByRole('button', { name: 'Next match' }).click()
  await expect(spreadsheet.locator('.spreadsheet-review-find-count')).toHaveText('2 / 2')
  await expect(spreadsheet.locator('.sheet-tab.active')).toHaveText('Other')
  await spreadsheet.getByRole('button', { name: 'Previous match' }).click()
  await expect(spreadsheet.locator('.spreadsheet-review-find-count')).toHaveText('1 / 2')
  await expect(spreadsheet.locator('.sheet-tab.active')).toHaveText('Deep')
  await query.fill('Not in this workbook')
  await expect(spreadsheet.locator('.spreadsheet-review-find-count')).toHaveText('0 / 0')
  await expect(spreadsheet.getByRole('button', { name: 'Next match' })).toBeDisabled()
  await spreadsheet.getByRole('button', { name: 'Close search' }).click()
  await expect(query).toBeHidden()
  await expect(find).toBeFocused()
  const shortcut = process.platform === 'darwin' ? 'Meta+f' : 'Control+f'
  await find.press(shortcut)
  await expect(query).toBeFocused()
  await expect.poll(() => app.findOverlayIsVisible()).toBe(false)
  const toolbar = spreadsheet.locator('.spreadsheet-review-toolbar')
  await toolbar.evaluate((element) => {
    element.style.width = '480px'
  })
  const narrowToolbarBounds = await toolbar.boundingBox()
  const narrowFindBounds = await toolbar.locator('.spreadsheet-review-find').boundingBox()
  expect(narrowToolbarBounds).not.toBeNull()
  expect(narrowFindBounds).not.toBeNull()
  expect(narrowFindBounds!.x + narrowFindBounds!.width).toBeGreaterThan(
    narrowToolbarBounds!.x + narrowToolbarBounds!.width - 20
  )
  expect(narrowFindBounds!.x + narrowFindBounds!.width).toBeLessThanOrEqual(
    narrowToolbarBounds!.x + narrowToolbarBounds!.width + 2
  )
  await toolbar.evaluate((element) => {
    element.style.width = ''
  })

  await page
    .getByRole('button', { name: 'Preview generated file search-feasibility.xls', exact: true })
    .click()
  await expect(
    page.getByRole('button', { name: 'File actions for search-feasibility.xls' })
  ).toBeVisible()
  const legacySpreadsheet = page
    .frameLocator('iframe[data-office-preview-frame]')
    .locator('.excel-wrapper')
  await expect(legacySpreadsheet).toBeVisible({ timeout: 90_000 })
  const legacySearch = await legacySpreadsheet.evaluate(async (root) => {
    const provider = (
      root as HTMLElement & { __flyfishViewerSearchProvider?: FileViewerSearchProvider }
    ).__flyfishViewerSearchProvider
    if (!provider) throw new Error('Legacy spreadsheet search provider was not registered')
    const state = await provider.search('Needle')
    return { total: state.total, labels: state.matches.map((match) => match.anchor?.label) }
  })
  expect(legacySearch).toEqual({
    total: 2,
    labels: ['Deep!A551', 'Other!A2']
  })
  await expect(legacySpreadsheet.locator('.sheet-tab.active')).toHaveText('Deep')

  await page.getByRole('button', { name: 'File actions for search-feasibility.xls' }).focus()
  await app.pressMainWindowShortcut('F', process.platform === 'darwin' ? ['meta'] : ['control'])
  await expect.poll(() => app.findOverlayIsVisible()).toBe(true)
})
