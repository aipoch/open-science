import { expect, test, type Locator, type Page } from '@playwright/test'

// Click painted padding, not the text/button center. jsdom cannot exercise CSS hit testing.
async function clickEdges(page: Page, row: Locator, action: string): Promise<void> {
  await row.scrollIntoViewIfNeeded()
  const box = (await row.boundingBox())!
  const points = [
    [box.x + box.width / 2, box.y + 1],
    [box.x + box.width / 2, box.y + box.height - 1],
    [box.x + 2, box.y + box.height / 2],
    [box.x + box.width - 2, box.y + box.height / 2]
  ]
  for (let index = 0; index < points.length; index++) {
    const [x, y] = points[index]
    await page.mouse.move(x, y)
    await page.mouse.click(x, y)
    await expect(page.getByTestId('actions')).toHaveText(
      Array(index + 1)
        .fill(action)
        .join(',')
    )
  }
}

for (const dark of [false, true]) {
  test(`Home project edges and metadata open once; actions stay independent (${dark ? 'dark' : 'light'})`, async ({
    page
  }) => {
    await page.goto(`/row-hit-targets.html?surface=home${dark ? '&dark' : ''}`)
    const project = page.getByRole('button', { name: 'P1', exact: true })
    const row = project.locator('..')
    await clickEdges(page, row, 'project')
    const metadata = (await row.getByText('1 session', { exact: true }).boundingBox())!
    await page.mouse.click(metadata.x + metadata.width / 2, metadata.y + metadata.height / 2)
    await expect(page.getByTestId('actions')).toHaveText('project,project,project,project,project')
    const actions = page.getByRole('button', { name: 'Open actions for P1' })
    const target = (await actions.boundingBox())!
    expect(target.width).toBeGreaterThanOrEqual(28)
    expect(target.height).toBeGreaterThanOrEqual(28)
    await actions.click()
    await expect(page.getByRole('menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toBeHidden()
    await expect(actions).toBeFocused()
    await expect(page.getByTestId('actions')).toHaveText('project,project,project,project,project')
    await project.focus()
    await expect(project).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('actions')).toHaveText(Array(6).fill('project').join(','))
    await expect(project).toBeFocused()
    await page.keyboard.press('Space')
    await expect(page.getByTestId('actions')).toHaveText(Array(7).fill('project').join(','))
    // The decorative card inset is outside any row and must remain inert.
    const card = (await row.locator('..').boundingBox())!
    await page.mouse.click(card.x + card.width / 2, card.y + 1)
    await expect(page.getByTestId('actions')).toHaveText(Array(7).fill('project').join(','))
  })
}

test('sidebar edges open the session while the dropdown and context menu remain independent', async ({
  page
}) => {
  await page.goto('/row-hit-targets.html?surface=sidebar')
  const row = page.locator('[data-session-id="session-1"]')
  await clickEdges(page, row, 'session')
  const actions = page.getByRole('button', { name: 'Open actions for Analysis session' })
  const target = (await actions.boundingBox())!
  expect(target.width).toBeGreaterThanOrEqual(28)
  expect(target.height).toBeGreaterThanOrEqual(28)
  for (const [x, y] of [
    [target.x + target.width / 2, target.y + 1],
    [target.x + target.width / 2, target.y + target.height - 1],
    [target.x + 1, target.y + target.height / 2],
    [target.x + target.width - 1, target.y + target.height / 2]
  ]) {
    await page.mouse.click(x, y)
    await expect(page.getByRole('menu')).toBeVisible()
    await expect(page.getByTestId('actions')).toHaveText('session,session,session,session')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toBeHidden()
    await expect(actions).toBeFocused()
  }
  await actions.click()
  await expect(page.getByTestId('session-preview-content')).toBeHidden()
  await page.getByRole('menuitem', { name: /Pin/ }).click()
  await expect(page.getByTestId('actions')).toHaveText('session,session,session,session,pin')
  await row.click({ button: 'right', position: { x: 3, y: 2 } })
  await expect(page.getByTestId('session-context-menu')).toBeVisible()
  await page.keyboard.press('Escape')
  const primary = row.locator('[data-slot="session-open-button"]')
  await primary.focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Space')
  await expect(page.getByTestId('actions')).toHaveText(
    'session,session,session,session,pin,session,session'
  )
})

test('dirty Home project drafts survive each dismissal until discard is confirmed', async ({
  page
}) => {
  await page.goto('/row-hit-targets.html?surface=home')
  const trigger = page.locator('header').getByRole('button', { name: 'New project', exact: true })
  await trigger.click()
  const name = page.getByRole('textbox', { name: 'Name', exact: true })
  const context = page.getByRole('textbox', { name: 'Agent Context', exact: true })
  await name.fill('Research project draft')
  await expect(context).toBeHidden()
  const advanced = page.getByText('Advanced agent options', { exact: true })
  await advanced.focus()
  await page.keyboard.press('Enter')
  await context.fill('Preserve these unsaved research instructions.')
  const prompt = page.getByRole('textbox', { name: 'Optimization prompt', exact: true })
  await prompt.fill('Keep the original intent.')
  await advanced.click()
  await expect(context).toBeHidden()
  await expect(prompt).toBeHidden()
  await advanced.focus()
  await page.keyboard.press('Space')
  await expect(context).toHaveValue('Preserve these unsaved research instructions.')
  await expect(prompt).toHaveValue('Keep the original intent.')
  for (const exit of ['Escape', 'Close', 'Cancel']) {
    await context.focus()
    if (exit === 'Escape') await page.keyboard.press('Escape')
    else await page.getByRole('dialog').getByRole('button', { name: exit, exact: true }).click()
    await expect(page.getByRole('alertdialog')).toBeVisible()
    await page.getByRole('button', { name: 'Keep editing', exact: true }).click()
    await expect(page.getByRole('alertdialog')).toBeHidden()
    await expect(name).toHaveValue('Research project draft')
    await expect(context).toHaveValue('Preserve these unsaved research instructions.')
    if (exit === 'Escape') await expect(context).toBeFocused()
    else
      await expect(
        page.getByRole('dialog').getByRole('button', { name: exit, exact: true })
      ).toBeFocused()
  }
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(trigger).toBeFocused()
  await trigger.click()
  await expect(name).toHaveValue('')
  await expect(context).toBeHidden()
  await advanced.click()
  await expect(context).toHaveValue('')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(page.getByRole('alertdialog')).toBeHidden()
  await expect(trigger).toBeFocused()
})

test('folder padding expands and collapses; removing access does not toggle the folder', async ({
  page
}) => {
  await page.goto('/row-hit-targets.html?surface=folders')
  await page.getByRole('button', { name: 'Files menu' }).click()
  await page.getByTestId('composer-your-files-trigger').hover()
  const toggle = page.getByTestId('your-files-root-toggle-root-1')
  await expect(toggle).toBeVisible()
  const row = toggle.locator('..')
  const box = (await row.boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + 1)
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  const nested = page.getByTestId('your-files-dir-root-1-nested')
  const nestedBox = (await nested.locator('..').boundingBox())!
  await page.mouse.click(nestedBox.x + 2, nestedBox.y + nestedBox.height - 1)
  await expect(nested).toHaveAttribute('aria-expanded', 'true')
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 1)
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await page.getByTestId('your-files-remove-root-1').click()
  await expect(page.getByTestId('actions')).toHaveText('remove-folder')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
})

