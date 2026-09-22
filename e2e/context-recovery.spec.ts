import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'

const PROMPT = 'Exercise exhausted context recovery.'
const COMPLETED = 'Context recovery completed in the same conversation.'

test('recovers an exhausted context through Main and retains the committed binding after restart', async ({
  app
}, testInfo) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  let page = await app.configureFakeAgent({ contextWindow: 128_000 })
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill('Context recovery')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(PROMPT)
  await page.getByRole('button', { name: 'Send message' }).click()
  try {
    await expect(page.getByText(COMPLETED, { exact: false })).toBeVisible()
  } catch (error) {
    await testInfo.attach('recovery-sessions', {
      body: JSON.stringify(await page.evaluate(() => window.api.sessions.loadAll())),
      contentType: 'application/json'
    })
    throw error
  }
  const recovered = await page.evaluate(async (prompt) => {
    return (await window.api.sessions.loadAll()).sessions.find((session) =>
      session.messages.some((message) => message.role === 'user' && message.content === prompt)
    )
  }, PROMPT)
  expect(recovered).toBeDefined()
  expect(recovered?.runtimeContext?.contextRecovery).toMatchObject({
    phase: 'completed',
    compactAttempts: 0,
    replacementAttempts: 1
  })
  expect(
    recovered?.messages.filter((message) => message.role === 'user' && message.content === PROMPT)
  ).toHaveLength(1)
  expect(recovered?.providerSessionId).not.toBe(
    recovered?.runtimeContext?.contextRecovery?.oldProviderSessionId
  )
  expect(
    (await app.readFakeAgentPrompts()).filter(({ sessionId }) =>
      [
        recovered?.providerSessionId,
        recovered?.runtimeContext?.contextRecovery?.oldProviderSessionId
      ].includes(sessionId)
    )
  ).toHaveLength(2)
  await expect(page.getByText('Recovering session…', { exact: true })).toHaveCount(0)
  page = await app.restartWithSessionFixture(recovered!)
  const restored = await page.evaluate(
    async (id) =>
      (await window.api.sessions.loadAll()).sessions.find((session) => session.id === id),
    recovered!.id
  )
  expect(restored?.providerSessionId).toBe(recovered?.providerSessionId)
  expect(restored?.runtimeContext?.contextRecovery?.phase).toBe('completed')
})

test('manually recovers an existing completed conversation without dispatching until new input', async ({
  app
}) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  let page = await app.configureFakeAgent({ contextWindow: 128_000 })
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill('Manual context recovery')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(PROMPT)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText(COMPLETED, { exact: false })).toBeVisible()
  const completed = await page.evaluate(
    async (prompt) =>
      (await window.api.sessions.loadAll()).sessions.find((session) =>
        session.messages.some((message) => message.role === 'user' && message.content === prompt)
      ),
    PROMPT
  )
  expect(completed).toBeDefined()
  // Historical sessions can carry an overflow error even when the last saved turn is complete.
  // Preserve that turn and clear only the prior episode receipt to model an existing bad session.
  const broken = {
    ...completed!,
    status: 'error' as const,
    error: 'Session too large to compact - context exceeds model limit even after stripping media',
    activeRun: undefined,
    runtimeContext: completed!.runtimeContext
      ? { ...completed!.runtimeContext, contextRecovery: undefined }
      : undefined
  }
  page = await app.restartWithSessionFixture(broken)
  await page
    .getByRole('region', { name: 'Recent sessions' })
    .getByRole('button', { name: PROMPT })
    .click()
  await page.getByRole('button', { name: 'Recover session', exact: true }).click()
  await expect
    .poll(async () =>
      page.evaluate(
        async (id) =>
          (await window.api.sessions.loadAll()).sessions.find((session) => session.id === id)
            ?.runtimeContext?.contextRecovery?.phase,
        broken.id
      )
    )
    .toBe('ready')
  const ready = await page.evaluate(
    async (id) =>
      (await window.api.sessions.loadAll()).sessions.find((session) => session.id === id),
    broken.id
  )
  expect(
    (await app.readFakeAgentPrompts()).filter(
      ({ sessionId }) => sessionId === ready?.providerSessionId
    )
  ).toHaveLength(0)
  expect(ready?.id).toBe(completed?.id)
  expect(ready?.providerSessionId).not.toBe(broken.providerSessionId)
  expect(ready?.messages.filter(({ role }) => role === 'user')).toHaveLength(
    completed!.messages.filter(({ role }) => role === 'user').length
  )
  const nextInput = 'MANUAL_RECOVERY_NEXT_INPUT: report the retained result once.'
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(nextInput)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect
    .poll(async () =>
      page.evaluate(
        async (id) =>
          (await window.api.sessions.loadAll()).sessions.find((session) => session.id === id)
            ?.runtimeContext?.contextRecovery?.phase,
        broken.id
      )
    )
    .toBe('completed')
  const newPrompts = (await app.readFakeAgentPrompts()).filter(
    ({ sessionId }) => sessionId === ready?.providerSessionId
  )
  expect(newPrompts).toHaveLength(1)
  expect(newPrompts[0].prompt).toContain(
    'Resume the existing task from the following persisted historical evidence.'
  )
  expect(newPrompts[0].prompt.split(nextInput)).toHaveLength(2)
  expect(newPrompts[0].prompt.length).toBeLessThan(48_000)
})
