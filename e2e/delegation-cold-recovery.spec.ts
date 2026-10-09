import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'

const PROMPT = 'Run delegated cold recovery regression.'

test('continues a child after force quit without rewriting persisted state', async ({
  app
}, testInfo) => {
  test.skip(process.platform !== 'darwin', 'Exercises the macOS cold process scan.')
  test.setTimeout(180_000)
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill('Delegation cold recovery')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  const controls = page.getByTestId('composer-controls-trigger')
  if (!(await controls.getAttribute('aria-label'))?.includes('Delegation On')) {
    await controls.click()
    await page.getByRole('menuitem', { name: 'Delegation', exact: true }).click()
    await page.keyboard.press('Escape')
  }
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(PROMPT)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('Cold recovery ready for exit.', { exact: false })).toBeVisible()
  const { interrupted, dataRoot } = await page.evaluate(async (prompt) => {
    const interrupted = (await window.api.sessions.loadAll()).sessions.find((s) =>
      s.messages.some((m) => m.role === 'user' && m.content === prompt)
    )
    if (!interrupted) throw new Error('Missing interrupted session')
    return { interrupted, dataRoot: (await window.api.storage.getInfo()).dataRoot }
  }, PROMPT)
  const receiptRoot = join(
    dataRoot,
    'delegation-process-ownership',
    interrupted.projectId,
    interrupted.id
  )
  await expect
    .poll(
      async () =>
        (await readdir(receiptRoot).catch(() => [])).filter((f) => f.endsWith('.json')).length
    )
    .toBe(1)
  const filename = (await readdir(receiptRoot)).find((f) => f.endsWith('.json'))!
  // The owner writes a launch intent before the real child identity is captured.
  // Wait for that identity so the crash exercises recovery of a spawned process.
  await expect
    .poll(async () => {
      const receipt = JSON.parse(await readFile(join(receiptRoot, filename), 'utf8'))
      return receipt.ownership?.leader?.birthToken
    })
    .toMatch(/^darwin-proc-uniqueid:/)
  const originalAttempt = interrupted.runtimeContext!.delegatedWork!.records[0].attempts[0].id

  // Keep the real persisted session and receipt untouched. Terminate the isolated app while
  // its child is running, then exercise recovery from exactly what survived on disk.
  page = await app.restartAfterCrash({ force: true })
  await page
    .getByRole('region', { name: 'Recent sessions' })
    .getByRole('button', { name: PROMPT })
    .click()
  await page.getByRole('button', { name: 'Resume session', exact: true }).click()
  const result = page.getByText('Cold recovery resumed:', { exact: false })
  await expect(result).toBeVisible({ timeout: 90_000 })
  await expect(result).toContainText('continued')
  await expect(result).toContainText('cancelled')
  await expect
    .poll(async () => {
      try {
        await readFile(join(receiptRoot, filename))
        return true
      } catch {
        return false
      }
    })
    .toBe(false)
  const attempts = await page.evaluate(
    async (id) =>
      (await window.api.sessions.loadAll()).sessions.find((s) => s.id === id)?.runtimeContext
        ?.delegatedWork?.records[0].attempts,
    interrupted.id
  )
  expect(attempts).toHaveLength(2)
  expect(attempts![0]).toMatchObject({ id: originalAttempt, status: 'cancelled' })
  expect(attempts![1].id).not.toBe(originalAttempt)
  await testInfo.attach('restored-attempts', {
    body: JSON.stringify(attempts),
    contentType: 'application/json'
  })
  await page.screenshot({ path: testInfo.outputPath('resumed.png'), fullPage: true })
})
