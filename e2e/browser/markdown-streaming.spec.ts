import { expect, test } from '@playwright/test'
import { crc32, deflateSync } from 'node:zlib'

test('renders costly appends with a real parser Worker and converges to the synchronous result', async ({
  page
}, testInfo) => {
  const workerUrls: string[] = []
  page.on('worker', (worker) => workerUrls.push(worker.url()))
  await page.addInitScript(() => {
    let parsedSnapshots = 0
    Object.assign(window, { __markdownParses: () => parsedSnapshots })
    window.Worker = new Proxy(window.Worker, {
      construct(Target, args: ConstructorParameters<typeof Worker>) {
        const worker = new Target(...args)
        if (String(args[0]).includes('markdown-parser')) {
          worker.addEventListener('message', (event: MessageEvent) => {
            if (event.data.tree?.children?.length > 0) parsedSnapshots++
          })
        }
        return worker
      }
    })
  })
  // Exercise the adaptive cost boundary even on faster CI hosts; assertions concern observable
  // text, Worker lifecycle and final semantics, not a wall-clock performance threshold.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  await page.goto('/markdown-streaming.html')
  const input = page.getByRole('textbox', { name: 'Markdown input' })
  const markdown = page.locator('.agent-markdown')
  const prefix = 'Scientific prose. '.repeat(12000) + '**bold** $a+b$ 中文~~标记~~ &amp;'
  await input.fill(prefix)
  await expect(markdown.locator('[data-streamdown="strong"]')).toHaveText('bold')
  await input.fill(prefix + ' first tail')
  await expect
    .poll(() => workerUrls.filter((url) => url.includes('markdown-parser')).length)
    .toBe(1)
  await input.fill(prefix + ' first tail and latest tail')
  await expect
    .poll(() =>
      markdown.evaluate((element) => element.textContent?.endsWith('first tail and latest tail'))
    )
    .toBe(true)
  await expect(markdown.locator('.katex')).toHaveCount(1)
  await expect(markdown.locator('del')).toHaveText('标记')
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { __markdownParses: () => number }).__markdownParses()
      )
    )
    .toBeGreaterThan(0)
  const streamed = await markdown.innerHTML()
  await page.getByRole('button', { name: 'Finish stream' }).click()
  await expect.poll(() => markdown.innerHTML()).toBe(streamed)
  await input.fill('A replacement branch **stays current**.')
  await expect(markdown).toHaveText('A replacement branch stays current.')
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  await input.fill(
    '## Completed result\n\nThe current branch is **ready**.\n\n| Result | Value |\n| --- | --- |\n| Sample | 42 |\n\n$a^2+b^2=c^2$'
  )
  await expect(markdown.locator('table')).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath('completed-markdown.png'),
    animations: 'disabled'
  })
  await cdp.detach()
})

test('preserves list, table and code content through incremental appends and completion', async ({
  page
}) => {
  await page.goto('/markdown-streaming.html')
  const input = page.getByRole('textbox', { name: 'Markdown input' })
  const markdown = page.locator('.agent-markdown')
  const list = '- **First** item\n- Second with `code`\n\n  Continued paragraph.'
  await input.fill(list)
  await expect(markdown.locator('li')).toHaveCount(2)
  await expect(markdown.locator('li').first()).toHaveText('First item')
  await expect(markdown.locator('li').last()).toContainText('Continued paragraph.')

  const table = '\n\n| Name | Value |\n| --- | --- |\n| **Sample** | `42` |'
  await input.fill(list + table)
  await expect(markdown.locator('tbody tr')).toHaveCount(1)
  await expect(markdown.locator('td')).toHaveText(['Sample', '42'])

  const code = '\n\n```text\n**literal** [link](https://example.com)'
  await input.fill(list + table + code)
  await expect(markdown.locator('pre')).toContainText('**literal** [link](https://example.com)')
  await input.fill(list + table + code + '\n```\n\nFinal **result**.')
  await expect(markdown).toContainText('Final result.')
  await page.getByRole('button', { name: 'Finish stream' }).click()
  await expect(markdown.locator('li')).toHaveCount(2)
  await expect(markdown.locator('td')).toHaveText(['Sample', '42'])
  await expect(markdown.locator('pre')).toContainText('**literal** [link](https://example.com)')
  await expect(markdown.locator('[data-streamdown="strong"]').last()).toHaveText('result')
})

