import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'
import { createProject, sendPrompt } from './certification/helpers'

// Native iframe context-menu events need a presented Electron window on macOS.
test.use({ windowMode: 'normal' })

test('persists Hidden across relaunch and revokes ordinary Electron reads', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  const projectId = await createProject(page, 'Temporary Hidden artifacts')
  await sendPrompt(
    page,
    'Create preview context menu artifacts.',
    'Preview context menu artifacts created',
    90_000
  )
  const file = await page.evaluate(async (projectId) => {
    const page = await window.api.projectFiles.listFiles({
      projectId,
      collection: { kind: 'all' },
      limit: 20
    })
    const file = page.items.find((file) => file.name === 'context-menu.html')
    if (!file) throw new Error('Fixture artifact missing')
    return file
  }, projectId)
  const lease = await page.evaluate(
    async (file) =>
      window.api.previewResources.acquire({
        source: 'artifact',
        projectId: file.projectId,
        fileId: file.sourceFileId,
        versionId: file.sourceVersionId
      }),
    file
  )
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  const fileCard = page.getByRole('button', {
    name: 'Preview generated file context-menu.html',
    exact: true
  })
  await fileCard.hover()
  await expect(
    page.getByRole('button', { name: 'Hide context-menu.html', exact: true })
  ).toHaveCount(0)
  await page
    .getByRole('button', {
      name: 'Open context-menu.html in split view beside the session',
      exact: true
    })
    .click()
  await page
    .getByTestId('preview-card')
    .frameLocator('iframe[title="Preview of context-menu.html"]')
    .getByText('Managed frame content.', { exact: true })
    .click({ button: 'right' })
  await expect(
    page.getByTestId('preview-content-context-menu').getByRole('menuitem', {
      name: 'Hide file',
      exact: true
    })
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'File actions for context-menu.html' }).click()
  await page.getByRole('menuitem', { name: 'Hide file', exact: true }).click()
  await expect(fileCard).toHaveCount(0)
  expect(
    await page.evaluate(
      async ({ file, lease }) => {
        const ordinary = await window.api.projectFiles.listFiles({
          projectId: file.projectId,
          collection: { kind: 'all' },
          limit: 20
        })
        const denied = await window.api.previewResources
          .readRange({ resourceId: lease.id, begin: 0, end: 1 })
          .then(
            () => false,
            () => true
          )
        await window.api.previewResources.release({ resourceId: lease.id })
        return {
          denied,
          listed: ordinary.items.some((item) => item.sourceFileId === file.sourceFileId)
        }
      },
      { file, lease }
    )
  ).toEqual({ denied: true, listed: false })
  page = await app.restart()
  expect(
    await page.evaluate(async (file) => {
      const hidden = await window.api.projectFiles.listFiles({
        projectId: file.projectId,
        collection: { kind: 'hidden' },
        limit: 20
      })
      const preview = await window.api.projectFiles.readHiddenArtifact({
        projectId: file.projectId,
        fileId: file.sourceFileId,
        versionId: file.sourceVersionId
      })
      return {
        listed: hidden.items.some((item) => item.sourceFileId === file.sourceFileId),
        content: preview.content
      }
    }, file)
  ).toMatchObject({ listed: true, content: expect.stringContaining('HTML context menu fixture') })
  await page.evaluate(
    async (file) =>
      window.api.projectFiles.setArtifactHidden({
        projectId: file.projectId,
        fileId: file.sourceFileId,
        hidden: false
      }),
    file
  )
  expect(
    await page.evaluate(async (file) => {
      const resource = await window.api.previewResources.acquire({
        source: 'artifact',
        projectId: file.projectId,
        fileId: file.sourceFileId,
        versionId: file.sourceVersionId
      })
      await window.api.previewResources.release({ resourceId: resource.id })
      return resource.size
    }, file)
  ).toBeGreaterThan(0)
})
