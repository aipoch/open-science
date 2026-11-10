import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'
import { openSettingsPage, setTheme } from './fixtures/settings-preferences'

test.use({ windowMode: 'normal' })

for (const theme of ['Light', 'Dark'] as const) {
  test(`shows live Notebook access summaries and navigation in ${theme} windows`, async ({
    app
  }, testInfo) => {
    await app.completeOnboarding()
    const page = await app.configureFakeAgent()
    await setTheme(page, theme)
    const settings = await openSettingsPage(page, 'Network')
    const entry = settings.getByRole('region', { name: 'Notebook network access', exact: true })
    const manage = entry.getByRole('button', { name: 'Manage access', exact: true })
    await expect(entry.getByText('Relaxed mode', { exact: true })).toBeVisible()
    await expect(entry.getByText('0 saved addresses', { exact: true })).toBeVisible()
    await expect(entry.locator('li')).toHaveCount(3)
    await expect(entry.getByRole('button')).toHaveCount(1)
    await expect(entry.getByRole('radio')).toHaveCount(0)
    await manage.hover()
    await manage.focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    await expect(manage).toBeFocused()
    expect(await manage.evaluate((el) => el.matches(':focus-visible'))).toBe(true)
    await manage.press('Enter')
    await expect(entry).toHaveCount(0)
    await settings.getByRole('button', { name: 'Add address', exact: true }).click()
    await settings.getByLabel('Hostname', { exact: true }).fill('localhost')
    await settings.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(settings.locator('form')).toHaveCount(0)
    await settings.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(entry.getByText('1 saved address', { exact: true })).toBeVisible()

    for (const mode of ['Relaxed', 'Strict'] as const) {
      if (mode === 'Strict') {
        await manage.click()
        await settings.getByRole('radio', { name: 'Strict', exact: true }).click()
        await settings.getByRole('button', { name: 'Switch to Strict mode', exact: true }).click()
        await expect(settings.getByText('Current: Strict', { exact: true })).toBeVisible()
        await settings.getByRole('button', { name: 'Back', exact: true }).click()
        const config = (await page.evaluate(() => window.api.settings.getSettings()))
          .notebookNetwork
        const ruleCount = config.strictWhitelist?.length ?? 0
        const groupCount = config.strictWhitelistGroups?.length ?? 0
        await expect(entry).toContainText(`${ruleCount} ${ruleCount === 1 ? 'rule' : 'rules'}`)
        await expect(entry).toContainText(`${groupCount} ${groupCount === 1 ? 'group' : 'groups'}`)
        await expect(entry).not.toContainText('saved address')
      }
      await expect(entry.getByText(`${mode} mode`, { exact: true })).toBeVisible()
      for (const width of [1024, 640]) {
        await page.setViewportSize({ width, height: 874 })
        await entry.scrollIntoViewIfNeeded()
        // Wait for the shared responsive navigation drawer to finish moving off-canvas.
        if (width < 768) {
          await expect
            .poll(async () => {
              const nav = await settings
                .getByRole('navigation', { name: 'Settings', exact: true, includeHidden: true })
                .boundingBox()
              return nav ? nav.x + nav.width : 0
            })
            .toBeLessThanOrEqual(1)
        }
        await expect(manage).toBeVisible()
        const layout = await entry.evaluate((el) => {
          const rows = [...el.querySelectorAll('li')]
          const clipped = [...el.querySelectorAll('li, p, button')]
            .filter((node) => node.scrollWidth > node.clientWidth + 1)
            .map((node) => node.textContent)
          const text = rows[2].querySelector('div')!.getBoundingClientRect()
          const action = rows[2].querySelector('button')!.getBoundingClientRect()
          return { clipped, noOverlap: action.x >= text.right - 1 || action.y >= text.bottom - 1 }
        })
        expect(layout.clipped).toEqual([])
        expect(layout.noOverlap).toBe(true)
        await entry.screenshot({
          animations: 'disabled',
          path: testInfo.outputPath(`${mode.toLowerCase()}-${width}.png`)
        })
      }
    }
    await settings.getByRole('button', { name: 'Close settings' }).click()
  })
}
