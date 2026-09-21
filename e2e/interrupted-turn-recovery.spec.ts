import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'

const PROMPT = 'Stream the long scroll journey.'
const COMPLETED = 'Segment 3 paragraph 7.'

test('continues a restored in-flight snapshot through the real Resume action', async ({
  app
}, testInfo) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill('Interrupted turn recovery')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(PROMPT)
  await page.getByRole('button', { name: 'Send message' }).click()

  // Capture an actual Main-owned in-flight Session, then restore that snapshot through the
  // isolated fixture. This avoids child-first process-tree shutdown recording an ACP error.
  await expect(page.getByText('Segment 1 paragraph 0.', { exact: false })).toBeVisible()
  const interrupted = await page.evaluate(async (prompt) => {
    const session = (await window.api.sessions.loadAll()).sessions.find((session) =>
      session.messages.some((message) => message.role === 'user' && message.content === prompt)
    )
    if (!session) throw new Error('The in-flight Session was not persisted.')
    return session
  }, PROMPT)
  expect(interrupted.status).toBe('running')
  expect(interrupted.messages.some((message) => message.content.includes(COMPLETED))).toBe(false)
  // Let the finite fake stream finish before the graceful fixture shutdown.
  await expect(page.getByText(COMPLETED, { exact: false })).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.api.sessions.loadAll()).sessions[0]?.status)
    )
    .toBe('idle')
  page = await app.restartWithSessionFixture(interrupted)
  const restored = await page.evaluate(
    async () => (await window.api.sessions.loadAll()).sessions[0]
  )
  await testInfo.attach('restored-session', {
    body: JSON.stringify(restored),
    contentType: 'application/json'
  })
  expect(restored.resumeRecovery).toMatchObject({ kind: 'resume-required', cause: 'app-restart' })
  expect(restored.resumeRecovery?.promptMessageId).toBe(
    interrupted.messages.find((message) => message.role === 'user')?.id
  )
  await page
    .getByRole('region', { name: 'Recent sessions' })
    .getByRole('button', { name: PROMPT })
    .click()
  await page.getByRole('button', { name: 'Resume session', exact: true }).click()

  try {
    await expect(page.getByText(COMPLETED, { exact: false })).toBeVisible()
  } catch (error) {
    await testInfo.attach('failed-resume-session', {
      body: JSON.stringify(
        await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions[0])
      ),
      contentType: 'application/json'
    })
    throw error
  }
  await expect(page.getByText(/unknown or superseded/i)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Resume session', exact: true })).toHaveCount(0)
  await expect
    .poll(() =>
      page.evaluate(
        async ({ prompt, completed }) => {
          const session = (await window.api.sessions.loadAll()).sessions.find((session) =>
            session.messages.some(
              (message) => message.role === 'user' && message.content === prompt
            )
          )
          return {
            userMessages: session?.messages.filter(
              (message) => message.role === 'user' && message.content === prompt
            ).length,
            completed: session?.messages.some(
              (message) => message.role === 'agent' && message.content.includes(completed)
            )
          }
        },
        { prompt: PROMPT, completed: COMPLETED }
      )
    )
    .toEqual({ userMessages: 1, completed: true })
  expect(
    (await app.readFakeAgentPrompts()).filter(({ prompt }) => prompt.trimEnd().endsWith(PROMPT))
  ).toHaveLength(2)
})
