import { expect, test, type Locator } from '@playwright/test'

async function expectNoOuterOverflow(dialog: Locator): Promise<void> {
  const metrics = await dialog.evaluate((node) => ({
    height: node.clientHeight,
    content: node.scrollHeight,
    scrollTop: node.scrollTop,
    children: [...node.querySelectorAll('*')]
      .filter(
        (el) =>
          ['auto', 'scroll'].includes(getComputedStyle(el).overflowY) &&
          el.scrollHeight > el.clientHeight + 1
      )
      .map((el) => ({
        tag: el.tagName,
        className: el.className,
        height: el.clientHeight,
        content: el.scrollHeight
      }))
  }))
  expect(metrics.content - metrics.height, JSON.stringify(metrics, null, 2)).toBeLessThanOrEqual(1)
  expect(metrics.scrollTop).toBe(0)
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
})

for (const size of [
  { width: 1000, height: 720 },
  { width: 560, height: 420 }
]) {
  test(`literature detail confines scrolling at ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size)
    await page.goto('/modal-scrollbars.html')
    const dialog = page.getByRole('dialog', { name: 'Metabolism in Tumour-Induced Bone Disease' })
    await expect(dialog).toBeVisible()
    await expectNoOuterOverflow(dialog)
    const header = dialog.locator(':scope > div').first()
    const before = await header.boundingBox()
    const body = dialog.locator(':scope > div').last()
    await body.hover()
    await page.mouse.wheel(0, 2000)
    await expect.poll(() => body.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
    expect(await header.boundingBox()).toEqual(before)
    await expectNoOuterOverflow(dialog)
  })
}

test('shared ScrollArea confines absolute descendants to its viewport', async ({ page }) => {
  await page.goto('/modal-scrollbars.html?mode=scroll-area')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  const root = dialog.locator('[data-slot="scroll-area"]')
  const viewport = root.locator('[data-slot="scroll-area-viewport"]')
  await expectNoOuterOverflow(dialog)
  await expectNoOuterOverflow(root)
  await viewport.hover()
  await page.mouse.wheel(0, 2000)
  await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
  await expect(dialog.getByRole('button', { name: 'Last action' })).toBeInViewport()
  await expect(dialog.getByRole('button', { name: 'Footer action' })).toBeInViewport()
})

test('shared confirmation keeps actions reachable in a small viewport', async ({ page }) => {
  await page.setViewportSize({ width: 560, height: 420 })
  await page.goto('/modal-scrollbars.html?mode=confirm')
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toBeVisible()
  await expectNoOuterOverflow(dialog)
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeInViewport()
  await expect(dialog.getByRole('button', { name: 'Confirm', exact: true })).toBeInViewport()
})

for (const size of [
  { width: 900, height: 500 },
  { width: 560, height: 420 }
]) {
  test(`folder grant keeps recovery actions visible after failure at ${size.width}x${size.height}`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width: 900, height: 800 })
    await page.goto(
      `/modal-scrollbars.html?mode=folder-grant${size.width === 560 ? '&longError=1' : ''}`
    )
    const dialog = page.getByTestId('grant-folder-access-dialog')
    const grant = dialog.getByRole('button', { name: 'Grant this folder', exact: true })
    await expect(grant).toBeEnabled()
    await grant.click()
    await page
      .getByTestId('grant-folder-access-confirmation')
      .getByRole('button', { name: 'Grant this folder', exact: true })
      .click()
    await expect(dialog.getByRole('alert')).toBeVisible()

    await page.setViewportSize(size)
    const bounds = await dialog.boundingBox()
    const actions = await grant.boundingBox()
    expect(bounds).not.toBeNull()
    expect(actions).not.toBeNull()
    expect(actions!.y + actions!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height)
    await expect(grant).toBeInViewport({ ratio: 1 })
    await expect(dialog.getByRole('radio', { name: 'Read-only', exact: true })).toBeInViewport({
      ratio: 1
    })
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport({
      ratio: 1
    })
    await dialog.getByText('Error details', { exact: true }).click()
    await expect(dialog.locator('pre')).toContainText('Notebook cleanup is incomplete')
    await expect(dialog.locator('pre')).toBeVisible()
    await expect(grant).toBeInViewport({ ratio: 1 })
    await page.screenshot({ path: testInfo.outputPath('folder-access-error.png') })
    await grant.click()
    await expect(page.getByTestId('grant-folder-access-confirmation')).toBeVisible()
  })
}
test('manual reference editor has no second outer scroller', async ({ page }) => {
  await page.setViewportSize({ width: 560, height: 320 })
  await page.goto('/modal-scrollbars.html?mode=library')
  await page.getByRole('button', { name: 'All references', exact: true }).click()
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Add reference', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add reference', exact: true })
  await expect(dialog).toBeVisible()
  await expectNoOuterOverflow(dialog)
  const fields = dialog.locator('fieldset').locator('..')
  await fields.hover()
  await page.mouse.wheel(0, 2000)
  await expect.poll(() => fields.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
  await expect(dialog.getByRole('textbox', { name: 'Abstract', exact: true })).toBeInViewport()
  await expectNoOuterOverflow(dialog)
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true })
  await cancel.focus()
  await expect(cancel).toBeInViewport()
  await expectNoOuterOverflow(dialog)
})

test('inbox reference detail keeps its actions outside the body scroller', async ({ page }) => {
  await page.setViewportSize({ width: 560, height: 420 })
  await page.goto('/modal-scrollbars.html?mode=library')
  await page.getByRole('button', { name: /^Inbox/ }).click()
  await page
    .getByRole('button', {
      name: 'View details: Metabolism in Tumour-Induced Bone Disease',
      exact: true
    })
    .click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expectNoOuterOverflow(dialog)
  await expect(dialog.getByRole('button', { name: 'Accept', exact: true })).toBeInViewport()
  await expect(dialog.getByRole('button', { name: 'Dismiss', exact: true })).toBeInViewport()
})

test('merge review has one main scroller at small heights', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 420 })
  await page.goto('/modal-scrollbars.html?mode=library')
  await page.getByRole('button', { name: 'All references', exact: true }).click()
  await page
    .getByRole('checkbox', {
      name: 'Select Metabolism in Tumour-Induced Bone Disease',
      exact: true
    })
    .check()
  await page.getByRole('checkbox', { name: 'Select Second reference', exact: true }).check()
  await page
    .locator('[data-slot="literature-selection-toolbar"]')
    .getByRole('button', { name: 'More actions', exact: true })
    .click()
  await page.getByRole('button', { name: 'Actions', exact: true }).hover()
  await page.getByRole('menuitem', { name: 'Merge', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Merge references', exact: true })
  await expect(dialog).toBeVisible()
  await expectNoOuterOverflow(dialog)
  await expect(
    dialog.getByRole('button', { name: 'Merge references', exact: true })
  ).toBeInViewport()
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport()
})

test('runtime package list keeps the last row inside its scrolling viewport', async ({ page }) => {
  await page.setViewportSize({ width: 560, height: 420 })
  await page.goto('/r-access.html?scenario=install-library')
  await page.getByRole('button', { name: 'Packages', exact: true }).click()
  const dialog = page.getByTestId('runtime-packages-dialog')
  await expect(dialog).toBeVisible()
  const list = dialog.locator('table').locator('..')
  await list.evaluate((node) => {
    node.scrollTop = node.scrollHeight
  })
  await expect(dialog.getByText('package-080', { exact: true })).toBeInViewport()
  await expectNoOuterOverflow(dialog)
})

for (const mode of ['jobs', 'report']) {
  test(`${mode} dialog does not duplicate the body scroll region`, async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 })
    await page.goto(`/modal-scrollbars.html?mode=${mode}`)
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expectNoOuterOverflow(dialog)
  })
}

for (const mode of ['artifact', 'package', 'skill-update']) {
  test(`${mode} shared dialog layout remains contained`, async ({ page }) => {
    await page.setViewportSize({ width: 560, height: 420 })
    await page.goto(`/modal-close.html?case=${mode}`)
    await page.getByRole('button', { name: 'Open audit' }).click()
    const dialog = page.locator('[role=dialog],[role=alertdialog]').last()
    await expect(dialog).toBeVisible()
    await expectNoOuterOverflow(dialog)
  })
}
