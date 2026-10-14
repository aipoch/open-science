import type { Page } from 'playwright'

export const openAllReferences = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  await page.getByRole('button', { name: 'All references', exact: true }).click()
}
