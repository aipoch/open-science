import { expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from '../fixtures/electron-app'
import { createProject, openRecentSession, sendPrompt } from './helpers'

const captureLifecycleEvidence = async (
  page: Parameters<typeof sendPrompt>[0],
  name: string
): Promise<void> => {
  const evidenceRoot = resolve('.scratch', 'notebook-lifecycle-e2e', 'evidence')
  await mkdir(evidenceRoot, { recursive: true })
  await page.screenshot({ path: resolve(evidenceRoot, name), fullPage: true })
}

const controlledWindowsFixtureAvailable =
  process.platform === 'win32' && Boolean(process.env.OPEN_SCIENCE_E2E_MICROMAMBA_EVENTS)

test('runs and shuts down a Notebook session through its packaged MCP boundary', async ({
  app
}) => {
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  await createProject(page, 'Notebook lifecycle evidence')
  await sendPrompt(page, 'Verify the notebook lifecycle.', 'Notebook lifecycle verified for')

  page = await app.restart()
  await openRecentSession(page, 'Verify the notebook lifecycle.')
  await expect(page.getByText('Notebook lifecycle verified for', { exact: false })).toBeVisible()
})

test('cancels a timed-out environment mutation before allowing a retry', async ({ app }) => {
  test.setTimeout(180_000)
  test.skip(
    !controlledWindowsFixtureAvailable,
    'Requires the controlled Windows micromamba process fixture.'
  )
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await createProject(page, 'Notebook mutation cancellation')
  await sendPrompt(
    page,
    'Verify Notebook mutation cancellation.',
    'Notebook mutation cancellation verified;',
    75_000
  )
  await captureLifecycleEvidence(page, 'cancellation-transcript.png')
})

test('keeps a healthy environment mutation alive beyond the client idle timeout', async ({
  app
}) => {
  test.setTimeout(180_000)
  test.skip(
    !controlledWindowsFixtureAvailable,
    'Requires the controlled Windows micromamba process fixture.'
  )
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await createProject(page, 'Long Notebook mutation')
  await sendPrompt(
    page,
    'Verify a long Notebook mutation.',
    'Long Notebook mutation verified after',
    100_000
  )
  await captureLifecycleEvidence(page, 'long-mutation-transcript.png')
})

test('creates and executes in a real Micromamba Python environment', async ({ app }) => {
  test.setTimeout(900_000)
  test.skip(
    process.platform !== 'win32' || !process.env.OPEN_SCIENCE_E2E_REAL_MICROMAMBA,
    'Requires the opt-in real Windows Micromamba installation check.'
  )
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await createProject(page, 'Real Notebook environment')
  try {
    await sendPrompt(
      page,
      'Verify a real Notebook environment.',
      'Real Notebook environment verified after',
      780_000
    )
  } finally {
    await app.captureMainLog('real-environment-main.log')
  }
  await captureLifecycleEvidence(page, 'real-environment-transcript.png')
})

test('cancels a timed-out package mutation before allowing a retry', async ({ app }) => {
  test.setTimeout(180_000)
  test.skip(
    !controlledWindowsFixtureAvailable,
    'Requires the controlled Windows micromamba process fixture.'
  )
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await createProject(page, 'Notebook package cancellation')
  await sendPrompt(
    page,
    'Verify Notebook package cancellation.',
    'Notebook package cancellation verified;',
    75_000
  )
  await captureLifecycleEvidence(page, 'package-cancellation-transcript.png')
})
