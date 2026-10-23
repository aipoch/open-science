import { expect, type Page } from '@playwright/test'

export const actionMenuPage = async (page: Page): Promise<Page> => {
  await expect
    .poll(() =>
      page
        .context()
        .pages()
        .some((candidate) => candidate.url().includes('/action-menu-overlay.html'))
    )
    .toBe(true)
  return page
    .context()
    .pages()
    .find((candidate) => candidate.url().includes('/action-menu-overlay.html'))!
}
