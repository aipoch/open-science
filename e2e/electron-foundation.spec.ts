import { readFile } from 'node:fs/promises'
import { expect } from '@playwright/test'
import type { Page } from 'playwright'
import { test } from './fixtures/electron-app'

const PROJECT_NAME = 'Electron E2E project'

test('localizes CSL validation failures across the desktop bridge', async ({ app }, testInfo) => {
  const page = await app.completeOnboarding()
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.evaluate(() => window.api.locale.setPreference({ preference: 'zh-Hans' }))
  await expect(page.getByRole('heading', { name: '引文样式', exact: true })).toBeVisible()

  const style = (info: string, citation = '<text variable="title"/>'): string =>
    `<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0"><info>${info}</info><citation><layout>${citation}</layout></citation><bibliography><layout><text variable="title"/></layout></bibliography></style>`
  const info = '<title>Original title</title><id>https://example.test/style</id>'
  for (const [content, message] of [
    ['<', '所选文件不是有效的 CSL XML。'],
    [style('<id>https://example.test/style</id>'), 'CSL 样式必须包含标题和 ID。'],
    [style('<title>Original title</title>'), 'CSL 样式必须包含标题和 ID。'],
    [
      style(`${info}<link rel="independent-parent" href="https://example.test/parent"/>`),
      '暂不支持依赖型 CSL 样式。请导入独立样式。'
    ],
    [style(info, '<text macro="author-原名"/>'), 'CSL 样式引用了未定义的宏：author-原名']
  ]) {
    await page.locator('input[type="file"][accept=".csl,application/xml,text/xml"]').setInputFiles({
      name: 'invalid.csl',
      mimeType: 'application/xml',
      buffer: Buffer.from(content)
    })
    await expect(page.locator('button').filter({ hasText: /^导入 CSL$/ })).toBeEnabled()
    await expect(page.getByRole('alert')).toHaveText(message)
  }
  await page.screenshot({ path: testInfo.outputPath('csl-validation-zh-Hans.png') })
  await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
  await expect(page.getByRole('alert')).toHaveText(
    'The CSL style references an undefined macro: author-原名'
  )
})

const createProject = async (page: Page, name: string): Promise<void> => {
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByLabel('Description').fill('Created through the real Electron IPC boundary.')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()
}

const openProjectActions = async (page: Page, name: string): Promise<void> => {
  const projects = page.getByRole('region', { name: 'Projects' })
  await projects.getByRole('button', { name, exact: true }).hover()
  await projects.getByRole('button', { name: `Open actions for ${name}` }).click()
}

test('creates a project through the desktop stack and reloads it after relaunch', async ({
  app
}) => {
  await expect(
    app.page.getByRole('heading', { name: 'Set up your research workspace.' })
  ).toBeVisible()

  // Seed only the external-provider-dependent prerequisite. The journey remains visible UI backed
  // by the production preload bridge, main process, and project database.
  let page = await app.completeOnboarding()

  await createProject(page, PROJECT_NAME)
  await expect(page.getByRole('button', { name: 'All projects' })).toBeVisible()

  page = await app.restart()
  const mainLog = await app.captureMainLog('startup-diagnostics.log')
  expect(await readFile(mainLog, 'utf8')).toContain('"operation":"application-startup"')

  const projects = page.getByRole('region', { name: 'Projects' })
  await expect(projects.getByRole('button', { name: PROJECT_NAME, exact: true })).toBeVisible()
})

test('renames a project through the home actions and keeps the change after relaunch', async ({
  app
}) => {
  const renamedProject = 'Renamed Electron project'
  let page = await app.completeOnboarding()
  await createProject(page, PROJECT_NAME)

  await page.getByRole('button', { name: 'All projects' }).click()
  await openProjectActions(page, PROJECT_NAME)
  await page.getByRole('menuitem', { name: 'Settings' }).click()

  const dialog = page.getByRole('dialog', { name: 'Project Settings' })
  await dialog.getByLabel('Name').fill(renamedProject)
  await dialog.getByRole('button', { name: 'Save' }).click()

  const projects = page.getByRole('region', { name: 'Projects' })
  await expect(projects.getByRole('button', { name: renamedProject, exact: true })).toBeVisible()
  await expect(projects.getByRole('button', { name: PROJECT_NAME, exact: true })).toHaveCount(0)

  page = await app.restart()
  await expect(
    page
      .getByRole('region', { name: 'Projects' })
      .getByRole('button', { name: renamedProject, exact: true })
  ).toBeVisible()
})

test('deletes a project through confirmation and keeps it absent after relaunch', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  await createProject(page, PROJECT_NAME)

  await page.getByRole('button', { name: 'All projects' }).click()
  await openProjectActions(page, PROJECT_NAME)
  await page.getByRole('menuitem', { name: 'Delete' }).click()

  const dialog = page.getByRole('alertdialog', { name: 'Delete project?' })
  await expect(dialog).toContainText(`This will permanently delete "${PROJECT_NAME}"`)
  await dialog.getByRole('button', { name: 'Delete' }).click()

  const projects = page.getByRole('region', { name: 'Projects' })
  await expect(projects.getByRole('button', { name: PROJECT_NAME, exact: true })).toHaveCount(0)
  await expect(projects).toContainText('No projects yet. Create one to get started.')

  page = await app.restart()
  await expect(
    page
      .getByRole('region', { name: 'Projects' })
      .getByRole('button', { name: PROJECT_NAME, exact: true })
  ).toHaveCount(0)
})
