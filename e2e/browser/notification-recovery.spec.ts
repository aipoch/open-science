import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'

test('keyboard reaches a read pending approval beside a broken row without retrying approval', async ({
  page
}) => {
  await page.setViewportSize({ width: 700, height: 500 })
  await page.goto('/notification-recovery.html')
  const bell = page.getByRole('button', { name: 'Messages, 1 unread' })
  await bell.focus()
  await page.keyboard.press('Enter')
  const center = page.getByRole('dialog', { name: 'Message center' })
  await expect(center.getByRole('alert')).toContainText('This message could not be displayed.')
  await center.getByRole('button', { name: 'Retry' }).press('Enter')
  await expect(center.getByRole('button', { name: 'Retry' })).toBeEnabled()
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { notificationQuality: { responses: number; repair: () => void } })
          .notificationQuality.responses
    )
  ).toBe(0)
  await page.evaluate(() =>
    (
      window as unknown as { notificationQuality: { responses: number; repair: () => void } }
    ).notificationQuality.repair()
  )
  await center.getByRole('button', { name: 'Retry' }).press('Enter')
  await expect(center.getByRole('alert')).toHaveCount(0)
  await center.getByRole('button', { name: /Approval needed.*Needs approval/ }).press('Enter')
  const approval = page.getByRole('dialog', { name: 'Allow external request?' })
  await expect(approval).toBeVisible()
  await approval.getByRole('button', { name: 'Show full arguments' }).press('Enter')
  await expect(approval).toContainText('/long/path/')
  await approval.getByRole('button', { name: 'Global', exact: true }).click()
  const confirmation = page.getByRole('alertdialog')
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { notificationQuality: { responses: number } }).notificationQuality
          .responses
    )
  ).toBe(0)
  const deny = approval.getByRole('button', { name: 'Deny', exact: true })
  await deny.scrollIntoViewIfNeeded()
  const rect = await deny.boundingBox()
  expect(rect!.y).toBeGreaterThanOrEqual(0)
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(500)
  expect(await approval.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await deny.press('Enter')
  await expect(approval).toHaveCount(0)
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { notificationQuality: { responses: number; repair: () => void } })
          .notificationQuality.responses
    )
  ).toBe(1)
})

for (const locale of ['de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh-Hans', 'zh-Hant']) {
  test(`${locale} recovery entry fits a narrow viewport and exposes named controls`, async ({
    page
  }) => {
    await page.setViewportSize({ width: 360, height: 400 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto(`/notification-recovery.html?locale=${locale}`)
    const catalog = JSON.parse(
      readFileSync(`src/shared/i18n/locales/${locale}.json`, 'utf8')
    ).renderer
    await page.getByRole('button', { name: catalog['Messages unavailable'] }).press('Enter')
    const dialog = page.getByRole('dialog', { name: catalog['Message center'] })
    await expect(dialog.getByRole('alert')).toContainText(
      catalog['Messages could not be displayed.']
    )
    const retry = dialog.getByRole('button', { name: catalog.Retry })
    await expect(retry).toBeVisible()
    await retry.focus()
    await expect(retry).toBeFocused()
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: catalog['Messages unavailable'] })).toBeFocused()
  })
}

test('exposes notification errors and named recovery controls to the accessibility tree', async ({
  page
}) => {
  await page.setViewportSize({ width: 700, height: 500 })
  await page.goto('/notification-recovery.html')
  await page.addScriptTag({ path: 'node_modules/axe-core/axe.min.js' })
  await page.getByRole('button', { name: 'Messages, 1 unread' }).click()
  const results = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: typeof import('axe-core') }).axe
    return axe.run(document.querySelector('[role="dialog"]')!, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] }
    })
  })
  expect(
    results.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) }))
  ).toEqual([])
})
