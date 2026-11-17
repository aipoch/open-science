import { expect, test } from '@playwright/test'

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
  await page.getByRole('button', { name: 'Edit README.md', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Edit README.md source' })
  await editor.evaluate((element: HTMLTextAreaElement) =>
    element.setSelectionRange(element.value.length, element.value.length)
  )
  await editor.focus()
  await page.keyboard.insertText('Retained draft')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByText('This file has a newer version.')).toBeVisible()
  await expect(editor).toHaveValue('# Current\nRetained draft')
  await editor.focus()
  await editor.press('ControlOrMeta+z')
  await expect(editor).toHaveValue('# Current\n')
  await editor.press('ControlOrMeta+Shift+z')
  await expect(editor).toHaveValue('# Current\nRetained draft')
  await page.getByRole('button', { name: 'Copy draft', exact: true }).click()
  await expect
    // Windows exposes native clipboard line endings as CRLF.
    .poll(async () =>
      (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')
    )
    .toBe('# Current\nRetained draft')
  await page.getByRole('button', { name: 'View latest version', exact: true }).click()
  const confirmation = page.getByTestId('discard-preview-changes-confirmation')
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole('button').first().click()
  await expect(editor).toHaveValue('# Current\nRetained draft')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  const saves = await page.evaluate(
    () =>
      (window as unknown as { previewEditRecovery: { saves: unknown[] } }).previewEditRecovery.saves
  )
  expect(saves).toHaveLength(2)
  expect(saves[1]).toEqual(saves[0])
})
