import { expect } from '@playwright/test'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { test } from './fixtures/electron-app'
import { createProject, openProjectSession } from './certification/helpers'
import { NotebookRunRepository, getNotebookDataRoot } from '../src/main/notebook/repository'
import { createRootNotebookLane } from '../src/main/notebook/lane-identity'
import type { PersistedChatSession } from '../src/shared/session-persistence'
import { createProjectDbClient } from '../src/main/projects/prisma-client'

test.use({ windowMode: 'normal' })

test('asks before importing Notebook files and previews Chinese Word and Markdown bodies', async ({
  app
}, testInfo) => {
  test.skip(
    Boolean(process.env.OPEN_SCIENCE_E2E_EXECUTABLE),
    'The native shell probe is installed by the source Electron fixture preload.'
  )
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  const projectName = 'Notebook local report links'
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
  const markdownName = '测试报告.md'
  const wordPath = join(directory, wordName)
  const markdownPath = join(directory, markdownName)
  await copyFile(resolve('test/fixtures/docx-report.docx'), wordPath)
  await writeFile(markdownPath, '预览测试成功\n', 'utf8')
  const session: PersistedChatSession = {
    id: sessionId,
    projectId,
    title: 'Unregistered Chinese report files',
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
        content: `[${wordName}](<${wordPath}>)\n\n[打开报告](${pathToFileURL(markdownPath).href})`,
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
  await expect(links).toHaveCount(2)
  const client = createProjectDbClient(dirname(dataRoot))
  const native = await app.observeNativeFileReveal()
  const uploadCount = (): Promise<number> => client.uploadFile.count({ where: { projectId } })
  const dialog = page.getByRole('dialog', { name: 'Import file for preview', exact: true })
  try {
    expect(await uploadCount()).toBe(0)
    await links.filter({ hasText: wordName }).click()
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(
      'This link points to a file in this conversation. Importing saves a copy in the project.'
    )
    await expect(
      dialog.getByRole('button', { name: 'Import and preview', exact: true })
    ).toBeEnabled()
    await expect(page.getByRole('dialog', { name: 'Open external link?' })).toHaveCount(0)
    expect(await uploadCount()).toBe(0)
    await page.screenshot({ path: testInfo.outputPath('file-import-choice.png') })
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toBeHidden()
    expect(await uploadCount()).toBe(0)
    await expect(page.locator('iframe[data-office-preview-frame]')).toHaveCount(0)

    await links.filter({ hasText: wordName }).click()
    // Real localFs IPC and backend validation run; the probe records only the terminal OS call.
    await dialog.getByRole('button', { name: 'Show in folder', exact: true }).click()
    await expect.poll(() => native.evaluate((probe) => probe.revealed)).toEqual([wordPath])
    expect(await native.evaluate((probe) => probe.opened)).toEqual([])
    expect(await uploadCount()).toBe(0)
    await expect(dialog).toBeHidden()
    await links.filter({ hasText: wordName }).click()
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Import and preview', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect.poll(uploadCount).toBe(1)
    const office = page.frameLocator('iframe[data-office-preview-frame]')
    // Assert real rendered document text, rather than only a ready host or successful import.
    await expect(office.locator('section.docx').first()).toBeVisible({ timeout: 90_000 })
    await expect(office.getByText('神经信号研究报告', { exact: true })).toBeVisible()
    await expect(
      office.getByText('本样例覆盖中文、长文本、表格、标题和列表的组合排版。', { exact: true })
    ).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('chinese-word-body.png') })

    await links.filter({ hasText: '打开报告' }).click()
    await expect(dialog).toBeVisible()
    expect(await uploadCount()).toBe(1)
    await dialog.getByRole('button', { name: 'Import and preview', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect.poll(uploadCount).toBe(2)
    await expect(page.getByRole('dialog', { name: 'Open external link?' })).toHaveCount(0)
    await expect(page.getByText('预览测试成功', { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('chinese-markdown-body.png') })
  } finally {
    await native.dispose()
    await client.$disconnect()
  }
})
