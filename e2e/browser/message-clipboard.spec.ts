import { expect, test } from '@playwright/test'

// The operating-system clipboard is shared across browser contexts.
test.describe.configure({ mode: 'serial' })

test('copies file references through the system clipboard, replaces selection and supports undo', async ({
  page,
  context
}, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/message-clipboard.html')
  const editor = page.getByRole('textbox', { name: 'Ask anything' })
  await page.getByRole('button', { name: 'Copy message', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Copied', exact: true })).toBeVisible()
  await editor.fill('replace me')
  await editor.press('ControlOrMeta+A')
  await editor.press('ControlOrMeta+V')
  await expect(editor.locator('[data-mention-type="artifact"]')).toHaveCount(2)
  const draft = await page.getByTestId('draft').textContent()
  expect(
    JSON.parse(draft!).nodes.filter((node: { type: string }) => node.type === 'artifact')
  ).toMatchObject([
    { id: 'csv-file', versionId: 'csv-version' },
    { id: 'xlsx-file', versionId: 'xlsx-version' }
  ])
  await editor.press('ControlOrMeta+Z')
  await expect(editor).toHaveText('replace me')
  await editor.press('ControlOrMeta+Shift+Z')
  await expect(editor.locator('[data-mention-type="artifact"]')).toHaveCount(2)
  await page.screenshot({ path: testInfo.outputPath('restored-references.png'), fullPage: true })
  await editor.press('End')
  await editor.pressSequentially(' continued')
  await expect(editor).toContainText('continued')
  await expect(editor.locator('[data-mention-type="artifact"]')).toHaveCount(2)
})

test('pastes readable text into another Project', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/message-clipboard.html?project=other')
  await page.getByRole('button', { name: 'Copy message', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Copied', exact: true })).toBeVisible()
  const editor = page.getByRole('textbox', { name: 'Ask anything' })
  await editor.click()
  await editor.press('ControlOrMeta+V')
  await expect(editor).toContainText('@对角线火山图.csv')
  await expect(editor.locator('[data-mention-type]')).toHaveCount(0)
})
