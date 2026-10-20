import { expect } from '@playwright/test'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { runWithCleanup, test } from '../fixtures/electron-app'
import { createProject, openRecentSession, sendPrompt } from './helpers'

const enabled = process.env.OPEN_SCIENCE_WINDOWS_APPCONTAINER_CERT === '1'
test.skip(!enabled, 'Enabled by the Windows packaged certification job.')

const entriesOrMissing = async (path: string): Promise<string[]> => {
  try {
    return await readdir(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

test('certifies a packaged Windows AppContainer REPL lifecycle', async ({ app }, testInfo) => {
  // Hosted runners pay 30-130s per AppContainer launch (antivirus-scanned ACL grants), and the
  // certification runs the full lifecycle twice (before/after app restart).
  test.setTimeout(1_500_000)
  expect(process.platform, 'Certification requires Windows x64.').toBe('win32')
  expect(process.arch).toBe('x64')
  expect(
    process.env.OPEN_SCIENCE_E2E_EXECUTABLE,
    'Use the installed packaged executable.'
  ).toBeTruthy()
  const brand = await app.captureBrandState()
  expect(brand.packaged).toBe(true)
  expect(
    [...brand.profile].some((character) => character.charCodeAt(0) > 127),
    'Exercise non-ASCII profile and configuration paths.'
  ).toBe(true)
  const storageRoot = join(dirname(brand.profile), 'storage')
  const sandboxRoot = join(storageRoot, 'notebook-sandbox')
  const prompt = 'Verify Windows REPL lifecycle.'
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  let workflowVerified = false
  const requireVerifiedWorkflow = async (): Promise<void> => {
    if (!workflowVerified) {
      throw new Error('Protected workflow is unverified; retain its profile and recovery records.')
    }
  }
  app.addCleanupAudit(requireVerifiedWorkflow)

  await runWithCleanup(
    async () => {
      await test.step('install protection and prepare the production runtimes', async () => {
        const status = await page.evaluate(async () => window.api.settings.installNotebookNetwork())
        expect(status).toMatchObject({ kind: 'ready' })
      })
      await createProject(page, 'AppContainer REPL 程序 한글')

      const assertClean = async (): Promise<void> => {
        await expect
          .poll(async () => entriesOrMissing(join(storageRoot, 'notebook-command-temp')))
          .toEqual([])
        const installations = await entriesOrMissing(sandboxRoot)
        expect(installations, 'Protection must own a durable installation receipt.').toHaveLength(1)
        const root = join(sandboxRoot, installations[0])
        expect(JSON.parse(await readFile(join(root, 'receipt.json'), 'utf8'))).toMatchObject({
          state: 'owned'
        })
        // Native rollback traverses both runtime trees after the workload has been reaped.
        // Allow slower Windows disks to finish it before requiring an empty durable lease set.
        await expect
          .poll(async () => entriesOrMissing(join(root, 'acl-leases')), { timeout: 90_000 })
          .toEqual([])
        await expect
          .poll(async () => {
            try {
              const state = JSON.parse(await readFile(join(root, 'acl-state.json'), 'utf8'))
              return { leases: state.leases, snapshots: state.snapshots }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
              throw error
            }
          })
          .toBeNull()
        expect(
          await page.evaluate(() => window.api.settings.getNotebookNetworkStatus())
        ).toMatchObject({
          kind: 'ready'
        })
      }

      for (const phase of ['before-app-restart', 'after-app-restart']) {
        await test.step(phase, async () => {
          await sendPrompt(page, prompt, 'Windows REPL lifecycle verified:', 300_000)
          await assertClean()
          await testInfo.attach(phase, { body: await page.screenshot(), contentType: 'image/png' })
        })
        if (phase === 'before-app-restart') {
          page = await app.restart()
          await openRecentSession(page, prompt)
        }
      }
      workflowVerified = true
    },
    async () => {
      await requireVerifiedWorkflow()
      // Remove only the isolated fixture's owned installation through the production workflow.
      await test.step('remove test protection', async () => {
        const status = await app.page.evaluate(() => window.api.settings.removeNotebookNetwork())
        expect(status).toMatchObject({ kind: 'setupRequired' })
      })
    }
  )
})
