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
  const composer = page.getByRole('textbox', { name: 'Ask anything' })
  const box = await composer.boundingBox()
  expect(box).not.toBeNull()
  const point = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
  const droppedArchive = join(dirname(archive), 'dropped.science')
  await writeFile(droppedArchive, 'Invalid archive for retry regression')
  const data = { items: [], files: [droppedArchive], dragOperationsMask: 1 }
  await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', ...point, data })
  await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', ...point, data })
  await expect(page.getByRole('status').filter({ hasText: 'Drop a .science file' })).toContainText(
    'Research exchange'
  )
  await page.screenshot({ path: testInfo.outputPath('project-package-drop.png') })
  await cdp.send('Input.dispatchDragEvent', { type: 'drop', ...point, data })
  await cdp.detach()
  await expect(page.getByText('Drop files', { exact: true })).toHaveCount(0)
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
