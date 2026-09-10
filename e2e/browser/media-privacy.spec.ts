import { expect, test } from '@playwright/test'

const imageBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAQAAAACgCAIAAABseyVrAAAACXBIWXMAAAPoAAAD6AG1e1JrAAADPklEQVR4nO3b0QkAIQwE0ZQ+pVuF5CMPLOAYRk7N7kxZCMxZDfa/wEIgG4AECOQPQAIEcgQiAQK5A5AAgVyCSYBAXoFIgECeQUmAQOYAJEAggzASIJBJMAkQSBSCBAgkC0QCBBKGIwECSYOSAIHEoUmAQPoAJEAghRgSIJBGGAkQSCWSBAikE0yCFLKV4knQ7W2w/wUWAtkAJEAgfwASIJAjEAkQyB2ABAjkEkwCBPIKRAIE8gxKAgQyByABAhmEkQCBTIJJgECiECRAIFkgEiCQMBwJEEgalAQIJA5NAgTSByABAinEkACBNMJIgEAqkSRAIJ1gEqSQrRRPgm5vg/0vsBDIBiABAvkDkACBHIFIgEDuACRAIJdgEiCQVyASIJBnUBIgkDkACRDIIIwECGQSTAIEEoUgAQLJApEAgYThSIBA0qAkQCBxaBIgkD4ACRBIIYYECKQRRgIEUokkAQLpBJMghWyleBJ0exvsf4GFQDYACRDIH4AECOQIRAIEcgcgAQK5BJMAgbwCkQCBPIOSAIHMAUiAQAZhJEAgk2ASIJAoBAkQSBaIBAgkDEcCBJIGJQECiUOTAIH0AUiAQAoxJEBAI4wECIxKJAkQGJ1gEoxDkVI8Ceb4Ntj/AguBbAASIJA/AAkQyBGIBAjkDkACBHIJJgECeQUiAQJ5BiUBApkDkACBDMJIgEAmwSRAIFEIEiCQLBAJEEgYjgQIJA1KAgQShyYBAukDkACBFGJIgEAaYSRAIJVIEiCQTjAJUshWiidBt7fB/hdYCGQDkACB/AFIgECOQCRAIHcAEiCQSzAJEMgrEAkQyDMoCRDIHIAECGQQRgIEMgkmAQKJQpAAgWSBSIBAwnAkQCBpUBIgkDg0CRBIH4AECKQQQwIE0ggjAQKpRJIAgXSCSZBCtlI8Cbq9Dfa/wEIgG4AECOQPQAIEcgQiAQK5A5AAgVyCSYBAXoFIgECeQUmAQOYAJEAggzASIJBJMAkQSBSCBAgkC0QCBBKGIwECSYOSAIHEoUmAQPoAJEAghRgSIJBGGAkQSCWSBAikE0yCFLKV4knQ7W2w/wUWAtkAJEAgfwASIJAjEAkQyB2ABAj0fRs8ThEJYWBXp48AAAAASUVORK5CYII=',
  'base64'
)

test('message image requests wait for activation, including after reopening history', async ({
  page
}) => {
  const requests: string[] = []
  await page.route('https://privacy-canary.invalid/**', async (route) => {
    requests.push(route.request().url())
    await route.fulfill({
      contentType: 'image/png',
      body: imageBytes
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

test('approved images retain the native download action', async ({ page }) => {
  await page.route('https://privacy-canary.invalid/**', (route) =>
    route.fulfill({ contentType: 'image/png', body: imageBytes })
  )
  await page.goto('/media-privacy.html')
  await page.getByRole('button', { name: /privacy-canary.invalid/ }).click()
  const wrapper = page.locator('[data-streamdown="image-wrapper"]')
  await expect(wrapper.locator('img')).toHaveJSProperty('naturalWidth', 256)
  await wrapper.hover()
  await page.screenshot({ path: test.info().outputPath('approved-image-download.png') })
  const download = page.waitForEvent('download')
  await wrapper.getByRole('button', { name: 'Download image' }).click()
  expect((await download).suggestedFilename()).toBe('image.png')
})