test('bookmark padding reveals its source; edit and delete remain separate', async ({ page }) => {
  await page.goto('/row-hit-targets.html?surface=bookmarks')
  await page.getByRole('button', { name: 'Bookmarks (1)' }).click()
  const primary = page.getByRole('button', { name: /A useful result/ })
  await clickEdges(page, primary.locator('..'), 'bookmark')
  await page.getByRole('button', { name: 'Edit bookmark note' }).click()
  await expect(page.getByRole('textbox')).toBeVisible()
  await expect(page.getByTestId('actions')).toHaveText('bookmark,bookmark,bookmark,bookmark')
  await page.getByRole('button', { name: 'Delete bookmark' }).click()
  await expect(page.getByTestId('actions')).toHaveText(
    'bookmark,bookmark,bookmark,bookmark,delete-bookmark'
  )
})

test('PDF outline edges and indentation navigate; collapse only changes expansion', async ({
  page
}) => {
  await page.goto('/row-hit-targets.html?surface=pdf')
  const nested = page.getByRole('treeitem', { name: 'Nested section' })
  await clickEdges(page, nested.locator('..'), 'page-2')
  await page.getByRole('button', { name: 'Collapse', exact: true }).click()
  await expect(nested).toBeHidden()
  await expect(page.getByTestId('actions')).toHaveText('page-2,page-2,page-2,page-2')
  const chapter = page.getByRole('treeitem', { name: 'Chapter' })
  await chapter.focus()
  await page.keyboard.press('ArrowRight')
  await expect(nested).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await expect(nested).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('actions')).toHaveText('page-2,page-2,page-2,page-2,page-2')
})

test('marketplace card body edges and details button open the same specialist exactly once', async ({
  page
}) => {
  await page.goto('/row-hit-targets.html?surface=marketplace')
  const primary = page.getByRole('button', { name: 'Researcher', exact: true })
  await expect(primary).toBeVisible()
  const body = page.getByText('Focused research', { exact: true }).locator('..')
  await clickEdges(page, body, 'specialist')
  await page.getByRole('button', { name: 'View details', exact: true }).click()
  await expect(page.getByTestId('actions')).toHaveText(Array(5).fill('specialist').join(','))
})

