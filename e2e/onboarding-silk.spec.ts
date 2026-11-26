import { expect } from '@playwright/test'
import type { CDPSession, Locator } from 'playwright'
import sharp from 'sharp'
import { test } from './fixtures/electron-app'
import { startWebModel } from './fixtures/web-model'

test.use({ windowMode: 'normal' })

const pixels = (canvas: Locator): Promise<string> =>
  canvas.evaluate((element: HTMLCanvasElement) => {
    const sample = document.createElement('canvas')
    sample.width = sample.height = 32
    const ctx = sample.getContext('2d')!
    ctx.drawImage(element, 0, 0, 32, 32)
    const rgba = ctx.getImageData(0, 0, 32, 32).data
    const shades = new Set<number>()
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i + 3]) shades.add((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2])
    }
    if (shades.size < 3) throw new Error('Silk has not painted a textured frame')
    return sample.toDataURL()
  })

const waitForCardTransitions = (card: Locator): Promise<void> =>
  card.evaluate(async (element) => {
    const transitions = element
      .getAnimations({ subtree: true })
      .filter(
        (animation) =>
          animation instanceof CSSTransition &&
          animation.effect?.getTiming().iterations !== Infinity
      )
    await Promise.allSettled(transitions.map((animation) => animation.finished))
  })

const expectStableCard = async (card: Locator, frame: string): Promise<void> => {
  await waitForCardTransitions(card)
  const screenPixels = async (): Promise<Buffer> =>
    sharp(await card.screenshot())
      .removeAlpha()
      .raw()
      .toBuffer()
  const settled = await screenPixels()
  for (let sample = 0; sample < 3; sample++) {
    await card.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
    expect(await pixels(card.locator('canvas'))).toBe(frame)
    const current = await screenPixels()
    expect(current.length).toBe(settled.length)
    // Include the mask and controls, allowing two levels of compositor rounding per channel.
    expect(current.some((value, i) => Math.abs(value - settled[i]) > 2)).toBe(false)
  }
}

test('animates only the hovered Silk card and keeps keyboard focus visually stable', async ({
  app
}, info) => {
  const { page } = app
  await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.locator('[data-onboarding-action="next"]').click()
  const connect = page.locator('[data-onboarding-entry="connect"]')
  const header = connect.locator('header')
  await header.hover()
  const card = connect.locator('.onboarding-provider-card-anthropic')
  const control = connect.locator('.onboarding-provider-card-openai')
  const canvas = card.locator('canvas')
  const otherCanvas = control.locator('canvas')
  const tray = card.locator('.onboarding-provider-card-actions')
  const idle = await pixels(canvas)
  const otherIdle = await pixels(otherCanvas)
  await expectStableCard(card, idle)
  await card.screenshot({ path: info.outputPath('anthropic-idle.png') })

  await card.hover()
  await expect.poll(() => pixels(canvas)).not.toBe(idle)
  const moving = await pixels(canvas)
  expect(await pixels(otherCanvas)).toBe(otherIdle)
  await expect.poll(() => pixels(canvas)).not.toBe(moving)
  expect(await pixels(otherCanvas)).toBe(otherIdle)
  await expect(tray).toHaveCSS('opacity', '1')
  await card.screenshot({ path: info.outputPath('anthropic-hover.png') })

  await header.hover()
  await expect(tray).toHaveCSS('opacity', '0')
  const stopped = await pixels(canvas)
  expect(stopped).not.toBe(idle)
  await expectStableCard(card, stopped)

  // Tab through the carousel as a keyboard user while the pointer remains on the header.
  const focusable = await connect.locator('button:enabled, input:enabled').count()
  for (let i = 0; i < focusable && !(await card.locator(':focus').count()); i++) {
    await page.keyboard.press('Tab')
  }
  await expect(card.locator(':focus')).toBeFocused()
  await expect(tray).toHaveCSS('opacity', '1')
  await expectStableCard(card, stopped)
  expect(await pixels(otherCanvas)).toBe(otherIdle)
})

