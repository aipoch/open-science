import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'
import { createProject } from './certification/helpers'
import type { PersistedChatSession } from '../src/shared/session-persistence'
import type { NotebookRunRecord } from '../src/shared/notebook'

test.use({ windowMode: 'normal' })

test('opens and completely reads three large Notebook runs without retaining previous pages', async ({
  app
}, info) => {
  test.setTimeout(240_000)
  await app.completeOnboarding()
  await app.beginResourceProfile({ outputRoot: info.outputPath('resource-profile') })
  let page = await app.configureFakeAgent()
  const projectId = await createProject(page, 'Bounded Notebook')
  const cwd = await app.createTestDirectory('bounded-notebook-workspace')
  const session: PersistedChatSession = {
    id: 'bounded-large-output',
    projectId,
    title: 'Large output history',
    cwd,
    status: 'idle',
    messages: [],
    activities: [],
    createdAt: 1,
    updatedAt: 5
  }
  const outputs = [0, 1, 2].map(
    (index) => `${index}:` + 'x'.repeat(1_572_865 - 13) + `:complete-${index}`
  )
  const runs: NotebookRunRecord[] = outputs.map((text, index) => ({
    runId: `large-${index}`,
    cellId: `cell-${index}`,
    source: 'user',
    kernelKind: 'python',
    script: `print(${index})`,
    status: 'completed',
    startedAt: index + 303,
    endedAt: index + 304,
    text: { stdout: text, stderr: '', traceback: '', plain: [text] },
    outputs: [{ type: 'stream', name: 'stdout', text }],
    workingFiles: []
  }))
  const olderRuns: NotebookRunRecord[] = Array.from({ length: 302 }, (_, index) => ({
    ...runs[0],
    runId: `old-${index}`,
    cellId: `old-cell-${index}`,
    startedAt: index + 1,
    endedAt: index + 2,
    script: `old_value = ${index}`,
    text: { stdout: 'old', stderr: '', traceback: '', plain: [] },
    outputs: []
  }))
  olderRuns[42].kernelKind = 'r'
  const tinyPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQVDL+DwACFAFmBODefwAAAABJRU5ErkJggg==',
    'base64'
  )
  const image = Buffer.concat([
    tinyPng,
    Buffer.alloc(Math.floor(3.5 * 1024 * 1024) - tinyPng.length)
  ]).toString('base64')
  const figure: NotebookRunRecord = {
    ...runs[0],
    runId: 'large-figure',
    cellId: 'large-figure-cell',
    startedAt: 306,
    endedAt: 307,
    script: 'figure()',
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [{ type: 'display', data: { 'image/png': image } }]
  }
  page = await app.restartWithSessionFixture(session, [...olderRuns, ...runs, figure])
  const otherSession = { ...session, id: 'bounded-other-session', title: 'Other bounded history' }
  page = await app.restartWithSessionFixture(otherSession, [
    { ...olderRuns[0], runId: 'other-run', cellId: 'other-cell', script: 'other_session_only' }
  ])
  await page
    .getByRole('region', { name: 'Projects', exact: true })
    .getByRole('button', { name: 'Bounded Notebook', exact: true })
    .click()
  await page.getByText(session.title, { exact: true }).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'View notebook', exact: true }).click()
  const cells = page.getByTestId('session-notebook-cell')
  await expect(cells).toHaveCount(100)
  await app.markResourceProfilePhase('bounded-summary')
  for (let index = 0; index < 3; index++) {
    const cell = cells.nth(index + 96)
    await cell.getByRole('button', { name: 'Read complete run', exact: true }).first().click()
    await expect(cell.getByTestId('notebook-content-page')).toHaveText(runs[index].script)
    let collected = ''
    while (collected.length < outputs[index].length) {
      await cell.getByRole('button', { name: 'Continue reading', exact: true }).click()
      const content = cell.getByTestId('notebook-content-page')
      await expect(content).toBeVisible()
      const chunk = (await content.textContent()) ?? ''
      expect(chunk.length).toBeLessThanOrEqual(65_536)
      collected += chunk
    }
    expect(collected).toBe(outputs[index])
    await expect(page.getByTestId('notebook-content-reader')).toHaveCount(1)
  }
  await app.markResourceProfilePhase('three-large-text-runs-read')
  const figureCell = cells.nth(99)
  await figureCell.getByRole('button', { name: 'Read complete run', exact: true }).first().click()
  await expect(figureCell.getByTestId('notebook-content-page')).toHaveText('figure()')
  await figureCell.getByRole('button', { name: 'Continue reading', exact: true }).click()
  await expect(figureCell.getByTestId('notebook-content-page')).toBeVisible()
  await figureCell.getByRole('button', { name: 'Continue reading', exact: true }).click()
  const displayedImage = figureCell.getByRole('img', { name: 'Notebook output' })
  await expect(displayedImage).toBeVisible({ timeout: 60_000 })
  await expect
    .poll(() => displayedImage.evaluate((image) => (image as HTMLImageElement).naturalWidth))
    .toBe(1)
  await app.markResourceProfilePhase('maximum-legal-image-read')
  await page.screenshot({ path: info.outputPath('large-notebook-complete.png') })
  const viewport = page.getByTestId('session-notebook-scroll-viewport')
  await viewport.hover()
  await page.mouse.wheel(0, -100_000)
  await expect(cells).toHaveCount(200)
  await page.mouse.wheel(0, -100_000)
  await expect(
    page.getByRole('button', { name: 'Return to latest runs', exact: true })
  ).toBeVisible()
  await page.mouse.wheel(0, -100_000)
  await expect(page.getByText('Beginning of notebook history', { exact: true })).toBeVisible()
  await expect(cells.first()).toContainText('old_value')
  await page.screenshot({ path: info.outputPath('large-notebook-earlier-page.png') })
  await page.getByTestId('session-notebook-tab-r').click()
  await expect(cells).toHaveCount(1)
  await expect(cells.first()).toContainText('old_value = 42')
  await page.getByRole('button', { name: 'Return to latest runs', exact: true }).click()
  await page.getByTestId('session-notebook-tab-python').click()
  await expect(cells).toHaveCount(100)
  await expect(cells.nth(96)).toContainText('print(0)')
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByText(otherSession.title, { exact: true }).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'View notebook', exact: true }).click()
  await expect(cells).toHaveCount(1)
  await expect(cells.first()).toContainText('other_session_only')
  await app.markResourceProfilePhase('earlier-history-loaded')
  const profile = await app.finishResourceProfile()
  await info.attach('resource-profile.json', {
    path: profile.summaryJsonPath,
    contentType: 'application/json'
  })
  const settings = await page.evaluate(() => window.api.settings.getSettings())
  expect(settings).toBeTruthy()
  await info.attach('persisted-integrity.json', {
    body: JSON.stringify({
      runs: (await app.readNotebookFixtureRuns(projectId, session.id)).map((run) => ({
        runId: run.runId,
        textLength: run.text.stdout.length
      }))
    }),
    contentType: 'application/json'
  })
})
