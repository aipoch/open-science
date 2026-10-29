import { expect, test } from '@playwright/test'

const catalog = Array.from({ length: 7 }, (_, index) => ({
  name: `case-${index + 1}`,
  title: `Research example ${index + 1}`,
  cover: { file_name: 'cover.svg' },
  case: { file_name: 'example.science', bytes: 512, sha256: 'a'.repeat(64) }
}))
test.beforeEach(async ({ page }) => {
  await page.route('https://statics.aipoch.com/open-science/usecases/**', (route) =>
    route.request().url().endsWith('manifest.json')
      ? route.fulfill({ json: catalog })
      : route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><rect width="640" height="360" fill="#e7e5df"/><path d="M0 300L200 140L330 220L500 50L640 140" fill="none" stroke="#d5ba28" stroke-width="20"/></svg>'
        })
  )
})

test('cycles three cards, reveals actions on hover and keyboard focus, and remains within the window', async ({
  page
}, info) => {
  await page.setViewportSize({ width: 1100, height: 960 })
  await page.goto('/home-use-cases.html')
  const section = page.getByRole('region', { name: 'Use Case Gallery' })
  await expect(section.getByRole('article')).toHaveCount(3)
  const first = section.getByRole('article').first()
  const actions = first.getByRole('link', { name: 'Details' }).locator('..')
  await expect(actions).toHaveCSS('opacity', '0')
  await first.hover()
  await expect(actions).toHaveCSS('opacity', '1')
  await expect(first.getByRole('link')).toHaveAttribute(
    'href',
    'https://aipoch.com/open-science/use-cases/case-1'
  )
  await page.screenshot({ path: info.outputPath('home-examples-hover.png') })
  await page.mouse.move(0, 0)
  await section.getByRole('button', { name: 'Next examples' }).focus()
  await page.keyboard.press('Tab')
  await expect(first.getByRole('link')).toBeFocused()
  await expect(actions).toHaveCSS('opacity', '1')
  await section.getByRole('button', { name: 'Next examples' }).click()
  await expect(
    section.getByRole('article', { name: 'Research example 4', exact: true })
  ).toBeVisible()
  await section.getByRole('button', { name: 'Next examples' }).click()
  await expect(
    section.getByRole('article', { name: 'Research example 7', exact: true })
  ).toBeVisible()
  await section.getByRole('button', { name: 'Next examples' }).click()
  await expect(
    section.getByRole('article', { name: 'Research example 1', exact: true })
  ).toBeVisible()
  await section.getByRole('button', { name: 'Previous examples' }).click()
  await expect(
    section.getByRole('article', { name: 'Research example 7', exact: true })
  ).toBeVisible()
  await page.setViewportSize({ width: 720, height: 500 })
  await section.scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath('home-examples-small.png') })
})

test('clears pointer focus presentation after opening details while preserving keyboard navigation', async ({
  page
}) => {
  await page
    .context()
    .route('https://aipoch.com/open-science/use-cases/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<title>Example details</title>' })
    )
  await page.goto('/home-use-cases.html')
  const card = page.getByRole('article').first()
  const details = card.getByRole('link', { name: 'Details' })
  const actions = details.locator('..')
  await card.hover()
  const opened = page.waitForEvent('popup')
  await details.click()
  const popup = await opened
  await popup.close()
  await page.bringToFront()
  await page.mouse.move(0, 0)
  await expect(actions).toHaveCSS('opacity', '0')
  await page.keyboard.press('Tab')
  await expect(card.getByRole('button', { name: 'Import' })).toBeFocused()
  await expect(actions).toHaveCSS('opacity', '1')
})

