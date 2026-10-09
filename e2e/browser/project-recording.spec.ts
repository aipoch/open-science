import { expect, test } from '@playwright/test'

test('project frames and exact static results work independently with no Notebook or execution', async ({
  page
}, testInfo) => {
  const networkDispatches: string[] = []
  const blockedAttempts: string[] = []
  await page.route('https://untrusted.invalid/**', async (route) => {
    networkDispatches.push(route.request().url())
    await route.abort()
  })
  page.on('requestfailed', (request) => {
    if (request.url().includes('untrusted.invalid'))
      blockedAttempts.push(request.failure()?.errorText ?? 'unknown')
  })
  await page.goto('/project-recording.html')
  await page.evaluate(() => {
    Object.assign(window, { executedMessages: [] })
    window.addEventListener('message', (event) => {
      if (event.data === 'executed')
        (window as unknown as { executedMessages: unknown[] }).executedMessages.push(event.data)
    })
    // A real browser pointer at CSS zoom checks this static iframe's inert behavior. This is
    // not an Electron webContents zoom/coordinate-bridge test; no such bridge is added here.
    document.body.style.zoom = '1.25'
  })
  const project = page.getByRole('region', { name: 'Project replay' })
  const results = page.getByRole('region', { name: 'Results', exact: true })
  await expect(project.getByRole('img', { name: 'Recorded project image' })).toBeVisible()
  await project.getByRole('button', { name: 'Next image' }).click()
  await expect(project.getByText('Recorded project image 2 of 2')).toBeVisible()
  await results.getByRole('button', { name: /final.html/ }).click()
  const frame = page.frameLocator('iframe[title="final.html"]')
  await expect(frame.getByRole('heading', { name: 'Saved result' })).toBeVisible()
  await expect(page.locator('iframe[title="final.html"]')).toHaveAttribute('sandbox', '')
  await expect(frame.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute(
    'content',
    /default-src 'none'/
  )
  await expect(frame.locator('script')).toHaveCount(0)
  await expect(frame.locator('#external-link')).not.toHaveAttribute('href')
  await expect(frame.locator('#passthrough')).toHaveAttribute(
    'data-preview-context-menu-passthrough',
    ''
  )
  await page
    .locator('iframe[title="final.html"]')
    .click({ button: 'right', position: { x: 40, y: 160 } })
  await page.keyboard.press('Escape')
  await expect(project.getByText('Recorded project image 2 of 2')).toBeVisible()
  await expect(frame.getByRole('heading', { name: 'Saved result' })).toBeVisible()
  await results.getByRole('button', { name: 'Ask about this file' }).click()
  await expect(page.getByTestId('file-reference')).toContainText('recorded-observation-file')
  const selection = JSON.parse(await page.getByTestId('file-reference').innerText())
  expect(selection).toMatchObject({
    kind: 'recorded-observation-file',
    source: 'project-recording',
    scope: 'recording',
    stage: 'unspecified',
    stepKeys: [],
    resource: {
      projectId: 'receiver-a',
      sessionId: 'session-a',
      artifactId: 'a-report',
      versionId: 'a-report-version'
    }
  })
  expect(selection).not.toHaveProperty('stepId')
  expect(selection).not.toHaveProperty('record')
  await page.getByRole('button', { name: 'Toggle project module' }).click()
  await expect(project).toHaveCount(0)
  await results.getByRole('button', { name: /values.csv/ }).click()
  await expect(results.getByText('trial,value\n1,42', { exact: true })).toBeVisible()
  await results.getByRole('button', { name: /summary.json/ }).click()
  await expect(results.getByText('{"value":42}', { exact: true })).toBeVisible()
  // Serialize only explicit fields; Window itself is not a serializable value.
  const evidence = await page.evaluate(() => ({
    stats: (window as unknown as { projectRecordingStatistics: unknown })
      .projectRecordingStatistics,
    executed: (window as unknown as { executedMessages: unknown[] }).executedMessages
  }))
  expect(evidence.executed).toEqual([])
  expect(evidence.stats).toMatchObject({ forbidden: [] })
  expect(
    (evidence.stats as { requests: string[] }).requests.every(
      (value) =>
        value === 'GET /api/recording/media' || value === 'POST /api/recording/file-selection'
    )
  ).toBe(true)
  expect(networkDispatches).toEqual([])
  expect(blockedAttempts.every((error) => ['csp', 'net::ERR_BLOCKED_BY_CSP'].includes(error))).toBe(
    true
  )
  await page.screenshot({ path: testInfo.outputPath('independent-results-125-percent.png') })
})

test('switching receiving versions with identical frame IDs never displays the previous source while loading', async ({
  page
}) => {
  await page.goto('/project-recording.html')
  const project = page.getByRole('region', { name: 'Project replay' })
  const image = project.getByRole('img', { name: 'Recorded project image' })
  await expect(image).toBeVisible()
  const source = await image.getAttribute('src')
  await page.getByRole('button', { name: 'Switch receiving source' }).click()
  await expect(page.getByTestId('receiving-source')).toHaveText('receiver-b')
  await expect(project.getByText('Preparing recorded material…')).toBeVisible()
  await expect(image).toHaveCount(0)
  await expect(image).toBeVisible()
  expect(await image.getAttribute('src')).not.toBe(source)
  const results = page.getByRole('region', { name: 'Results', exact: true })
  await results.getByRole('button', { name: /final.html/ }).click()
  await results.getByRole('button', { name: 'Ask about this file' }).click()
  await expect(page.getByTestId('file-reference')).toContainText('recorded-observation-file')
  const selection = JSON.parse(await page.getByTestId('file-reference').innerText())
  expect(selection.receiving.projectId).toBe('receiver-b')
  expect(selection.resource.versionId).toBe('b-report-version')
})