test('keeps the provider tray translucent in both themes and sizes each step to its content', async ({
  app
}) => {
  const { page } = app
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  const connect = page.locator('[data-onboarding-entry="connect"]')
  const header = connect.locator('header')
  const card = connect.locator('.onboarding-provider-card-anthropic')
  const silk = card.locator('.onboarding-provider-silk')
  const tray = card.locator('.onboarding-provider-card-actions')
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expect
      .poll(() => page.locator('html').evaluate((el) => el.classList.contains('dark')))
      .toBe(colorScheme === 'dark')
    await header.hover()
    await expect(card).toHaveCSS('background-color', 'rgb(26, 26, 25)')
    await expect(card).toHaveCSS('background-size', '180% 180%')
    await expect(silk).toHaveCSS('opacity', '0.52')
    await card.hover()
    await expect(silk).toHaveCSS('opacity', '0.68')
    await expect(tray).toHaveCSS('opacity', '1')
    await expect(tray).toHaveCSS('border-top-width', '0px')
    await expect(tray).toHaveCSS('backdrop-filter', 'blur(18px) saturate(1.12)')
    await expect(tray).toHaveCSS('background-image', /linear-gradient\(.*0\.46\)\)/)
  }

  const feedback = connect.locator('.onboarding-quick-feedback')
  await expect(feedback).toHaveCSS('overflow-y', 'auto')
  await expect(feedback.locator('footer')).toHaveCSS('margin-top', '0px')
  expect(await connect.evaluate((el) => el.computedStyleMap().get('height')?.toString())).toBe(
    'auto'
  )
  expect(await connect.evaluate((el) => el.computedStyleMap().get('min-height')?.toString())).toBe(
    'auto'
  )
  expect(await connect.evaluate((el) => getComputedStyle(el).maxHeight)).toBe(
    await page
      .getByRole('dialog', { name: 'Open-Science onboarding' })
      .evaluate((el) => getComputedStyle(el).maxHeight)
  )
  await connect.getByRole('button', { name: 'Advanced options' }).click()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Set up the agent runtime' })).toBeVisible()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.locator('[data-provider-kind="custom"]').click()
  await expect(page.locator('#provider-base-url')).toBeVisible()
  await page.getByRole('button', { name: 'Change provider', exact: true }).click()
  await expect(page.getByRole('searchbox', { name: 'Search providers' })).toBeVisible()
  await page.getByRole('button', { name: 'Continue with free Kilo Gateway', exact: true }).click()
  await page.getByRole('button', { name: 'Finish', exact: true }).click()
  const readyActions = page.locator('[data-onboarding-entry="ready"] .onboarding-ready-actions')
  await expect(readyActions).toBeVisible()
  expect(
    await readyActions.evaluate((el) => el.computedStyleMap().get('margin-top')?.toString())
  ).toBe('auto')
})

