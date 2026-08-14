import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'

test('keeps the E2E window hidden across relaunch', async ({ app }) => {
  await expect.poll(() => app.mainWindowState()).toEqual({ minimized: false, visible: false })

  await app.restart()

  await expect.poll(() => app.mainWindowState()).toEqual({ minimized: false, visible: false })
})
