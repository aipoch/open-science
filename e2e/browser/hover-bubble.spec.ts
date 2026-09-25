import { expect, test, type Locator } from '@playwright/test'

// Sample real browser keyframes at known times without relying on machine/frame scheduling.
async function sampleEntry(content: Locator): Promise<void> {
  await expect
    .poll(() =>
      content.evaluate((el) =>
        el
          .getAnimations()
          .some((a) => a instanceof CSSAnimation && a.animationName === 'hover-bubble-enter')
      )
    )
    .toBe(true)
  const samples = await content.evaluate((el) => {
    const animation = el
      .getAnimations()
      .find((a) => a instanceof CSSAnimation && a.animationName === 'hover-bubble-enter')!
    animation.pause()
    const samples = [0, 72, 144, 192, 240].map((time) => {
      animation.currentTime = time
      const style = getComputedStyle(el)
      return { opacity: Number(style.opacity), scale: new DOMMatrixReadOnly(style.transform).a }
    })
    animation.finish()
    return samples
  })
  expect(samples[0].scale).toBeCloseTo(0.9)
  expect(samples[0].opacity).toBe(0)
  expect(samples[1].scale).toBeGreaterThan(samples[0].scale)
  expect(samples[1].scale).toBeLessThan(samples[2].scale)
  expect(samples[1].opacity).toBeGreaterThan(0)
  expect(samples[1].opacity).toBeLessThan(1)
  expect(samples[2]).toEqual({ opacity: 1, scale: 1.02 })
  expect(samples[3].scale).toBeGreaterThan(1)
  expect(samples[3].scale).toBeLessThan(samples[2].scale)
  expect(samples[3].opacity).toBe(1)
  expect(samples[4]).toEqual({ opacity: 1, scale: 1 })
}

for (const side of ['top', 'right', 'bottom', 'left']) {
  test(`grows from the ${side} anchor without moving its trigger`, async ({ page }) => {
    await page.goto('/hover-bubble.html')
    const trigger = page.getByRole('button', { name: side, exact: true })
    const before = await trigger.boundingBox()
    // Pause at animationstart so even a busy CI worker can inspect the entry keyframes.
    await page.evaluate(() =>
      document.addEventListener('animationstart', (event) => {
        if (event.animationName === 'hover-bubble-enter')
          (event.target as HTMLElement).getAnimations().forEach((a) => a.pause())
      })
    )
    await trigger.hover()
    const bubble = page.getByTestId(`bubble-${side}`)
    await expect(bubble).toHaveAttribute('data-state', 'delayed-open')
    await expect(bubble).toHaveAttribute('data-side', side)
    await sampleEntry(bubble)
    const origin = await bubble.evaluate((el) => {
      const style = getComputedStyle(el)
      const box = el.getBoundingClientRect()
      const expected = style.getPropertyValue('--radix-tooltip-content-transform-origin').trim()
      return {
        actual: style.transformOrigin.split(' ').map(parseFloat),
        expected: expected
          .split(' ')
          .map((part, axis) =>
            part.endsWith('%')
              ? (parseFloat(part) / 100) * (axis === 0 ? box.width : box.height)
              : parseFloat(part)
          )
      }
    })
    expect(origin.expected).toHaveLength(2)
    origin.actual.forEach((value, axis) => expect(value).toBeCloseTo(origin.expected[axis], 2))
    expect(await trigger.boundingBox()).toEqual(before)
  })
}

