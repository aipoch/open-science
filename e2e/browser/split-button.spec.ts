import { expect, test, type Page } from '@playwright/test'

const geometry = (
  page: Page
): Promise<{
  side: string | undefined
  gap: number
  groupWidth: number
  panelWidth: number
  left: number
  right: number
  radii: string[]
  groupRadii: string[]
  connected: string | undefined
  clip: string
  background: string
  buttonBackground: string
}> =>
  page.evaluate(() => {
    const group = document.querySelector<HTMLElement>('[data-split-group]')!
    const panel = document.querySelector<HTMLElement>('[data-split-panel]')!
    const a = group.getBoundingClientRect(),
      b = panel.getBoundingClientRect()
    const p = getComputedStyle(panel),
      g = getComputedStyle(group)
    return {
      side: panel.dataset.side,
      gap: panel.dataset.side === 'top' ? a.top - b.bottom : b.top - a.bottom,
      groupWidth: a.width,
      panelWidth: b.width,
      left: b.left,
      right: b.right,
      radii: [
        p.borderTopLeftRadius,
        p.borderTopRightRadius,
        p.borderBottomRightRadius,
        p.borderBottomLeftRadius
      ],
      groupRadii: [
        g.borderTopLeftRadius,
        g.borderTopRightRadius,
        g.borderBottomRightRadius,
        g.borderBottomLeftRadius
      ],
      connected: group.dataset.connected,
      clip: p.clipPath,
      background: p.backgroundColor,
      buttonBackground: getComputedStyle(group.querySelector('button')!).backgroundColor
    }
  })

for (const bottom of [false, true]) {
  test(`resolves ${bottom ? 'up' : 'down'} despite the opposite preference and joins both edges`, async ({
    page
  }) => {
    await page.goto(`/split-button.html${bottom ? '?bottom=1' : ''}`)
    await page.getByRole('button', { name: 'Options' }).click()
    await expect(page.getByRole('menu')).toBeVisible()
    await expect.poll(async () => (await geometry(page)).connected).toBe('true')
    const rect = await geometry(page)
    expect(rect.side).toBe(bottom ? 'top' : 'bottom')
    expect(Math.abs(rect.gap)).toBeLessThanOrEqual(1.5)
    expect(Math.abs(rect.groupWidth - rect.panelWidth)).toBeLessThan(1)
    expect(rect.background).not.toBe(rect.buttonBackground)
    expect(rect.radii.slice(bottom ? 2 : 0, bottom ? 4 : 2)).toEqual(['0px', '0px'])
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Options' })).toBeFocused()
  })
}

test('wide panel avoids the viewport and retains only exposed corner radii', async ({ page }) => {
  await page.setViewportSize({ width: 330, height: 400 })
  await page.goto('/split-button.html?wide=1&shift=1&bottom=1&dark=1')
  await page.getByRole('button', { name: 'Options' }).click()
  await expect.poll(async () => (await geometry(page)).connected).toBe('true')
  const rect = await geometry(page)
  expect(rect.left).toBeGreaterThanOrEqual(0)
  expect(rect.right).toBeLessThanOrEqual(330)
  expect(rect.panelWidth).toBeGreaterThan(rect.groupWidth)
  expect(rect.radii[2]).not.toBe('0px')
  await page.waitForTimeout(260)
  await page.screenshot({ path: 'test-results/split-button-wide.png' })
})

