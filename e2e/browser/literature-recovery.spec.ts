import { expect, test } from '@playwright/test'

test('previews conflicting promotion, renames the child, then allows parent deletion', async ({
  page
}) => {
  await page.goto('/literature-recovery.html')
  await page.getByRole('button', { name: 'Collection actions' }).click()
  await page.getByRole('menuitem', { name: 'Delete collection' }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog.getByRole('button', { name: 'Delete collection' })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Rename conflicting collection' }).click()
  const editor = page.getByRole('dialog', { name: 'Edit collection' })
  await editor.getByLabel('Name', { exact: true }).fill('Child review')
  await editor.getByRole('button', { name: 'Save changes' }).click()
  await expect(editor).toBeHidden()
  await page.getByRole('button', { name: 'Collection actions' }).click()
  await page.getByRole('menuitem', { name: 'Delete collection' }).click()
  await expect(dialog.getByText('Child review', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Delete collection' }).click()
  await expect(page.getByRole('heading', { name: 'All references' })).toBeVisible()
})

test('retries one failed row while retaining the unchecked review', async ({ page }) => {
  await page.goto('/literature-recovery.html?mode=batch')
  await expect(
    page.getByText('The source could not be reached. Check the connection and retry.')
  ).toBeVisible()
  await page.getByRole('button', { name: 'Retry this reference' }).click()
  await expect(page.getByRole('button', { name: 'Retry this reference' })).toBeHidden()
  const state = await page.evaluate(
    () =>
      (
        window as unknown as {
          literatureRecovery: { commands: unknown[]; job: { rows: Array<{ checked: boolean }> } }
        }
      ).literatureRecovery
  )
  expect(state.commands).toContainEqual({
    action: 'retry-failed',
    jobId: '9323d39a-2ae2-49c8-8826-a589c78f1f5d',
    itemIds: ['failed']
  })
  expect(state.job.rows[1].checked).toBe(false)
})
