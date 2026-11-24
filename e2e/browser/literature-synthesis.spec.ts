import { expect, test } from '@playwright/test'

test('two-paper selection, hidden tags, editing, source UI preview and Markdown saving', async ({
  page
}, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/literature-synthesis.html')
  await page.getByRole('checkbox', { name: /Paper One/ }).check()
  await page.getByRole('checkbox', { name: /Paper Two/ }).check()
  await page.getByRole('button', { name: 'Create from selected papers' }).click()
  const candidates = page.getByRole('dialog', { name: 'Choose excerpts.', exact: true })
  await candidates.getByRole('textbox', { name: 'Note title' }).fill('Methods and evidence')
  await candidates.getByRole('button', { name: 'Select current results' }).click()
  await candidates.getByRole('button', { name: 'Filter by Tag', exact: true }).click()
  await page.getByRole('menuitemcheckbox', { name: 'Methods', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(candidates.getByText('1 selected excerpt hidden by the filter')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('synthesis-desktop-candidates.png') })
  await candidates.getByRole('button', { name: /Create synthesis note.*2/i }).click()
  const workspace = page.getByRole('dialog', { name: 'Synthesis notes', exact: true })
  const prose = workspace.getByRole('textbox', {
    name: /^(Overall analysis|Excerpt analysis)$/,
    exact: true
  })
  await expect(prose).toBeFocused()
  await page.keyboard.insertText('Across-paper synthesis argument.')
  await expect(prose).toHaveValue('Across-paper synthesis argument.')
  await expect(workspace.getByText('Second study reports an independent result.')).toBeVisible()
  await workspace.getByRole('button', { name: 'More actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Add heading', exact: true }).click()
  await workspace
    .getByRole('textbox', { name: 'Heading', exact: true })
    .fill('Methods across studies')
  const headingBlock = workspace
    .getByRole('listitem')
    .filter({ has: page.getByRole('textbox', { name: 'Heading', exact: true }) })
  const headingActions = headingBlock.getByRole('button', { name: 'Block actions', exact: true })
  const initialHeadingIndex = await headingBlock.evaluate((block) =>
    Array.from(block.parentElement!.children).indexOf(block)
  )
  for (let index = 1; index < initialHeadingIndex; index++) {
    await headingActions.click()
    await page.getByRole('menuitem', { name: 'Move up', exact: true }).click()
  }
  await headingActions.click()
  await page.getByRole('menuitem', { name: 'Move up', exact: true }).click()
  await expect(
    workspace.getByRole('listitem').first().getByRole('textbox', { name: 'Heading', exact: true })
  ).toHaveValue('Methods across studies')
  await workspace.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(workspace.getByText('Saved', { exact: true })).toBeVisible()
  await workspace.getByRole('button', { name: 'Back to synthesis notes', exact: true }).click()
  await page
    .getByRole('dialog', { name: 'Synthesis notes', exact: true })
    .getByRole('button', { name: 'Methods and evidence', exact: true })
    .click()
  await expect(
    workspace.getByRole('textbox', { name: /^(Overall analysis|Excerpt analysis)$/ })
  ).toHaveValue('Across-paper synthesis argument.')
  await expect(workspace.getByRole('textbox', { name: 'Heading', exact: true })).toHaveValue(
    'Methods across studies'
  )
  await expect(
    workspace.getByRole('listitem').first().getByRole('textbox', { name: 'Heading', exact: true })
  ).toHaveValue('Methods across studies')
  await workspace
    .getByRole('textbox', { name: /^(Overall analysis|Excerpt analysis)$/ })
    .fill('Draft kept through source preview.')
  const source = workspace.getByRole('button', { name: /Paper One.*Page 1/i }).first()
  const readsBeforePreview = await page.evaluate(
    () =>
      (
        window as unknown as { synthesisFixture: { requests(): Array<{ action: string }> } }
      ).synthesisFixture
        .requests()
        .filter((request) => request.action === 'read').length
  )
  await source.click()
  await expect(page.getByRole('dialog', { name: 'Source preview UI fixture' })).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Source preview UI fixture' })).toContainText(
    'version-0'
  )
  const previewRequests = await page.evaluate(() =>
    (
      window as unknown as { synthesisFixture: { requests(): Array<{ action: string }> } }
    ).synthesisFixture.requests()
  )
  expect(previewRequests.at(-1)).toMatchObject({ action: 'source', blockId: expect.any(String) })
  expect(previewRequests.filter((request) => request.action === 'read')).toHaveLength(
    readsBeforePreview
  )
  await page.screenshot({ path: testInfo.outputPath('synthesis-source-ui-preview.png') })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Source preview UI fixture' })).toHaveCount(0)
  await expect(source).toBeFocused()
  await expect(
    workspace.getByRole('textbox', { name: /^(Overall analysis|Excerpt analysis)$/ })
  ).toHaveValue('Draft kept through source preview.')
  await expect(workspace.getByText('Unsaved changes', { exact: true })).toBeVisible()
  await workspace.getByRole('button', { name: 'More actions', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Export Markdown', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await workspace.getByRole('button', { name: 'Save', exact: true }).click()
  await workspace.getByRole('button', { name: 'More actions', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Export Markdown', exact: true })).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('synthesis-desktop-menu.png') })
  await page.getByRole('menuitem', { name: 'Export Markdown', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as { synthesisFixture: { savedFiles(): Array<{ text: string }> } }
        ).synthesisFixture.savedFiles()
      )
    )
    .toEqual([
      {
        name: 'fixture-synthesis.md',
        text: expect.stringContaining('Draft kept through source preview.')
      }
    ])
  await page.screenshot({ path: testInfo.outputPath('synthesis-desktop-editor.png') })
  await workspace.getByRole('button', { name: 'Close', exact: true }).click()
  await page.reload()
  await page.getByRole('button', { name: 'Open synthesis notes' }).click()
  await page.getByRole('button', { name: 'Methods and evidence', exact: true }).click()
  await expect(
    page.getByRole('textbox', { name: /^(Overall analysis|Excerpt analysis)$/ })
  ).toHaveValue('Draft kept through source preview.')
  expect(errors).toEqual([])
})

test('narrow viewport keeps keyboard editing, block movement and dirty cancellation usable', async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/literature-synthesis.html')
  const paper = page.getByRole('checkbox', { name: /Paper One/ })
  await paper.focus()
  await paper.press('Space')
  const create = page.getByRole('button', { name: 'Create from selected papers' })
  await create.focus()
  await create.press('Enter')
  const candidates = page.getByRole('dialog', { name: 'Choose excerpts.', exact: true })
  await expect(candidates.getByText('First study reports the measured result.')).toBeInViewport()
  const title = candidates.getByRole('textbox', { name: 'Note title' })
  await title.fill('Keyboard synthesis')
  const select = candidates.getByRole('button', { name: 'Select current results' })
  await select.focus()
  await select.press('Enter')
  const confirm = candidates.getByRole('button', { name: /Create synthesis note.*1/i })
  await confirm.focus()
  await confirm.press('Enter')
  const workspace = page.getByRole('dialog', { name: 'Synthesis notes', exact: true })
  await expect(
    workspace.getByRole('textbox', { name: /^(Overall analysis|Excerpt analysis)$/, exact: true })
  ).toBeFocused()
  await page.keyboard.insertText('Keyboard-authored prose.')
  const block = workspace
    .getByRole('listitem')
    .filter({ has: page.getByRole('textbox', { name: /^(Overall analysis|Excerpt analysis)$/ }) })
  const blockActions = block.getByRole('button', { name: 'Block actions', exact: true })
  await blockActions.focus()
  await page.keyboard.press('Enter')
  await page.getByRole('menuitem', { name: 'Move down', exact: true }).press('Enter')
  await expect(workspace.getByRole('listitem').nth(1)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('alertdialog', { name: 'Discard unsaved changes?' })).toBeVisible()
  await page.getByRole('button', { name: 'Keep editing' }).focus()
  await page.keyboard.press('Enter')
  await expect(
    workspace.getByRole('textbox', { name: /^(Overall analysis|Excerpt analysis)$/ })
  ).toHaveValue('Keyboard-authored prose.')
  await workspace.getByRole('button', { name: 'Save', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(workspace.getByText('Saved', { exact: true })).toBeVisible()
  const overflow = await workspace.evaluate((root) => ({
    scroll: root.scrollWidth,
    width: root.clientWidth,
    right: root.getBoundingClientRect().right,
    viewport: innerWidth
  }))
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.width + 1)
  expect(overflow.right).toBeLessThanOrEqual(overflow.viewport)
  await page.screenshot({ path: testInfo.outputPath('synthesis-narrow-keyboard.png') })
})
