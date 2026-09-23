import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'

// Real Electron + Radix. No renderer-store injection: the permission wait is produced by the
// deterministic agent through the production protocol.
test('offers Side chat while idle and hides its new-chat entry while main awaits permission', async ({
  app
}, testInfo) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await page.setViewportSize({ width: 1400, height: 1000 })
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill('Side chat admission regression')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  const mainComposer = page.getByRole('textbox', { name: 'Ask anything' })
  await mainComposer.fill('Summarize the deterministic fixture.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(
    page.getByText('Deterministic reply: Summarize the deterministic fixture.', { exact: true })
  ).toBeVisible()
  const idleSendMenu = page.getByTestId('branch-send-menu-trigger')
  await expect(idleSendMenu).toBeVisible({ timeout: 60_000 })
  await idleSendMenu.click()
  const sideChatItem = page.getByTestId('menu-side-chat')
  await expect(sideChatItem).toHaveText('New side chat')
  await expect(page.getByTestId('menu-send-side-chat')).toHaveCount(0)
  await sideChatItem.hover()
  await expect(page.getByRole('tooltip')).toContainText(
    'Opens an empty Side chat; keeps your draft.'
  )
  const row = await sideChatItem.boundingBox()
  const icon = await sideChatItem.locator('svg').boundingBox()
  expect(row).not.toBeNull()
  expect(icon).not.toBeNull()
  expect(Math.abs(icon!.y + icon!.height / 2 - (row!.y + row!.height / 2))).toBeLessThan(2)
  await page.screenshot({ path: testInfo.outputPath('side-chat-menu-tooltip.png') })
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await mainComposer.fill('Request fixture permission. allow')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByTestId('permission-composer')).toBeVisible()
  await expect(mainComposer).toBeHidden()
  await expect(page.getByTestId('blocked-composer-side-chat')).toHaveCount(0)
  await expect(page.getByTestId('blocking-composer-overlay')).not.toContainText('New side chat')
  await page.screenshot({ path: testInfo.outputPath('side-chat-main-permission.png') })
})

test('keeps Side chat across renderer reload but discards it on application restart', async ({
  app
}) => {
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  await page.setViewportSize({ width: 1400, height: 1000 })
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill('Ephemeral side chat regression')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await page
    .getByRole('textbox', { name: 'Ask anything' })
    .fill('Summarize the deterministic fixture.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const mainReply = 'Deterministic reply: Summarize the deterministic fixture.'
  await expect(page.getByText(mainReply, { exact: true })).toBeVisible()
  await page.getByTestId('branch-send-menu-trigger').click()
  await page.getByTestId('menu-side-chat').click()
  await page.getByPlaceholder('Follow up…').fill('Discuss alternatives without approving main.')
  await page.getByRole('button', { name: 'Send Side chat follow up', exact: true }).click()
  const sideReply = 'Deterministic reply: Discuss alternatives without approving main.'
  await expect(page.getByText(sideReply, { exact: false })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: 'Ephemeral side chat regression', exact: true }).click()
  await expect(page.getByText(sideReply, { exact: false })).toBeVisible()
  page = await app.restart()
  await page.getByRole('button', { name: 'Ephemeral side chat regression', exact: true }).click()
  await expect(page.getByText(mainReply, { exact: true })).toBeVisible()
  await expect(page.getByPlaceholder('Follow up…')).toHaveCount(0)
  await expect(page.getByText(sideReply, { exact: false })).toHaveCount(0)
  expect(await page.evaluate(() => window.api.sideChat.list())).toMatchObject({ chats: [] })
})
