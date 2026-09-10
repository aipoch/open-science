import { expect, test } from '@playwright/test'

test('keeps the trigger when a text drag ends outside its surface and clears stale selection', async ({
  page
}) => {
  await page.goto('/text-annotation.html')
  const paragraph = page.getByTestId('paragraph-0')
  const box = (await paragraph.boundingBox())!
  await page.mouse.move(box.x + 1, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width + 80, box.y + box.height / 2, { steps: 15 })
  await page.mouse.up()
  expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('第一段中文')
  const trigger = page.locator('[data-annotation-trigger]')
  await expect(trigger).toBeVisible()

  // Native selection changes can happen without a mouseup on the owning surface.
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await expect(trigger).toHaveCount(0)

  const second = (await page.getByTestId('paragraph-1').boundingBox())!
  await page.mouse.move(second.x + 1, second.y + second.height / 2)
  await page.mouse.down()
  await page.mouse.move(second.x + 180, second.y + second.height / 2, { steps: 10 })
  await page.mouse.up()
  await expect(trigger).toHaveCount(1)
  await expect(trigger).toBeVisible()
  await trigger.click()
  await expect(page.getByRole('textbox')).toBeVisible()
  await page.getByRole('textbox').press('Escape')
  await expect(page.getByRole('textbox')).toHaveCount(0)
  await expect(trigger).toBeVisible()
  await trigger.click()
  await expect(page.getByRole('textbox')).toBeVisible()
})

test('retains the selected quote when rendered text nodes are replaced', async ({ page }) => {
  await page.goto('/text-annotation.html')
  const paragraph = page.getByTestId('paragraph-0')
  const box = (await paragraph.boundingBox())!
  await page.mouse.move(box.x + 1, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 180, box.y + box.height / 2, { steps: 10 })
  await page.mouse.up()
  const trigger = page.locator('[data-annotation-trigger]')
  await expect(trigger).toBeVisible()
  // Streamed markdown can rebuild text nodes without changing the quoted text.
  await paragraph.evaluate((element) => {
    element.replaceChildren(document.createTextNode(element.textContent!))
    return new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    )
  })
  await expect(trigger).toBeVisible()
  await trigger.click()
  await expect(page.getByRole('textbox')).toBeVisible()
})
