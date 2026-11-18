import { expect, test } from '@playwright/test'
import type { ManagedFileVersionSaveTextEditRequest } from '../../src/shared/managed-file-versions'
import type { Annotation } from '../../src/shared/annotation-contract'
import type { DocumentConversationRequest } from '../../src/renderer/src/pages/workspace/previews/preview-types'

declare global {
  interface Window {
    previewEditRecovery: {
      saves: ManagedFileVersionSaveTextEditRequest[]
      requests: DocumentConversationRequest[]
      annotations: Annotation[]
    }
  }
}

test('Markdown footnotes do not leave an empty outer scroll region', async ({ page }) => {
  await page.goto('/preview-edit-recovery.html?footnotes')
  const preview = page.getByTestId('preview-file-content-surface')
  const markdown = page.locator('.agent-markdown')
  const footnote = markdown.locator('.footnotes li').last()
  await expect(footnote).toContainText('Final footnote.')
  expect(await markdown.evaluate((element) => element.clientHeight)).toBeGreaterThan(
    await preview.evaluate((element) => element.clientHeight)
  )
  await footnote.scrollIntoViewIfNeeded()
  await footnote.hover()
  await page.mouse.wheel(0, 1200)
  await expect
    .poll(() => preview.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeLessThanOrEqual(1)
  await expect(footnote).toBeInViewport()
})

test('conflict keeps native editor undo and offers complete draft copy', async ({
  page,
  context
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/preview-edit-recovery.html')
  const editor = page.getByTestId('markdown-plate-editor')
  await editor.click()
  await editor.press('ControlOrMeta+End')
  await editor.press('Enter')
  await page.keyboard.type('Retained draft')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByText('This file has a newer version.')).toBeVisible()
  await expect(editor).toContainText('Retained draft')
  await editor.focus()
  await editor.press('ControlOrMeta+z')
  await expect(editor).not.toContainText('Retained draft')
  await editor.press('ControlOrMeta+Shift+z')
  await expect(editor).toContainText('Retained draft')
  await page.getByRole('button', { name: 'Copy draft', exact: true }).click()
  await expect
    // Windows exposes native clipboard line endings as CRLF.
    .poll(async () =>
      (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')
    )
    .toBe('# Current\n\nRetained draft\n')
  await page.getByRole('button', { name: 'View latest version', exact: true }).click()
  const confirmation = page.getByTestId('discard-preview-changes-confirmation')
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole('button').first().click()
  await expect(editor).toContainText('Retained draft')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  const saves = await page.evaluate(() => window.previewEditRecovery.saves)
  expect(saves).toHaveLength(2)
  expect(saves[1]).toEqual(saves[0])
})

test('Markdown opens editable, renders typed syntax and saves only on request', async ({
  page
}) => {
  await page.goto('/preview-edit-recovery.html?success')
  const editor = page.getByTestId('markdown-plate-editor')
  const save = page.getByRole('button', { name: 'Save changes', exact: true })
  await expect(editor).toHaveAttribute('contenteditable', 'true')
  await expect(page.getByRole('button', { name: 'Edit README.md', exact: true })).toHaveCount(0)
  await expect(save).toBeDisabled()
  await editor.click()
  await editor.press('ControlOrMeta+End')
  await editor.press('Enter')
  await page.keyboard.type('## Live heading')
  await expect(editor.locator('h2')).toHaveText('Live heading')
  await editor.press('Enter')
  await page.keyboard.type('**bold** ')
  await expect(editor.locator('strong')).toHaveText('bold')
  await expect(save).toBeEnabled()
  // Deliberately exceed the removed 900ms autosave window.
  await page.waitForTimeout(1200)
  const saveCount = () => page.evaluate(() => window.previewEditRecovery.saves.length)
  expect(await saveCount()).toBe(0)
  await save.click()
  await expect(save).toBeDisabled()
  expect(await saveCount()).toBe(1)
  await expect(editor).toHaveAttribute('contenteditable', 'true')
  await editor.click()
  await editor.press('ControlOrMeta+End')
  await page.keyboard.type('Unsaved follow-up')
  await page.waitForTimeout(1200)
  expect(await saveCount()).toBe(1)
  await page.getByRole('button', { name: 'Close preview of README.md', exact: true }).click()
  await expect(page.getByTestId('discard-preview-changes-confirmation')).toBeVisible()
})

test('selection toolbar follows the visible selection after scrolling', async ({ page }) => {
  await page.goto('/preview-edit-recovery.html?features')
  const editor = page.getByTestId('markdown-plate-editor')
  const passage = editor.locator('p').last().locator('[data-slate-string]')
  await passage.scrollIntoViewIfNeeded()
  const box = (await passage.boundingBox())!
  await page.mouse.move(box.x, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width, box.y + box.height / 2, { steps: 12 })
  await page.mouse.up()
  const toolbar = page.getByTestId('markdown-floating-toolbar')
  await expect(toolbar).toBeVisible()
  const selectionBox = await page.evaluate(() => {
    const box = window.getSelection()!.getRangeAt(0).getBoundingClientRect()
    return { top: box.top, bottom: box.bottom, left: box.left, right: box.right }
  })
  const toolbarBox = (await toolbar.boundingBox())!
  expect(Math.abs(toolbarBox.y + toolbarBox.height - selectionBox.top)).toBeLessThan(25)
  expect(toolbarBox.x).toBeGreaterThanOrEqual(0)
  expect(toolbarBox.x + toolbarBox.width).toBeLessThanOrEqual(page.viewportSize()!.width)
  await toolbar.getByRole('button', { name: 'Bold', exact: true }).click()
  await expect(editor.locator('strong')).toHaveText('Choose this passage for formatting.')
  await editor.locator('p').first().hover()
  await page.mouse.wheel(0, -3000)
  await expect(toolbar).toBeHidden()
  expect(await page.evaluate(() => window.previewEditRecovery.saves)).toHaveLength(0)
})

test('inline agent request sends the unsaved document without saving it', async ({ page }) => {
  await page.goto('/preview-edit-recovery.html?success')
  const editor = page.getByTestId('markdown-plate-editor')
  await editor.click()
  await editor.press('ControlOrMeta+End')
  await editor.press('Enter')
  await page.keyboard.type('Unsaved evidence')
  await page.getByRole('button', { name: 'Ask agent', exact: true }).click()
  await page
    .getByRole('textbox', { name: 'Tell the agent what to write or edit' })
    .fill('Explain the evidence')
  await page.getByRole('button', { name: 'Send to conversation', exact: true }).click()
  await expect(page.getByTestId('markdown-agent-prompt')).toBeHidden()
  const recorded = await page.evaluate(() => window.previewEditRecovery)
  expect(recorded.requests).toHaveLength(1)
  expect(recorded.requests[0].text).toContain('Explain the evidence')
  expect(recorded.requests[0].text).toContain('Unsaved evidence')
  expect(recorded.saves).toHaveLength(0)
  await expect(editor).toContainText('Unsaved evidence')
})

test('selection actions format, link, copy and send comments without saving', async ({
  page,
  context
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/preview-edit-recovery.html?success')
  const editor = page.getByTestId('markdown-plate-editor')
  await editor.click()
  await editor.press('ControlOrMeta+a')
  await page.getByTestId('markdown-selection-action-strikethrough').click()
  await expect(editor.locator('del')).toHaveText('Current')
  await editor.focus()
  await editor.press('ControlOrMeta+a')
  await page.getByTestId('markdown-selection-action-link').click()
  await page.getByTestId('markdown-link-url').fill('https://example.org/report')
  await page.getByTestId('markdown-link-apply').click()
  await expect(editor.getByRole('link')).toHaveAttribute('aria-label', 'https://example.org/report')
  await editor.focus()
  await editor.press('ControlOrMeta+a')
  await page.getByTestId('markdown-selection-action-copy').click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Current')
  await editor.focus()
  await editor.press('ControlOrMeta+a')
  await page.getByTestId('markdown-selection-action-comment').click()
  await page.getByTestId('markdown-comment-note').fill('Explain this heading')
  await page.getByTestId('markdown-comment-submit').click()
  await expect
    .poll(() => page.evaluate(() => window.previewEditRecovery.annotations.length))
    .toBe(1)
  expect(await page.evaluate(() => window.previewEditRecovery.annotations[0])).toMatchObject({
    quote: 'Current',
    note: 'Explain this heading'
  })
  expect(await page.evaluate(() => window.previewEditRecovery.saves)).toHaveLength(0)
})

test('block menu inserts editable content and drag reorders whole blocks', async ({ page }) => {
  await page.goto('/preview-edit-recovery.html?success')
  const editor = page.getByTestId('markdown-plate-editor')
  await editor.locator('h1').hover()
  await expect(editor.locator('[data-markdown-block]').first().getByRole('button')).toHaveCount(2)
  const dragHandle = editor.getByRole('button', { name: 'Drag block', exact: true }).first()
  await expect(dragHandle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(dragHandle.locator('..')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(dragHandle.locator('..')).toHaveCSS('box-shadow', 'none')
  await editor.getByRole('button', { name: 'Insert block', exact: true }).first().click()
  await page.getByRole('menuitem', { name: 'Heading 2', exact: true }).click()
  await expect(editor).toBeFocused()
  await page.keyboard.type('Inserted heading')
  await expect(editor.locator('h2')).toHaveText('Inserted heading')
  await editor.locator('h1').hover()
  await editor
    .getByRole('button', { name: 'Drag block', exact: true })
    .first()
    .dragTo(editor.locator('h2'))
  await expect(editor.locator('h1, h2').first()).toHaveText('Inserted heading')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => window.previewEditRecovery.saves[0]?.content))
    .toBe('## Inserted heading\n\n# Current\n')
})

test('checklist and dropdown choices survive Markdown serialization', async ({ page }) => {
  await page.goto('/preview-edit-recovery.html?success')
  const editor = page.getByTestId('markdown-plate-editor')
  await editor.locator('h1').hover()
  await editor.getByRole('button', { name: 'Insert block', exact: true }).first().click()
  await page.getByRole('menuitem', { name: 'Checklist', exact: true }).click()
  await editor.getByRole('checkbox', { name: 'Incomplete task', exact: true }).check()
  await editor.locator('h1').hover()
  await editor.getByRole('button', { name: 'Insert block', exact: true }).first().click()
  await page.getByRole('menuitem', { name: 'Dropdown', exact: true }).click()
  const dropdown = editor.getByRole('combobox', { name: 'Dropdown value', exact: true })
  await dropdown.selectOption({ index: 1 })
  const selected = await dropdown.inputValue()
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.previewEditRecovery.saves.length)).toBe(1)
  const source = await page.evaluate(() => window.previewEditRecovery.saves[0].content)
  expect(source).toContain('- [x]')
  expect(source).toContain('```openscience-dropdown')
  expect(source).toContain(JSON.stringify(selected))
  await expect(dropdown).toHaveValue(selected)
  expect(await page.evaluate(() => window.previewEditRecovery.saves.length)).toBe(1)
})

test('table, date, image and dropdown option editing remain manual drafts', async ({ page }) => {
  await page.goto('/preview-edit-recovery.html?success')
  const editor = page.getByTestId('markdown-plate-editor')
  await editor.locator('h1').hover()
  await editor.getByRole('button', { name: 'Insert block', exact: true }).first().click()
  await page.getByRole('menuitem', { name: 'Table', exact: true }).click()
  await editor.locator('th').first().click()
  await page.keyboard.type('Column')
  await expect(editor.locator('th').first()).toContainText('Column')
  await editor.locator('h1').hover()
  await editor.getByRole('button', { name: 'Insert block', exact: true }).first().click()
  await page.getByRole('menuitem', { name: 'Date', exact: true }).click()
  await page.getByLabel('Date', { exact: true }).fill('2026-11-17')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(editor).toContainText('2026-11-17')
  await editor.locator('h1').hover()
  await editor.getByRole('button', { name: 'Insert block', exact: true }).first().click()
  await page.getByRole('menuitem', { name: 'Image', exact: true }).click()
  let fetches = 0
  await page.route('https://example.org/diagram.png', async (route) => {
    fetches++
    await route.abort()
  })
  await page.getByLabel('Image URL', { exact: true }).fill('https://example.org/diagram.png')
  await page.getByLabel('Image alt text', { exact: true }).fill('Diagram')
  expect(fetches).toBe(0)
  await page.getByRole('button', { name: 'Load image', exact: true }).click()
  await expect.poll(() => fetches).toBe(1)
  await editor.locator('h1').hover()
  await editor.getByRole('button', { name: 'Insert block', exact: true }).first().click()
  await page.getByRole('menuitem', { name: 'Dropdown', exact: true }).click()
  await page.getByRole('button', { name: 'Edit options', exact: true }).click()
  await page.getByLabel('Options (one per line)', { exact: true }).fill('First\nSecond\nThird')
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await editor.getByRole('combobox', { name: 'Dropdown value' }).selectOption('Third')
  expect(await page.evaluate(() => window.previewEditRecovery.saves)).toHaveLength(0)
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.previewEditRecovery.saves.length)).toBe(1)
  const source = await page.evaluate(() => window.previewEditRecovery.saves[0].content)
  expect(source).toContain('Column')
  expect(source).toContain('2026-11-17')
  expect(source).toContain('![Diagram](https://example.org/diagram.png)')
  expect(source).toContain('"selected":"Third"')
})