test('reverses an in-flight close on the same panel without moving the anchor or scaling text', async ({
  page
}) => {
  await page.goto('/split-button.html?bottom=1&wide=1')
  const trigger = page.getByRole('button', { name: 'Options' })
  await trigger.click()
  await expect(page.getByRole('menu')).toBeVisible()
  const before = await trigger.boundingBox()
  await page.evaluate(() => {
    ;(window as unknown as { originalPanel: Element }).originalPanel =
      document.querySelector('[data-split-panel]')!
  })
  const point = { x: before!.x + before!.width / 2, y: before!.y + before!.height / 2 }
  await page.mouse.click(point.x, point.y)
  await page.waitForTimeout(50)
  await page.mouse.click(point.x, point.y)
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  expect(
    await page.evaluate(
      () =>
        document.querySelector('[data-split-panel]') ===
        (window as unknown as { originalPanel: Element }).originalPanel
    )
  ).toBe(true)
  expect(await trigger.boundingBox()).toEqual(before)
  expect(
    await page
      .getByRole('menuitem')
      .first()
      .evaluate((el) => getComputedStyle(el).transform)
  ).toBe('none')
  await page.waitForTimeout(270)
  expect(
    (await geometry(page)).clip
      .match(/[0-9.]+/g)
      ?.map(Number)
      .every((value) => value === 0)
  ).toBe(true)
})

test('keeps independent availability and keyboard menu selection', async ({ page }) => {
  await page.goto('/split-button.html?main-off=1')
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Options' }).focus()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'Plan' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'Branch' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('result')).toHaveText('Branch')
  await page.goto('/split-button.html?menu-off=1')
  await expect(page.getByRole('button', { name: 'Options' })).toBeDisabled()
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByTestId('result')).toHaveText('send')
})

test('scope choice does not submit until the primary button is activated', async ({ page }) => {
  await page.goto('/split-button.html?scope=1&bottom=1')
  await page.getByRole('button', { name: 'Choose authorization scope' }).click()
  await page.getByRole('menuitemradio', { name: 'Once This call only' }).click()
  await expect(page.getByTestId('result')).toBeEmpty()
  await page.getByRole('button', { name: 'Allow once', exact: true }).click()
  await expect(page.getByTestId('result')).toHaveText('once')
})

test('reduced motion removes the reveal animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/split-button.html')
  await page.getByRole('button', { name: 'Options' }).click()
  expect(
    await page
      .getByRole('menu')
      .evaluate((el) => el.getAnimations().filter((a) => a.playState === 'running').length)
  ).toBe(0)
})

test('question skip is recorded per question while the menu still declines the whole request', async ({
  page
}) => {
  await page.goto('/ask-user.html?mixed=1')
  await page.getByRole('button', { name: 'Skip', exact: true }).click()
  await expect(page.getByTestId('submitted-answer')).toBeEmpty()
  await expect(page.getByTestId('elicitation-question-progress')).toHaveText('2 of 2')
  await page.getByTestId('elicitation-option-Option 2').click()
  await page.getByRole('button', { name: 'Finish', exact: true }).click()
  expect(JSON.parse(await page.getByTestId('submitted-answer').innerText()).answers).toContainEqual(
    { fieldId: 'question_0', status: 'skipped' }
  )
  await expect(page.getByTestId('elicitation-answer-summary')).toContainText('User skipped')
  await page.goto('/ask-user.html?mixed=1')
  await page.getByRole('button', { name: 'More skip options' }).click()
  await page.getByRole('menuitem', { name: 'Skip all' }).click()
  expect(JSON.parse(await page.getByTestId('submitted-answer').innerText()).action).toBe('decline')
})

test('short conversation picker keeps search and new conversation reachable while its list scrolls', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 430 })
  await page.goto('/library-workbench.html')
  await page.getByRole('button', { name: 'Choose another conversation' }).click()
  const search = page.getByRole('combobox', { name: 'Search conversations' })
  for (let index = 0; index < 9; index++) await search.press('ArrowDown')
  await expect(search).toBeInViewport({ ratio: 1 })
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeInViewport({
    ratio: 1
  })
  await search.fill('#35')
  await search.press('Enter')
  await expect(page.getByRole('status').filter({ hasText: 'session-34:' })).toBeVisible()
})

