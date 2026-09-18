import { expect, test } from '@playwright/test'

test('reload recovery keeps active text, verifies completed uploads and exposes interrupted uploads', async ({
  page
}) => {
  await page.goto('/composer-recovery.html')
  const text = 'Unsent research notes — '.repeat(500)
  await page.getByRole('textbox', { name: 'Draft', exact: true }).fill(text)
  await page.getByRole('button', { name: 'Complete upload', exact: true }).click()
  await expect(page.getByTestId('attachments')).toHaveText('completed.txt')
  await page.getByRole('button', { name: 'Start upload', exact: true }).click()
  await expect(page.getByTestId('transfers')).toContainText('pending.txt')
  await page.getByRole('button', { name: 'Require reload', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Unsent drafts', exact: true })).toContainText(
    text
  )
  await Promise.all([
    page.waitForEvent('load'),
    page.getByRole('button', { name: 'Reload', exact: true }).click()
  ])
  await expect(page.getByRole('textbox', { name: 'Draft', exact: true })).toHaveValue(text)
  await expect(page.getByTestId('attachments')).toHaveText('completed.txt')
  await expect(page.getByTestId('transfers')).toContainText('pending.txt: error')
  await expect(page.getByTestId('transfers')).toContainText('select the file again')
})

test('a cleared draft is not resurrected after a browser reload', async ({ page }) => {
  await page.goto('/composer-recovery.html')
  await page.getByRole('textbox', { name: 'Draft', exact: true }).fill('sent text')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await page.reload()
  await expect(page.getByRole('textbox', { name: 'Draft', exact: true })).toHaveValue('')
})

test('multiple project drafts return to their own identities after recovery reload', async ({
  page
}) => {
  await page.goto('/composer-recovery.html')
  await page.getByRole('textbox', { name: 'Draft', exact: true }).fill('Project A notes')
  await page.getByRole('button', { name: 'Switch project' }).click()
  await page.getByRole('textbox', { name: 'Draft', exact: true }).fill('Project B notes')
  await page.getByRole('button', { name: 'Require reload' }).click()
  const drafts = page.getByRole('textbox', { name: 'Unsent drafts', exact: true })
  await expect(drafts).toContainText('Project A notes')
  await expect(drafts).toContainText('Project B notes')
  await Promise.all([
    page.waitForEvent('load'),
    page.getByRole('button', { name: 'Reload', exact: true }).click()
  ])
  await expect(page.getByRole('textbox', { name: 'Draft', exact: true })).toHaveValue(
    'Project A notes'
  )
  await page.getByRole('button', { name: 'Switch project' }).click()
  await expect(page.getByRole('textbox', { name: 'Draft', exact: true })).toHaveValue(
    'Project B notes'
  )
})

test('failed storage requires a saved copy and pairing failure identifies the connection', async ({
  page
}) => {
  await page.setViewportSize({ width: 700, height: 500 })
  await page.goto('/composer-recovery.html')
  await page.getByRole('button', { name: 'Block storage' }).click()
  await page.getByRole('textbox', { name: 'Draft', exact: true }).fill('Keep a copy of this draft')
  await page.getByRole('button', { name: 'Require reload' }).click()
  await expect(page.getByRole('button', { name: 'Reload', exact: true })).toBeDisabled()
  await expect(page.getByRole('textbox', { name: 'Unsent drafts', exact: true })).toContainText(
    'Keep a copy'
  )
  await page.getByRole('checkbox', { name: 'I saved a copy of my drafts.' }).check()
  await expect(page.getByRole('button', { name: 'Reload', exact: true })).toBeEnabled()
  await page.reload()
  await page.getByRole('button', { name: 'Require pairing' }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('Pairing required')
  await expect(dialog).toContainText('127.0.0.1:4178')
  await expect(dialog).toContainText('pair again')
  await expect(dialog.getByRole('button')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
