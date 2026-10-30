import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'
import { homeNewProjectButton } from './fixtures/project'

// Keep the UI, command transport, database and restricted runner real. Only the external model
// executable is replaced by the common deterministic ACP fixture.
test('optimizes drafts without sending and persists project-specific templates', async ({
  app
}, testInfo) => {
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  const pythonPath = process.env.OPEN_SCIENCE_TASK_PYTHON
  if (pythonPath) {
    await page.evaluate(async (path) => {
      await window.api.runtime.registerInterpreter('python', path)
      const { python } = await window.api.runtime.listEnvironments()
      const runtime = python.find((entry) => entry.envId === path || entry.interpreterPath === path)
      if (!runtime) throw new Error('The task interpreter was not registered.')
      await window.api.runtime.setEnvironmentEnabled('python', runtime.envId, true)
    }, pythonPath)
  }
  await homeNewProjectButton(page).click()
  let dialog = page.getByRole('dialog', { name: 'New project', exact: true })
  await dialog.getByLabel('Name', { exact: true }).fill('Prompt optimization')
  await dialog
    .getByLabel('Optimization prompt', { exact: true })
    .fill('Preserve the scientific intent and use concise language.')
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click()
  const original = 'Summarize the deterministic fixture.'
  const improved = `Deterministic reply: ${original}`
  let editor = page.getByRole('textbox', { name: 'Ask anything' })
  let optimize = page.getByRole('button', { name: 'Optimize question', exact: true })
  await expect(optimize).toBeDisabled()
  await editor.fill(original)
  await optimize.click()
  await expect(editor).toHaveText(improved)
  expect(
    await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions)
  ).toHaveLength(0)
  await editor.fill(`${improved} Keep the evidence.`)
  await page.getByRole('button', { name: 'Undo optimization', exact: true }).click()
  await expect(editor).toHaveText(original)
  await optimize.click()
  await expect(editor).toHaveText(improved)
  await page.screenshot({ path: testInfo.outputPath('optimized-draft.png') })
  await page.setViewportSize({ width: 430, height: 900 })
  await expect(optimize).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeInViewport({
    ratio: 1
  })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  )
  await page.screenshot({ path: testInfo.outputPath('optimized-draft-narrow.png') })
  await page.setViewportSize({ width: 1280, height: 928 })
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(editor).toHaveText('')
  await expect(page.getByRole('button', { name: 'Undo optimization', exact: true })).toHaveCount(0)
  await expect(page.getByText('Response completed.', { exact: true })).toBeVisible()

  // A model response which drops a protected span must leave the draft untouched.
  await editor.fill('Explain `print(1)`')
  await optimize.click()
  await expect(
    page.getByText('Could not optimize your question. Your draft was kept. Please try again.')
  ).toBeVisible()
  await expect(editor).toHaveText('Explain `print(1)`')

  await page.locator('button[title="Prompt optimization"]').click()
  await page.getByRole('menuitem', { name: 'Project settings', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Project Settings', exact: true })
  await expect(dialog.getByLabel('Optimization prompt', { exact: true })).toHaveValue(
    'Preserve the scientific intent and use concise language.'
  )
  await dialog
    .getByLabel('Optimization prompt', { exact: true })
    .fill('Prefer structured research tasks.')
  await page.screenshot({ path: testInfo.outputPath('project-optimization-settings.png') })
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  page = await app.restart()
  await page.getByRole('button', { name: 'Prompt optimization', exact: true }).click()
  await page.locator('button[title="Prompt optimization"]').click()
  await page.getByRole('menuitem', { name: 'Project settings', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Project Settings', exact: true })
  await expect(dialog.getByLabel('Optimization prompt', { exact: true })).toHaveValue(
    'Prefer structured research tasks.'
  )
  await dialog.getByRole('button', { name: 'Restore default', exact: true }).click()
  await expect(dialog.getByLabel('Optimization prompt', { exact: true })).toHaveValue('')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  expect(
    await page.evaluate(
      async () =>
        (await window.api.projects.list()).find((project) => project.name === 'Prompt optimization')
          ?.optimizationPrompt ?? ''
    )
  ).toBe('')

  // Plan-first submission must invalidate undo state just like the primary Send action.
  editor = page.getByRole('textbox', { name: 'Ask anything' })
  optimize = page.getByRole('button', { name: 'Optimize question', exact: true })
  await editor.fill(original)
  await optimize.click()
  await expect(editor).toHaveText(improved)
  await page.getByRole('button', { name: 'More send options', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Plan first', exact: true }).click()
  await expect(editor).toHaveText('')
  await expect(page.getByRole('button', { name: 'Undo optimization', exact: true })).toHaveCount(0)
})
