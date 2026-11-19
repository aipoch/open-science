import type { Page } from '@playwright/test'

export const captureExternalRequests = (page: Page): string[] => {
  const externalRequests: string[] = []
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:4178')) externalRequests.push(request.url())
  })
  return externalRequests
}

export const useNarrowViewport = async (page: Page): Promise<void> => {
  await page.setViewportSize({ width: 375, height: 900 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
}