test('opens the full provider picker with the defaults and completes onboarding', async ({
  app
}, info) => {
  const { page } = app
  // A cancelled subscription can leave a different framework active before using the shortcut.
  await page.evaluate(() => window.api.settings.setAgentFramework({ id: 'codex' }))
  await page.reload()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const dialog = page.getByRole('dialog', { name: 'Open-Science onboarding' })
  await dialog.getByRole('button', { name: 'Next', exact: true }).click()
  const storage = await page.evaluate(() => window.api.storage.getInfo())
  expect(storage.isDefault).toBe(true)
  expect(
    await page.evaluate(async () => (await window.api.settings.getSettings()).agentFrameworkId)
  ).toBe('codex')

  const card = dialog
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: 'Looking for another provider?' }) })
  const action = card.getByRole('button', { name: 'Advanced mode' })
  await card.hover()
  await expect(action).toBeVisible()
  const tray = card.locator('.onboarding-provider-card-actions')
  await expect(tray).toHaveCSS('opacity', '1')
  const bounds = (await tray.boundingBox())!
  const button = (await action.boundingBox())!
  expect(Math.abs(button.x + button.width / 2 - (bounds.x + bounds.width / 2))).toBeLessThan(1)
  const offsetAboveCenter = bounds.y + bounds.height / 2 - (button.y + button.height / 2)
  expect(offsetAboveCenter).toBeGreaterThan(0)
  expect(offsetAboveCenter).toBeLessThanOrEqual(8)
  await action.focus()
  await expect(action).toBeFocused()
  await expect(tray).toHaveCSS('opacity', '1')
  await card.screenshot({ path: info.outputPath('advanced-mode-card.png') })
  await action.press('Enter')

  await expect(dialog.locator('[aria-current="step"]')).toHaveText('3Model provider')
  await expect(dialog.getByRole('searchbox', { name: 'Search providers' })).toBeVisible()
  expect(await page.evaluate(async () => (await window.api.storage.getInfo()).dataRoot)).toBe(
    storage.defaultDataRoot
  )
  expect(
    await page.evaluate(async () => (await window.api.settings.getSettings()).agentFrameworkId)
  ).toBe('open-science-agent')
  for (const id of ['cloudflare-ai-gateway', 'aws-bedrock', 'microsoft-foundry', 'vectrust']) {
    await expect(dialog.locator(`[data-provider-kind="official:${id}"]`)).toBeVisible()
  }
  await dialog.locator('[data-provider-kind="official:cloudflare-ai-gateway"]').click()
  await expect(dialog.locator('#provider-cloudflare-mode')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Continue with free Kilo Gateway' })).toHaveCount(
    0
  )
  await dialog.getByRole('button', { name: 'Change provider' }).click()
  await dialog.getByRole('button', { name: 'Continue with free Kilo Gateway', exact: true }).click()
  const settings = await page.evaluate(() => window.api.settings.getSettings())
  expect(settings.providers.find(({ id }) => id === settings.activeProviderId)?.vendorId).toBe(
    'kilo'
  )
  expect(settings.activeModel).toBe('kilo-auto/free')
  await expect(dialog.locator('[aria-current="step"]')).toHaveText('4Notebook runtime')
  await dialog.getByRole('button', { name: 'Finish', exact: true }).click()
  await dialog.getByRole('button', { name: 'Start exploring', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Projects' })).toBeVisible()
})

test('keeps search and filters pinned above the configured provider and its details', async ({
  app
}, info) => {
  const { page } = app
  const gateway = await startWebModel('deepseek-flash', () => 'OK')
  try {
    await page.evaluate(async (baseUrl) => {
      const model = 'deepseek-flash'
      const { providerId } = await window.api.settings.saveValidatedProvider({
        name: 'DeepSeek',
        type: 'custom',
        baseUrl,
        model,
        key: 'fixture-key',
        apiEndpoints: ['chat-completions']
      })
      if (!providerId) throw new Error('Fixture provider did not pass validation')
      await window.api.settings.setActiveProvider({ id: providerId, model })
    }, gateway.baseUrl)
    await page.reload()
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' })
    const dialog = page.getByRole('dialog', { name: 'Open-Science onboarding' })
    await dialog.getByRole('button', { name: 'Next', exact: true }).click()
    await dialog.getByRole('button', { name: 'Advanced mode', exact: true }).focus()
    await page.keyboard.press('Enter')

    const search = dialog.getByRole('searchbox', { name: 'Search providers' })
    const filters = dialog.getByRole('group', { name: 'Provider category' })
    const notice = dialog
      .getByRole('status')
      .filter({ hasText: 'Already configured: DeepSeek (deepseek-flash)' })
    const firstCard = dialog.locator('[data-provider-kind]').first()
    await expect(notice).toBeInViewport()
    const filterBounds = (await filters.boundingBox())!
    const noticeBounds = (await notice.boundingBox())!
    expect(filterBounds.y + filterBounds.height).toBeLessThan(noticeBounds.y)
    expect(noticeBounds.y + noticeBounds.height).toBeLessThan((await firstCard.boundingBox())!.y)
    await dialog.screenshot({ path: info.outputPath('configured-provider.png') })
    await search.hover()
    await page.mouse.wheel(0, 320)
    await expect(notice).not.toBeInViewport()
    const searchTop = (await search.boundingBox())!.y
    const filterTop = (await filters.boundingBox())!.y
    const cardTop = (await firstCard.boundingBox())!.y
    await page.mouse.wheel(0, 240)
    await expect.poll(async () => (await firstCard.boundingBox())!.y).toBeLessThan(cardTop - 100)
    expect((await search.boundingBox())!.y).toBeCloseTo(searchTop, 0)
    expect((await filters.boundingBox())!.y).toBeCloseTo(filterTop, 0)
    await expect(filters).toBeInViewport()
    await filters.getByRole('button', { name: /Model vendors/ }).click()
    await search.fill('DeepSeek')
    await dialog.locator('[data-provider-kind="official:deepseek"]').click()
    await expect(notice).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: 'Test & continue' })).toHaveAttribute(
      'data-variant',
      'default'
    )
    await dialog.screenshot({ path: info.outputPath('provider-details.png') })
    await dialog.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(notice).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled()
  } finally {
    await gateway.close()
  }
})