test('keeps completed Mermaid SVG nodes through streaming completion and updates equal-length code', async ({
  page
}, testInfo) => {
  await page.goto('/markdown-streaming.html')
  const input = page.getByRole('textbox', { name: 'Markdown input' })
  const markdown = page.locator('.agent-markdown')
  const chart = '```mermaid\ngraph LR\n A[Start] --> B[Finish]\n```\n\nTail'
  await input.fill(chart)
  const svg = markdown.locator('svg[data-mermaid-render-id]')
  await expect(svg).toBeVisible()
  const initial = await svg.elementHandle()
  expect(initial).not.toBeNull()
  for (let index = 1; index <= 5; index++) await input.fill(chart + '.'.repeat(index))
  await page.getByRole('button', { name: 'Finish stream' }).click()
  await expect
    .poll(() => svg.evaluate((element, previous) => element === previous, initial))
    .toBe(true)
  await page.screenshot({ path: testInfo.outputPath('mermaid-completed.png') })
  await input.fill(chart.replace('Finish', 'Review'))
  await expect(svg).toContainText('Review')
  await input.fill('```js\nconst answer = 1\n```')
  await expect(markdown.locator('pre')).toContainText('answer = 1')
  await input.fill('```js\nconst answer = 2\n```')
  await expect(markdown.locator('pre')).toContainText('answer = 2')
})

test('keeps each approved image current without reloading unchanged media', async ({
  page
}, testInfo) => {
  const requests: string[] = []
  await page.route('https://figures.invalid/**', (route) => {
    requests.push(route.request().url())
    return route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" fill="teal"/></svg>'
    })
  })
  await page.goto('/markdown-streaming.html')
  const input = page.getByRole('textbox', { name: 'Markdown input' })
  const markdown = page.locator('.agent-markdown')
  const content =
    '![Initial figure](https://figures.invalid/first.svg)\n\n![Second figure](https://figures.invalid/second.svg)\n\nTail'
  await input.fill(content)
  expect(requests).toEqual([])
  await page.getByRole('button', { name: /Initial figure.*figures.invalid/ }).click()
  await page.getByRole('button', { name: /Second figure.*figures.invalid/ }).click()
  await expect.poll(() => requests.length).toBe(2)
  await expect(markdown.locator('img')).toHaveCount(2)
  const first = markdown.getByRole('img', { name: 'Initial figure' })
  await expect(first).toHaveAttribute('src', 'https://figures.invalid/first.svg')
  const initial = await first.elementHandle()
  await input.fill(content.replace('Initial', 'Updated'))
  const updated = markdown.getByRole('img', { name: 'Updated figure' })
  await expect(updated).toBeVisible()
  expect(await updated.evaluate((element, previous) => element === previous, initial)).toBe(true)
  for (let index = 1; index <= 5; index++)
    await input.fill(content.replace('Initial', 'Updated') + '.'.repeat(index))
  await page.getByRole('button', { name: 'Finish stream' }).click()
  await expect(updated).toHaveJSProperty('complete', true)
  expect(requests).toHaveLength(2)
  await page.screenshot({ path: testInfo.outputPath('distinct-approved-images.png') })
  await input.fill(content.replace('first.svg', 'third.svg'))
  await expect(page.getByRole('button', { name: /Initial figure.*figures.invalid/ })).toBeVisible()
  expect(requests).toHaveLength(2)
})

test('uses the current hyperlink after an equal-length source replacement', async ({ page }) => {
  const requests: string[] = []
  await page.route('https://sources.invalid/**', async (route) => {
    requests.push(route.request().url())
    await route.abort()
  })
  await page.goto('/markdown-streaming.html')
  const input = page.getByRole('textbox', { name: 'Markdown input' })
  await input.fill('[Paper](https://sources.invalid/old) summary.')
  const link = page.locator('a[data-session-message-link]')
  await expect(link).toHaveAttribute('href', 'https://sources.invalid/old')
  await input.fill('[Paper](https://sources.invalid/new) summary.')
  await expect(link).toHaveAttribute('href', 'https://sources.invalid/new')
  await link.hover()
  await expect(page.locator('[data-source-preview-hover-url]')).toHaveText(
    'https://sources.invalid/new'
  )
  expect(requests).toEqual([])
})

test('updates equal-length formatted text, table cells and formulas', async ({ page }) => {
  await page.goto('/markdown-streaming.html')
  const input = page.getByRole('textbox', { name: 'Markdown input' })
  const markdown = page.locator('.agent-markdown')
  const content = '**Cold**\n\n| Name | Value |\n| --- | --- |\n| Sample | 1 |\n\n$a+1$'
  await input.fill(content)
  await expect(markdown.locator('annotation')).toHaveText('a+1')
  await input.fill(content.replace('Cold', 'Warm').replaceAll('1', '2'))
  await expect(markdown.locator('[data-streamdown="strong"]')).toHaveText('Warm')
  await expect(markdown.locator('td')).toHaveText(['Sample', '2'])
  await expect(markdown.locator('annotation')).toHaveText('a+2')
})