test('animates warm tooltips and fades closed content before removing it', async ({ page }) => {
  await page.goto('/hover-bubble.html')
  await page.getByRole('button', { name: 'top', exact: true }).hover()
  await expect(page.getByTestId('bubble-top')).toHaveAttribute('data-state', 'delayed-open')
  await expect(page.getByTestId('bubble-top')).toHaveCSS('transform', 'none')
  await page.evaluate(() =>
    document.addEventListener('animationstart', (event) => {
      if (event.animationName.startsWith('hover-bubble-'))
        (event.target as HTMLElement).getAnimations().forEach((a) => a.pause())
    })
  )
  // Leave the hoverable-content grace corridor before entering the next trigger.
  await page.mouse.move(0, 0, { steps: 5 })
  await page.getByRole('button', { name: 'right', exact: true }).hover()
  const next = page.getByTestId('bubble-right')
  await expect(next).toHaveAttribute('data-state', 'instant-open')
  await sampleEntry(next)
  const previous = page.getByTestId('bubble-top')
  await expect(previous).toHaveAttribute('data-state', 'closed')
  await expect(previous).toHaveCSS('pointer-events', 'none')
  await previous.evaluate((el) => el.getAnimations().forEach((a) => a.finish()))
  await expect(previous).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(next).toHaveAttribute('data-state', 'closed')
  const opacity = await next.evaluate((el) => {
    const animation = el.getAnimations()[0]
    animation.currentTime = 45
    const opacity = Number(getComputedStyle(el).opacity)
    animation.finish()
    return opacity
  })
  expect(opacity).toBeGreaterThan(0)
  expect(opacity).toBeLessThan(1)
  await expect(next).toHaveCount(0)
})

test('keeps keyboard tooltip focus and immediate reduced-motion dismissal', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/hover-bubble.html')
  const outside = page.getByRole('button', { name: 'Outside', exact: true })
  await outside.focus()
  await page.keyboard.press('Tab')
  const trigger = page.getByRole('button', { name: 'top', exact: true })
  await expect(trigger).toBeFocused()
  const bubble = page.getByTestId('bubble-top')
  await expect(bubble).toHaveAttribute('data-state', 'instant-open')
  await expect(bubble).toHaveCSS('animation-name', 'none')
  await expect(bubble).toHaveCSS('transform', 'none')
  await page.keyboard.press('Escape')
  await expect(bubble).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await page.getByRole('button', { name: 'View Skill availability for 2 agents' }).hover()
  const preview = page.locator('[data-slot="skill-usage-agents-popover"]')
  await expect(preview).toHaveCSS('animation-name', 'none')
  await page.keyboard.press('Escape')
  await expect(preview).toHaveCount(0)
})

test('preserves hover-to-action and click-only popover behavior', async ({ page }) => {
  await page.goto('/hover-bubble.html')
  await page.getByRole('button', { name: 'Outside', exact: true }).focus()
  const trigger = page.getByRole('button', { name: 'View Skill availability for 2 agents' })
  await trigger.hover()
  const preview = page.locator('[data-slot="skill-usage-agents-popover"]')
  await expect(preview).toHaveCSS('animation-name', 'hover-bubble-enter')
  await expect(page.getByRole('button', { name: 'Outside', exact: true })).toBeFocused()
  await preview.getByRole('button', { name: 'Open Analyst in Specialist Settings' }).click()
  await expect(page.getByRole('status', { name: 'Opened specialist' })).toHaveText('Analyst')
  await expect(preview).toHaveCount(0)
  await page.getByRole('button', { name: 'Click panel', exact: true }).click()
  await expect(page.getByTestId('click-panel')).toHaveCSS('animation-name', 'none')
})

test('keeps session rename protected during row switching and returns keyboard focus', async ({
  page
}) => {
  await page.goto('/hover-bubble.html')
  const row = page.getByRole('button', { name: 'First row', exact: true })
  await row.hover()
  const preview = page.locator('[data-slot="session-preview-content"][data-state="open"]')
  await expect(preview).toHaveCSS('animation-name', 'hover-bubble-enter')
  await preview.getByRole('button', { name: 'Rename session title' }).click()
  const input = page.getByRole('textbox', { name: 'Session title' })
  await input.fill('Unsaved title')
  await page.getByRole('button', { name: 'Second row', exact: true }).hover()
  await expect(input).toHaveValue('Unsaved title')
  await expect(input).toBeFocused()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-slot="session-preview-content"]')).toHaveCount(0)
  await expect(row).toBeFocused()
})

