import { expect, test } from '@playwright/test'
import { createServer } from 'node:http'

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

// Count requests at a real controlled HTTP server: DOM string assertions cannot prove that
// Mermaid did not fetch while measuring a label before returning its final SVG.
test('Mermaid HTML labels and diagram configuration cannot fetch images during layout', async ({
  page
}) => {
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url ?? '')
    response.writeHead(200, { 'content-type': 'image/png' })
    response.end(imageBytes)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    const label = `flowchart TD\n A["<b>Start</b><br/><img src='${origin}/html' srcset='${origin}/srcset 2x'>"] --> B["Finish"]`
    const sources = [
      label,
      `flowchart TD\n A["<input type='image' src='${origin}/input'>"]`,
      `flowchart TD\n A["<INPUT TYPE='image' SRC='${origin}/input-upper'>"]`,
      `flowchart TD\n A["&lt;input type='image' src='${origin}/input-entity'&gt;"]`,
      `flowchart TD\n A["<table background='${origin}/table'><tr background='${origin}/tr'><td background='${origin}/td'>Start</td></tr></table>"]`,
      `flowchart TD\n A["<svg><filter id='f'><feImage href='${origin}/filter'/></filter><rect filter='url(#f)' width='50' height='50'/></svg>"]`,
      `flowchart TD\n A["<svg><filter id='g'><feImage xlink:href='${origin}/filter-xlink'/></filter><rect filter='url(#g)' width='50' height='50'/></svg>"]`,
      `---\nconfig:\n  fontFamily: "Arial; background-image:url(${origin}/font)"\n---\n${label}`,
      `flowchart TD\n A["<IMG SRC='${origin}/uppercase'>"]`,
      `flowchart TD\n A["&lt;img src='${origin}/encoded'&gt;"]`,
      `flowchart TD\n A["<svg><image href='${origin}/svg'/><use href='${origin}/use#x'/></svg>"]`,
      `flowchart TD\n A["<span style='background-image:url(${origin}/style)'>Start</span>"]`,
      `---\nconfig:\n  dompurifyConfig:\n    FORBID_TAGS: []\n  themeCSS: ".nodeLabel {background-image:url(${origin}/theme)}"\n---\n${label}`,
      `%%{init: {"dompurifyConfig":{"FORBID_TAGS":[]},"themeCSS":".nodeLabel {background-image:url(${origin}/directive)}"}}%%\n${label}`
    ]
    for (const source of sources) {
      await page.goto(
        `/media-privacy.html?mermaid=enabled&chart=${encodeURIComponent('```mermaid\n' + source + '\n```')}`
      )
      await expect(page.locator('svg[data-mermaid-render-id]')).toBeVisible()
      await page.waitForTimeout(300)
      expect(requests, source).toEqual([])
    }
    const concurrent =
      '```mermaid\n' +
      sources.find((source) => source.includes('themeCSS:')) +
      '\n```\n\n```mermaid\n---\nconfig:\n  theme: dark\n---\nflowchart TD\n C[Concurrent] --> D[Ordinary]\n```'
    await page.goto(`/media-privacy.html?mermaid=enabled&chart=${encodeURIComponent(concurrent)}`)
    await expect(page.locator('svg[data-mermaid-render-id]')).toHaveCount(2)
    await expect(page.locator('svg[data-mermaid-render-id]').last()).toContainText('Ordinary')
    await page.waitForTimeout(300)
    expect(requests).toEqual([])
    // Ordinary HTML formatting and graph geometry survive the label sanitizer.
    await page.goto(
      `/media-privacy.html?mermaid=enabled&chart=${encodeURIComponent('```mermaid\n' + label + '\n```')}`
    )
    const svg = page.locator('svg[data-mermaid-render-id]')
    await expect(svg).toBeVisible()
    await expect(svg.locator('b')).toHaveText('Start')
    await expect(svg).toContainText('Finish')
    expect((await svg.boundingBox())?.width).toBeGreaterThan(50)
    const formatted = `flowchart TD\n A["<a href='https://example.invalid/guide' title='Guide'><em>Linked</em></a><table><tr><td>Cell</td></tr></table>"] --> B["<code>x</code><sub>1</sub><sup>2</sup>"]`
    await page.goto(
      `/media-privacy.html?mermaid=enabled&chart=${encodeURIComponent('```mermaid\n' + formatted + '\n```')}`
    )
    await expect(svg).toBeVisible()
    await expect(svg.locator('a[href="https://example.invalid/guide"]')).toContainText('Linked')
    await expect(svg.locator('td')).toHaveText('Cell')
    await expect(svg.locator('code')).toHaveText('x')
    await expect(svg.locator('sub')).toHaveText('1')
    await expect(svg.locator('sup')).toHaveText('2')
    expect(requests).toEqual([])
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})

test('quoted and escaped Mermaid image metadata remains blocked', async ({ page }) => {
  const requests: string[] = []
  await page.route('https://privacy-canary.invalid/**', async (route) => {
    requests.push(route.request().url())
    await route.fulfill({ contentType: 'image/png', body: imageBytes })
  })
  for (const key of ['"img"', '"\\x69mg"']) {
    const chart =
      '```mermaid\nflowchart TD\n A@{ ' +
      key +
      ': "https://privacy-canary.invalid/image.png", label: "Image", h: 60 }\n```'
    await page.goto(`/media-privacy.html?mermaid=enabled&chart=${encodeURIComponent(chart)}`)
    await expect(page.getByText('Images in Mermaid diagrams are blocked')).toBeVisible()
    expect(requests).toEqual([])
  }
})
