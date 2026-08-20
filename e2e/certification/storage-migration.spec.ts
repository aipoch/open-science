import { expect } from '@playwright/test'
import { test } from '../fixtures/electron-app'
import { createProject, openRecentSession, sendPrompt } from './helpers'

test('stages a verified data-root move and recovers on discard', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Storage migration evidence')
  await sendPrompt(page, 'Persist the migration fixture.', 'Deterministic reply:')

  const parent = await app.createTestDirectory('migration-target')
  const result = await page.evaluate(async (targetParent) => {
    const bridge = globalThis as unknown as {
      api: {
        storage: {
          discardMigratedCopy: (path: string) => Promise<void>
          inspectDataRoot: (
            path: string
          ) => Promise<{ kind: string; recoveryStatus?: 'copying' | 'verified' }>
          migrate: (path: string) => Promise<{ ok: boolean; error?: string }>
        }
      }
    }
    const migration = await bridge.api.storage.migrate(targetParent)
    const staged = await bridge.api.storage.inspectDataRoot(targetParent)
    await bridge.api.storage.discardMigratedCopy(targetParent)
    const discarded = await bridge.api.storage.inspectDataRoot(targetParent)
    return { migration, staged, discarded }
  }, parent)

  expect(result.migration).toEqual({ ok: true })
  expect(result.staged).toMatchObject({ kind: 'recover', recoveryStatus: 'verified' })
  expect(result.discarded.kind).toBe('move')

  page = await app.restart()
  await openRecentSession(page, 'Persist the migration fixture.')
})
