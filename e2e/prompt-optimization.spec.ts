import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'
import { homeNewProjectButton } from './fixtures/project'

test.use({ windowMode: 'normal' })

const DEFAULT_OPTIMIZATION_PROMPT =
  "Rewrite the user's input into a clear, specific, and actionable prompt while preserving its original intent and important details."

// Keep the UI, command transport, database and restricted runner real. Only the external model
// executable is replaced by the common deterministic ACP fixture.
test('optimizes drafts without sending and persists project-specific templates', async ({
  app
}, testInfo) => {
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
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
  await dialog.getByText('Advanced agent options', { exact: true }).click()
  await dialog
    .getByLabel('Optimization prompt', { exact: true })
    .fill('Preserve the scientific intent and use concise language.')
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click()
  const original = 'Summarize the deterministic fixture.'
  const improved = `Deterministic reply: ${original}`
  let editor = page.getByRole('textbox', { name: 'Ask anything' })
  let optimize = page.getByRole('button', { name: 'Optimize question', exact: true })
  await expect(optimize).toBeDisabled()
  await expect(optimize).toBeVisible()
  await editor.fill('Prompt optimization cancellation fixture.')
  await optimize.click()
  const cancel = page.getByRole('button', { name: 'Cancel optimization', exact: true })
  await expect(cancel).toBeEnabled()
  await editor.hover()
  await cancel.hover()
  await expect(page.getByRole('tooltip')).toHaveText('Cancel optimization')
  await page.screenshot({ path: testInfo.outputPath('optimization-cancellable.png') })
  await cancel.click()
  await expect(editor).toHaveText('Prompt optimization cancellation fixture.')
  await expect(optimize).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Undo optimization', exact: true })).toHaveCount(0)
  await editor.fill(original)
  await optimize.click()
  await expect(editor).toHaveText(improved)
  expect(
    await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions)
  ).toHaveLength(0)
  const undo = page.getByRole('button', { name: 'Undo optimization', exact: true })
  await undo.hover()
  await expect(page.getByRole('tooltip')).toHaveText('Undo optimization')
  await editor.fill(`${improved} Prompt optimization cancellation fixture.`)
  await page.getByRole('button', { name: 'Optimize question', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Cancel optimization', exact: true })).toBeEnabled()
  await cancel.click()
  await expect(page.getByRole('button', { name: 'Optimize question', exact: true })).toBeEnabled()
  await expect(undo).toHaveCount(0)
  await expect(editor).toHaveText(`${improved} Prompt optimization cancellation fixture.`)
  const editedDraft = `${improved} Keep the evidence.`
  await editor.fill(editedDraft)
  await optimize.click()
  await expect(editor).toHaveText(`Deterministic reply: ${editedDraft}`)
  await page.getByRole('button', { name: 'Undo optimization', exact: true }).click()
  await expect(editor).toHaveText(editedDraft)
  await expect(optimize).toBeFocused()
  await expect(optimize).toBeVisible()
  await optimize.click()
  await expect(editor).toContainText('Deterministic reply:')
  await page.screenshot({ path: testInfo.outputPath('optimized-draft.png') })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.setViewportSize({ width: 430, height: 900 })
  await expect(page.getByRole('button', { name: 'Undo optimization', exact: true })).toBeVisible()
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

  // Exercise real paste staging and deletion; removing the attachment invalidates the undo snapshot.
  const longText = 'Measured value: 42.\n'.repeat(600)
  const prefix = 'Optimize pasted text regression: '
  await editor.fill(prefix)
  await editor.press('End')
  await editor.evaluate((element, text) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', text)
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true })
    )
  }, longText)
  const pastedAttachment = page.locator('[data-pasted-text-attachment="true"]')
  await expect(pastedAttachment).toHaveCount(1)
  await expect(pastedAttachment.getByRole('button', { name: /^Remove attachment/ })).toBeVisible()
  await optimize.click()
  await expect(editor).toContainText('Improved pasted text:')
  await pastedAttachment.getByRole('button', { name: /^Remove attachment/ }).click()
  await expect(pastedAttachment).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Undo optimization', exact: true })).toHaveCount(0)
  await expect(optimize).toBeEnabled()

  // A model response which drops a protected span must leave the draft untouched.
  await editor.fill('Explain `print(1)`')
  await optimize.click()
  await expect(
    page.getByText('Could not optimize your question. Your draft was kept. Please try again.', {
      exact: true
    })
  ).toBeVisible()
  await expect(editor).toHaveText('Explain `print(1)`')

  await page.locator('button[title="Prompt optimization"]').click()
  await page.getByRole('menuitem', { name: 'Project settings', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Project Settings', exact: true })
  await dialog.getByText('Advanced agent options', { exact: true }).click()
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
  await dialog.getByText('Advanced agent options', { exact: true }).click()
  await expect(dialog.getByLabel('Optimization prompt', { exact: true })).toHaveValue(
    'Prefer structured research tasks.'
  )
  await dialog.getByLabel('Optimization prompt', { exact: true }).fill('')
  await expect(dialog.getByLabel('Optimization prompt', { exact: true })).toHaveValue('')
  await expect(dialog.getByLabel('Optimization prompt', { exact: true })).toHaveAttribute(
    'placeholder',
    DEFAULT_OPTIMIZATION_PROMPT
  )
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
