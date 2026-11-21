import { expect, test, type Page } from '@playwright/test'
import type { ImageTaskStart } from '../../src/shared/image-task'

type Fixture = {
  imageEditFixture: {
    finish(): void
    requests: ImageTaskStart[]
  }
}

const imageSelectionAlignmentError = (page: Page, inDialog = false): Promise<number> =>
  page.evaluate((inDialog) => {
    const root = inDialog ? document.querySelector('[role="dialog"]') : document
    const image = root?.querySelector<HTMLImageElement>('[data-image-edit-surface] img')
    const outline = root?.querySelector<HTMLElement>('[data-testid="image-selection-outline"]')
    if (!image || !outline || !image.naturalWidth || !image.naturalHeight) return Infinity
    const imageRect = image.getBoundingClientRect()
    const outlineRect = outline.getBoundingClientRect()
    const scale = Math.min(
      imageRect.width / image.naturalWidth,
      imageRect.height / image.naturalHeight
    )
    const content = {
      left: imageRect.left + (imageRect.width - image.naturalWidth * scale) / 2,
      top: imageRect.top + (imageRect.height - image.naturalHeight * scale) / 2,
      width: image.naturalWidth * scale,
      height: image.naturalHeight * scale
    }
    return Math.max(
      Math.abs(outlineRect.left - content.left),
      Math.abs(outlineRect.top - content.top),
      Math.abs(outlineRect.width - content.width),
      Math.abs(outlineRect.height - content.height)
    )
  }, inDialog)

