import { expect, test } from '@playwright/test'

test('message image requests wait for activation, including after reopening history', async ({
  page
}) => {
  const requests: string[] = []
  await page.route('https://privacy-canary.invalid/**', async (route) => {
    requests.push(route.request().url())
    await route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=',
        'base64'
      )
    })
  })
  await page.goto('/media-privacy.html')
  await expect(page.locator('.agent-markdown')).toBeVisible()
  // Give layout, image decoding and lazy loading time to issue any automatic request.
  await page.waitForTimeout(300)
  expect(requests).toEqual([])
  await page.getByRole('button', { name: /privacy-canary.invalid/ }).click()
  await expect.poll(() => requests.length).toBe(1)
  await expect(page.locator('img')).toHaveAttribute(
    'src',
    'https://privacy-canary.invalid/image.png'
  )
  await page.reload()
  await expect(page.getByRole('button', { name: /privacy-canary.invalid/ })).toBeVisible()
  await page.waitForTimeout(300)
  expect(requests).toHaveLength(1)
})

for (const mode of ['enabled', 'disabled']) {
  test(`Mermaid image nodes cannot issue hidden requests with media ${mode}`, async ({ page }) => {
    const requests: string[] = []
    await page.route('https://privacy-canary.invalid/**', async (route) => {
      requests.push(route.request().url())
      await route.abort()
    })
    await page.goto(`/media-privacy.html?mermaid=${mode}`)
    await expect(page.locator('.agent-markdown')).toBeVisible()
    await expect
      .poll(
        async () =>
          requests.length > 0 ||
          (await page.getByText('Images in Mermaid diagrams are blocked').isVisible())
      )
      .toBe(true)
    expect(requests).toEqual([])
    await expect(page.getByText('Images in Mermaid diagrams are blocked')).toBeVisible()
  })
}

test('ordinary Mermaid charts retain shape metadata and render without image requests', async ({
  page
}) => {
  await page.goto('/media-privacy.html?mermaid=ordinary')
  await expect(page.locator('svg[data-mermaid-render-id]')).toBeVisible()
  await expect(page.getByText('Images in Mermaid diagrams are blocked')).toHaveCount(0)
})
