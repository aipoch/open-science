import { readFile, writeFile, unlink } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'

test('drops a native package into the current Project without adding an attachment', async ({
  app
}, testInfo) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  const archive = await app.configureSessionPackageDialogs()
  await page.getByRole('button', { name: 'New project', exact: true }).click()
  const project = page.getByRole('dialog', { name: 'New project' })
  await project.getByLabel('Name').fill('Research exchange')
  await project.getByRole('button', { name: 'Create project' }).click()
  const prompt = 'Summarize the deterministic fixture.'
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(prompt)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText(`Deterministic reply: ${prompt}`, { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0)
  await page.getByRole('button', { name: `Open actions for ${prompt}` }).click()
  await page.getByRole('menuitem', { name: 'Export', exact: true }).hover()
  await page.getByRole('menuitem', { name: 'Export Session package', exact: true }).click()
  const exporting = page.getByRole('dialog', { name: 'Export Session package', exact: true })
  await exporting.getByRole('button', { name: 'Export', exact: true }).click()
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
  await expect(importing.getByText('Package operation completed', { exact: true })).toBeVisible()
  await importing.getByRole('button', { name: 'Open imported Session', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Imported research history' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Research exchange', exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('project-package-drop-completed.png') })
})

test('attaches native files across the conversation and excludes both sidebars', async ({
  app
}, testInfo) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await page.getByRole('button', { name: 'New project', exact: true }).click()
  const project = page.getByRole('dialog', { name: 'New project' })
  await project.getByLabel('Name').fill('Workspace file drop')
  await project.getByRole('button', { name: 'Create project' }).click()
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
      await page
        .getByRole('textbox', { name: 'Ask anything' })
        .fill('Check the workspace file drop.')
      await page.getByRole('button', { name: 'Send message' }).click()
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