test('keeps the agent setup actions and Notebook actions pinned while their runtime lists scroll', async ({
  app
}, info) => {
  const { page } = app
  await page.setViewportSize({ width: 620, height: 500 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const dialog = page.getByRole('dialog', { name: 'Open-Science onboarding' })
  await dialog.getByRole('button', { name: 'Next', exact: true }).click()
  await dialog.getByRole('button', { name: 'Advanced options' }).click()
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click()
  const footer = dialog.locator('[data-slot="card-footer"]')
  const scroller = footer.locator('..')
  const bottomGap = (): Promise<number> =>
    footer.evaluate((el) =>
      Math.abs(
        el.closest('[role="dialog"]')!.getBoundingClientRect().bottom -
          el.getBoundingClientRect().bottom
      )
    )
  for (const [title, action] of [
    ['Set up the agent runtime', 'Continue'],
    ['Notebook runtime (optional)', 'Finish']
  ] as const) {
    const heading = dialog.getByRole('heading', { name: title, exact: true })
    await expect(heading).toBeVisible()
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight))
      .toBeGreaterThan(0)
    await scroller.evaluate((el) => el.scrollTo(0, 0))
    expect(await bottomGap()).toBeLessThanOrEqual(1)
    await heading.hover()
    await page.mouse.wheel(0, 220)
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
    expect(await bottomGap()).toBeLessThanOrEqual(1)
    const back = footer.getByRole('button', { name: 'Back', exact: true })
    const next = footer.getByRole('button', { name: action, exact: true })
    await expect(back).toBeInViewport({ ratio: 1 })
    await expect(next).toBeInViewport({ ratio: 1 })
    await back.click({ trial: true })
    if (action === 'Finish')
      await dialog.screenshot({ path: info.outputPath('notebook-footer.png') })
    await next.click()
    if (action === 'Continue') {
      await dialog.getByRole('button', { name: 'Continue with free Kilo Gateway' }).click()
    }
  }
  await expect(dialog.getByRole('button', { name: 'Start exploring' })).toBeVisible()
})

test('leaves space between a visible horizontal scrollbar and the quick-connect actions', async ({
  app
}, info) => {
  const { page } = app
  await page.setViewportSize({ width: 960, height: 740 })
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' })
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  const connect = page.locator('[data-onboarding-entry="connect"]')
  const scroller = connect.locator('.onboarding-provider-viewport > div')
  // Reserve a classic scrollbar on hosts that normally use overlay scrollbars.
  await page.addStyleTag({
    content: `
    .onboarding-provider-viewport > div { scrollbar-width: auto; }
    .onboarding-provider-viewport > div::-webkit-scrollbar { height: 12px; }
    .onboarding-provider-viewport > div::-webkit-scrollbar-thumb { background: gray; border-radius: 6px; }
  `
  })
  expect(
    await scroller.evaluate((el: HTMLDivElement) => el.offsetHeight - el.clientHeight)
  ).toBeGreaterThan(0)
  const skip = connect.getByRole('button', { name: /Skip to access free Kilo models/ })
  const track = (await scroller.boundingBox())!
  expect((await skip.boundingBox())!.y - (track.y + track.height)).toBeGreaterThanOrEqual(8)
  await connect.screenshot({ path: info.outputPath('quick-connect-scrollbar.png') })
  await skip.click({ trial: true })
})

