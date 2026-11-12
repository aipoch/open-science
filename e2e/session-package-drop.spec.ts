import { readFile, writeFile, unlink } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'
import { createProjectViaUi } from './fixtures/project'
import { submitPromptViaUi } from './fixtures/conversation'

test('drops native packages into Workspace and Home and restores a child discussion after restart', async ({
  app
}, testInfo) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  const archive = await app.configureSessionPackageDialogs()
  await createProjectViaUi(page, 'Research exchange')
  const prompt = 'Summarize the deterministic fixture.'
  await submitPromptViaUi(page, prompt)
  await expect(page.getByText(`Deterministic reply: ${prompt}`, { exact: true })).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.api.acp.getState()).promptInFlightSessionIds)
    )
    .toEqual([])
  await page.getByRole('button', { name: `Open actions for ${prompt}` }).click()
  await page.getByRole('menuitem', { name: 'Export', exact: true }).hover()
  await page.getByRole('menuitem', { name: 'Export Session package', exact: true }).click()
  const exporting = page.getByRole('dialog', { name: 'Export Session package', exact: true })
  await exporting.getByRole('button', { name: 'Choose save location…', exact: true }).click()
  await expect(exporting.getByRole('button', { name: 'Show in folder' })).toBeVisible()
  await exporting.getByRole('button', { name: 'Close', exact: true }).click()

  // CDP supplies a real native File, exercising Electron webUtils and the command boundary.
  const cdp = await page.context().newCDPSession(page)
  const header = page.getByTestId('conversation-header')
  const box = await header.boundingBox()
  expect(box).not.toBeNull()
  const point = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
  const droppedArchive = join(dirname(archive), 'dropped.science')
  await writeFile(droppedArchive, 'Invalid archive for retry regression')
  const data = { items: [], files: [droppedArchive], dragOperationsMask: 1 }
  await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', ...point, data })
  await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', ...point, data })
  await expect(
    page.getByText('Drop files to attach or import a .science package', { exact: true })
  ).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('project-package-drop.png') })
  await cdp.send('Input.dispatchDragEvent', { type: 'drop', ...point, data })
  await cdp.detach()
  await expect(
    page.getByText('Drop files to attach or import a .science package', { exact: true })
  ).toHaveCount(0)
  const importing = page.getByRole('dialog', { name: 'Import Session package', exact: true })
  await expect(importing.getByRole('button', { name: 'Try again', exact: true })).toBeVisible()
  await expect(
    importing.getByRole('button', { name: 'Choose another package', exact: true })
  ).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('package-retry-failed.png') })
  await unlink(droppedArchive)
  await importing.getByRole('button', { name: 'Try again', exact: true }).click()
  // The configured picker points to the valid original archive. Accidentally opening it
  // would show a confirmation instead of this missing-source error.
  await expect(importing.getByRole('alert')).toContainText('The original package is unavailable.')
  await page.screenshot({ path: testInfo.outputPath('package-retry-missing.png') })
  await writeFile(droppedArchive, await readFile(archive))
  await importing.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(importing.getByRole('button', { name: 'Import', exact: true })).toBeVisible()
  await expect(page.getByLabel('Destination project')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Remove attachment dropped.science' })).toHaveCount(
    0
  )
  await page.screenshot({ path: testInfo.outputPath('project-package-drop-confirm.png') })
  await importing.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(
    importing.getByRole('status').filter({ hasText: /^Session imported$/ })
  ).toBeVisible()
  await importing.getByRole('button', { name: 'Open imported Session', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Imported research history' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Research exchange', exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('project-package-drop-completed.png') })

  const importedGroup = page
    .getByRole('group')
    .filter({ has: page.getByText('Imported research', { exact: true }) })
  const firstImport = importedGroup.locator('[data-session-id]')
  await expect(firstImport).toHaveCount(1)
  const firstImportId = await firstImport.getAttribute('data-session-id')

  await page.getByRole('button', { name: 'All projects', exact: true }).click()
  const home = page.getByRole('main')
  const homeCdp = await page.context().newCDPSession(page)
  const homeData = { items: [], files: [archive], dragOperationsMask: 1 }
  const homeHint = page.getByText('Drop a .science file to import', { exact: true })
  // A short, scrolled Home must retain an overlay covering the entire visible drop target.
  await page.setViewportSize({ width: 1000, height: 320 })
  await home.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  const homeBox = await home.boundingBox()
  expect(homeBox).not.toBeNull()
  const homePoint = { x: homeBox!.x + homeBox!.width / 2, y: homeBox!.y + homeBox!.height / 2 }
  for (const cancel of [true, false]) {
    await homeCdp.send('Input.dispatchDragEvent', {
      type: 'dragEnter',
      ...homePoint,
      data: homeData
    })
    await homeCdp.send('Input.dispatchDragEvent', {
      type: 'dragOver',
      ...homePoint,
      data: homeData
    })
    await expect(homeHint).toBeVisible()
    const overlayBox = await homeHint.locator('..').locator('..').boundingBox()
    expect(overlayBox).toEqual(homeBox)
    await page.screenshot({ path: testInfo.outputPath('home-package-drop.png') })
    await homeCdp.send('Input.dispatchDragEvent', { type: 'drop', ...homePoint, data: homeData })
    await expect(homeHint).toHaveCount(0)
    await expect(
      importing.getByRole('radio', { name: 'Research exchange', exact: true })
    ).toBeVisible()
    await expect(importing.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled()
    await expect(importing.getByRole('button', { name: 'Import', exact: true })).toHaveCount(0)
    if (cancel) {
      await importing.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(
        importing.getByText('Package operation cancelled', { exact: true })
      ).toBeVisible()
      await importing.getByRole('button', { name: 'Close', exact: true }).click()
      await expect(home).toBeVisible()
    }
  }
  await homeCdp.detach()
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.screenshot({ path: testInfo.outputPath('home-package-project-selection.png') })
  await importing.getByRole('radio', { name: 'Research exchange', exact: true }).check()
  await importing.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(importing.getByRole('button', { name: 'Import', exact: true })).toBeVisible()
  await importing.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(
    importing.getByRole('status').filter({ hasText: /^Session imported$/ })
  ).toBeVisible()
  await importing.getByRole('button', { name: 'Open imported Session', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Imported research history' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('home-package-drop-completed.png') })

  // Both imports share the original title. Ask must attach to the selected local import.
  const selectedImport = importedGroup.locator(
    `[data-session-id]:not([data-session-id="${firstImportId}"])`
  )
  await expect(selectedImport).toBeVisible()
  const parentId = await selectedImport.getAttribute('data-session-id')
  await page
    .getByTestId('replay-panel')
    .getByRole('button', { name: 'Ask about this step' })
    .click()
  await expect(page.getByTestId('session-discussion-draft')).toContainText(prompt)
  const childSelector = `[data-parent-session-id="${parentId}"]`
  await expect(importedGroup.locator(childSelector)).toHaveCount(0)
  const question = 'What did the imported study find?'
  await submitPromptViaUi(page, question)
  await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toContainText(
    'Deterministic reply:'
  )
  const child = importedGroup.locator(childSelector)
  await expect(child).toBeVisible()
  const childId = await child.getAttribute('data-session-id')

  const restored = await app.restart()
  await restored
    .getByRole('region', { name: 'Projects', exact: true })
    .getByRole('button', { name: 'Research exchange', exact: true })
    .click()
  const restoredGroup = restored
    .getByRole('group')
    .filter({ has: restored.getByText('Imported research', { exact: true }) })
  await expect(restoredGroup.locator(`[data-session-id="${parentId}"]`)).toBeVisible()
  await restoredGroup
    .locator(`[data-session-id="${childId}"]${childSelector}`)
    .locator('[data-slot="session-open-button"]')
    .click()
  const conversation = restored.getByRole('region', { name: 'Conversation', exact: true })
  await expect(conversation).toContainText(question)
  await expect(restored.getByTestId('session-discussion-source')).toContainText(prompt)
  const sidebar = restored.getByRole('navigation', { name: 'Sessions', exact: true })
  const parentRow = sidebar.locator(`[data-session-id="${parentId}"]`)
  const childRow = sidebar.locator(`[data-session-id="${childId}"]`)
  const { projectId } = await restored.evaluate(async (id) => {
    const row = (await window.api.sessions.loadAll()).sessions.find((entry) => entry.id === id)!
    return { projectId: row.projectId }
  }, childId)
  await parentRow.getByRole('button', { name: `Open actions for ${prompt}` }).click()
  await restored.getByRole('menuitem', { name: 'Archive', exact: true }).click()
  await expect(childRow).toContainText(`Archived source: ${prompt}`)
  await expect(restored.getByTestId('session-discussion-source')).toContainText(
    `Archived source: ${prompt}`
  )
  await restored
    .getByTestId('session-discussion-source')
    .getByRole('button', { name: /View replay:/ })
    .click()
  await expect(restored.getByTestId('replay-panel')).toBeVisible()
  await restored.screenshot({ path: testInfo.outputPath('archived-parent-discussion.png') })
  const focus = await restored.evaluate(
    async (request) => {
      const session = await window.api.sessions.loadOne(request)
      const binding = session!.runtimeContext!.sessionContext!.bindings[0]
      const snapshot = await window.api.sessionReplay.getSelectionSnapshot({
        projectId: binding.projectId,
        id: binding.contextId
      })
      return { id: binding.contextId, snapshot, messages: session!.messages }
    },
    { projectId, sessionId: childId! }
  )
  expect(focus.snapshot).toBeTruthy()
  await restored.evaluate(
    async ({ projectId, sessionId }) => {
      const parent = await window.api.sessions.loadOne({ projectId, sessionId })
      await window.api.sessions.updateArchive({
        projectId,
        sessionId,
        archived: false,
        expectedRevision: parent!.revision!
      })
    },
    { projectId, sessionId: parentId! }
  )
  await expect(restoredGroup.locator(childSelector)).toBeVisible()
  await parentRow.getByRole('button', { name: `Open actions for ${prompt}` }).click()
  await restored.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  const deletion = restored.getByRole('alertdialog', { name: 'Delete Session?' })
  await expect(deletion).toContainText('1 child discussion will become an ordinary conversation.')
  await deletion.screenshot({ path: testInfo.outputPath('delete-parent-discussion.png') })
  await deletion.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(parentRow).toHaveCount(0)
  await expect(childRow).toBeVisible()
  await expect(restored.getByTestId('session-discussion-source')).toHaveCount(0)
  await expect(conversation.getByText('Source deleted', { exact: true })).toBeVisible()
  await expect(conversation.getByRole('button', { name: 'Show annotation source' })).toHaveCount(0)
  const reopened = await app.restart()
  await reopened
    .getByRole('region', { name: 'Projects', exact: true })
    .getByRole('button', { name: 'Research exchange', exact: true })
    .click()
  await reopened.locator(`[data-session-id="${childId}"] [data-slot="session-open-button"]`).click()
  const detached = await reopened.evaluate((request) => window.api.sessions.loadOne(request), {
    projectId,
    sessionId: childId!
  })
  expect(detached?.messages).toEqual(focus.messages)
  expect(
    await reopened.evaluate((request) => window.api.sessionReplay.getSelectionSnapshot(request), {
      projectId,
      id: focus.id
    })
  ).toEqual(focus.snapshot)
  expect(detached?.parentSessionId).toBeUndefined()
  expect(detached?.deletedDiscussionSourceId).toBe(parentId)
  expect(detached?.runtimeContext?.sessionContext).toBeUndefined()
  await expect(reopened.getByText('Source deleted', { exact: true })).toBeVisible()
  await reopened.screenshot({ path: testInfo.outputPath('detached-parent-discussion.png') })
  const replies = reopened
    .getByRole('region', { name: 'Conversation', exact: true })
    .getByText(`Deterministic reply: ${prompt}`, { exact: true })
  const previousReplies = await replies.count()
  await submitPromptViaUi(reopened, 'Continue as an ordinary conversation.')
  await expect(replies).toHaveCount(previousReplies + 1, { timeout: 90_000 })
  const followUp = (await app.readFakeAgentPrompts())
    .filter(
      (row) =>
        row.prompt.includes('Continue as an ordinary conversation.') &&
        !row.prompt.includes('Generate Session metadata')
    )
    .at(-1)
  expect(followUp?.prompt).toContain('Continue as an ordinary conversation.')
  expect(followUp?.prompt).not.toContain('Current discussion focus for this turn')
})

test('attaches native files across the conversation and excludes both sidebars', async ({
  app
}, testInfo) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await createProjectViaUi(page, 'Workspace file drop')
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await expect(page.getByTestId('files-view')).toBeVisible()
  await expect(page.locator('#right-panel')).toBeVisible()
  const file = testInfo.outputPath('drop-data.csv')
  await writeFile(file, 'name,value\nalpha,1\n')
  const cdp = await page.context().newCDPSession(page)
  const data = { items: [], files: [file], dragOperationsMask: 1 }
  const hint = page.getByText('Drop files to attach or import a .science package', { exact: true })
  const attachment = page.getByRole('button', {
    name: 'Remove attachment drop-data.csv',
    exact: true
  })
  const workspace = page.getByTestId('workspace-file-drop-zone')
  await expect(page.getByRole('button', { name: 'Choose a .science file' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('new-session-import-guide.png') })
  // Exercise real native File intake outside the composer, with both empty and populated history.
  for (const target of [workspace, page.getByTestId('conversation-header')]) {
    await app.setMainWindowZoomFactor(target === workspace ? 1 : 1.25)
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
    const box = await target.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.width).toBeGreaterThan(40)
    const point = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
    await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', ...point, data })
    await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', ...point, data })
    await expect(hint).toBeVisible()
    await page.screenshot({
      path: testInfo.outputPath(
        `file-drop-${await page.getByRole('heading', { name: 'New conversation' }).count()}.png`
      )
    })
    await cdp.send('Input.dispatchDragEvent', { type: 'drop', ...point, data })
    await expect(hint).toBeHidden()
    await expect(attachment).toHaveCount(1)
    await expect(attachment).toBeVisible()
    await expect(
      page.getByRole('dialog', { name: 'Import Session package', exact: true })
    ).toHaveCount(0)
    await attachment.click()
    await expect(attachment).toHaveCount(0)
    if (target === workspace) {
      await submitPromptViaUi(page, 'Check the workspace file drop.')
      await expect(page.getByText('Deterministic reply:', { exact: false })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0)
    }
  }
  // Both sidebars are outside the attachment and package-import target.
  const packageFile = testInfo.outputPath('excluded.science')
  await writeFile(packageFile, 'Excluded target must not begin package validation')
  for (const target of [
    page.getByRole('button', { name: 'Files', exact: true }),
    page.locator('#right-panel')
  ]) {
    const box = await target.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.width).toBeGreaterThan(40)
    const point = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
    for (const path of [file, packageFile]) {
      const excludedData = { ...data, files: [path] }
      await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', ...point, data: excludedData })
      await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', ...point, data: excludedData })
      await expect(hint).toBeHidden()
      await cdp.send('Input.dispatchDragEvent', { type: 'drop', ...point, data: excludedData })
      await expect(attachment).toHaveCount(0)
      await expect(
        page.getByRole('dialog', { name: 'Import Session package', exact: true })
      ).toHaveCount(0)
      await expect(workspace).toBeVisible()
    }
  }
  await cdp.detach()
})
