import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'

test.use({ windowMode: 'normal' })
test('keeps a native webpage visible and updating below menus, including submenus and zoom', async ({
  app
}, testInfo) => {
  const page = await app.completeOnboarding()
  await app.setMainWindowZoomFactor(1.25)
  await app.createLiveMenuBackground()
  await page.evaluate(() => {
    const icon =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path d="M3 8l3 3 7-7" fill="none" stroke="black" stroke-width="2"/></svg>'
    window.api.window.openActionMenu!({
      id: 'native-live',
      pointer: { x: 400, y: 180 },
      dark: false,
      compact: false,
      focusFirst: true,
      entries: [
        {
          kind: 'action',
          action: 'disabled',
          label: 'Disabled action',
          icon,
          disabled: true,
          danger: false
        },
        {
          kind: 'action',
          action: 'copy',
          label: 'Copy live value',
          icon,
          disabled: false,
          danger: false
        },
        {
          kind: 'action',
          action: 'nested',
          label: 'Nested action',
          icon,
          disabled: false,
          danger: false,
          submenu: { label: 'Nested actions', icon, group: 0 }
        }
      ]
    })
  })
  await expect.poll(() => app.readNativeMenuLayers().then((s) => s.menuVisible)).toBe(true)
  const overlay = page
    .context()
    .pages()
    .find((p) => p.url().includes('/action-menu-overlay.html'))!
  await expect(overlay.getByTestId('native-action-menu')).toBeVisible()
  const before = await app.readNativeMenuLayers()
  expect(before.pageVisible).toBe(true)
  expect(before.menuOnTop).toBe(true)
  await expect
    .poll(() => app.readNativeMenuLayers().then((s) => s.ticks), { intervals: [20, 40, 80] })
    .toBeGreaterThan(before.ticks + 2)
  await expect(overlay.getByText('Copy live value', { exact: true })).toBeFocused()
  await overlay.keyboard.press('ArrowDown')
  await overlay.keyboard.press('ArrowRight')
  await expect(overlay.getByText('Nested action', { exact: true })).toBeVisible()
  await overlay.screenshot({ path: testInfo.outputPath('native-action-menu.png') })
  await overlay.keyboard.press('Escape')
  await expect.poll(() => app.readNativeMenuLayers().then((s) => s.menuVisible)).toBe(false)
  const after = await app.readNativeMenuLayers()
  expect(after.pageVisible).toBe(true)
  // Browser pages never receive the privileged application or overlay preload.
  const remote = page
    .context()
    .pages()
    .find((p) => p.url().startsWith('data:text/html'))!
  expect(
    await remote.evaluate(() => ({
      api: typeof window.api,
      overlay: typeof (window as unknown as { actionMenu?: unknown }).actionMenu,
      node: typeof (window as unknown as { require?: unknown }).require
    }))
  ).toEqual({ api: 'undefined', overlay: 'undefined', node: 'undefined' })
})
