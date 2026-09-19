import { expect, test } from '@playwright/test'

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