test('touch targets remain distinct and single actions never auto-open', async ({ browser }) => {
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 640 }
  })
  const page = await context.newPage()
  await page.goto('http://127.0.0.1:4178/split-button.html')
  const trigger = page.getByRole('button', { name: 'Options' })
  expect((await trigger.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  expect((await trigger.boundingBox())!.width).toBeGreaterThanOrEqual(44)
  await expect(page.getByRole('menu')).toHaveCount(0)
  await trigger.tap()
  await expect(page.getByRole('menu')).toBeVisible()
  await page.getByRole('menuitem', { name: 'Plan' }).tap()
  await expect(page.getByTestId('result')).toHaveText('Plan')
  await page.goto('http://127.0.0.1:4178/split-button.html?single=1')
  await expect(trigger).toHaveCount(0)
  await expect(page.getByRole('menu')).toHaveCount(0)
  await context.close()
})

test('an exiting panel does not steal focus from the next control', async ({ page }) => {
  await page.goto('/split-button.html')
  await page.getByRole('button', { name: 'Options' }).click()
  await expect(page.getByRole('menuitem', { name: 'Plan' })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Outside' }).focus()
  await expect(page.locator('[data-split-panel]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Outside' })).toBeFocused()
})

for (const kind of ['menu', 'popover']) {
  for (const backwards of [false, true]) {
    test(`${kind}: Escape then ${backwards ? 'Shift+Tab' : 'Tab'} navigates during exit`, async ({
      page
    }) => {
      await page.goto(`/split-button.html${kind === 'popover' ? '?popover=1' : ''}`)
      const trigger = page.getByRole('button', { name: 'Options' })
      await trigger.focus()
      await page.keyboard.press('Enter')
      await page
        .getByRole(kind === 'menu' ? 'menuitem' : 'button', { name: 'Plan', exact: true })
        .focus()
      await page.waitForTimeout(260)
      const panel = page.locator('[data-split-panel]')
      const original = await panel.elementHandle()
      await page.keyboard.press('Escape')
      // No retry: focus must return before the 160 ms exit completes.
      expect(await trigger.evaluate((node) => node === document.activeElement)).toBe(true)
      expect(await original!.evaluate((node) => node.isConnected)).toBe(true)
      await original!.evaluate((node) => {
        const action = node.querySelector<HTMLElement>('[role="menuitem"], button')!
        action.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        action.click()
      })
      await page.keyboard.press(backwards ? 'Shift+Tab' : 'Tab')
      const destination = page.getByRole('button', {
        name: backwards ? 'Send' : 'After',
        exact: true
      })
      await expect(destination).toBeFocused()
      await expect(panel).toHaveCount(0)
      await expect(destination).toBeFocused()
      await expect(page.getByTestId('result')).toBeEmpty()
    })
  }

  test(`${kind}: outside close then retained reopen resets Escape focus restoration`, async ({
    page
  }) => {
    await page.goto(`/split-button.html${kind === 'popover' ? '?popover=1' : ''}`)
    const trigger = page.getByRole('button', { name: 'Options' })
    await trigger.click()
    await expect(page.locator('[data-split-panel]')).toBeVisible()
    await page.waitForTimeout(260)
    const original = await page.locator('[data-split-panel]').elementHandle()
    const outside = await page.getByRole('button', { name: 'Outside' }).boundingBox()
    const arrow = await trigger.boundingBox()
    // Real pointer events without locator actionability waits inside the exit window.
    await page.mouse.click(outside!.x + outside!.width / 2, outside!.y + outside!.height / 2)
    await page.mouse.click(arrow!.x + arrow!.width / 2, arrow!.y + arrow!.height / 2)
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(
      await original!.evaluate((node) => node === document.querySelector('[data-split-panel]'))
    ).toBe(true)
    await page
      .getByRole(kind === 'menu' ? 'menuitem' : 'button', { name: 'Plan', exact: true })
      .focus()
    await page.keyboard.press('Escape')
    expect(await trigger.evaluate((node) => node === document.activeElement)).toBe(true)
    await expect(page.locator('[data-split-panel]')).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await expect(page.getByTestId('result')).toHaveText('outside')
  })
}

