import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { expect } from '@playwright/test'
import type { PersistedChatSession } from '../src/shared/session-persistence'
import { test } from './fixtures/electron-app'
import { createProject, openRecentSession, sendPrompt } from './certification/helpers'

const execute = promisify(execFile)
const stem = '非小细胞肺癌免疫治疗耐药与肿瘤相关巨噬细胞_综述'
const names = [
  stem + '.md',
  stem + '.docx',
  '研究'.repeat(30) + '.md',
  'a'.repeat(252) + '.md',
  'demo_chart.md',
  'study_analysis_results.docx'
]
const prompt = 'Create long filename artifacts.'
const content = '# Long filename report\n\n中文附件完整内容。\n'

test('publishes and downloads long Unicode attachments before and after restart', async ({
  app
}, testInfo) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  const dataRoot = await page.evaluate(async () => (await window.api.storage.getInfo()).dataRoot)
  const fixtureDirectory = await app.createTestDirectory('long-filename-downloads')
  const configRoot = join(dirname(fixtureDirectory), 'storage')
  expect((await realpath(dataRoot)).startsWith((await realpath(configRoot)) + sep)).toBe(true)
  if (process.env.OPEN_SCIENCE_TASK_ROOT) {
    expect(
      (await realpath(configRoot)).startsWith(
        (await realpath(process.env.OPEN_SCIENCE_TASK_ROOT)) + sep
      )
    ).toBe(true)
  }
  if (process.env.OPEN_SCIENCE_TASK_PYTHON) {
    const python = await realpath(process.env.OPEN_SCIENCE_TASK_PYTHON)
    await page.evaluate(async (python) => {
      await window.api.runtime.registerInterpreter('python', python)
      await window.api.runtime.setEnvironmentEnabled('python', python, true)
      await window.api.runtime.setAgentEnvironmentCreationEnabled({ enabled: false })
    }, python)
    const settings = JSON.parse(await readFile(join(configRoot, 'settings.json'), 'utf8'))
    expect(settings.notebookManualInterpreters.python).toContain(python)
    expect(settings.notebookRuntimeEnablement.python.enabled[python]).toBe(true)
  }
  await testInfo.attach('isolated-runtime', {
    body: JSON.stringify({
      dataRoot: await realpath(dataRoot),
      micromamba: process.env.OPEN_SCIENCE_MICROMAMBA_BIN
    }),
    contentType: 'application/json'
  })
  const projectId = await createProject(page, 'Long Unicode attachments')
  await sendPrompt(page, prompt, 'Long filename artifacts published.')
  const readSession = (): Promise<PersistedChatSession | undefined> =>
    page.evaluate(async (projectId) => {
      const sessions = (await window.api.sessions.loadAll()).sessions
      return sessions.find((session) => session.projectId === projectId)
    }, projectId)
  await expect
    .poll(
      async () => {
        const session = await readSession()
        return {
          status: session?.status,
          activeRun: Boolean(session?.activeRun),
          error: session?.error,
          names: session?.artifacts?.map((artifact) => artifact.name).sort()
        }
      },
      { timeout: 30_000 }
    )
    .toEqual({ status: 'idle', activeRun: false, error: undefined, names: [...names].sort() })
  const session = await readSession()
  expect(session?.error).toBeUndefined()
  expect(session?.artifacts?.map((artifact) => artifact.name).sort()).toEqual([...names].sort())
  const originals = session!.artifacts!

  const verify = async (round: string): Promise<void> => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const restored = await page.evaluate(
      async (id) =>
        (await window.api.sessions.loadAll()).sessions.find((session) => session.id === id),
      session!.id
    )
    expect(restored?.error).toBeUndefined()
    expect(restored?.artifacts?.map((artifact) => artifact.name).sort()).toEqual([...names].sort())
    // Absolute paths deliberately exceed legacy MAX_PATH; each component remains legal.
    const outputRoot = join(
      fixtureDirectory,
      round,
      'nested-directory-'.repeat(10),
      'nested-directory-'.repeat(8)
    )
    await mkdir(outputRoot, { recursive: true })
    for (const artifact of restored!.artifacts!) {
      const original = originals.find((original) => original.name === artifact.name)!
      expect(artifact).toMatchObject({
        id: original.id,
        artifactId: original.artifactId,
        versionId: original.versionId,
        sha256: original.sha256
      })
      const output = join(outputRoot, artifact.name!)
      expect(output.length).toBeGreaterThan(260)
      await execute(
        process.execPath,
        [
          resolve('packages/open-science/cli.mjs'),
          'artifacts',
          'download',
          artifact.id,
          '--output',
          output,
          '--config-root',
          configRoot,
          '--json'
        ],
        { timeout: 30_000 }
      )
      const bytes = await readFile(output)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(original.sha256)
      if (artifact.name!.endsWith('.md')) expect(bytes.toString('utf8')).toBe(content)
      else expect(bytes.subarray(0, 2).toString()).toBe('PK')
    }
    await page.getByRole('button', { name: 'Files', exact: true }).click()
    for (const name of [names[0], names[2]]) {
      await page
        .getByRole('button', { name: `Preview generated file ${name}`, exact: true })
        .last()
        .click()
      await expect(page.getByText('中文附件完整内容。', { exact: true }).last()).toBeVisible()
      const tab = page.getByRole('tab').and(page.getByTitle(name, { exact: true }))
      await expect(tab).toHaveAccessibleName(name)
      await expect(tab.getByTestId('file-name-ellipsis')).toBeVisible()
      const prefix = tab.getByTestId('file-name-head')
      await expect(prefix).toContainText(name.slice(0, 3))
      await expect(tab.getByTestId('file-name-tail')).toHaveCount(0)
      expect(
        await tab.evaluate((el) => el.parentElement!.getBoundingClientRect().width)
      ).toBeLessThanOrEqual(160)
      expect(await prefix.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    }
    await page
      .getByRole('button', { name: `Preview generated file ${names[1]}`, exact: true })
      .last()
      .click()
    await expect(page.locator('[data-office-preview-state="ready"]')).toBeVisible()
    await expect(
      page.frameLocator('iframe[data-office-preview-frame]').locator('.docx-review-counter')
    ).toHaveText('1 / 1')
    await page.screenshot({ path: testInfo.outputPath(`${round}.png`) })
    await page
      .getByRole('tab')
      .and(page.getByTitle(names[0], { exact: true }))
      .click()
    await expect(page.getByText('中文附件完整内容。', { exact: true }).last()).toBeVisible()
    await page.getByRole('button', { name: 'Files', exact: true }).click()
    for (const name of [names[4], names[5]]) {
      await page.getByRole('tab', { name: 'Files', exact: true }).click()
      await page
        .getByRole('button', { name: `Open ${name} in split view beside the session`, exact: true })
        .click()
    }
    for (const name of [names[1], names[2], 'Files']) {
      const close = page.locator(`[data-preview-close="${name}"]`)
      if (await close.count()) await close.click()
    }
    const english = page.getByRole('tab').and(page.getByTitle(names[5], { exact: true }))
    await expect(english).toHaveAccessibleName(names[5])
    await expect(english.getByTestId('file-name-head')).toHaveText('study')
    await expect(english.getByTestId('file-name-tail')).toHaveCount(0)
    const short = page.getByRole('tab').and(page.getByTitle(names[4], { exact: true }))
    await expect(short.getByTestId('file-name-ellipsis')).toHaveCount(0)
    const strip = page.getByTestId('preview-tab-strip')
    await english.click()
    await expect
      .poll(() =>
        strip.evaluate((el) => {
          const bounds = el.getBoundingClientRect()
          return Array.from(el.querySelectorAll('[role="presentation"]')).every((tab) => {
            const rect = tab.getBoundingClientRect()
            return rect.left >= bounds.left && rect.right <= bounds.right
          })
        })
      )
      .toBe(true)
    await expect(page.locator('[data-office-preview-state="ready"]')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`${round}-markdown.png`) })
    const chrome = await page.getByTestId('preview-panel-top-bar').boundingBox()
    if (chrome) {
      await page.screenshot({
        path: testInfo.outputPath(`${round}-filename-detail.png`),
        clip: { x: chrome.x, y: chrome.y, width: chrome.width, height: 120 }
      })
    }
  }
  await verify('published')
  page = await app.restart()
  await openRecentSession(page, prompt)
  await verify('restarted')
})
