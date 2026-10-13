import { expect } from '@playwright/test'
import type { Page } from 'playwright'

export const setViewport = async (page: Page, width: number, height = 800): Promise<void> => {
  await page.setViewportSize({ width, height })
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width)
}
