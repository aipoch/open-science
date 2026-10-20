import { expect, test } from '@playwright/test'

for (const surface of ['main', 'delegate']) {
  test(`${surface} supports 16 choices and keyboard multi-selection`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 700 })
    await page.goto(`/ask-user.html${surface === 'delegate' ? '?delegate=1' : ''}`)
    const first =
      surface === 'main'
        ? page.getByTestId('elicitation-option-Option 1')
        : page.getByRole('button', { name: 'Option 1', exact: true })
    const last =
      surface === 'main'
        ? page.getByTestId('elicitation-option-Option 16')
        : page.getByRole('button', { name: 'Option 16', exact: true })
    await expect(page.getByText('Select one or more options')).toBeVisible()
    await first.click()
    await first.press('Tab')
    await page.keyboard.press('Space')
    await last.click()
    await expect(first).toHaveAttribute('aria-pressed', 'true')
    await expect(last).toHaveAttribute('aria-pressed', 'true')
    const finish = page.getByRole('button', { name: 'Finish', exact: true })
    await expect(finish).toBeInViewport({ ratio: 1 })
    await finish.click()
    const response = JSON.parse(await page.getByTestId('submitted-answer').innerText())
    expect(surface === 'main' ? response.answers : response.delegatedQuestion.answers).toEqual([
      {
        ...(surface === 'main' ? { fieldId: 'question_0' } : { questionIndex: 0 }),
        value: ['Option 1', 'Option 2', 'Option 16']
      }
    ])
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
  })
}
