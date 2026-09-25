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
    await page.getByRole('button', { name: 'Open actions for P1' }).click()
    await expect(page.getByRole('menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('actions')).toHaveText('project,project,project,project,project')
    await project.focus()
    await page.keyboard.press('Enter')
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
  await page.getByRole('button', { name: 'Open actions for Analysis session' }).click()
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

test('marketplace card edges and details button open the same specialist exactly once', async ({
  page
}) => {
  await page.goto('/row-hit-targets.html?surface=marketplace')
  const primary = page.getByRole('button', { name: /Researcher.*Focused research/ })
  await clickEdges(page, primary.locator('..'), 'specialist')
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
