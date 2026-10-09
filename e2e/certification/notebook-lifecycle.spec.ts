import { expect } from '@playwright/test'
import { access, mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
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

const sendReviewedPrompt = async (
  page: Parameters<typeof sendPrompt>[0],
  prompt: string,
  reply: string,
  commands: string[],
  timeout: number
): Promise<void> => {
  await Promise.all([
    sendPrompt(page, prompt, reply, timeout),
    (async () => {
      const review = page.getByRole('group', {
        name: 'Permission request: Review potentially destructive code',
        exact: true
      })
      let previousCode: string | undefined
      for (const command of commands) {
        await expect(review).toContainText(command)
        const code = review.getByTestId('tool-code-block')
        if (previousCode) await expect(code).not.toHaveText(previousCode)
        previousCode = await code.innerText()
        await review.getByRole('button', { name: 'Allow once', exact: true }).click()
      }
    })()
  ])
}

test('executes Windows REPL cells and recovers Shell after an interpreter exit', async ({
  app
}) => {
  test.skip(process.platform !== 'win32', 'Exercises the Windows REPL and PowerShell launch paths.')
  test.setTimeout(180_000)
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await createProject(page, 'Windows REPL lifecycle')
  await sendPrompt(
    page,
    'Verify Windows REPL lifecycle.',
    'Windows REPL lifecycle verified:',
    120_000
  )
})

test('installs global npm tools through the app and reuses them across Sessions and restart', async ({
  app
}) => {
  test.setTimeout(240_000)
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  await createProject(page, 'Npm installation')
  await sendReviewedPrompt(
    page,
    'Verify application npm global install.',
    'Application npm install verified',
    ['node -e "eval(Buffer.from('],
    90_000
  )
  await page.getByRole('button', { name: 'All projects', exact: true }).click()
  await createProject(page, 'Npm shared tools')
  await sendReviewedPrompt(
    page,
    'Verify application npm shared tool and local install.',
    'Application npm local verified',
    ['node -e "eval(Buffer.from(', 'node -e "eval(Buffer.from('],
    90_000
  )
  await captureLifecycleEvidence(page, 'npm-across-sessions.png')
  page = await app.restart()
  await openRecentSession(page, 'Verify application npm shared tool and local install.')
  await sendPrompt(
    page,
    'Verify application npm tool after restart.',
    'Application npm restart verified',
    90_000
  )
  await captureLifecycleEvidence(page, 'npm-after-app-restart.png')
  const parent = await app.createTestDirectory('npm-migration')
  const staged = await page.evaluate(async (parent) => {
    const bridge = globalThis as unknown as {
      api: {
        storage: {
          migrate: (parent: string) => Promise<{ ok: boolean; error?: string }>
          inspectDataRoot: (
            parent: string
          ) => Promise<{ kind: string; dataRoot: string; recoveryStatus?: string }>
        }
      }
    }
    const moved = await bridge.api.storage.migrate(parent)
    if (!moved.ok) throw new Error(moved.error)
    return bridge.api.storage.inspectDataRoot(parent)
  }, parent)
  expect(staged).toMatchObject({ kind: 'recover', recoveryStatus: 'verified' })
  const packageRoot = join(
    staged.dataRoot,
    'runtime',
    'npm',
    `${process.platform}-${process.arch}`,
    ...(process.platform === 'win32' ? [] : ['lib']),
    'node_modules',
    'os-npm-app-fixture'
  )
  expect(JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).name).toBe(
    'os-npm-app-fixture'
  )
  const discarded = await page.evaluate(async (parent) => {
    const bridge = globalThis as unknown as {
      api: {
        storage: {
          discardMigratedCopy: (parent: string) => Promise<unknown>
        }
      }
    }
    return bridge.api.storage.discardMigratedCopy(parent)
  }, parent)
  expect(discarded).toEqual({ ok: true })
  await expect(access(staged.dataRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  await sendPrompt(
    page,
    'Verify application npm tool after restart.',
    'Application npm restart verified',
    90_000
  )
})

test('runs and shuts down a Notebook session through its packaged MCP boundary', async ({
  app
}) => {
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  await createProject(page, 'Notebook lifecycle evidence')
  await sendReviewedPrompt(
    page,
    'Verify the notebook lifecycle.',
    'Notebook lifecycle verified for',
    ['node -e "setTimeout(() => console.log(\'notebook-lifecycle-e2e\'), 0)"'],
    30_000
  )

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
    100_000
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