test('Escape then Enter during exit cannot execute the cancelled menu action', async ({ page }) => {
  await page.goto('/split-button.html')
  await page.getByRole('button', { name: 'Options' }).focus()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'Plan' })).toBeFocused()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('result')).toBeEmpty()
  // Enter now reaches the restored trigger and reopens, rather than activating the cancelled item.
  await expect(page.getByRole('button', { name: 'Options' })).toHaveAttribute(
    'aria-expanded',
    'true'
  )
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-split-panel]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Options' })).toBeFocused()
})

test('reopening a retained scope menu restores its selected option and keyboard navigation', async ({
  page
}) => {
  await page.goto('/split-button.html?scope=1')
  const trigger = page.getByRole('button', { name: 'Choose authorization scope' })
  await trigger.click()
  const selected = page.getByRole('menuitemradio', {
    name: 'This conversation Remembered for this conversation',
    exact: true
  })
  await expect(selected).toBeFocused()
  const original = await page.locator('[data-split-panel]').elementHandle()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Enter')
  await expect(selected).toBeFocused()
  expect(
    await original!.evaluate((node) => node === document.querySelector('[data-split-panel]'))
  ).toBe(true)
  await page.keyboard.press('ArrowDown')
  await expect(
    page.getByRole('menuitemradio', {
      name: 'This project Remembered for this project',
      exact: true
    })
  ).toBeFocused()
  await expect(page.getByTestId('result')).toBeEmpty()
})

for (const url of ['/split-button.html?scope=1', '/web-permission.html']) {
  test(`filled approval segments have no unpainted joining borders (${url})`, async ({ page }) => {
    await page.goto(url)
    const group = page.locator('[data-split-group]').first()
    await expect(group).toBeVisible()
    await expect(group.locator('[data-split-primary]')).toHaveCSS('border-right-width', '0px')
    await expect(group.locator('[data-split-trigger]')).toHaveCSS('border-left-width', '0px')
    expect(
      await group
        .locator('[data-split-trigger]')
        .evaluate((node) => getComputedStyle(node, '::after').width)
    ).toBe('1px')
  })
}

test('expanded skipped answers use the translated sentinel', async ({ page }) => {
  await page.goto('/ask-user.html?mixed=1&locale=zh-Hans')
  await page.getByRole('button', { name: '跳过', exact: true }).click()
  await page.getByTestId('elicitation-option-Option 2').click()
  await page.getByRole('button', { name: '完成', exact: true }).click()
  const record = page.getByTestId('elicitation-question-record').first()
  const answer = record.getByTestId('elicitation-answer-row')
  await expect(answer).toHaveText('用户跳过')
  await answer.click()
  await expect(record.getByTestId('elicitation-choice-review')).toContainText('用户跳过')
  await expect(record.getByTestId('elicitation-choice-review')).not.toContainText('User skipped')
})

test('interrupted reopen honors an owner that prevents autofocus', async ({ page }) => {
  await page.goto('/split-button.html?prevent-focus=1')
  const trigger = page.getByRole('button', { name: 'Options' })
  await trigger.focus()
  await trigger.click()
  await expect(trigger).toBeFocused()
  const original = await page.locator('[data-split-panel]').elementHandle()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Enter')
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await expect(trigger).toBeFocused()
  expect(
    await original!.evaluate((node) => node === document.querySelector('[data-split-panel]'))
  ).toBe(true)
})

test('interrupted conversation picker reopen focuses its search field', async ({ page }) => {
  await page.goto('/library-workbench.html')
  const trigger = page.getByRole('button', { name: 'Choose another conversation' })
  await trigger.click()
  const search = page.getByRole('combobox', { name: 'Search conversations' })
  await expect(search).toBeFocused()
  const original = await page.locator('[data-split-panel]').elementHandle()
  await page.keyboard.press('Escape')
  await trigger.focus()
  await page.keyboard.press('Enter')
  await expect(search).toBeFocused()
  expect(
    await original!.evaluate((node) => node === document.querySelector('[data-split-panel]'))
  ).toBe(true)
})