for (const width of [420, 1000]) {
  test(`image edit keeps its canvas and draft while generating at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await page.goto('/image-edit.html')
    await page.getByTestId('preview-edit-image').click()
    const input = page.getByRole('textbox', { name: 'Image editing instruction' })
    await expect(input).toBeFocused()
    await input.fill('Make the circle yellow. Keep the background and text unchanged.')
    const image = page.locator('[aria-label="Image editing canvas"] img')
    await expect(image).toBeVisible()
    const before = await image.boundingBox()
    const original = await image.getAttribute('src')
    await page.getByRole('button', { name: 'Send image edit' }).click()
    await expect(page.getByTestId('image-task-status')).toHaveText('Processing')
    await expect(input).toHaveValue(
      'Make the circle yellow. Keep the background and text unchanged.'
    )
    await expect(input).toBeDisabled()
    await expect(page.getByTestId('image-edit-pending')).toBeVisible()
    await expect(image).toBeHidden()
    expect(await image.getAttribute('src')).toBe(original)
    const pending = await image.boundingBox()
    expect(Math.abs(pending!.height - before!.height)).toBeLessThanOrEqual(2)
    expect(Math.abs(pending!.y - before!.y)).toBeLessThanOrEqual(2)
    await expect(page.getByRole('button', { name: 'Image history', exact: true })).toBeEnabled()
    await page.screenshot({ path: `test-results/image-edit-pending-${width}.png` })
    await page.getByRole('button', { name: 'View source image', exact: true }).click()
    await expect(image).toBeVisible()
    await page.evaluate(() => (window as unknown as Fixture).imageEditFixture.finish())
    await expect(page.getByText('New image ready', { exact: true })).toBeVisible()
    expect(await image.getAttribute('src')).toBe(original)
    await page.getByRole('button', { name: 'View image', exact: true }).click()
    await expect(image).not.toHaveAttribute('src', original!)
    await page.getByRole('button', { name: 'Continue editing', exact: true }).click()
    await input.fill('Now add a border')
    await page.getByRole('button', { name: 'Send image edit' }).click()
    expect(
      await page.evaluate(
        () =>
          (window as unknown as Fixture).imageEditFixture.requests[1].edit.source.sourceVersionId
      )
    ).toBe('v2')
    await page.getByRole('button', { name: 'Back to image preview' }).click()
    await page.getByTestId('preview-edit-image').click()
    await expect(input).toHaveValue('Now add a border')
    await expect(page.getByTestId('image-task-status')).toHaveText('Processing')
    await page.getByRole('button', { name: 'Stop image editing' }).click()
    await expect(input).toBeEnabled()
    await expect(input).toHaveValue('Now add a border')
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
  })
}

test('preview zoom survives entering image edit and cancelling keeps region instructions', async ({
  page
}) => {
  await page.setViewportSize({ width: 700, height: 800 })
  await page.goto('/image-edit.html')
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await expect
    .poll(() =>
      page
        .locator('.react-transform-component')
        .evaluate((node) => getComputedStyle(node).transform)
    )
    .not.toBe('matrix(1, 0, 0, 1, 0, 0)')
  // Wait for the zoom animation to finish before comparing the saved transform.
  await page.waitForTimeout(400)
  const before = await page
    .locator('.react-transform-component')
    .evaluate((node) => getComputedStyle(node).transform)
  await page.getByTestId('preview-edit-image').click()
  await expect
    .poll(() =>
      page
        .locator('.react-transform-component')
        .evaluate((node) => getComputedStyle(node).transform)
    )
    .toBe(before)
  await page.getByRole('button', { name: 'Mark a point', exact: true }).click()
  // Click the visible image; the transformed surface extends outside its clipping viewport.
  await page.mouse.click(350, 250)
  const region = page.getByRole('textbox', { name: 'Region instruction', exact: true })
  await region.fill('Change this circle')
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('button', { name: 'Send image edit' }).click()
  await expect(page.getByText('Change this circle', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Stop image editing' }).click()
  await expect(page.getByRole('button', { name: 'Send image edit' })).toBeEnabled()
  await expect(page.getByText('Change this circle', { exact: true })).toBeVisible()
})

test('floating controls fit a small dark panel and collapse after the result arrives', async ({
  page
}) => {
  await page.setViewportSize({ width: 360, height: 600 })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.goto('/image-edit.html')
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await page.getByTestId('preview-edit-image').click()
  const input = page.getByRole('textbox', { name: 'Image editing instruction' })
  await input.fill('Translate all labels. Keep the layout.\nPreserve the colors and arrows.')
  await page.getByRole('button', { name: 'Expand instructions', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Collapse instructions', exact: true })
  ).toBeVisible()
  await page.getByRole('button', { name: 'Send image edit', exact: true }).scrollIntoViewIfNeeded()
  const toolbarBounds = await page.getByTestId('image-edit-tools').boundingBox()
  const zoomBounds = await page.getByRole('button', { name: 'Zoom in', exact: true }).boundingBox()
  expect(toolbarBounds!.y + toolbarBounds!.height).toBeLessThan(zoomBounds!.y)
  await page.screenshot({ path: 'test-results/image-edit-studio-dark-edit.png' })
  await page.getByRole('button', { name: 'Send image edit', exact: true }).click()
  await expect(page.getByTestId('image-edit-pending')).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'View source image', exact: true })
  ).toBeInViewport()
  await page.evaluate(() => (window as unknown as Fixture).imageEditFixture.finish())
  const next = page.getByRole('button', { name: 'Continue editing', exact: true })
  await expect(next).toBeVisible()
  await expect(input).toHaveCount(0)
  await expect(next).toBeFocused()
  await expect(
    page.getByRole('button', { name: 'Compare with input image', exact: true })
  ).toBeEnabled()
  await page.screenshot({ path: 'test-results/image-edit-studio-dark-result.png' })
  await next.click()
  await expect(input).toBeFocused()
  await expect(page.getByRole('button', { name: 'Image model', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360)
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(600)
})

test('image instructions use the left composer and preserve the conversation draft', async ({
  page
}) => {
  await page.setViewportSize({ width: 1200, height: 800 })
  await page.goto('/image-edit.html?conversation')
  const chat = page.getByRole('textbox', { name: 'Conversation draft' })
  await chat.fill('My unsent conversation draft')
  const editFocus = await page.evaluateHandle(() => {
    const panes: (string | undefined)[] = []
    document.addEventListener('focusin', (event) => {
      if (
        event.target instanceof HTMLTextAreaElement &&
        event.target.matches('[aria-label="Image editing instruction"]')
      ) {
        panes.push(event.target.closest('section')?.dataset.testid)
      }
    })
    return panes
  })
  await page.getByTestId('preview-edit-image').click()
  const left = page.getByTestId('conversation-pane')
  const right = page.getByTestId('preview-pane')
  const input = left.getByRole('textbox', { name: 'Image editing instruction' })
  await expect(input).toBeFocused()
  expect(await editFocus.jsonValue()).toEqual(['conversation-pane'])
  await expect(chat).toBeHidden()
  await expect(right.getByRole('textbox', { name: 'Image editing instruction' })).toHaveCount(0)
  await input.fill('Make the circle gold')
  await left.getByRole('button', { name: 'Send image edit' }).click()
  await expect(right.getByTestId('image-edit-pending')).toBeVisible()
  await expect(input).toBeDisabled()
  await page.screenshot({ path: 'test-results/image-edit-unified-composer.png' })
  await left.getByRole('button', { name: 'Back to conversation', exact: true }).click()
  await expect(chat).toBeVisible()
  await expect(chat).toHaveValue('My unsent conversation draft')
  await page.getByTestId('preview-edit-image').click()
  await expect(input).toHaveValue('Make the circle gold')
  await expect(input).toBeDisabled()
  await page.evaluate(() => (window as unknown as Fixture).imageEditFixture.finish())
  await expect(left.getByRole('button', { name: 'Continue editing', exact: true })).toBeVisible()
  await left.getByRole('button', { name: 'Continue editing', exact: true }).click()
  await expect(input).toBeFocused()
  await expect(chat).toBeHidden()
})

test('floating tools follow the image and selection distinguishes hover from click', async ({
  page
}) => {
  await page.setViewportSize({ width: 1200, height: 900 })
  await page.goto('/image-edit.html?conversation')
  await page.getByTestId('preview-edit-image').click()
  const tools = page.getByTestId('image-edit-tools')
  const outline = page.getByTestId('image-selection-outline')
  await expect(tools).toBeVisible()
  await expect(outline).toHaveAttribute('data-selected', 'true')
  const image = await outline.boundingBox()
  const bar = await tools.boundingBox()
  expect(bar!.y + bar!.height).toBeLessThan(image!.y)
  expect(image!.y - bar!.y - bar!.height).toBeCloseTo(12, 0)
  expect(Math.abs(bar!.x + bar!.width / 2 - image!.x - image!.width / 2)).toBeLessThan(2)
  await page.mouse.click(image!.x + 10, bar!.y - 16)
  await expect(outline).toHaveAttribute('data-selected', 'false')
  await page.mouse.move(image!.x + 20, image!.y + 20)
  await expect(outline).toHaveAttribute('data-hovered', 'true')
  await expect(tools).toBeVisible()
  await page.mouse.click(image!.x + 20, image!.y + 20)
  await expect(outline).toHaveAttribute('data-selected', 'true')
  await page.screenshot({ path: 'test-results/image-edit-floating-tools.png' })
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await page.waitForTimeout(50)
  const immediateAlignmentError = await imageSelectionAlignmentError(page)
  expect(immediateAlignmentError).toBeLessThanOrEqual(2)
  await expect.poll(async () => (await outline.boundingBox())!.width).toBeGreaterThan(image!.width)
  await expect.poll(() => imageSelectionAlignmentError(page)).toBeLessThanOrEqual(2)
  await expect(tools).toBeInViewport()
  await expect.poll(async () => (await tools.boundingBox())!.width).toBeCloseTo(bar!.width, 0)
  await page.setViewportSize({ width: 850, height: 650 })
  await expect(tools).toBeInViewport()
})

test('image preview keeps edit in the toolbar and ordinary clicks for annotations', async ({
  page
}) => {
  await page.setViewportSize({ width: 1200, height: 900 })
  await page.goto('/image-edit.html?conversation')
  const edit = page.getByTestId('preview-edit-image')
  await expect(edit).toBeVisible()
  await expect(page.getByTestId('image-edit-entry-outline')).toHaveCount(0)
  await page.screenshot({ path: 'test-results/image-edit-toolbar-action.png' })
  await edit.click()
  await expect(page.getByTestId('image-editor')).toBeVisible()
  await page.getByRole('button', { name: 'Back to conversation', exact: true }).click()
  await page.locator('[data-image-annotation-surface]').click()
  await expect(page.getByRole('textbox', { name: 'Annotation note' })).toBeVisible()
  await page.keyboard.press('Escape')
})

test('dark preview exposes a toolbar edit action without image metadata', async ({ page }) => {
  await page.setViewportSize({ width: 920, height: 900 })
  await page.goto('/image-edit.html?conversation&noDimensions')
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  const action = page.getByTestId('preview-edit-image')
  await expect(action).toBeVisible()
  await page.screenshot({ path: 'test-results/image-edit-hover-dark.png' })
  await action.click()
  await expect(page.getByTestId('image-editor')).toBeVisible()
  await expect(page.getByRole('group', { name: 'Image editing canvas' })).toBeVisible()
  await page.getByRole('textbox', { name: 'Image editing instruction' }).fill('Darken the circle')
  await page.getByRole('button', { name: 'Send image edit' }).click()
  expect(
    await page.evaluate(
      () => (window as unknown as Fixture).imageEditFixture.requests[0].edit.naturalSize
    )
  ).toEqual({ width: 1200, height: 800 })
})

test('expanded image previews require an explicit edit action and preserve the left draft', async ({
  page
}) => {
  await page.setViewportSize({ width: 1200, height: 900 })
  await page.goto('/image-edit.html?conversation&preview')
  const chat = page.getByRole('textbox', { name: 'Conversation draft' })
  await chat.fill('Leave this conversation draft alone')
  await page.getByRole('button', { name: 'Open full screen preview' }).click()
  const dialog = page.getByRole('dialog', { name: 'Preview source.png' })
  await expect(dialog.getByTestId('preview-edit-image')).toBeVisible()
  await dialog.locator('[data-image-annotation-surface]').click()
  await expect(dialog.getByTestId('image-editor')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Annotation note' })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await dialog.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await dialog.getByRole('button', { name: 'Edit image', exact: true }).click()
  const input = dialog.getByRole('textbox', { name: 'Image editing instruction' })
  await input.fill('Preserve this image draft')
  await expect(input).toBeVisible()
  await page.screenshot({ path: 'test-results/image-edit-file-dialog.png' })
  await dialog.getByRole('button', { name: 'Close preview of source.png' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(chat).toBeVisible()
  await expect(chat).toHaveValue('Leave this conversation draft alone')
  // Reopening the same shared draft must still start in preview mode.
  await page.getByRole('button', { name: 'Open full screen preview' }).click()
  await expect(dialog.getByTestId('image-editor')).toHaveCount(0)
  await dialog.locator('[data-image-annotation-surface]').click()
  await expect(dialog.getByTestId('image-editor')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Edit image', exact: true }).click()
  await expect(input).toHaveValue('Preserve this image draft')
  await dialog.getByRole('button', { name: 'Back to image preview', exact: true }).click()
  await expect(dialog.getByTestId('image-editor')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Close preview of source.png' }).click()
  await expect(chat).toHaveValue('Leave this conversation draft alone')
})

test('paged conversation history still exposes image editing and loads branch authority on click', async ({
  page
}) => {
  await page.setViewportSize({ width: 920, height: 900 })
  await page.goto('/image-edit.html?conversation&paged')
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  const entry = page.getByTestId('preview-edit-image')
  await expect(entry).toBeVisible()
  await page.screenshot({ path: 'test-results/image-edit-paged-hover.png' })
  await entry.click()
  await expect(page.getByRole('textbox', { name: 'Annotation note' })).toHaveCount(0)
  const left = page.getByTestId('conversation-pane')
  await expect(left.getByRole('textbox', { name: 'Image editing instruction' })).toBeVisible()
  await left.getByRole('textbox', { name: 'Image editing instruction' }).fill('Fix the arrows')
  await left.getByRole('button', { name: 'Send image edit' }).click()
  await expect(page.getByTestId('image-edit-pending')).toBeVisible()
  const request = await page.evaluate(
    () => (window as unknown as Fixture).imageEditFixture.requests[0]
  )
  expect(request).toMatchObject({ frameId: expect.any(String), branchId: expect.any(String) })
})

test('editing shows saved v1 and v2 even without image-edit tasks', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 850 })
  await page.goto('/image-edit.html?conversation&versions')
  await page.getByTestId('preview-edit-image').click()
  const strip = page.getByTestId('image-recent-results')
  const v1 = strip.locator('[data-image-strip-version="v1"]')
  const v2 = strip.locator('[data-image-strip-version="v2"]')
  await expect(v1).toContainText('v1')
  await expect(v2).toContainText('v2')
  await expect(v1).toHaveAttribute('aria-pressed', 'true')
  await v2.click()
  await expect(v2).toHaveAttribute('aria-pressed', 'true')
  await expect(v1).toHaveAttribute('aria-pressed', 'false')
  await page.screenshot({ path: 'test-results/image-edit-saved-versions.png' })
  const input = page.getByRole('textbox', { name: 'Image editing instruction' })
  await input.fill('Edit this saved version')
  await page.getByRole('button', { name: 'Send image edit' }).click()
  expect(
    await page.evaluate(
      () => (window as unknown as Fixture).imageEditFixture.requests[0].edit.source.sourceVersionId
    )
  ).toBe('v2')
  await expect(v1).toBeVisible()
  await expect(v2).toBeVisible()
})

test('Compare remains visible and compares saved versions without image task provenance', async ({
  page
}) => {
  await page.setViewportSize({ width: 1100, height: 850 })
  await page.goto('/image-edit.html?conversation')
  await page.getByTestId('preview-edit-image').click()
  await expect(page.getByRole('button', { name: 'Compare', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Compare', exact: true })).toBeDisabled()
  await page.goto('/image-edit.html?conversation&versions')
  await page.getByTestId('preview-edit-image').click()
  await page.locator('[data-image-strip-version="v2"]').click()
  const compare = page.getByRole('button', { name: 'Compare', exact: true })
  await expect(compare).toBeEnabled()
  await compare.click()
  const canvas = page.getByRole('group', { name: 'Image comparison', exact: true })
  await expect(canvas).toBeVisible()
  await expect(canvas.getByRole('img', { name: 'Version 1', exact: true })).toBeVisible()
  await expect(canvas.getByRole('img', { name: 'Version 2', exact: true })).toBeVisible()
  await page.getByRole('slider', { name: 'Comparison position' }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('slider', { name: 'Comparison position' })).toHaveAttribute(
    'aria-valuenow',
    '51'
  )
  await page.screenshot({ path: 'test-results/image-edit-version-compare.png' })
  await page.keyboard.press('Escape')
  await expect(canvas).toHaveCount(0)
  await expect(compare).toBeFocused()
  await expect(page.locator('[data-image-strip-version="v2"]')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
})

test('expanding the workbench moves an active composer with its draft', async ({ page }) => {
  await page.goto('/image-edit.html?conversation&workbench')
  const left = page.getByTestId('conversation-pane')
  const instruction = { name: 'Image editing instruction' }
  await expect(page.getByTestId('preview-edit-image')).toBeVisible()
  await page.screenshot({ path: 'test-results/image-edit-workbench-toolbar.png' })
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLImageElement>('[data-image-annotation-surface] img')?.naturalWidth
  )
  const fullImageAcquires = await page.evaluateHandle(() => {
    const acquire = window.api.previewResources.acquire
    const requests: string[] = []
    window.api.previewResources.acquire = (request) => {
      if (request.imagePreview === true) requests.push(request.source)
      return acquire(request)
    }
    return requests
  })
  await page.getByTestId('preview-edit-image').click()
  await page.waitForFunction(
    () => document.querySelector<HTMLImageElement>('[data-image-edit-surface] img')?.naturalWidth
  )
  expect.soft(await fullImageAcquires.jsonValue()).toEqual([])
  await fullImageAcquires.dispose()
  await left.getByRole('textbox', instruction).fill('Keep these instructions')
  const pauseDialogAnimation = await page.addStyleTag({
    content: '[role="dialog"] { animation-play-state: paused !important; }'
  })
  await page.getByRole('button', { name: /Open full screen preview of/i }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('textbox', instruction)).toHaveValue('Keep these instructions')
  await expect(left.getByRole('textbox', instruction)).toHaveCount(0)
  await expect.poll(() => imageSelectionAlignmentError(page, true)).toBeLessThanOrEqual(2)
  await pauseDialogAnimation.evaluate((style) => {
    style.parentNode?.removeChild(style)
  })
  await dialog.evaluate((node) => Promise.all(node.getAnimations().map(({ finished }) => finished)))
  await expect.poll(() => imageSelectionAlignmentError(page, true)).toBeLessThanOrEqual(2)
  await page.screenshot({ path: 'test-results/image-edit-expanded-workbench.png' })
  await page.keyboard.press('Escape')
  await expect(left.getByRole('textbox', instruction)).toHaveValue('Keep these instructions')
  await left.getByRole('button', { name: 'Back to conversation' }).click()
  await page.getByRole('button', { name: /Open full screen preview of/i }).click()
  await dialog.locator('[data-image-annotation-surface]').click()
  await expect(dialog.getByTestId('image-editor')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Edit image', exact: true }).click()
  await expect(dialog.getByRole('textbox', instruction)).toHaveValue('Keep these instructions')
})
