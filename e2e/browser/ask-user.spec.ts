import { expect, test } from '@playwright/test'

for (const height of [700, 400, 300]) {
  test(`long question remains readable and actionable at 390×${height}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height })
    await page.goto('/ask-user.html?mixed=1&embedded=1&long=1')
    const options = page.getByTestId('elicitation-options')
    const skip = page.getByRole('button', { name: 'Skip', exact: true })
    await expect
      .poll(() => options.evaluate((node) => node.clientHeight))
      .toBeGreaterThanOrEqual(40)
    await expect(skip).toBeInViewport({ ratio: 1 })
    const title = page.getByRole('heading', { name: /Question line 1/ })
    await expect(title).toHaveText(
      Array.from({ length: 24 }, (_, index) => `Question line ${index + 1}`).join('\n')
    )
    const titleScroll = page.getByTestId('elicitation-question-title')
    await expect(titleScroll).toHaveAccessibleName(/Question line 24/)
    const footerBefore = await skip.boundingBox()
    await titleScroll.focus()
    await page.keyboard.press('End')
    await expect.poll(() => titleScroll.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
    expect((await skip.boundingBox())!.y).toBeCloseTo(footerBefore!.y, 0)
    await page.getByTestId('elicitation-option-Option 16').click()
    await expect(page.getByRole('button', { name: 'Next question', exact: true })).toBeInViewport({
      ratio: 1
    })
    await page.getByRole('button', { name: 'Next question', exact: true }).click()
    await expect(page.getByRole('heading', { name: /Which approach/ })).toBeVisible()
    await skip.click()
    expect(JSON.parse(await page.getByTestId('submitted-answer').innerText())).toMatchObject({
      action: 'accept',
      answers: [
        { fieldId: 'question_0', value: ['Option 16'] },
        { fieldId: 'question_1', status: 'skipped' }
      ]
    })
  })
}

test('embedded question keeps its title and actions fixed while scrolling and resizing choices', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 700 })
  await page.goto('/ask-user.html?mixed=1&embedded=1')
  const title = page.getByRole('heading', { name: 'Which outputs?', exact: true })
  const skipAll = page.getByRole('button', { name: 'More skip options', exact: true })
  const options = page.getByTestId('elicitation-option-Option 1').locator('..')
  await expect(skipAll).toBeInViewport({ ratio: 1 })
  const titleBefore = await title.boundingBox()
  const footerBefore = await skipAll.boundingBox()
  await options.hover()
  await page.mouse.wheel(0, 1000)
  await expect.poll(() => options.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
  expect((await title.boundingBox())!.y).toBeCloseTo(titleBefore!.y, 0)
  expect((await skipAll.boundingBox())!.y).toBeCloseTo(footerBefore!.y, 0)
  expect(
    await page.getByTestId('elicitation-composer-scroll').evaluate((node) => node.scrollTop)
  ).toBe(0)
  const handle = page.getByRole('separator', { name: 'Resize question panel' })
  await handle.focus()
  await handle.press('ArrowDown')
  const smaller = await page.getByTestId('elicitation-composer').boundingBox()
  await expect(title).toBeInViewport({ ratio: 1 })
  await expect(skipAll).toBeInViewport({ ratio: 1 })
  await handle.press('ArrowUp')
  expect((await page.getByTestId('elicitation-composer').boundingBox())!.height).toBeGreaterThan(
    smaller!.height
  )
  for (let index = 0; index < 12; index += 1) await handle.press('ArrowDown')
  await page.getByRole('button', { name: 'Skip', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Which approach', exact: false })).toBeVisible()
  await expect.poll(() => options.evaluate((node) => node.scrollTop)).toBe(0)
  await page.getByRole('textbox').fill('One\nTwo\nThree\nFour\nFive\nSix\nSeven\nEight')
  await expect(page.getByRole('button', { name: 'Finish', exact: true })).toBeInViewport({
    ratio: 1
  })
  await expect(skipAll).toBeInViewport({ ratio: 1 })
  await page.screenshot({ path: test.info().outputPath('question-fixed-actions.png') })
  await page.getByRole('button', { name: 'Skip', exact: true }).click()
  expect(JSON.parse(await page.getByTestId('submitted-answer').innerText())).toMatchObject({
    action: 'accept',
    answers: [
      { fieldId: 'question_0', status: 'skipped' },
      { fieldId: 'question_1', status: 'skipped' }
    ]
  })
})

test('split skip menu supports dismissal, focus return, and explicit skipping of all questions', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 700 })
  await page.goto('/ask-user.html?mixed=1&embedded=1&dark=1')
  const trigger = page.getByRole('button', { name: 'More skip options', exact: true })
  const skip = page.getByRole('button', { name: 'Skip', exact: true })
  await expect(page.getByRole('menuitem', { name: 'Skip all', exact: true })).toHaveCount(0)
  await skip.focus()
  await page.keyboard.press('Tab')
  await expect(trigger).toBeFocused()
  await trigger.press('ArrowDown')
  const menuItem = page.getByRole('menuitem', { name: 'Skip all', exact: true })
  await expect(menuItem).toBeFocused()
  await expect(page.getByTestId('submitted-answer')).toHaveText('')
  await page.keyboard.press('Escape')
  await expect(menuItem).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await skip.click()
  await expect(page.getByRole('heading', { name: 'Which approach', exact: false })).toBeVisible()
  await trigger.click()
  await expect(menuItem).toBeVisible()
  expect(await menuItem.locator('..').getAttribute('data-side')).toBe('bottom')
  await page.screenshot({ path: test.info().outputPath('split-skip-menu.png') })
  await menuItem.click()
  await expect(menuItem).toHaveCount(0)
  expect(JSON.parse(await page.getByTestId('submitted-answer').innerText())).toMatchObject({
    action: 'decline'
  })
})

test('Chinese single-question skip is recorded and remains reviewable', async ({ page }) => {
  await page.goto('/ask-user.html?locale=zh-Hans')
  await page.getByRole('button', { name: '跳过', exact: true }).click()
  await expect(page.getByTestId('elicitation-answer-row')).toHaveText('用户跳过')
  expect(JSON.parse(await page.getByTestId('submitted-answer').innerText())).toMatchObject({
    action: 'accept',
    answers: [{ fieldId: 'question_0', status: 'skipped' }]
  })
  const presentation = (): Promise<Record<string, string | null | undefined>> =>
    page.getByTestId('elicitation-answer-row').evaluate((row) => {
      const icon = row.firstElementChild!
      const label = row.children[1].firstElementChild!
      return {
        text: row.textContent,
        iconBackground: getComputedStyle(icon).backgroundColor,
        iconColor: getComputedStyle(icon).color,
        textColor: getComputedStyle(label).color,
        fontWeight: getComputedStyle(label).fontWeight,
        strokeWidth: icon.querySelector('svg')?.getAttribute('stroke-width')
      }
    })
  const skippedPresentation = await presentation()
  await page.getByTestId('elicitation-answer-row').click()
  await expect(
    page.getByTestId('elicitation-choice-review').locator('[data-selected="true"]')
  ).toHaveCount(0)
  await page.reload()
  await page.getByRole('button', { name: '更多跳过选项', exact: true }).click()
  await page.getByRole('menuitem', { name: '跳过全部', exact: true }).click()
  await expect(page.getByTestId('elicitation-answer-row')).toHaveText('用户跳过')
  expect(await presentation()).toEqual(skippedPresentation)
})

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
      await expect(page.getByTestId('choice-kind-chip')).toHaveText('Single select')
      await expect(page.getByRole('heading', { name: 'Which outputs?' })).toHaveCount(1)
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
  const records = page.getByTestId('elicitation-question-record')
  await expect(records.nth(0).getByTestId('choice-kind-chip')).toHaveText('Несколько вариантов')
  await expect(records.nth(1).getByTestId('choice-kind-chip')).toHaveText('Один вариант')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  )
})

test('three recorded questions expose independent answer disclosures without repeating titles', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 800 })
  await page.goto('/ask-user.html?review=1')
  const records = page.getByTestId('elicitation-question-record')
  await expect(records).toHaveCount(3)
  await expect(page.getByRole('heading')).toHaveText([
    'Which outputs?',
    'Which approach should we use for the next phase of this research project?',
    'Which resources are available?'
  ])
  await expect(page.getByText('3 questions', { exact: false })).toHaveCount(0)
  const firstAnswer = records.nth(0).getByTestId('elicitation-answer-row')
  await expect(firstAnswer).toHaveText('Option 1, Option 3')
  await records.nth(0).getByRole('heading').click()
  await expect(firstAnswer).toHaveAttribute('aria-expanded', 'false')
  await firstAnswer.focus()
  await page.keyboard.press('Enter')
  await expect(firstAnswer).toHaveAttribute('aria-expanded', 'true')
  await expect(firstAnswer).toBeFocused()
  const options = records.nth(0).getByTestId('elicitation-choice-review')
  await expect(options.getByRole('heading')).toHaveCount(0)
  await expect(options.getByTestId('choice-kind-chip')).toHaveCount(0)
  await expect(options.locator('[data-testid^="elicitation-option-"]')).toHaveCount(16)
  await expect(options.getByTestId('elicitation-option-Option 1')).toHaveAttribute(
    'data-selected',
    'true'
  )
  await expect(options.getByTestId('elicitation-option-Option 3')).toHaveAttribute(
    'data-selected',
    'true'
  )
  await expect(options.getByTestId('elicitation-option-Option 16')).toHaveAttribute(
    'data-selected',
    'false'
  )
  const secondAnswer = records.nth(1).getByTestId('elicitation-answer-row')
  await secondAnswer.focus()
  await page.keyboard.press('Space')
  await expect(secondAnswer).toHaveAttribute('aria-expanded', 'true')
  await firstAnswer.click()
  await expect(firstAnswer).toHaveAttribute('aria-expanded', 'false')
  await expect(secondAnswer).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('heading')).toHaveCount(3)
  await expect(page.getByTestId('choice-kind-chip')).toHaveCount(3)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  )
})

test('Chinese agent-decide answers stay translated while the submitted value stays stable', async ({
  page
}) => {
  await page.goto('/ask-user.html?locale=zh-Hans')
  await page.getByRole('button', { name: '让智能体决定', exact: true }).click()
  await expect(page.getByRole('textbox')).toHaveValue('')
  await page.getByRole('button', { name: '完成', exact: true }).click()
  const answer = page.getByTestId('elicitation-answer-row')
  await expect(answer).toHaveText('让智能体决定')
  expect(JSON.parse(await page.getByTestId('submitted-answer').innerText()).answers).toEqual([
    { fieldId: 'question_0_custom', status: 'answered', value: 'Let the agent decide' }
  ])
  await answer.click()
  const review = page.getByTestId('elicitation-choice-review')
  await expect(review.getByText('让智能体决定', { exact: true })).toBeVisible()
  await expect(page.getByTestId('elicitation-answer-summary')).not.toContainText(
    'Let the agent decide'
  )
})

for (const side of ['top', 'bottom'] as const) {
  test(`skip menu connects to the control and fits a narrow window when opening ${side}`, async ({
    page
  }) => {
    await page.setViewportSize({ width: 320, height: 500 })
    await page.goto('/ask-user.html?single=1&locale=zh-Hans')
    const skip = page.getByRole('button', { name: '跳过', exact: true, includeHidden: true })
    const group = skip.locator('..')
    // Put the real control at either viewport edge to exercise Radix collision placement.
    await group.evaluate((element, openingSide) => {
      Object.assign((element as HTMLElement).style, {
        position: 'fixed',
        right: '8px',
        top: openingSide === 'bottom' ? '8px' : 'auto',
        bottom: openingSide === 'top' ? '8px' : 'auto'
      })
    }, side)
    await page.getByRole('button', { name: '更多跳过选项' }).click()
    const menu = page.getByRole('menu')
    await expect(menu).toHaveAttribute('data-side', side)
    const groupBox = (await group.boundingBox())!
    const menuBox = (await menu.boundingBox())!
    expect(Math.abs(menuBox.width - groupBox.width)).toBeLessThan(1)
    const gap =
      side === 'top'
        ? groupBox.y - menuBox.y - menuBox.height
        : menuBox.y - groupBox.y - groupBox.height
    expect(gap).toBeLessThanOrEqual(0)
    expect(gap).toBeGreaterThanOrEqual(-1.5)
    expect(menuBox.x).toBeGreaterThanOrEqual(0)
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(320)
    await expect
      .poll(() =>
        menu.evaluate((element) =>
          Math.max(...(getComputedStyle(element).clipPath.match(/[\d.]+/g) ?? []).map(Number))
        )
      )
      .toBe(0)
    const radii = await group.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        top: parseFloat(style.borderTopRightRadius),
        bottom: parseFloat(style.borderBottomRightRadius)
      }
    })
    expect(radii[side]).toBe(0)
    expect(radii[side === 'top' ? 'bottom' : 'top']).toBeGreaterThan(0)
    await page.screenshot({ path: test.info().outputPath(`connected-skip-${side}.png`) })
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect
      .poll(() => group.evaluate((element) => getComputedStyle(element).borderRadius))
      .toBe('8px')
  })
}

test('skip menu reverses its edge animation smoothly and keeps the arrow in sync', async ({
  page
}) => {
  await page.goto('/ask-user.html?single=1')
  const trigger = page.getByRole('button', { name: 'More skip options' })
  const menu = page.getByTestId('question-skip-menu')
  await trigger.click()
  await expect(menu).toBeVisible()
  await expect(menu).toHaveAttribute('data-connected', 'true')
  expect(
    await menu.evaluate(
      (element) =>
        element
          .getAnimations()
          .find(
            (animation) =>
              animation.effect instanceof KeyframeEffect &&
              animation.effect.getKeyframes().some((frame) => 'clipPath' in frame)
          )
          ?.effect?.getTiming().duration
    )
  ).toBe(240)
  expect(
    await trigger.locator('svg').evaluate((element) => getComputedStyle(element).transitionDuration)
  ).toBe('0.24s')
  await expect
    .poll(() =>
      menu.evaluate((element) =>
        Math.max(...(getComputedStyle(element).clipPath.match(/[\d.]+/g) ?? []).map(Number))
      )
    )
    .toBe(0)
  await menu.evaluate((element) => {
    ;(element as HTMLElement).dataset.instance = 'original'
    // Freeze both the clip and Radix Presence animation partway through the exit.
    // Driver round trips on a busy CI runner must not consume the 160 ms reversal window.
    let frame = 0
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame)
      if (element.getAttribute('data-state') !== 'closed') return
      frame = requestAnimationFrame(() => {
        if (element.getAttribute('data-state') !== 'closed') return
        for (const animation of element.getAnimations()) {
          animation.pause()
          animation.currentTime = 40
        }
      })
    })
    observer.observe(element, { attributes: true, attributeFilter: ['data-state'] })
    element.addEventListener(
      'stop-freezing-exit',
      () => {
        observer.disconnect()
        cancelAnimationFrame(frame)
        for (const animation of element.getAnimations()) {
          if (animation.playState === 'paused') animation.play()
        }
      },
      { once: true }
    )
  })
  await page.keyboard.press('Escape')
  await expect
    .poll(() =>
      menu.evaluate(
        (element) =>
          element
            .getAnimations()
            .find(
              (animation) =>
                animation.effect instanceof KeyframeEffect &&
                animation.effect.getKeyframes().some((frame) => 'clipPath' in frame) &&
                animation.playState === 'paused'
            )
            ?.effect?.getTiming().duration
      )
    )
    .toBe(160)
  expect(
    await trigger.locator('svg').evaluate((element) => getComputedStyle(element).transitionDuration)
  ).toBe('0.16s')
  // Reopen through the real trigger while the original node is still exiting.
  const before = await menu.evaluate((element) => getComputedStyle(element).clipPath)
  expect(before).not.toBe('inset(0%)')
  await trigger.click()
  await expect(menu).toHaveAttribute('data-instance', 'original')
  const after = await menu.evaluate((element) => getComputedStyle(element).clipPath)
  const clip = (value: string): number => Math.max(...(value.match(/[\d.]+/g) ?? []).map(Number))
  expect(clip(after)).toBeLessThan(100)
  expect(Math.abs(clip(after) - clip(before))).toBeLessThan(35)
  await expect
    .poll(() =>
      menu.evaluate((element) =>
        Math.max(...(getComputedStyle(element).clipPath.match(/[\d.]+/g) ?? []).map(Number))
      )
    )
    .toBe(0)
  await page.keyboard.press('Escape')
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'Skip all' })).toBeFocused()
  await expect(menu).toHaveAttribute('data-instance', 'original')
  await menu.dispatchEvent('stop-freezing-exit')
  await page.getByRole('heading', { name: 'Which outputs?' }).click()
  await expect(menu).toHaveCount(0)
})

test('skip control honors reduced motion without delaying Escape focus return', async ({
  page
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/ask-user.html?single=1')
  const trigger = page.getByRole('button', { name: 'More skip options' })
  await trigger.press('ArrowDown')
  const menu = page.getByTestId('question-skip-menu')
  await expect(page.getByRole('menuitem', { name: 'Skip all' })).toBeFocused()
  expect(await menu.evaluate((element) => element.getAnimations().length)).toBe(0)
  expect(await trigger.locator('svg').evaluate((element) => element.getAnimations().length)).toBe(0)
  expect(
    await menu.evaluate((element) =>
      Math.max(...(getComputedStyle(element).clipPath.match(/[\d.]+/g) ?? []).map(Number))
    )
  ).toBe(0)
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test('Escape restores focus immediately and a following Tab is not undone by exit motion', async ({
  page
}) => {
  await page.goto('/ask-user.html?single=1')
  const trigger = page.getByRole('button', { name: 'More skip options' })
  await page.evaluate(() => {
    const next = document.createElement('button')
    next.textContent = 'Following control'
    next.id = 'following-skip-control'
    document.querySelector('[data-testid="question-skip-control"]')!.after(next)
  })
  await trigger.press('ArrowDown')
  await page.keyboard.press('Escape')
  // Observe focus before the 160 ms exit can finish.
  expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true)
  await page.keyboard.press('Tab')
  const next = page.locator('#following-skip-control')
  await expect(next).toBeFocused()
  await expect(page.getByTestId('question-skip-menu')).toHaveCount(0)
  await expect(next).toBeFocused()
})

for (const side of ['top', 'bottom'] as const) {
  test(`skip menu visibly expands ${side} after placement without depending on starting-style`, async ({
    page
  }) => {
    await page.goto('/ask-user.html?single=1')
    await page.getByTestId('question-skip-control').evaluate((element, openingSide) => {
      Object.assign((element as HTMLElement).style, {
        position: 'fixed',
        right: '16px',
        top: openingSide === 'bottom' ? '16px' : 'auto',
        bottom: openingSide === 'top' ? '16px' : 'auto'
      })
    }, side)
    const clips = await page.evaluate(async () => {
      // Portal measurement must not rely on a browser synthesizing @starting-style on mount.
      const removeStartingStyle = (sheet: CSSStyleSheet | CSSGroupingRule): void => {
        for (let index = sheet.cssRules.length - 1; index >= 0; index--) {
          const rule = sheet.cssRules[index]
          if (
            rule.cssText.startsWith('@starting-style') &&
            rule.cssText.includes('question-skip-menu')
          ) {
            sheet.deleteRule(index)
          } else if ('cssRules' in rule) removeStartingStyle(rule as CSSGroupingRule)
        }
      }
      for (const sheet of document.styleSheets) removeStartingStyle(sheet)
      const trigger = document.querySelector<HTMLButtonElement>('[aria-label="More skip options"]')!
      trigger.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })
      )
      const samples: number[] = []
      const start = performance.now()
      while (performance.now() - start < 500) {
        await new Promise(requestAnimationFrame)
        const menu = document.querySelector<HTMLElement>('[data-testid="question-skip-menu"]')
        if (!menu) continue
        const rect = menu.getBoundingClientRect()
        if (rect.top < 0 || rect.bottom > innerHeight) continue
        samples.push(
          Math.max(...(getComputedStyle(menu).clipPath.match(/[\d.]+/g) ?? []).map(Number))
        )
      }
      return samples
    })
    expect(clips[0]).toBeGreaterThan(80)
    expect(clips.some((clip) => clip > 1 && clip < 99)).toBe(true)
    expect(clips.at(-1)).toBe(0)
    await expect(page.getByRole('menu')).toHaveAttribute('data-side', side)
  })
}
