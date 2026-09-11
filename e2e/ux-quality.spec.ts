import { expect } from '@playwright/test'
import { cpus, platform, release, totalmem } from 'node:os'
import { writeFile } from 'node:fs/promises'
import { test } from './fixtures/electron-app'
import { openProjectSession } from './certification/helpers'
import { literatureItemInputSchema } from '../src/shared/literature'

test('measures representative local workloads and verifies 200 percent project controls', async ({
  app
}, testInfo) => {
  test.setTimeout(240_000)
  let page = await app.completeOnboarding()
  const samples: Record<string, number[]> = {}
  const sample = (name: string, duration: number): void => {
    ;(samples[name] ??= []).push(duration)
  }
  for (let i = 0; i < 3; i++) {
    page = await app.restart()
    await expect(page.getByRole('button', { name: 'New project' })).toBeVisible()
    sample('navigationToHomeActionMs', await page.evaluate(() => performance.now()))
  }
  await app.setMainWindowZoomFactor(2)
  try {
    await page.getByRole('button', { name: 'New project' }).press('Enter')
    const dialog = page.getByRole('dialog', { name: 'New project' })
    await dialog.getByLabel('Name').fill('Zoom acceptance')
    const create = dialog.getByRole('button', { name: 'Create project' })
    await create.scrollIntoViewIfNeeded()
    expect(
      await create.evaluate((el) => {
        const r = el.getBoundingClientRect()
        return r.top >= 0 && r.bottom <= innerHeight
      })
    ).toBe(true)
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).press('Enter')
    await expect(dialog).toHaveCount(0)
  } finally {
    await app.setMainWindowZoomFactor(1)
  }
  const cwd = await app.createTestDirectory('m10-capacity')
  await Promise.all(
    Array.from({ length: 1000 }, (_, i) =>
      writeFile(`${cwd}/sample-${String(i).padStart(4, '0')}.txt`, 'scientific fixture')
    )
  )

  await page.evaluate(async (cwd) => {
    const project = await window.api.projects.create({ name: 'M10 capacity', description: '' })
    const now = Date.now() - 10_000
    for (let session = 0; session < 3; session++)
      await window.api.sessions.saveSession({
        id: `m10-capacity-${session}`,
        projectId: project.id,
        title: `Capacity ${session}`,
        cwd,
        status: 'idle',
        createdAt: now,
        updatedAt: now,
        messages: Array.from({ length: 400 }, (_, i) => ({
          id: `m10-message-${session}-${i}`,
          role: 'user' as const,
          content: `Message ${i} ` + 'Scientific evidence. '.repeat(20),
          status: 'complete' as const,
          eventIds: [],
          createdAt: now + i,
          updatedAt: now + i
        }))
      })
    for (let i = 0; i < 3; i++)
      await window.api.sessions.saveSession({
        id: `m10-diagram-${i}`,
        projectId: project.id,
        title: `Diagram ${i}`,
        cwd,
        status: 'idle',
        createdAt: now,
        updatedAt: now,
        messages: [
          {
            id: `diagram-message-${i}`,
            role: 'agent',
            content:
              '```mermaid\ngraph TD\n' +
              Array.from({ length: 30 }, (_, j) => `N${j}-->N${j + 1}`).join('\n') +
              '\n```',
            status: 'complete',
            eventIds: [],
            createdAt: now,
            updatedAt: now
          }
        ]
      })
  }, cwd)
  const literature = literatureItemInputSchema.parse({
    itemType: 'journalArticle',
    title: 'Scale paper'
  })
  await page.evaluate(async (item) => {
    for (let i = 0; i < 1000; i++)
      await window.api.literature.transact({
        kind: 'create-item',
        item: { ...item, title: `Scale paper ${i}` }
      })
  }, literature)
  page = await app.restart()
  for (let i = 0; i < 3; i++) {
    const query = await page.evaluate(async () => {
      const start = performance.now()
      const result = await window.api.literature.search({
        scope: 'library',
        query: 'Scale paper',
        limit: 100
      })
      return { ms: performance.now() - start, count: result.entries?.length ?? 0 }
    })
    expect(query.count).toBe(100)
    sample('library1000Query100Ms', query.ms)
  }
  await openProjectSession(page, 'M10 capacity', 'Capacity 0')
  for (const i of [1, 2, 0]) {
    const start = performance.now()
    await page
      .getByRole('navigation', { name: 'Sessions' })
      .getByRole('button', { name: new RegExp(`^Session status:.*Capacity ${i}$`) })
      .click()
    await expect(page.locator(`[data-message-id="m10-message-${i}-399"]`)).toBeVisible()
    sample('session400SwitchMs', performance.now() - start)
    const input = page.getByRole('textbox', { name: 'Ask anything' })
    const typing = performance.now()
    await input.fill('A retained draft '.repeat(100))
    sample('composer1700FillMs', performance.now() - typing)
    await input.fill('')
    sample(
      'rendererHeapBytes',
      await page.evaluate(
        () =>
          (performance as Performance & { memory: { usedJSHeapSize: number } }).memory
            .usedJSHeapSize
      )
    )
  }
  for (let i = 0; i < 3; i++) {
    const start = performance.now()
    await page
      .getByRole('navigation', { name: 'Sessions' })
      .getByRole('button', { name: new RegExp(`^Session status:.*Diagram ${i}$`) })
      .click()
    await expect(page.locator('[data-streamdown="mermaid"] svg')).toBeVisible()
    sample('diagram30FirstOpenMs', performance.now() - start)
  }
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await page.getByRole('button', { name: 'Filter project files' }).click()
  await page
    .getByRole('menu', { name: 'Filter project files' })
    .getByRole('menuitemradio')
    .last()
    .click()
  const browser = page.getByLabel('Local file browser')
  const address = browser.getByLabel('Directory path')
  const listingStart = performance.now()
  await address.fill(cwd)
  await address.press('Enter')
  const contents = browser.getByRole('list', { name: 'Directory contents' })
  await expect(contents.getByRole('button')).toHaveCount(1000)
  sample('directory1000FirstListMs', performance.now() - listingStart)
  for (let i = 0; i < 3; i++) {
    const scroll = await contents.evaluate(async (el, index) => {
      const viewport = el.parentElement!
      const start = performance.now()
      viewport.scrollTop = index % 2 === 0 ? viewport.scrollHeight : 0
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
      return {
        ms: performance.now() - start,
        scrollable: viewport.scrollHeight > viewport.clientHeight,
        top: viewport.scrollTop
      }
    }, i)
    expect(scroll.scrollable).toBe(true)
    if (i % 2 === 0) expect(scroll.top).toBeGreaterThan(0)
    sample('directory1000ScrollTwoFramesMs', scroll.ms)
  }
  const summary = Object.fromEntries(
    Object.entries(samples).map(([name, values]) => [
      name,
      { samples: values, median: [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] }
    ])
  )
  const report = {
    environment: {
      platform: platform(),
      release: release(),
      cpu: cpus()[0]?.model,
      memoryBytes: totalmem()
    },
    summary,
    limitations:
      'Local unpackaged Electron; OS caches warm. Navigation timing excludes process spawn and onboarding. Fill includes Playwright transport, not hardware keystroke latency. Directory scroll uses DOM scroll plus two animation frames, not end-to-end wheel latency. First directory list has one sample. Heap is renderer JS heap only. No performance comparison or optimization claim.'
  }
  await writeFile(
    testInfo.outputPath('quality-performance.json'),
    JSON.stringify(report, null, 2) + '\n'
  )
  await testInfo.attach('M10 performance', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json'
  })
})