test('contains long titles within two complete lines without clipping a third line', async ({
  page
}, info) => {
  const title = 'CAN 10,000 AI PAPERS PREDICT WHICH TOPICS WILL GROW SIX MONTHS LATER?'
  await page.route('https://statics.aipoch.com/open-science/usecases/manifest.json', (route) =>
    route.fulfill({ json: [{ ...catalog[0], title }, ...catalog.slice(1)] })
  )
  await page.goto('/home-use-cases.html')
  const heading = page.getByRole('heading', { name: title })
  await expect(heading).toBeVisible()
  await expect(heading).toHaveAttribute('title', title)
  const dimensions = await heading.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      height: element.getBoundingClientRect().height,
      lineHeight: parseFloat(style.lineHeight),
      overflow: element.scrollHeight > element.clientHeight
    }
  })
  expect(dimensions.overflow).toBe(true)
  expect(dimensions.height).toBeLessThanOrEqual(dimensions.lineHeight * 2)
  await page.screenshot({ path: info.outputPath('long-title.png') })
})

for (const destination of ['existing', 'new'])
  test(`imports using the ${destination} project flow and opens the session`, async ({ page }) => {
    await page.goto('/home-use-cases.html')
    await page.getByRole('button', { name: 'Next examples' }).click()
    if (destination === 'new') {
      const oldNames = await page
        .getByRole('article')
        .evaluateAll((cards) => cards.map((card) => card.getAttribute('aria-label')))
      await page.getByRole('button', { name: 'Random examples' }).click()
      await expect
        .poll(() =>
          page
            .getByRole('article')
            .evaluateAll((cards) => cards.map((card) => card.getAttribute('aria-label')))
        )
        .not.toEqual(oldNames)
    }
    const selected = await page
      .getByRole('article')
      .evaluateAll((cards) => cards.map((card) => card.getAttribute('aria-label')))
    const first = page.getByRole('article').first()
    await first.hover()
    await first.getByRole('button', { name: 'Import', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Import Session package', exact: true })
    if (destination === 'new') {
      await dialog.getByRole('button', { name: 'New project', exact: true }).click()
      await dialog.getByLabel('Project name', { exact: true }).fill('Example project')
    } else await dialog.getByText('Research project', { exact: true }).click()
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect(dialog.getByText('Imported example', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(page.getByTestId('navigation')).toHaveText(
      `workspace:${destination === 'new' ? 'new-project' : 'research'}`
    )
    await expect(page.getByRole('article')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('button', { name: 'Back to Home' }).click()
    expect(
      await page
        .getByRole('article')
        .evaluateAll((cards) => cards.map((card) => card.getAttribute('aria-label')))
    ).toEqual(selected)
    expect(
      await page
        .getByRole('article')
        .first()
        .evaluate((card) => card.parentElement!.getAnimations().length)
    ).toBe(0)
    await page.getByRole('button', { name: 'Next examples' }).click()
    await expect(page.getByRole('article').first()).toHaveAttribute(
      'aria-label',
      'Research example 7'
    )
  })

test('retains the downloading card overlay and solid disabled button until cancellation', async ({
  page
}, info) => {
  await page.goto('/home-use-cases.html?download')
  const card = page.getByRole('article').first()
  const importButton = card.getByRole('button', { name: 'Import', exact: true })
  const actions = card.getByRole('link', { name: 'Details' }).locator('..')
  await card.hover()
  await importButton.click()
  await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '35')
  await page.mouse.move(0, 0)
  await expect(actions).toHaveCSS('opacity', '1')
  await expect(importButton).toBeDisabled()
  await expect(importButton).toHaveCSS('opacity', '1')
  await expect(page.getByRole('article').nth(1).getByRole('link').locator('..')).toHaveCSS(
    'opacity',
    '0'
  )
  await page.getByRole('button', { name: 'Next examples' }).click()
  await page.getByRole('button', { name: 'Previous examples' }).click()
  await page.mouse.move(0, 0)
  await expect(actions).toHaveCSS('opacity', '1')
  await expect(importButton).toHaveCSS('opacity', '1')
  await page.screenshot({ path: info.outputPath('download-selected.png') })
  await card.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.mouse.move(0, 0)
  await expect(card.getByRole('progressbar')).toHaveCount(0)
  await expect(actions).toHaveCSS('opacity', '0')
  await expect(importButton).toBeEnabled()
})

test('continues the existing import from the card at project selection and confirmation', async ({
  page
}) => {
  await page.goto('/home-use-cases.html')
  const card = page.getByRole('article').first()
  await card.hover()
  await card.getByRole('button', { name: 'Import', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Import Session package', exact: true })
  await dialog.getByRole('button', { name: 'Hide progress', exact: true }).click()
  const resume = card.getByRole('button', { name: 'Continue', exact: true })
  await expect(resume).toBeEnabled()
  await expect(resume).toHaveAttribute('aria-busy', 'false')
  await resume.click()
  await dialog.getByText('Research project', { exact: true }).click()
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(dialog.getByText('Imported example', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Hide progress', exact: true }).click()
  await expect(resume).toBeEnabled()
  await expect(resume).toHaveAttribute('aria-busy', 'false')
  await resume.click()
  await expect(dialog.getByText('Imported example', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(page.getByTestId('navigation')).toHaveText('workspace:research')
})

test('renders Chinese copy in dark mode', async ({ page }, info) => {
  await page.goto('/home-use-cases.html?zh&dark')
  await expect(page.getByRole('region', { name: '案例广场' }).getByRole('article')).toHaveCount(3)
  await page.getByRole('article').first().hover()
  await page.screenshot({ path: info.outputPath('home-examples-dark-zh.png') })
})

test('centers the gallery arrow and chooses three distinct cases without another catalog request', async ({
  page
}) => {
  let requests = 0
  page.on('request', (request) => {
    if (request.url().endsWith('/manifest.json')) requests++
  })
  await page.goto('/home-use-cases.html')
  const section = page.getByRole('region', { name: 'Use Case Gallery' })
  await expect(section.getByRole('article')).toHaveCount(3)
  const heading = section.getByRole('link', { name: 'Use Case Gallery', exact: true })
  const linkBounds = (await heading.boundingBox())!
  const iconBounds = (await heading.locator('svg').boundingBox())!
  expect(
    Math.abs(linkBounds.y + linkBounds.height / 2 - iconBounds.y - iconBounds.height / 2)
  ).toBeLessThan(1)
  const first = section.getByRole('article').first()
  await first.hover()
  await expect(first.getByRole('link', { name: 'Details' }).locator('svg')).toHaveAttribute(
    'class',
    /lucide-arrow-up-right/
  )
  const names = (): Promise<(string | null)[]> =>
    section
      .getByRole('article')
      .evaluateAll((cards) => cards.map((card) => card.getAttribute('aria-label')))
  let previous = await names()
  for (let index = 0; index < 5; index++) {
    await section.getByRole('button', { name: 'Random examples' }).click()
    await expect.poll(async () => (await names()).sort()).not.toEqual([...previous].sort())
    const next = await names()
    expect(new Set(next).size).toBe(3)
    expect([...next].sort()).not.toEqual([...previous].sort())
    previous = next
  }
  expect(requests).toBe(1)
})

test('random selection keeps an opaque previous group beneath the incoming cards', async ({
  page
}) => {
  await page.goto('/home-use-cases.html')
  const section = page.getByRole('region', { name: 'Use Case Gallery' })
  await expect(section.getByRole('article')).toHaveCount(3)
  for (const image of await section.locator('img').all())
    await expect(image).toHaveCSS('opacity', '1')
  const feedback = await section
    .getByRole('button', { name: 'Random examples' })
    .evaluate((button) => {
      const before = button.getBoundingClientRect()
      ;(button as HTMLButtonElement).click()
      const icon = button.querySelector('svg')!
      const arrowAnimations = Array.from(icon.querySelectorAll('path')).map(
        (path) => path.getAnimations()[0]
      )
      arrowAnimations.filter(Boolean).forEach((animation) => {
        animation.pause()
        animation.currentTime = 100
      })
      const after = button.getBoundingClientRect()
      return {
        iconStable: getComputedStyle(icon).transform === 'none',
        arrowsAnimated: arrowAnimations.every(Boolean),
        staggered:
          new Set(
            arrowAnimations.filter(Boolean).map((animation) => animation.effect!.getTiming().delay)
          ).size === 2,
        flipsOnce: arrowAnimations.filter(Boolean).every((animation) => {
          const effect = animation.effect as KeyframeEffect
          return (
            effect.getTiming().iterations === 1 &&
            effect.getKeyframes().some((frame) => String(frame.transform).includes('scaleY(-1)'))
          )
        }),
        buttonStable: before.x === after.x && before.y === after.y && before.width === after.width,
        gridExit: button
          .closest('section')!
          .querySelector('article')!
          .parentElement!.getAnimations()
          .some(
            (animation) =>
              (animation.effect as KeyframeEffect).getKeyframes().at(-1)?.opacity === '0'
          )
      }
    })
  expect(feedback.iconStable).toBe(true)
  expect(feedback.arrowsAnimated).toBe(true)
  expect(feedback.staggered).toBe(true)
  expect(feedback.flipsOnce).toBe(true)
  expect(feedback.buttonStable).toBe(true)
  expect(feedback.gridExit).toBe(false)
  await expect
    .poll(
      () =>
        section
          .getByRole('article')
          .first()
          .evaluate((card) => {
            const animation = card.parentElement!.getAnimations()[0]
            if (!animation) return false
            animation.pause()
            animation.currentTime = 80
            return true
          }),
      { intervals: [10, 20] }
    )
    .toBe(true)
  const frame = await section.evaluate((element) => {
    const outgoing = element.querySelector<HTMLElement>('[inert][aria-hidden="true"]')!
    const incoming = Array.from(element.querySelectorAll('article')).find(
      (card) => !card.closest('[inert]')
    )!.parentElement!
    const style = getComputedStyle(incoming)
    return {
      outgoingOpacity: Number(getComputedStyle(outgoing).opacity),
      incomingOpacity: Number(style.opacity),
      x: new DOMMatrixReadOnly(style.transform).e,
      readyImages: Array.from(incoming.querySelectorAll('img')).every(
        (img) => img.complete && img.naturalWidth > 0 && getComputedStyle(img).opacity === '1'
      )
    }
  })
  expect(frame.outgoingOpacity).toBe(1)
  expect(frame.incomingOpacity).toBeGreaterThan(0)
  expect(frame.incomingOpacity).toBeLessThan(1)
  expect(frame.x).toBe(0)
  expect(frame.readyImages).toBe(true)
  await section
    .getByRole('article')
    .first()
    .evaluate((card) =>
      card.parentElement!.getAnimations().forEach((animation) => animation.finish())
    )
  await expect(section.locator('[inert][aria-hidden="true"]')).toHaveCount(0)
})

test('random switching remains immediate with reduced motion and rapid navigation keeps the last action', async ({
  page
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/home-use-cases.html')
  const section = page.getByRole('region', { name: 'Use Case Gallery' })
  await expect(section.getByRole('article')).toHaveCount(3)
  await section.getByRole('button', { name: 'Random examples' }).click()
  expect(
    await section
      .getByRole('article')
      .evaluateAll((cards) => cards.flatMap((card) => card.getAnimations()))
  ).toEqual([])
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await section.evaluate((element) => {
    ;(element.querySelector('[aria-label="Random examples"]') as HTMLButtonElement).click()
    ;(element.querySelector('[aria-label="Next examples"]') as HTMLButtonElement).click()
  })
  await expect(section.getByRole('article').first()).toHaveAttribute(
    'aria-label',
    'Research example 4'
  )
  await expect
    .poll(() =>
      section
        .getByRole('article')
        .first()
        .evaluate(
          (card) =>
            card
              .parentElement!.getAnimations()
              .filter((animation) => animation.playState === 'running').length
        )
    )
    .toBe(0)
  await expect(section.getByRole('article').first()).toHaveAttribute(
    'aria-label',
    'Research example 4'
  )
})

test('keeps a full-size cover placeholder until an image loads, including failed covers', async ({
  page
}, info) => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/usecases/*/cover.svg', async (route) => {
    if (route.request().url().includes('/case-1/')) return route.abort()
    await pending
    return route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#92bfae"/></svg>'
    })
  })
  await page.goto('/home-use-cases.html', { waitUntil: 'domcontentloaded' })
  const cards = page.getByRole('region', { name: 'Use Case Gallery' }).getByRole('article')
  await expect(cards).toHaveCount(3)
  await cards.first().scrollIntoViewIfNeeded()
  const sizes = (): Promise<number[]> =>
    cards.evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().height)
    )
  const before = await sizes()
  const images = cards.locator('img')
  await expect(images.nth(1)).toHaveCSS('opacity', '0')
  await expect(images.first()).toHaveCSS('opacity', '0')
  await page.screenshot({ path: info.outputPath('cover-placeholder.png') })
  release()
  await expect(images.nth(1)).toHaveCSS('opacity', '1')
  await expect(images.nth(2)).toHaveCSS('opacity', '1')
  await expect(images.first()).toHaveCSS('opacity', '0')
  expect(await sizes()).toEqual(before)
})

test('keeps the download accessible from project navigation and cancels through global progress', async ({
  page
}) => {
  await page.goto('/home-use-cases.html?download')
  const card = page.getByRole('article').first()
  await card.hover()
  await card.getByRole('button', { name: 'Import', exact: true }).click()
  await page.getByText('Research project', { exact: true }).click()
  await expect(page.getByTestId('navigation')).toHaveText('workspace:research')
  const progress = page.getByRole('group', { name: 'Package progress' })
  await expect(progress).toContainText('Downloading 35%')
  await progress.getByRole('button', { name: 'View progress' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Downloading 35%')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(card.getByRole('progressbar')).toHaveCount(0)
})

test('keeps the current group visible during cover preparation and lets later paging win', async ({
  page
}) => {
  await page.goto('/home-use-cases.html')
  await expect(page.getByRole('article')).toHaveCount(3)
  await page.evaluate(() => {
    Math.random = () => 0.999
  })
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let requested = false
  await page.route('**/case-4/cover.svg', async (route) => {
    requested = true
    await held
    await route.abort()
  })
  try {
    await page.getByRole('button', { name: 'Random examples' }).click()
    await expect.poll(() => requested).toBe(true)
    await expect(page.getByRole('article').nth(2)).toHaveAttribute(
      'aria-label',
      'Research example 3'
    )
    await expect(page.getByRole('article').first().locator('..')).toHaveCSS('opacity', '1')
    await page.getByRole('button', { name: 'Next examples' }).click()
    release()
    await expect(page.getByRole('article').first()).toHaveAttribute(
      'aria-label',
      'Research example 4'
    )
    await expect(page.getByRole('article').nth(2)).toHaveAttribute(
      'aria-label',
      'Research example 6'
    )
    await expect(page.getByRole('article').first().locator('img')).toHaveCSS('opacity', '0')
  } finally {
    release()
  }
})

test('finishes a shuffle with a placeholder when cover preparation times out', async ({ page }) => {
  await page.goto('/home-use-cases.html')
  await expect(page.getByRole('article')).toHaveCount(3)
  await page.evaluate(() => {
    Math.random = () => 0.999
  })
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/case-4/cover.svg', async (route) => {
    await held
    await route.abort()
  })
  try {
    await page.getByRole('button', { name: 'Random examples' }).click()
    const card = page.getByRole('article').nth(2)
    await expect(card).toHaveAttribute('aria-label', 'Research example 4', { timeout: 3000 })
    await expect(card.locator('img')).toHaveCSS('opacity', '0')
    release()
    await expect(card.locator('.animate-pulse')).toHaveCount(0)
  } finally {
    release()
  }
})
