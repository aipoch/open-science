import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'

// Real Electron + Radix + independent side-chat runtime. No renderer-store injection:
// the permission wait is produced by the deterministic agent through the production protocol.
test('opens and sends an independent Side chat while main is waiting for permission', async ({
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
  await page.getByTestId('branch-send-menu-trigger').click()
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
  const open = page.getByTestId('blocked-composer-side-chat')
  await expect(open).toBeVisible()
  await expect(open).toBeEnabled()
  await open.click()
  const followUp = page.getByPlaceholder('Follow up…')
  await expect(followUp).toBeVisible()
  await followUp.fill('Discuss alternatives without approving main.')
  await page.getByRole('button', { name: 'Send Side chat follow up', exact: true }).click()
  await expect(
    page.getByText('Deterministic reply: Discuss alternatives without approving main.', {
      exact: false
    })
  ).toBeVisible()
  // Side chat must not answer, approve, cancel or otherwise consume the main permission request.
  await expect(page.getByTestId('permission-composer')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('side-chat-main-permission.png') })
})
