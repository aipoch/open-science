import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { _electron as electron } from 'playwright'
import { expect, test } from '@playwright/test'

// Playwright requires a destructured fixture argument even without requested fixtures.
// eslint-disable-next-line no-empty-pattern
test('preserves settings failure categories through IPC and the isolated preload', async ({}) => {
  const root = await mkdtemp(join(tmpdir(), 'settings-error-transport-'))
  try {
    await Promise.all(
      [
        ['e2e/fixtures/settings-error-transport.ts', 'main.cjs'],
        ['src/preload/index.ts', 'preload.cjs']
      ].map(([source, output]) =>
        build({
          entryPoints: [resolve(source)],
          outfile: join(root, output),
          bundle: true,
          platform: 'node',
          format: 'cjs',
          external: ['electron'],
          logLevel: 'silent'
        })
      )
    )
    const application = await electron.launch({
      args: [`--user-data-dir=${join(root, 'profile')}`, join(root, 'main.cjs')]
    })
    try {
      const page = await application.firstWindow()
      await page.waitForFunction(() => Boolean(window.api?.settings))
      const outcomes = []
      for (const fault of ['storage', 'invalid', 'credential']) {
        await application.evaluate((_electron, fault) => {
          process.env.SETTINGS_TRANSPORT_FAULT = fault
        }, fault)
        outcomes.push(
          await page.evaluate(async () => {
            try {
              await window.api.settings.getSettings()
              return { unexpectedSuccess: true }
            } catch (error) {
              const failure = error as { code?: string; message?: string }
              return { code: failure.code, message: failure.message }
            }
          })
        )
      }
      expect(outcomes).toEqual(
        ['settings-storage-unavailable', 'settings-invalid', 'settings-credential-unavailable'].map(
          (code) => ({ code, message: 'Settings read failed.' })
        )
      )
      await application.evaluate(() => {
        delete process.env.SETTINGS_TRANSPORT_FAULT
      })
      expect(await page.evaluate(() => window.api.settings.getSettings())).toEqual({
        providers: [],
        revision: 7
      })
    } finally {
      await application.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