for (const dark of [false, true]) {
  test(`keeps long copy inside a narrow viewport after collision flip (${dark ? 'dark' : 'light'})`, async ({
    page
  }) => {
    await page.setViewportSize({ width: 390, height: 700 })
    await page.goto(`/hover-bubble.html${dark ? '?dark' : ''}`)
    await page.getByRole('button', { name: 'Edge', exact: true }).hover()
    const bubble = page.getByTestId('edge-bubble')
    await expect(bubble).toHaveAttribute('data-side', 'left')
    await expect(bubble).toHaveCSS('transform', 'none')
    const box = (await bubble.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)
    const size = await bubble.evaluate((el) => ({ scroll: el.scrollWidth, width: el.clientWidth }))
    expect(size.scroll).toBeLessThanOrEqual(size.width + 1)
  })
}

test('uses a 200ms cold delay and a 300ms shared skip window', async ({ page }) => {
  await page.goto('/hover-bubble.html')
  const first = page.getByRole('button', { name: 'top', exact: true })
  const next = page.getByRole('button', { name: 'right', exact: true })
  const firstBox = (await first.boundingBox())!
  const nextBox = (await next.boundingBox())!
  await page.clock.install()
  await page.clock.pauseAt(new Date())
  await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2, {
    steps: 5
  })
  await page.clock.runFor(199)
  expect(await page.getByTestId('bubble-top').count()).toBe(0)
  await page.clock.runFor(1)
  await expect(page.getByTestId('bubble-top')).toHaveAttribute('data-state', 'delayed-open')
  await page.mouse.move(0, 0, { steps: 5 })
  await page.clock.runFor(299)
  await page.mouse.move(nextBox.x + nextBox.width / 2, nextBox.y + nextBox.height / 2, { steps: 5 })
  await page.clock.runFor(1)
  await expect(page.getByTestId('bubble-right')).toHaveAttribute('data-state', 'instant-open')
  await page.mouse.move(0, 0, { steps: 5 })
  await page.clock.runFor(301)
  await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2, {
    steps: 5
  })
  await page.clock.runFor(199)
  expect(await page.getByTestId('bubble-top').count()).toBe(0)
  await page.clock.runFor(1)
  await expect(page.getByTestId('bubble-top')).toHaveAttribute('data-state', 'delayed-open')
})

test('shows shared hints for every Home header icon action', async ({ page }) => {
  await page.goto('/button-feedback.html?home')
  for (const [label, hint] of [
    ['Search', 'Search (Cmd/Ctrl+K)'],
    ['Library', 'Library'],
    ['Messages, no unread messages', 'Message center'],
    ['Model settings', 'Settings'],
    ['New project', 'New project']
  ]) {
    const trigger = page.getByRole('button', { name: label, exact: true })
    await expect(trigger).not.toHaveAttribute('title')
    await trigger.hover()
    await expect(page.getByRole('tooltip')).toHaveText(hint)
    const bubble = page.locator('[data-slot="tooltip-content"][data-state$="open"]')
    await expect(bubble).toHaveClass(/hover-bubble/)
    await expect(bubble).toHaveClass(/bg-text-000/)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('tooltip')).toHaveCount(0)
  }
})

test('shares Home hover intent across standalone header components', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/button-feedback.html?home')
  const actions = [
    page.getByRole('button', { name: 'Search', exact: true }),
    page.getByRole('link', { name: /Star Open-Science on GitHub/ }),
    page.getByRole('button', { name: 'Library', exact: true }),
    page.getByRole('button', { name: 'Messages, no unread messages', exact: true }),
    page.getByRole('button', { name: 'Model settings', exact: true }),
    page.locator('.update-reminder[data-variant="home"]'),
    page.getByRole('button', { name: 'New project', exact: true })
  ]
  await expect(actions[0]).toBeVisible()
  await page.clock.install()
  await page.clock.pauseAt(new Date())
  for (const [index, action] of actions.entries()) {
    const box = (await action.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 })
    await page.clock.runFor(index === 0 ? 200 : 1)
    await expect(page.locator('[data-slot="tooltip-content"]')).toHaveAttribute(
      'data-state',
      index === 0 ? 'delayed-open' : 'instant-open'
    )
    await expect(action).toHaveAttribute('aria-describedby')
  }
})