test('shows the monochrome brand silhouettes in both card themes', async ({ app }, info) => {
  const { page } = app
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await expect
      .poll(() => page.locator('html').evaluate((el) => el.classList.contains('dark')))
      .toBe(theme === 'dark')
    for (const id of ['openai', 'anthropic', 'xai']) {
      const card = page.locator(`.onboarding-provider-card-${id}`)
      const mark = card.locator('h2').locator('xpath=preceding-sibling::*[1]')
      const png = await mark.screenshot({ path: info.outputPath(`${theme}-${id}.png`) })
      const pixels = await sharp(png).removeAlpha().greyscale().raw().toBuffer()
      const ink = pixels.filter((value) => value > 211).length / pixels.length
      expect(ink, `${theme} ${id} visible strokes`).toBeGreaterThan(0.05)
      expect(ink, `${theme} ${id} visible negative space`).toBeLessThan(0.85)
    }
  }
})

const tap = async (cdp: CDPSession, action: Locator): Promise<void> => {
  await action.scrollIntoViewIfNeeded()
  const bounds = (await action.boundingBox())!
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }]
  })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

test('reveals individual actions on a hybrid mouse and touchscreen', async ({ app }) => {
  const page = await app.openAdditionalRenderer({ mouseAndTouch: true })
  expect(
    await page.evaluate(
      () =>
        matchMedia('(any-hover: hover) and (any-pointer: coarse) and (any-pointer: fine)').matches
    )
  ).toBe(true)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  const connect = page.locator('[data-onboarding-entry="connect"]')
  const card = connect.locator('.onboarding-provider-card-anthropic')
  const tray = card.locator('.onboarding-provider-card-actions')
  const control = connect.locator(
    '.onboarding-provider-card-openai .onboarding-provider-card-actions'
  )
  await connect.locator('header').hover()
  await expect(tray).toHaveCSS('opacity', '0')
  await expect(control).toHaveCSS('opacity', '0')
  await card.hover()
  await expect(tray).toHaveCSS('opacity', '1')
  await expect(control).toHaveCSS('opacity', '0')
  await connect.locator('header').hover()
  await expect(tray).toHaveCSS('opacity', '0')
  const useKey = card.getByRole('button', { name: 'Have an API key?' })
  await useKey.focus()
  await expect(tray).toHaveCSS('opacity', '1')
  await connect.getByRole('button', { name: 'Advanced options' }).focus()
  await expect(tray).toHaveCSS('opacity', '0')
  const cdp = await page.context().newCDPSession(page)
  try {
    await tap(cdp, card.getByRole('heading'))
    await expect(tray).toHaveCSS('opacity', '1')
    await expect(control).toHaveCSS('opacity', '0')
    await tap(cdp, useKey)
  } finally {
    await cdp.detach()
  }
  await connect.getByRole('button', { name: 'Advanced options' }).focus()
  await expect(tray).toHaveCSS('opacity', '1')
  await expect(card.getByLabel('API key', { exact: true })).toBeVisible()
  await expect(control).toHaveCSS('opacity', '0')
})

test('exposes quick-connect actions on the first tap on touch-only devices', async ({ app }) => {
  const { page } = app
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    expect(
      await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches)
    ).toBe(true)
    const card = page.locator('.onboarding-provider-card-anthropic')
    const tray = card.locator('.onboarding-provider-card-actions')
    await expect(tray).toHaveCSS('opacity', '1')
    await expect(tray).toHaveCSS('pointer-events', 'auto')
    await tap(cdp, card.getByRole('button', { name: 'Have an API key?' }))
    await expect(card.getByLabel('API key', { exact: true })).toBeVisible()
    await tap(cdp, page.getByRole('button', { name: 'Advanced mode', exact: true }))
    await expect(page.getByRole('searchbox', { name: 'Search providers' })).toBeVisible()
  } finally {
    await cdp.detach()
  }
})
