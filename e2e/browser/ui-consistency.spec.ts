import { expect, test } from '@playwright/test'

for (const dark of [false, true]) {
  test(`production Reviewer, Office and search surfaces resolve ${dark ? 'dark' : 'light'} colors`, async ({
    page
  }) => {
    await page.goto(`/ui-consistency.html${dark ? '?dark' : ''}`)
    const toolbar = page.locator('.docx-review-toolbar')
    await expect(toolbar).toBeVisible()
    const officeBackground = await toolbar.evaluate(
      (node) => getComputedStyle(node).backgroundColor
    )
    const backgroundChannels = officeBackground.match(/[\d.]+/g)!.map(Number)
    expect(
      backgroundChannels.slice(0, 3).every((channel) => (dark ? channel < 70 : channel > 220))
    ).toBe(true)
    const failure = page.getByText('Recorded review failure')
    const foreground = await failure.evaluate((node) => getComputedStyle(node).color)
    expect(foreground).not.toBe(
      await page.getByTestId('reviewer').evaluate((node) => getComputedStyle(node).color)
    )
    await page.getByRole('tab', { name: 'Recent files' }).click()
    const file = page.locator('.search-recent-file')
    await expect(file).toBeVisible()
    const rest = await file.evaluate((node) => getComputedStyle(node).backgroundColor)
    await file.hover()
    await expect
      .poll(() => file.evaluate((node) => getComputedStyle(node).backgroundColor))
      .not.toBe(rest)
    await expect(page.locator('.docx-wrapper')).toContainText('Office preview theme verification')
  })
}

test('preview menu returns focus without reopening a pointer tooltip, retaining keyboard hints', async ({
  page
}) => {
  await page.goto('/ui-consistency.html')
  const trigger = page.getByRole('button', { name: 'More actions', exact: true })
  const outside = (await page
    .getByRole('heading', { name: 'UI consistency verification' })
    .boundingBox())!
  await trigger.hover()
  await expect(page.getByRole('tooltip')).toHaveText('More actions')
  await trigger.click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeFocused()
  // Radix defers outside-pointer setup until the task after focus moves into the menu.
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
  await page.mouse.click(outside.x + 20, outside.y + 10)
  await expect(page.getByRole('menu')).toBeHidden()
  await expect(trigger).toBeFocused()
  await page.waitForTimeout(400)
  await expect(page.getByRole('tooltip')).toBeHidden()
  await page.getByRole('button', { name: 'Outside action' }).click()
  await page.keyboard.press('Shift+Tab')
  await expect(trigger).toBeFocused()
  await expect(page.getByRole('tooltip')).toHaveText('More actions')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
})

test('PDF annotation tags and replay/journal popover close controls retain their actions', async ({
  page
}) => {
  await page.goto('/ui-consistency.html?interactions')
  await page.getByTestId('pdf-notes').getByRole('button', { name: 'Add tag', exact: true }).click()
  await expect(page.getByPlaceholder('Search Tags…')).toBeVisible()
  await page.getByRole('option', { name: 'Important' }).click()
  await page.keyboard.press('Escape')
  await expect(
    page
      .getByTestId('pdf-notes')
      .getByRole('button', { name: 'Remove Important from this annotation' })
  ).toBeVisible()
  const browse = page
    .getByTestId('replay')
    .getByRole('button', { name: 'Browse steps', exact: true })
  await browse.click()
  await page.getByRole('button', { name: 'Close step list' }).click()
  await expect(page.getByRole('button', { name: 'Close step list' })).toBeHidden()
  await expect(browse).toBeFocused()
  const editColors = page
    .getByTestId('journal')
    .getByRole('button', { name: 'Edit category colors' })
  await editColors.click()
  const colors = page.getByRole('dialog', { name: 'Category: Edit category colors' })
  await expect(colors).toBeVisible()
  await colors.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(colors).toBeHidden()
  await expect(editColors).toBeFocused()
})

test('column controls share the skip window and disabled explanations remain keyboard accessible', async ({
  page
}) => {
  await page.goto('/ui-consistency.html?interactions')
  const journal = page.getByTestId('journal')
  await journal.getByRole('button', { name: 'ISSN: Hide column' }).hover()
  await expect(page.getByRole('tooltip')).toHaveText('Hide column')
  const next = journal.getByRole('button', { name: 'External IDs: Hide column' })
  await page.mouse.move(1, 1, { steps: 3 })
  const nextBounds = (await next.boundingBox())!
  await page.mouse.move(nextBounds.x + nextBounds.width / 2, nextBounds.y + nextBounds.height / 2, {
    steps: 3
  })
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveAttribute(
    'data-state',
    'instant-open'
  )
  await page.getByTestId('skills').getByRole('button', { name: 'Actions for Mine' }).click()
  const disabledDelete = page.getByRole('menuitem', { name: 'Delete', exact: true })
  for (
    let i = 0;
    i < 12 && !(await disabledDelete.evaluate((node) => node === document.activeElement));
    i++
  )
    await page.keyboard.press('ArrowDown')
  await expect(disabledDelete).toBeFocused()
  await expect(page.getByRole('tooltip')).toContainText('Owned by Reviewer.')
  await page.keyboard.press('Escape')
  if (await page.getByRole('menu').isVisible()) await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toBeHidden()
  await page
    .getByTestId('specialists')
    .getByRole('button', { name: 'Actions for Reviewer' })
    .click()
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  const dialog = page.getByRole('alertdialog')
  await dialog.getByRole('button', { name: /Skills you can also delete/ }).click()
  const disabledSkill = dialog.locator('[data-slot="specialist-delete-disabled-skill"]')
  for (
    let i = 0;
    i < 20 && !(await disabledSkill.evaluate((node) => node === document.activeElement));
    i++
  )
    await page.keyboard.press('Tab')
  await expect(disabledSkill).toBeFocused()
  await expect(page.getByRole('tooltip')).toHaveText('Used by the Main Agent and will be kept.')
})