// A real tall PNG exercises image decode and intrinsic layout without external network or fixtures.
function tallPng(): Buffer {
  const chunk = (kind: string, bytes: Buffer): Buffer => {
    const payload = Buffer.concat([Buffer.from(kind), bytes])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(bytes.length)
    const checksum = Buffer.alloc(4)
    checksum.writeUInt32BE(crc32(payload))
    return Buffer.concat([length, payload, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1200, 0)
  header.writeUInt32BE(1800, 4)
  header[8] = 8
  header[9] = 6
  const pixels = Buffer.alloc((1200 * 4 + 1) * 1800, 200)
  for (let row = 0; row < 1800; row++) pixels[row * (1200 * 4 + 1)] = 0
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

for (const dimensions of [false, true]) {
  test(`follows delayed streaming image growth at bottom (dimensions: ${dimensions})`, async ({
    page
  }) => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let requests = 0
    await page.route('**/delayed-stream-image.png', async (route) => {
      requests++
      await gate
      await route.fulfill({ contentType: 'image/png', body: tallPng() })
    })
    await page.goto(`/markdown-streaming.html?image-scroll${dimensions ? '&dimensions' : ''}`)
    const viewport = page.getByRole('region')
    const bottomGap = (): Promise<number> =>
      viewport.evaluate((e) => e.scrollHeight - e.clientHeight - e.scrollTop)
    await expect.poll(bottomGap).toBeLessThanOrEqual(1)
    await expect.poll(() => viewport.evaluate((e) => e.scrollTop)).toBeGreaterThan(500)
    await page.getByRole('button', { name: 'Stream image', exact: true }).click()
    await expect.poll(() => requests).toBe(1)
    await expect.poll(bottomGap).toBeLessThanOrEqual(1)
    const beforeHeight = await viewport.evaluate((e) => e.scrollHeight)
    await viewport.evaluate((e) => {
      const state = { running: true, gaps: [] as number[] }
      Object.assign(window, { __imageBottomProbe: state })
      const sample = (): void => {
        if (!state.running) return
        state.gaps.push(e.scrollHeight - e.clientHeight - e.scrollTop)
        requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })
    release()
    const image = page.locator('[data-session-artifact-image] img')
    await expect.poll(() => image.evaluate((e: HTMLImageElement) => e.naturalHeight)).toBe(1800)
    await expect
      .poll(() => viewport.evaluate((e) => e.scrollHeight))
      .toBeGreaterThan(beforeHeight + 500)
    const gaps = await page.evaluate(async () => {
      const state = (
        window as unknown as { __imageBottomProbe: { running: boolean; gaps: number[] } }
      ).__imageBottomProbe
      for (let frame = 0; frame < 30; frame++) await new Promise(requestAnimationFrame)
      state.running = false
      return state.gaps
    })
    await test.info().attach('image-arrival-bottom-gaps', {
      body: JSON.stringify(gaps),
      contentType: 'application/json'
    })
    expect(Math.max(...gaps), `bottom gaps: ${gaps.join(', ')}`).toBeLessThanOrEqual(1)
    for (let chunk = 0; chunk < 4; chunk++) {
      await page.getByRole('button', { name: 'Append text', exact: true }).click()
      await expect.poll(bottomGap).toBeLessThanOrEqual(1)
    }
    await page.getByRole('button', { name: 'Complete generation', exact: true }).click()
    await expect(page.getByTestId('reply-tail')).toHaveText('Completed')
    await expect.poll(bottomGap).toBeLessThanOrEqual(1)
    expect(requests).toBe(1)
    await page.screenshot({ path: test.info().outputPath('image-stream-bottom.png') })
  })
}

test('delayed image growth respects an upward scroll and can resume bottom following', async ({
  page
}) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/delayed-stream-image.png', async (route) => {
    await gate
    await route.fulfill({ contentType: 'image/png', body: tallPng() })
  })
  await page.goto('/markdown-streaming.html?image-scroll')
  const viewport = page.getByRole('region')
  await page.getByRole('button', { name: 'Stream image', exact: true }).click()
  await expect(page.locator('[data-session-artifact-image-status]')).toBeVisible()
  const initial = await viewport.evaluate((e) => e.scrollTop)
  await viewport.hover()
  await page.mouse.wheel(0, -250)
  await expect.poll(() => viewport.evaluate((e) => e.scrollTop)).toBeLessThan(initial - 100)
  // Native wheel momentum must settle before measuring the effect of image arrival.
  await page.waitForTimeout(300)
  const releasedTop = await viewport.evaluate((e) => e.scrollTop)
  release()
  await expect
    .poll(() =>
      page
        .locator('[data-session-artifact-image] img')
        .evaluate((e: HTMLImageElement) => e.naturalHeight)
    )
    .toBe(1800)
  await page.getByRole('button', { name: 'Append text', exact: true }).click()
  await expect.poll(() => viewport.evaluate((e) => e.scrollTop)).toBe(releasedTop)
  await page.getByRole('button', { name: 'Scroll to end', exact: true }).click()
  const gap = (): Promise<number> =>
    viewport.evaluate((e) => e.scrollHeight - e.clientHeight - e.scrollTop)
  await expect.poll(gap).toBeLessThanOrEqual(1)
  await page.getByRole('button', { name: 'Append text', exact: true }).click()
  await expect.poll(gap).toBeLessThanOrEqual(1)
})
