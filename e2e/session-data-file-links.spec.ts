import { expect } from '@playwright/test'
import { copyFile, mkdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { test } from './fixtures/electron-app'
import { createProject, openProjectSession } from './certification/helpers'
import { NotebookRunRepository, getNotebookDataRoot } from '../src/main/notebook/repository'
import { createRootNotebookLane } from '../src/main/notebook/lane-identity'
import type { PersistedChatSession } from '../src/shared/session-persistence'
import { createProjectDbClient } from '../src/main/projects/prisma-client'

test.use({ windowMode: 'normal' })

test('previews original Notebook documents and opens external files in the system', async ({
  app
}, testInfo) => {
  test.skip(
    Boolean(process.env.OPEN_SCIENCE_E2E_EXECUTABLE),
    'The native shell probe is installed by the source Electron fixture preload.'
  )
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  const projectName = 'Notebook reports'
  const projectId = await createProject(page, projectName)
  const sessionId = 'local-report-links'
  // Use the active data root: the isolated profile can relocate it independently of config storage.
  const { dataRoot } = await page.evaluate(() => window.api.storage.getStatus())
  const notebook = new NotebookRunRepository(dataRoot)
  await notebook.loadOrCreate({
    projectId,
    sessionId,
    workspaceCwd: '',
    lane: createRootNotebookLane(projectId, sessionId, `root-frame-${sessionId}`)
  })
  const directory = getNotebookDataRoot(dataRoot, projectId, sessionId)
  await mkdir(directory, { recursive: true })
  const wordName = '研究报告.docx'
  const markdownName = '分析摘要.md'
  const externalPath = testInfo.outputPath('采样记录.csv')
  await mkdir(dirname(externalPath), { recursive: true })
  await writeFile(externalPath, 'External document')
  const wordPath = join(directory, wordName)
  const markdownPath = join(directory, markdownName)
  await copyFile(resolve('test/fixtures/docx-report.docx'), wordPath)
  await writeFile(markdownPath, '预览测试成功\n', 'utf8')
  const session: PersistedChatSession = {
    id: sessionId,
    projectId,
    title: '查看分析结果',
    cwd: '',
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
    messages: [
      {
        id: 'report-answer',
        role: 'agent',
        // Exercise native drive/backslash paths on Windows and POSIX paths elsewhere. Angle
        // brackets preserve spaces in OS temp directories; the second link exercises file URIs.
        content: `本次分析的文件如下。\n\n- [${wordName}](<${wordPath}>)\n- [${markdownName}](${pathToFileURL(markdownPath).href})\n\n原始数据见[采样记录.csv](${pathToFileURL(externalPath).href})。`,
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 2
      }
    ]
  }
  const priorNativeProbe = process.env.OPEN_SCIENCE_E2E_NATIVE_FILE_REVEAL_PROBE
  process.env.OPEN_SCIENCE_E2E_NATIVE_FILE_REVEAL_PROBE = '1'
  try {
    page = await app.restartWithSessionFixture(session)
  } finally {
    if (priorNativeProbe === undefined) delete process.env.OPEN_SCIENCE_E2E_NATIVE_FILE_REVEAL_PROBE
    else process.env.OPEN_SCIENCE_E2E_NATIVE_FILE_REVEAL_PROBE = priorNativeProbe
  }
  await openProjectSession(page, projectName, session.title)
  const links = page.locator('[data-session-data-file-link]')
  await expect(links).toHaveCount(3)
  const client = createProjectDbClient(dirname(dataRoot))
  const native = await app.observeNativeFileReveal()
  const uploadCount = (): Promise<number> => client.uploadFile.count({ where: { projectId } })
  try {
    await links.filter({ hasText: '采样记录.csv' }).click()
    await expect.poll(() => native.evaluate((probe) => probe.opened)).toEqual([externalPath])
    await links
      .filter({ hasText: '采样记录.csv' })
      .locator('..')
      .getByRole('button', { name: 'Show in folder' })
      .click()
    await expect.poll(() => native.evaluate((probe) => probe.revealed)).toEqual([externalPath])
    await page.evaluate(() => window.api.locale.setPreference({ preference: 'zh-Hans' }))
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans')
    await page.screenshot({ path: testInfo.outputPath('01-links.png') })
    await links.filter({ hasText: wordName }).click()
    const office = page.frameLocator('iframe[data-office-preview-frame]')
    // Assert real rendered document text, rather than only a ready host or successful import.
    await expect(office.locator('section.docx').first()).toBeVisible({ timeout: 90_000 })
    await expect(office.getByText('神经信号研究报告', { exact: true })).toBeVisible()
    await expect(
      office.getByText('本样例覆盖中文、长文本、表格、标题和列表的组合排版。', { exact: true })
    ).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('02-preview.png') })

    await unlink(externalPath)
    const missing = links.filter({ hasText: '采样记录.csv' })
    const paragraph = missing.locator('xpath=ancestor::p[1]')
    const feedback = paragraph.getByRole('status')
    await missing.click()
    await expect(feedback).toHaveText('无法打开此文件。')
    await page.screenshot({ path: testInfo.outputPath('03-missing.png') })
    await expect(feedback).toBeEmpty({ timeout: 7000 })
    await paragraph.getByRole('button', { name: '在文件夹中显示' }).click()
    await expect(feedback).toHaveText('无法打开该文件夹。')
    await page.screenshot({ path: testInfo.outputPath('04-folder.png') })
    await writeFile(externalPath, 'Restored document')
    await missing.click()
    await expect(feedback).toBeEmpty({ timeout: 2000 })
    await links.filter({ hasText: markdownName }).click()
    await expect(page.getByRole('dialog', { name: 'Open external link?' })).toHaveCount(0)
    await expect(page.getByText('预览测试成功', { exact: true })).toBeVisible()
    expect(await uploadCount()).toBe(0)
  } finally {
    await native.dispose()
    await client.$disconnect()
  }
})
