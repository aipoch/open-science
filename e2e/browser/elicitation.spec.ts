import { expect, test } from '@playwright/test'

test('keeps multi-question progress and drafts while the panel collapses and the inline entry reveals it', async ({
  page
}) => {
  await page.goto('/elicitation.html')
  const entry = page.getByRole('button', { name: '3 questions awaiting your answer', exact: true })
  await expect(entry).toBeVisible()
  await expect(page.getByRole('heading', { level: 3 })).toHaveCount(1)
  await page.getByTestId('elicitation-option-data').click()
  await page.getByRole('button', { name: 'Next question', exact: true }).click()
  await page.getByRole('textbox', { name: 'Type your own answer' }).fill('Use my RNA-seq dataset')
  const viewport = await page
    .getByTestId('transcript-viewport')
    .evaluate((element) => ({ height: element.clientHeight, scrollTop: element.scrollTop }))
  await page.getByRole('button', { name: 'Collapse question panel', exact: true }).click()
  await expect(page.getByTestId('elicitation-choice-mode')).toBeHidden()
  await expect(page.getByTestId('elicitation-question-progress')).toHaveText('2 of 3')
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeHidden()
  expect(
    await page
      .getByTestId('transcript-viewport')
      .evaluate((element) => ({ height: element.clientHeight, scrollTop: element.scrollTop }))
  ).toEqual(viewport)
  await entry.click()
  const input = page.getByRole('textbox', { name: 'Type your own answer' })
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('Use my RNA-seq dataset')
  await page.getByRole('button', { name: 'Previous question', exact: true }).click()
  await expect(page.getByTestId('elicitation-option-data')).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Next question', exact: true }).click()
  await expect(input).toHaveValue('Use my RNA-seq dataset')
  await page.getByRole('button', { name: 'Next question', exact: true }).click()
  await page.getByTestId('elicitation-option-report').click()
  await page.getByRole('button', { name: 'Finish', exact: true }).click()
  await expect(page.getByTestId('elicitation-composer')).toHaveCount(0)
  await expect(page.getByTestId('elicitation-answer-row')).toHaveCount(3)
})

test('single-question collapse omits progress and keeps keyboard access to the whole pending label', async ({
  page
}) => {
  await page.setViewportSize({ width: 360, height: 740 })
  await page.goto('/elicitation.html?questions=1')
  await expect(page.getByTestId('elicitation-question-progress')).toHaveCount(0)
  await page.getByRole('button', { name: 'Collapse question panel', exact: true }).click()
  const entry = page.getByRole('button', { name: '1 question awaiting your answer', exact: true })
  await entry.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('elicitation-choice-mode')).toBeVisible()
  await expect(page.getByTestId('elicitation-option-literature')).toBeFocused()
})

test('revealing a scrolled-away choice keeps the focused option visible without moving the transcript', async ({
  page
}) => {
  await page.setViewportSize({ width: 360, height: 540 })
  await page.goto('/elicitation.html')
  const option = page.getByTestId('elicitation-option-literature')
  const options = page.getByTestId('elicitation-options')
  await option.click()
  await options.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  const clipped = await option.evaluate((element) => {
    const viewport = element.parentElement!.getBoundingClientRect()
    return element.getBoundingClientRect().bottom <= viewport.top
  })
  expect(clipped).toBe(true)
  const before = await page
    .getByTestId('transcript-viewport')
    .evaluate((element) => ({ height: element.clientHeight, scrollTop: element.scrollTop }))
  await page.getByRole('button', { name: 'Collapse question panel', exact: true }).click()
  await page.getByRole('button', { name: '3 questions awaiting your answer', exact: true }).click()
  await expect(option).toBeFocused()
  const visible = await option.evaluate((element) => {
    const viewport = element.parentElement!
    const top = viewport.getBoundingClientRect().top + viewport.clientTop
    const bounds = element.getBoundingClientRect()
    return bounds.top >= top - 1 && bounds.bottom <= top + viewport.clientHeight + 1
  })
  expect(visible).toBe(true)
  expect(
    await page
      .getByTestId('transcript-viewport')
      .evaluate((element) => ({ height: element.clientHeight, scrollTop: element.scrollTop }))
  ).toEqual(before)
})

test('the maximum question count fits with collapse and expand in a narrow translated panel', async ({
  page
}) => {
  await page.setViewportSize({ width: 320, height: 740 })
  await page.goto('/elicitation.html?questions=8&locale=zh-Hans')
  await expect(page.getByTestId('elicitation-question-progress-segment')).toHaveCount(8)
  await page.getByRole('button', { name: '收起问题面板', exact: true }).click()
  const geometry = await page.getByTestId('elicitation-panel-toolbar').evaluate((element) => {
    const progress = element
      .querySelector('[data-testid="elicitation-question-progress"]')!
      .getBoundingClientRect()
    const button = element.querySelector('button')!.getBoundingClientRect()
    return {
      fits: element.scrollWidth <= element.clientWidth,
      separated: progress.right <= button.left,
      aligned: Math.abs((progress.top + progress.bottom - button.top - button.bottom) / 2) < 1
    }
  })
  expect(geometry).toEqual({ fits: true, separated: true, aligned: true })
  await page.getByRole('button', { name: '展开问题面板', exact: true }).click()
  await expect(page.getByTestId('elicitation-choice-mode')).toBeVisible()
})
