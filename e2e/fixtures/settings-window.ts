import { expect } from '@playwright/test'
import type { Page } from 'playwright'

// Keep business locators on the Settings renderer; the workspace Page remains available for
// responsiveness and propagation assertions while the auxiliary window is open.
export const getSettingsPage = async (workspace: Page): Promise<Page> => {
  let settings: Page | undefined
  await expect
    .poll(() => {
      settings = workspace
        .context()
        .pages()
        .find((page) => new URL(page.url()).pathname.endsWith('/settings.html'))
      return Boolean(settings)
    })
    .toBe(true)
  await settings!.waitForLoadState('domcontentloaded')
  return settings!
}
