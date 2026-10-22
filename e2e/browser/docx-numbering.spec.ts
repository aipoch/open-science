import { expect, test } from '@playwright/test'

for (const paginated of [false, true]) {
  test(`DOCX list numbering continues ${paginated ? 'across pages' : 'within a page'} and restarts for a new list`, async ({
    page
  }, testInfo) => {
    await page.goto(`/docx-numbering.html${paginated ? '?pages' : ''}`)
    const preview = page.locator('[data-office-preview-ready="true"]')
    await expect(preview).toBeVisible()
    await expect(preview.locator('section.docx')).toHaveCount(paginated ? 2 : 1)
    await expect(preview.locator('p.docx-num-1-0, p.docx-num-2-0')).toHaveCount(7)

    // CSS counter() expressions in computed styles do not expose their painted values. Chromium's
    // accessibility tree does; fixture prose deliberately contains no standalone numeric text.
    const cdp = await page.context().newCDPSession(page)
    const expectNumbering = async (): Promise<void> => {
      const { nodes } = await cdp.send('Accessibility.getFullAXTree')
      const numbers = nodes
        .filter((node) => node.role?.value === 'StaticText' && /^\d+$/.test(node.name?.value ?? ''))
        .map((node) => node.name!.value)
      expect(numbers).toEqual(['1', '2', '3', '4', '5', '1', '2'])
    }
    try {
      await expectNumbering()
      await preview.getByRole('button', { name: 'Zoom in', exact: true }).click()
      const wrapper = preview.locator('.docx-wrapper')
      const scale = (): Promise<string> =>
        wrapper.evaluate((element) =>
          (element as HTMLElement).style.getPropertyValue('--open-science-docx-scale')
        )
      const beforeResize = await scale()
      await page.setViewportSize({ width: 480, height: 500 })
      await expect.poll(scale).not.toBe(beforeResize)
      await preview.getByText('Next item', { exact: true }).scrollIntoViewIfNeeded()
      await expectNumbering()
      await page.screenshot({ path: testInfo.outputPath('numbering.png'), fullPage: true })
    } finally {
      await cdp.detach()
    }
  })
}
