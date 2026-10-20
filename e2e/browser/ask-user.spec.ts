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
    await expect(page.getByTestId('choice-kind-chip')).toHaveText('Multi select')
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

  test(`${surface} labels single select and retains only the latest choice`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 700 })
    await page.goto(`/ask-user.html?single=1${surface === 'delegate' ? '&delegate=1' : ''}`)
    await expect(page.getByTestId('choice-kind-chip')).toHaveText('Single select')
    const first =
      surface === 'main'
        ? page.getByTestId('elicitation-option-Option 1')
        : page.getByRole('button', { name: 'Option 1', exact: true })
    const second =
      surface === 'main'
        ? page.getByTestId('elicitation-option-Option 2')
        : page.getByRole('button', { name: 'Option 2', exact: true })
    await first.click()
    await second.click()
    await expect(first).toHaveAttribute('aria-pressed', 'false')
    await expect(second).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: 'Finish', exact: true }).click()
    const response = JSON.parse(await page.getByTestId('submitted-answer').innerText())
    expect(surface === 'main' ? response.answers : response.delegatedQuestion.answers).toEqual([
      {
        ...(surface === 'main' ? { fieldId: 'question_0' } : { questionIndex: 0 }),
        value: 'Option 2'
      }
    ])
    if (surface === 'main') {
      await expect(
        page.getByTestId('elicitation-answer-summary').getByTestId('choice-kind-chip')
      ).toHaveText('Single select')
      await page.getByTestId('elicitation-answer-row').click()
      await expect(page.getByTestId('choice-kind-chip')).toHaveText([
        'Single select',
        'Single select'
      ])
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
  })
}

test('mixed questions keep long localized chips clear of the progress indicator on narrow screens', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 700 })
  await page.goto('/ask-user.html?mixed=1&locale=ru')
  await expect(page.getByTestId('choice-kind-chip')).toHaveText('Несколько вариантов')
  const progress = page.getByTestId('elicitation-question-progress')
  const title = page.getByRole('heading', { name: 'Which outputs?', exact: true })
  const progressBox = await progress.boundingBox()
  const titleBox = await title.boundingBox()
  expect(progressBox!.y + progressBox!.height).toBeLessThanOrEqual(titleBox!.y)
  expect(
    await title.evaluate(
      (element) => element.clientWidth - parseFloat(getComputedStyle(element).paddingRight)
    )
  ).toBeGreaterThan(100)
  await page.getByTestId('elicitation-option-Option 1').click()
  await page.getByRole('button', { name: 'Следующий вопрос', exact: true }).click()
  await expect(page.getByTestId('choice-kind-chip')).toHaveText('Один вариант')
  await page.getByTestId('elicitation-option-Option 2').click()
  await page.getByRole('button', { name: 'Завершить', exact: true }).click()
  const rows = page.getByTestId('elicitation-answer-row')
  await expect(rows.nth(0).getByTestId('choice-kind-chip')).toHaveText('Несколько вариантов')
  await expect(rows.nth(1).getByTestId('choice-kind-chip')).toHaveText('Один вариант')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  )
})
