import { expect } from '@playwright/test'
import type { Page } from 'playwright'

const createProject = async (page: Page, name: string): Promise<string> => {
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()

  return page.evaluate(async (projectName) => {
    const bridge = globalThis as unknown as {
      api: { projects: { list: () => Promise<Array<{ id: string; name: string }>> } }
    }
    const project = (await bridge.api.projects.list()).find((item) => item.name === projectName)
    if (!project) throw new Error(`Project was not persisted: ${projectName}`)
    return project.id
  }, name)
}

const sendPrompt = async (page: Page, prompt: string, reply: string): Promise<void> => {
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(prompt)
  await page.getByRole('button', { name: 'Send message' }).click()
  const expectedReply = page.getByText(reply, { exact: false })
  const fixtureFailure = page.getByText(/^E2E fixture failure:/)
  await expect(expectedReply.or(fixtureFailure)).toBeVisible({ timeout: 30_000 })
  if (await fixtureFailure.isVisible()) throw new Error(await fixtureFailure.innerText())
}

export { createProject, sendPrompt }
