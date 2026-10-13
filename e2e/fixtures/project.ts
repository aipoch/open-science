import type { Locator, Page } from 'playwright'

// The empty-state entry can share this label; preparation always uses the Home header.
export const homeNewProjectButton = (page: Page): Locator =>
  page.locator('header').getByRole('button', { name: 'New project', exact: true })

// English UI setup only. Keep scenario-specific fields and outcome assertions in the spec.
export const createProjectViaUi = async (page: Page, name: string): Promise<void> => {
  await homeNewProjectButton(page).click()
  const dialog = page.getByRole('dialog', { name: 'New project', exact: true })
  await dialog.getByLabel('Name', { exact: true }).fill(name)
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click()
}
