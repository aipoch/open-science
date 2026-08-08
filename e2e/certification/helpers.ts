import { expect } from '@playwright/test'
import type { Page } from 'playwright'

const createProject = async (page: Page, name: string): Promise<string> => {
  const existingProjectIds = await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: { projects: { list: () => Promise<Array<{ id: string }>> } }
    }
    return (await bridge.api.projects.list()).map((project) => project.id)
  })
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()

  let projectId: string | undefined
  await expect
    .poll(
      async () => {
        projectId = await page.evaluate(async (existingIds) => {
          const bridge = globalThis as unknown as {
            api: { projects: { list: () => Promise<Array<{ id: string }>> } }
          }
          return (await bridge.api.projects.list()).find(
            (project) => !existingIds.includes(project.id)
          )?.id
        }, existingProjectIds)
        return projectId
      },
      { timeout: 30_000 }
    )
    .toEqual(expect.any(String))
  return projectId!
}

const sendPrompt = async (
  page: Page,
  prompt: string,
  reply: string,
  timeout = 30_000
): Promise<void> => {
  const expectedReply = page.getByText(reply, { exact: false })
  const fixtureFailure = page.getByText(/^E2E fixture failure:/)
  const existingReplyCount = await expectedReply.count()
  const existingFailureCount = await fixtureFailure.count()
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(prompt)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(
    expectedReply.nth(existingReplyCount).or(fixtureFailure.nth(existingFailureCount))
  ).toBeVisible({ timeout })
  if ((await fixtureFailure.count()) > existingFailureCount) {
    throw new Error(await fixtureFailure.last().innerText())
  }
}

const openRecentSession = async (page: Page, prompt: string): Promise<void> => {
  const session = page
    .getByRole('region', { name: 'Recent sessions' })
    .getByRole('button', { name: prompt })
  await expect(session).toBeVisible({ timeout: 60_000 })
  await session.click()
}

export { createProject, openRecentSession, sendPrompt }
