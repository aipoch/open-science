import { expect, test } from '@playwright/test'

test('PDF outline follows same-page sections and navigates native destinations at the current zoom', async ({
  page
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.setViewportSize({ width: 1100, height: 650 })
  await page.goto('/pdf-outline.html')
  await page.getByRole('button', { name: 'Show navigation' }).click()
  const reader = page.getByRole('region', { name: 'outline.pdf scrollable preview' })
  const second = page.getByRole('treeitem', { name: 'Second heading', exact: true })
  await second.click()
  await expect(second).toHaveAttribute('aria-selected', 'true')
  // Verify the actual text destination, not only a page counter or selected CSS class.
  const destinationTop = async (text: string): Promise<number> =>
    page.evaluate((text) => {
      const reader = document.querySelector('[role="region"]')!
      const heading = [...reader.querySelectorAll('.textLayer span')].find(
        (span) => span.textContent === text
      )!
      // Offscreen pages mount their text layer asynchronously after outline navigation.
      return heading
        ? heading.getBoundingClientRect().top - reader.getBoundingClientRect().top
        : Infinity
    }, text)
  await expect.poll(() => destinationTop('Second heading')).toBeLessThan(100)
  await expect.poll(() => destinationTop('Second heading')).toBeGreaterThan(0)
  await expect(page.getByRole('button', { name: 'Reset zoom' })).toBeDisabled()
  await page.getByRole('treeitem', { name: 'Same destination alias' }).click()
  await expect(page.getByRole('treeitem', { name: 'Same destination alias' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await page.getByRole('treeitem', { name: 'First heading', exact: true }).click()
  await expect.poll(() => destinationTop('First heading')).toBeLessThan(100)
  await reader.hover()
  await page.mouse.wheel(0, 800)
  await expect(second).toHaveAttribute('aria-selected', 'true')
  await page.mouse.wheel(0, -700)
  await expect(page.getByRole('treeitem', { name: 'First heading', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await page.getByRole('treeitem', { name: 'Rotated heading', exact: true }).click()
  await expect(
    page.getByRole('treeitem', { name: 'Rotated heading', exact: true })
  ).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => destinationTop('Rotated heading')).toBeLessThan(100)
  await expect.poll(() => destinationTop('Rotated heading')).toBeGreaterThan(0)
  await page.getByRole('button', { name: 'Pages', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Page 1', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Page 2 · i', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Page 3 · 1', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})