test('tag resource edges navigate while removal does not', async ({ page }) => {
  await page.goto('/row-hit-targets.html?surface=tags')
  const row = page.locator('[data-slot="tag-resource-row"]').locator('..')
  await clickEdges(page, row, 'tag-resource')
  await page.getByRole('button', { name: /Remove Analysis from/ }).click()
  await expect(page.getByTestId('actions')).toHaveText(
    'tag-resource,tag-resource,tag-resource,tag-resource,remove-tag'
  )
})

test('compute card edges open details; removal opens only its confirmation', async ({ page }) => {
  await page.goto('/row-hit-targets.html?surface=compute')
  await clickEdges(page, page.locator('[data-slot="compute-host-card"]'), 'host')
  await page.getByRole('button', { name: 'Remove Compute host', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toBeVisible()
  await expect(page.getByTestId('actions')).toHaveText('host,host,host,host')
})

test('a pending folder removal does not pass clicks through to expansion', async ({ page }) => {
  await page.goto('/row-hit-targets.html?surface=folders&pending')
  await page.getByRole('button', { name: 'Files menu' }).click()
  await page.getByTestId('composer-your-files-trigger').hover()
  const remove = page.getByTestId('your-files-remove-root-1')
  await remove.click()
  await expect(remove).toBeDisabled()
  const box = (await remove.boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(page.getByTestId('your-files-root-toggle-root-1')).toHaveAttribute(
    'aria-expanded',
    'false'
  )
  await expect(page.getByTestId('actions')).toHaveText('remove-folder')
})

test('a pending tag removal does not pass clicks through to resource navigation', async ({
  page
}) => {
  await page.goto('/row-hit-targets.html?surface=tags&pending')
  await page.locator('[data-slot="tag-resource-row"]').hover()
  const remove = page.getByRole('button', { name: /Remove Analysis from/ })
  await remove.click()
  await expect(remove).toBeDisabled()
  const box = (await remove.boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(page.getByTestId('actions')).toHaveText('remove-tag')
})

test('project edges remain usable on a narrow touch viewport with enlarged text', async ({
  browser,
  baseURL
}) => {
  const context = await browser.newContext({
    baseURL,
    hasTouch: true,
    viewport: { width: 390, height: 850 }
  })
  const page = await context.newPage()
  await page.goto('/row-hit-targets.html?surface=home')
  await page.addStyleTag({ content: 'html { font-size: 20px; }' })
  const project = page.getByRole('button', { name: 'P1', exact: true })
  await clickEdges(page, project.locator('..'), 'project')
  await page.getByRole('button', { name: 'Open actions for P1' }).tap()
  await expect(page.getByRole('menu')).toBeVisible()
  await expect(page.getByTestId('actions')).toHaveText('project,project,project,project')
  await context.close()
})

test('the mobile session menu keeps its visible 28px touch target and 14px icon', async ({
  browser,
  baseURL
}) => {
  const context = await browser.newContext({
    baseURL,
    hasTouch: true,
    viewport: { width: 390, height: 850 }
  })
  const page = await context.newPage()
  await page.goto('/row-hit-targets.html?surface=sidebar&mobile')
  const actions = page.getByRole('button', { name: 'Open actions for Analysis session' })
  await expect(actions).toHaveCSS('opacity', '1')
  const target = (await actions.boundingBox())!
  expect(target.width).toBe(28)
  expect(target.height).toBe(28)
  const icon = (await actions.locator('svg').boundingBox())!
  expect(icon.width).toBe(14)
  expect(icon.height).toBe(14)
  await actions.tap()
  await expect(page.getByRole('menu')).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /Pin/ })).toBeVisible()
  await page.getByRole('menuitem', { name: /Pin/ }).tap()
  await expect(page.getByTestId('actions')).toHaveText('pin')
  await context.close()
})

test('film-generating row yields its action slot without ghost clicks, sticky focus, or shortcut overlap', async ({
  page
}) => {
  await page.goto('/row-hit-targets.html?surface=sidebar&film')
  const row = page.locator('[data-session-id="session-1"]')
  const mark = row.getByRole('img', { name: 'Research film in progress' })
  const actions = row.getByRole('button', { name: 'Open actions for Analysis session' })
  const titleButton = row.locator('[data-slot="session-open-button"]')

  // Resting state: film mark sits in the action slot and the invisible menu button ignores pointer hits.
  await expect(actions).toHaveCSS('opacity', '0')
  await expect(actions).toHaveCSS('pointer-events', 'none')
  const restingMarkBox = (await mark.boundingBox())!
  const restingActionsBox = (await actions.boundingBox())!
  expect(restingMarkBox.x).toBeGreaterThanOrEqual(restingActionsBox.x)
  expect(restingMarkBox.x + restingMarkBox.width).toBeLessThanOrEqual(
    restingActionsBox.x + restingActionsBox.width
  )

  // Moving directly onto the resting film mark from outside and clicking immediately must open the
  // session rather than opening the unrevealed dropdown menu.
  await page.mouse.move(0, 0)
  await page.mouse.move(
    restingMarkBox.x + restingMarkBox.width / 2,
    restingMarkBox.y + restingMarkBox.height / 2
  )
  await page.mouse.click(
    restingMarkBox.x + restingMarkBox.width / 2,
    restingMarkBox.y + restingMarkBox.height / 2
  )
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(page.getByTestId('actions')).toHaveText('session')

  // Moving off the row after a mouse click must let the action button hide and the mark return
  // (mouse click gives :focus without :focus-visible).
  await page.mouse.move(400, 400)
  await expect(actions).toHaveCSS('opacity', '0')
  await expect(actions).toHaveCSS('pointer-events', 'none')
  await expect
    .poll(async () => (await mark.boundingBox())!.x)
    .toBeGreaterThanOrEqual(restingMarkBox.x - 0.5)

  // Hovering the row slides the mark clear of the actions slot and enables clicking the menu button.
  const rowBox = (await row.boundingBox())!
  await page.mouse.move(rowBox.x + 24, rowBox.y + rowBox.height / 2)
  await expect(actions).toHaveCSS('opacity', '1')
  await expect(actions).toHaveCSS('pointer-events', 'auto')
  const hoveredMarkBox = (await mark.boundingBox())!
  expect(hoveredMarkBox.x + hoveredMarkBox.width).toBeLessThan(restingActionsBox.x)

  await actions.click()
  await expect(page.getByRole('menu')).toBeVisible()
  // Clicking outside the menu must dismiss it and let the row return to its resting layout.
  await page.mouse.click(400, 400)
  await expect(page.getByRole('menu')).toBeHidden()
  await expect(actions).toHaveCSS('opacity', '0')
  await expect(actions).toHaveCSS('pointer-events', 'none')
  await expect
    .poll(async () => (await mark.boundingBox())!.x)
    .toBeGreaterThanOrEqual(restingMarkBox.x - 0.5)

  // Keyboard Escape dismissal still restores focus to the trigger.
  await page.mouse.move(rowBox.x + 24, rowBox.y + rowBox.height / 2)
  await expect(actions).toHaveCSS('pointer-events', 'auto')
  await actions.click()
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toBeHidden()
  await expect(actions).toBeFocused()

  // Keyboard focus-visible reveals the action button and slides the mark clear without hover.
  await page.mouse.move(400, 400)
  await titleButton.focus()
  await page.keyboard.press('Tab')
  await expect(actions).toBeFocused()
  await expect(actions).toHaveCSS('opacity', '1')
  await expect(actions).toHaveCSS('pointer-events', 'auto')
  await expect
    .poll(async () => {
      const box = (await mark.boundingBox())!
      return box.x + box.width
    })
    .toBeLessThan(restingActionsBox.x)

  // Holding Meta (⌘1 on macOS) must keep the pill and film mark in independent non-overlapping boxes.
  await page.keyboard.down('Meta')
  const metaPill = row.locator('kbd')
  await expect(metaPill).toHaveText('⌘1')
  const metaPillBox = (await metaPill.boundingBox())!
  const metaMarkBox = (await mark.boundingBox())!
  expect(metaMarkBox.x + metaMarkBox.width).toBeLessThanOrEqual(metaPillBox.x)
  await page.keyboard.up('Meta')
  await expect(metaPill).toHaveCount(0)
})

test('film-generating row avoids shortcut overlap for wider Ctrl+1 pill', async ({ page }) => {
  await page.goto('/row-hit-targets.html?surface=sidebar&film&platform=linux')
  const row = page.locator('[data-session-id="session-1"]')
  const mark = row.getByRole('img', { name: 'Research film in progress' })
  await page.keyboard.down('Control')
  const ctrlPill = row.locator('kbd')
  await expect(ctrlPill).toHaveText('Ctrl+1')
  const ctrlPillBox = (await ctrlPill.boundingBox())!
  const ctrlMarkBox = (await mark.boundingBox())!
  expect(ctrlMarkBox.x + ctrlMarkBox.width).toBeLessThanOrEqual(ctrlPillBox.x)
  await page.keyboard.up('Control')
  await expect(ctrlPill).toHaveCount(0)
})
