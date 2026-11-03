import { expect, test, type Locator } from '@playwright/test'

const catalog = Array.from({ length: 7 }, (_, index) => ({
  name: `case-${index + 1}`,
  title: `Research example ${index + 1}`,
  cover: { file_name: 'cover.svg' },
  catalog: index % 2 ? 'Biology' : 'Science',
  catalog_name: index % 2 ? 'biology' : 'science',
  introduction: { file_name: 'intro.md' },
  case: { file_name: 'example.science', bytes: 512, sha256: 'a'.repeat(64) }
}))
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 600 })
  await page.route('https://statics.aipoch.com/open-science/usecases/**', (route) =>
    route.request().url().endsWith('manifest.json')
      ? route.fulfill({ json: catalog })
      : route.request().url().endsWith('intro.md')
        ? route.fulfill({
            contentType: 'text/markdown',
            body: '# Published findings\n\nA reproducible research example.\n\n- Verified results'
          })
        : route.fulfill({
            contentType: 'image/svg+xml',
            body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><rect width="640" height="360" fill="#e7e5df"/><path d="M0 300L200 140L330 220L500 50L640 140" fill="none" stroke="#d5ba28" stroke-width="20"/></svg>'
          })
  )
})

test('opens whole cards with mouse and keyboard without overlay actions', async ({
  page
}, info) => {
  await page.goto('/home-use-cases.html')
  const section = page.getByRole('region', { name: 'Use Case Marketplace' })
  await expect(section.getByRole('article')).toHaveCount(6)
  const card = section.getByRole('article').first()
  await expect(card.getByRole('button', { name: 'Details', exact: true })).toHaveCount(0)
  await expect(card.getByRole('button', { name: 'Import', exact: true })).toHaveCount(0)
  await card.scrollIntoViewIfNeeded()
  const restingCard = await card.boundingBox()
  await card.hover()
  await expect(card).toHaveCSS('transform', 'none')
  expect(await card.boundingBox()).toEqual(restingCard)
  await expect(card).not.toHaveCSS('box-shadow', 'none')
  await page.screenshot({ path: info.outputPath('home-case-card-hover.png') })
  const button = card.getByRole('button', { name: 'Research example 1', exact: true })
  await button.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Case details', exact: true })
  await expect(dialog.getByRole('heading', { name: 'Published findings' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(button).toBeFocused()
  await page.setViewportSize({ width: 720, height: 500 })
  await card.scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('appends six cases per scroll without replacing cards or repeating the final batch', async ({
  page
}, info) => {
  const many = Array.from({ length: 19 }, (_, index) => ({
    ...catalog[0],
    name: `case-${index + 1}`,
    title: `Research example ${index + 1}`
  }))
  let requests = 0
  await page.route('**/usecases/manifest.json', (route) => {
    requests++
    return route.fulfill({ json: many })
  })
  await page.goto('/home-use-cases.html?long')
  const section = page.getByRole('region', { name: 'Use Case Marketplace' })
  const cards = section.getByRole('article')
  await expect(cards).toHaveCount(6)
  const first = await cards.first().boundingBox()
  const third = await cards.nth(2).boundingBox()
  const fourth = await cards.nth(3).boundingBox()
  expect(third!.y).toBe(first!.y)
  expect(fourth!.y).toBeGreaterThan(first!.y)
  for (const count of [12, 18, 19]) {
    await cards.last().scrollIntoViewIfNeeded()
    await expect(cards).toHaveCount(count)
    await expect(cards.first()).toHaveAttribute('aria-label', 'Research example 1')
    expect(
      await cards.evaluateAll(
        (elements) => new Set(elements.map((element) => element.getAttribute('aria-label'))).size
      )
    ).toBe(count)
  }
  await cards.last().scrollIntoViewIfNeeded()
  await page.mouse.wheel(0, 600)
  await expect(cards).toHaveCount(19)
  expect(requests).toBe(1)
  await expect(
    page.locator('[data-home-navigation]').getByRole('button', { name: 'Projects', exact: true })
  ).toBeInViewport()
  await page.screenshot({ path: info.outputPath('home-gallery-infinite-scroll.png') })
})

test('prefetches a hovered introduction once and reuses it when opening details', async ({
  page
}) => {
  let requests = 0
  let release!: () => void
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/case-1/intro.md', async (route) => {
    requests++
    await ready
    await route.fulfill({ contentType: 'text/markdown', body: '# Prefetched findings' })
  })
  await page.goto('/home-use-cases.html')
  const card = page.getByRole('article').first()
  await card.hover()
  await expect.poll(() => requests).toBe(1)
  await card.getByRole('button').first().click()
  const dialog = page.getByRole('dialog', { name: 'Case details', exact: true })
  await expect(dialog.getByText('Loading introduction…')).toBeVisible()
  release()
  await expect(dialog.getByRole('heading', { name: 'Prefetched findings' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await card.getByRole('button').first().click()
  await expect(dialog.getByRole('heading', { name: 'Prefetched findings' })).toBeVisible()
  await expect(dialog.getByText('Loading introduction…')).toHaveCount(0)
  expect(requests).toBe(1)
})

test('opens introduction inside the app, restores focus and preserves the home scroll position', async ({
  page
}, info) => {
  await page.goto('/home-use-cases.html?long')
  const homeScroll = page.locator('[data-home-scroll]')
  const card = page.getByRole('article').first()
  const details = card.getByRole('button').first()
  await details.scrollIntoViewIfNeeded()
  const before = await homeScroll.evaluate((element) => element.scrollTop)
  await details.click()
  const dialog = page.getByRole('dialog', { name: 'Case details', exact: true })
  await expect(dialog.getByRole('heading', { name: 'Published findings' })).toBeVisible()
  await expect(dialog.getByText('A reproducible research example.')).toBeVisible()
  expect(page.context().pages()).toHaveLength(1)
  await page.screenshot({ path: info.outputPath('in-app-case-detail.png') })
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(details).toBeFocused()
  expect(await homeScroll.evaluate((element) => element.scrollTop)).toBe(before)
  await page.mouse.move(0, 0)
  await page.keyboard.press('Tab')
  await expect(page.getByRole('article').nth(1).getByRole('button').first()).toBeFocused()
})

test('browses and filters the marketplace, preserving the loaded list when details close', async ({
  page
}, info) => {
  await page.setViewportSize({ width: 1280, height: 600 })
  const many = Array.from({ length: 19 }, (_, index) => ({
    ...catalog[index % catalog.length],
    name: `case-${index + 1}`,
    title: `Research example ${index + 1}`
  }))
  await page.route('**/usecases/manifest.json', (route) => route.fulfill({ json: many }))
  await page.goto('/home-use-cases.html?long')
  await page
    .getByRole('heading', { name: 'Use Case Marketplace', exact: true })
    .getByRole('button')
    .click()
  const dialog = page.getByRole('dialog', { name: 'Case details', exact: true })
  await expect(page.getByTestId('navigation')).toHaveText('marketplace:')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('combobox')).toHaveCount(0)
  const cards = page.getByRole('article')
  await expect(cards).toHaveCount(6)
  await cards.last().scrollIntoViewIfNeeded()
  await expect(cards).toHaveCount(12)
  const scroll = page.locator('[data-use-case-browser-scroll]')
  await cards.nth(8).scrollIntoViewIfNeeded()
  const previousScroll = await scroll.evaluate((element) => element.scrollTop)
  await cards.nth(8).getByRole('button').first().click()
  await expect(dialog.getByRole('heading', { name: 'Published findings' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Back to list', exact: true })).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Go to Use Case Marketplace' })).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Browse all examples' })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(cards).toHaveCount(12)
  expect(await scroll.evaluate((element) => element.scrollTop)).toBe(previousScroll)
  await page.screenshot({ path: info.outputPath('marketplace-categories.png') })
  await page
    .getByRole('group', { name: 'Category', exact: true })
    .getByRole('button', { name: 'Biology', exact: true })
    .click()
  await page.getByRole('textbox', { name: 'Search examples' }).fill('Research example 2')
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toHaveAttribute('aria-label', 'Research example 2')
  await cards.first().getByRole('button').first().click()
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Search examples' })).toHaveValue(
    'Research example 2'
  )
  await expect(page.getByRole('button', { name: 'Biology', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(cards).toHaveCount(1)
  await page.screenshot({ path: info.outputPath('in-app-case-gallery.png') })
  await page.getByRole('textbox', { name: 'Search examples' }).fill('not a case')
  await expect(page.getByText('No matching examples')).toBeVisible()
  await page.getByRole('textbox', { name: 'Search examples' }).fill('Research example 2')
  await cards.first().getByRole('button').first().click()
  await dialog.getByRole('button', { name: 'Import', exact: true }).click()
  const importDialog = page.getByRole('dialog', { name: 'Import Session package', exact: true })
  await expect(importDialog).toBeVisible()
  await importDialog.getByText('Research project', { exact: true }).click()
  await importDialog.getByRole('button', { name: 'Continue', exact: true }).click()
  await importDialog.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(page.getByTestId('navigation')).toHaveText('workspace:research')
  await expect(dialog).toHaveCount(0)
})

test('opens the same marketplace from the toolbar and detail Go to Use Case Marketplace action', async ({
  page
}, info) => {
  await page.goto('/home-use-cases.html?long')
  await page.getByRole('button', { name: 'Sharing marketplace', exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Sharing marketplace' })).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Use Case Marketplace', exact: true })
  ).toHaveCount(1)
  await expect(page.getByRole('textbox', { name: 'Search examples' })).toBeVisible()
  await page.getByRole('button', { name: 'Collapse sidebar panel' }).click()
  await expect(page.getByRole('button', { name: 'Expand sidebar panel' })).toBeVisible()
  await page.getByRole('button', { name: 'Back to Home', exact: true }).click()
  await page.getByRole('article').first().getByRole('button').first().click()
  const dialog = page.getByRole('dialog', { name: 'Case details', exact: true })
  await expect(dialog.getByRole('button', { name: 'Back to examples' })).toHaveCount(0)
  const inset = await dialog
    .getByRole('heading', { name: 'Research example 1' })
    .evaluate(
      (heading) =>
        heading.getBoundingClientRect().left -
        heading.closest('[role="dialog"]')!.getBoundingClientRect().left
    )
  expect(inset).toBeLessThanOrEqual(24)
  expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(960)
  const [importBounds, browseBounds] = await dialog.evaluate((element) =>
    ['Import', 'Go to Use Case Marketplace'].map((label) => {
      const button = Array.from(element.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === label
      )!
      const { x, y, width } = button.getBoundingClientRect()
      return { x, y, width }
    })
  )
  expect(browseBounds.x).toBeGreaterThan(importBounds.x + importBounds.width)
  expect(browseBounds.y).toBe(importBounds.y)
  await expect(dialog.getByRole('button', { name: 'View more', exact: true })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Go to Use Case Marketplace' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('navigation')).toHaveText('marketplace:')
  await page.setViewportSize({ width: 390, height: 700 })
  await expect(page.getByRole('textbox', { name: 'Search examples' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath('marketplace-narrow.png') })
})

test('keeps the homepage gallery title visible while its cards scroll', async ({ page }) => {
  const many = Array.from({ length: 19 }, (_, index) => ({
    ...catalog[0],
    name: `case-${index + 1}`,
    title: `Research example ${index + 1}`
  }))
  await page.route('**/usecases/manifest.json', (route) => route.fulfill({ json: many }))
  await page.goto('/home-use-cases.html?long')
  const title = page
    .getByRole('heading', { name: 'Use Case Marketplace', exact: true })
    .getByRole('button')
  await page.getByRole('article').last().scrollIntoViewIfNeeded()
  await expect(page.getByRole('article')).toHaveCount(12)
  const scroll = page.locator('[data-home-scroll]')
  await title.evaluate((element) => {
    const viewport = element.closest('[data-home-scroll]')!
    viewport.scrollTop +=
      element.getBoundingClientRect().top - viewport.getBoundingClientRect().top + 150
  })
  const viewport = await scroll.boundingBox()
  await expect(title).toBeInViewport()
  const position = await title.boundingBox()
  expect(position!.y).toBeGreaterThanOrEqual(viewport!.y)
  expect(position!.y).toBeLessThan(viewport!.y + 40)
  await expect(
    page
      .locator('[data-home-navigation]')
      .getByRole('button', { name: 'Use Case Marketplace', exact: true })
  ).toHaveAttribute('aria-current', 'location')
})

test('retries failed introductions and handles cases without an introduction', async ({ page }) => {
  let failing = true
  await page.route('**/case-1/intro.md', (route) =>
    route.fulfill(
      failing ? { status: 503 } : { contentType: 'text/markdown', body: '# Recovered introduction' }
    )
  )
  await page.goto('/home-use-cases.html')
  await page.getByRole('article').first().getByRole('button').first().click()
  const dialog = page.getByRole('dialog', { name: 'Case details', exact: true })
  await expect(dialog.getByText('Could not load this introduction. Try again.')).toBeVisible()
  failing = false
  await dialog.getByRole('button', { name: 'Try again' }).click()
  await expect(dialog.getByRole('heading', { name: 'Recovered introduction' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await page.route('**/case-2/intro.md', (route) => route.fulfill({ status: 204 }))
  await page.getByRole('article').nth(1).getByRole('button').first().click()
  await expect(dialog.getByText('No introduction is available for this example yet.')).toBeVisible()
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
    await page.getByRole('article').last().scrollIntoViewIfNeeded()
    await expect(page.getByRole('article')).toHaveCount(7)
    const selected = await page
      .getByRole('article')
      .evaluateAll((cards) => cards.map((card) => card.getAttribute('aria-label')))
    const first = page.getByRole('article').first()
    await first.hover()
    await first.getByRole('button').first().click()
    await page
      .getByRole('dialog', { name: 'Case details', exact: true })
      .getByRole('button', { name: 'Import', exact: true })
      .click()
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
    await page.getByRole('article').last().scrollIntoViewIfNeeded()
    await expect(page.getByRole('article')).toHaveCount(7)
  })

test('downloads inside the detail dialog and keeps cancellation and progress on the case', async ({
  page
}, info) => {
  await page.goto('/home-use-cases.html?download')
  const card = page.getByRole('article').first()
  await card.getByRole('button').first().click()
  const dialog = page.getByRole('dialog', { name: 'Case details', exact: true })
  await dialog.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Downloading 35%', exact: true })).toBeVisible()
  await expect(dialog.getByRole('progressbar')).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Downloading 35%', exact: true })).toBeDisabled()
  await expect(
    page.getByRole('dialog', { name: 'Import Session package', exact: true })
  ).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('case-detail-download.png') })
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog.getByRole('progressbar')).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toBeEnabled()
  await dialog.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Downloading 35%', exact: true })).toBeVisible()
  await expect(dialog.getByRole('progressbar')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '35')
  await card.getByRole('button', { name: 'Cancel', exact: true }).click()
})

test('continues the existing import from the card at project selection and confirmation', async ({
  page
}) => {
  await page.goto('/home-use-cases.html')
  const card = page.getByRole('article').first()
  await card.hover()
  await card.getByRole('button').first().click()
  await page
    .getByRole('dialog', { name: 'Case details', exact: true })
    .getByRole('button', { name: 'Import', exact: true })
    .click()
  const dialog = page.getByRole('dialog', { name: 'Import Session package', exact: true })
  await dialog.getByRole('button', { name: 'Hide progress', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const resume = page
    .getByRole('dialog', { name: 'Case details', exact: true })
    .getByRole('button', { name: 'Continue', exact: true })
  await expect(resume).toBeEnabled()
  await expect(resume).toHaveAttribute('aria-busy', 'false')
  await resume.click()
  await dialog.getByText('Research project', { exact: true }).click()
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(dialog.getByText('Imported example', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Hide progress', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(resume).toBeEnabled()
  await expect(resume).toHaveAttribute('aria-busy', 'false')
  await resume.click()
  await expect(dialog.getByText('Imported example', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(page.getByTestId('navigation')).toHaveText('workspace:research')
})

test('renders Chinese copy in dark mode', async ({ page }, info) => {
  await page.goto('/home-use-cases.html?zh&dark')
  await expect(page.getByRole('region', { name: '案例市场' }).getByRole('article')).toHaveCount(6)
  await page.getByRole('article').first().hover()
  await page.screenshot({ path: info.outputPath('home-examples-dark-zh.png') })
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
  const cards = page.getByRole('region', { name: 'Use Case Marketplace' }).getByRole('article')
  await expect(cards).toHaveCount(6)
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

for (const catalogFails of [false, true]) {
  test(`retries a failed cover without reloading healthy covers when catalog refresh ${catalogFails ? 'fails' : 'succeeds'}`, async ({
    page
  }) => {
    let recover = false
    const coverRequests = new Map<string, number>()
    await page.route('**/manifest.json', (route) =>
      recover && catalogFails
        ? route.fulfill({ status: 503, body: 'temporary failure' })
        : route.fulfill({ json: catalog.slice(0, 2) })
    )
    await page.route('**/usecases/*/cover.svg*', (route) => {
      const path = new URL(route.request().url()).pathname
      coverRequests.set(path, (coverRequests.get(path) ?? 0) + 1)
      return !recover && path.includes('/case-1/')
        ? route.fulfill({ status: 503, body: 'temporary failure' })
        : route.fulfill({
            contentType: 'image/svg+xml',
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="green"/></svg>'
          })
    })
    await page.goto('/home-use-cases.html')
    await page.getByRole('button', { name: 'Sharing marketplace', exact: true }).click()
    const cards = page.getByRole('main').getByRole('article')
    await expect(cards).toHaveCount(2)
    const failed = cards.nth(0).locator('img')
    const healthy = cards.nth(1).locator('img')
    await expect
      .poll(() => failed.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth === 0))
      .toBe(true)
    await expect.poll(() => healthy.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(640)
    const healthyRequests = coverRequests.get('/open-science/usecases/case-2/cover.svg')
    const healthySource = await healthy.getAttribute('src')
    recover = true
    await page.getByRole('button', { name: 'Refresh examples' }).click()
    await expect.poll(() => failed.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(640)
    await expect(page.getByRole('button', { name: 'Refresh examples' })).toBeEnabled()
    expect(coverRequests.get('/open-science/usecases/case-2/cover.svg')).toBe(healthyRequests)
    await expect(healthy).toHaveAttribute('src', healthySource!)
    await expect(cards).toHaveCount(2)
    await cards.first().getByRole('button', { name: 'Research example 1', exact: true }).click()
    const detailCover = page
      .getByRole('dialog', { name: 'Case details', exact: true })
      .locator('img')
      .first()
    await expect
      .poll(() => detailCover.evaluate((el: HTMLImageElement) => el.naturalWidth))
      .toBe(640)
  })
}

test('keeps the download accessible from project navigation and cancels through global progress', async ({
  page
}) => {
  await page.goto('/home-use-cases.html?download')
  const card = page.getByRole('article').first()
  await card.hover()
  await card.getByRole('button').first().click()
  await page
    .getByRole('dialog', { name: 'Case details', exact: true })
    .getByRole('button', { name: 'Import', exact: true })
    .click()
  await page
    .getByRole('dialog', { name: 'Case details', exact: true })
    .getByRole('button', { name: 'Close', exact: true })
    .click()
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

test('home navigation has two capsule targets beside the shared scrolling content', async ({
  page
}, info) => {
  await page.setViewportSize({ width: 1760, height: 900 })
  await page.goto('/home-use-cases.html?long&updates')
  const gallery = page.getByRole('region', { name: 'Use Case Marketplace' })
  const jump = page
    .locator('[data-home-navigation]')
    .getByRole('button', { name: 'Use Case Marketplace', exact: true })
  const back = page
    .locator('[data-home-navigation]')
    .getByRole('button', { name: 'Projects', exact: true })
  const scroller = page.locator('[data-home-scroll]')
  const header = page.locator('main header')
  const updates = page.getByRole('region', { name: 'Session updates' })
  await expect(gallery.getByRole('article')).toHaveCount(6)
  await expect(back).toBeVisible()
  await expect(jump).toBeVisible()
  // The native scrollbar belongs to the full-width viewport, not the centered content column.
  const scrollBounds = (await scroller.boundingBox())!
  expect(scrollBounds.x).toBe(0)
  expect(scrollBounds.width).toBe(1760)
  const backBounds = (await back.boundingBox())!
  const jumpBounds = (await jump.boundingBox())!
  expect(backBounds.y).toBeLessThan(jumpBounds.y)
  const upperDot = (await back.locator('[data-home-navigation-capsule]').boundingBox())!
  const lowerDot = (await jump.locator('[data-home-navigation-capsule]').boundingBox())!
  expect(lowerDot.y - upperDot.y - upperDot.height + 3).toBe(5)
  const recentBounds = (await page.getByRole('region', { name: 'Recent sessions' }).boundingBox())!
  const projectBounds = (await page.getByRole('region', { name: 'Projects' }).boundingBox())!
  expect(recentBounds.x - projectBounds.x - projectBounds.width).toBeLessThanOrEqual(24)
  expect(
    await scroller
      .locator('..')
      .locator('[data-home-navigation]')
      .getByRole('button', { name: 'Use Case Marketplace', exact: true })
      .count()
  ).toBe(1)
  const capsule = jump.locator('[data-home-navigation-capsule]')
  await expect(capsule).toHaveCSS('width', '24px')
  await expect(capsule).toHaveCSS('height', '7px')
  await expect(jump.locator('[data-home-navigation-shape]')).toHaveCSS(
    'clip-path',
    'inset(1.5px 0px 1.5px 20px round 999px)'
  )
  await expect(jump.locator('svg')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('home-navigation-dots.png') })
  await jump.hover()
  await expect(capsule).toHaveCSS('height', '7px')
  await expect(capsule).toHaveCSS('width', '24px')
  await expect(page.getByRole('tooltip')).toHaveText('Use Case Marketplace')
  const expandedBounds = (await capsule.boundingBox())!
  expect(expandedBounds.x).toBeGreaterThan(recentBounds.x + recentBounds.width)
  expect(expandedBounds.x + expandedBounds.width).toBeLessThanOrEqual(
    (await header.boundingBox())!.x + (await header.boundingBox())!.width
  )
  await page.screenshot({ path: info.outputPath('home-navigation-capsule.png') })

  // Only the toolbar stays fixed; task cards scroll away and project headings take over.
  const headerBefore = await header.boundingBox()
  const updatesBefore = await updates.boundingBox()
  const projectsBefore = await page.getByRole('region', { name: 'Projects' }).boundingBox()
  await page.mouse.move(500, 650)
  await page.mouse.wheel(0, 300)
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(100)
  expect(await header.boundingBox()).toEqual(headerBefore)
  const projectHeading = page
    .getByRole('region', { name: 'Projects', exact: true })
    .getByRole('heading')
  expect((await projectHeading.boundingBox())!.y).toBeCloseTo(scrollBounds.y, 0)
  await expect(back).toHaveAttribute('aria-current', 'location')
  await expect(jump).not.toHaveAttribute('aria-current')
  expect(
    (await updates.boundingBox())!.y + (await updates.boundingBox())!.height
  ).toBeLessThanOrEqual(scrollBounds.y)
  const stickyBounds = (await projectHeading.boundingBox())!
  expect(stickyBounds.x).toBeLessThan(projectBounds.x - 4)
  expect(stickyBounds.x + stickyBounds.width).toBeGreaterThan(
    projectBounds.x + projectBounds.width + 4
  )
  await page.screenshot({ path: info.outputPath('project-heading-sticky.png') })
  expect(await jump.boundingBox()).toEqual(jumpBounds)
  expect((await page.getByRole('region', { name: 'Projects' }).boundingBox())!.y).toBeLessThan(
    projectsBefore!.y
  )

  await jump.focus()
  await page.keyboard.press('Enter')
  await expect(jump).toBeFocused()
  await expect(back).toBeVisible()
  await expect(gallery.getByRole('article').first()).toBeInViewport({ ratio: 1 })
  await expect(
    gallery.getByRole('button', { name: 'Use Case Marketplace', exact: true })
  ).toBeInViewport()
  expect((await updates.boundingBox())!.y).toBeLessThan(updatesBefore!.y)
  expect(await jump.boundingBox()).toEqual(jumpBounds)
  await expect(jump).toHaveAttribute('aria-current', 'location')
  await expect(back).not.toHaveAttribute('aria-current')
  await expect(page.getByTestId('navigation')).toHaveText('home:')
  await page.screenshot({ path: info.outputPath('home-navigation-gallery.png') })

  // Each destination stays independent, including a repeat click at the destination.
  await jump.click()
  await expect(back).toBeVisible()
  await back.click()
  await expect
    .poll(async () =>
      Math.abs(
        (await page.getByRole('region', { name: 'Projects', exact: true }).boundingBox())!.y -
          scrollBounds.y
      )
    )
    .toBeLessThan(1)
  await expect(page.getByRole('region', { name: 'Projects' }).getByRole('heading')).toBeInViewport()
  await expect(back).toHaveAttribute('aria-current', 'location')
  await expect(jump).not.toHaveAttribute('aria-current')
  await expect(jump).toBeVisible()
  await back.click()
  await expect
    .poll(async () =>
      Math.abs(
        (await page.getByRole('region', { name: 'Projects', exact: true }).boundingBox())!.y -
          scrollBounds.y
      )
    )
    .toBeLessThan(1)
  await page.setViewportSize({ width: 1100, height: 2800 })
  await expect(jump).toBeHidden()
  await expect(back).toBeHidden()
})

test('home navigation stays absent when everything fits or the gallery is unavailable', async ({
  page
}) => {
  await page.setViewportSize({ width: 1100, height: 960 })
  await page.route('**/usecases/manifest.json', (route) =>
    route.fulfill({ json: catalog.slice(0, 3) })
  )
  await page.goto('/home-use-cases.html')
  await expect(page.getByRole('article')).toHaveCount(3)
  await expect(
    page.locator('[data-home-navigation]').getByRole('button', { name: 'Use Case Marketplace' })
  ).toBeHidden()
  await expect(
    page.locator('[data-home-navigation]').getByRole('button', { name: 'Projects' })
  ).toBeHidden()
  await page.route('**/usecases/manifest.json', (route) => route.fulfill({ json: [] }))
  await page.goto('/home-use-cases.html?long')
  await expect(page.getByRole('region', { name: 'Projects' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Use Case Marketplace' })).toHaveCount(0)
  await expect(
    page.locator('[data-home-navigation]').getByRole('button', { name: 'Use Case Marketplace' })
  ).toHaveCount(0)
})

test('home navigation capsules fit small windows with reduced motion and scrolling task cards', async ({
  page
}, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 390, height: 600 })
  await page.goto('/home-use-cases.html?long&updates&many-updates&zh&dark')
  const jump = page
    .locator('[data-home-navigation]')
    .getByRole('button', { name: '案例市场', exact: true })
  const back = page
    .locator('[data-home-navigation]')
    .getByRole('button', { name: '项目', exact: true })
  const scroller = page.locator('[data-home-scroll]')
  await expect(back).toBeVisible()
  await expect(jump).toBeVisible()
  expect((await scroller.boundingBox())!.height).toBeGreaterThanOrEqual(300)
  await jump.hover()
  const capsule = jump.locator('[data-home-navigation-capsule]')
  await expect(capsule).toHaveCSS('height', '7px')
  await expect(capsule).toHaveCSS('width', '24px')
  const bounds = (await capsule.boundingBox())!
  const scrollBounds = (await scroller.boundingBox())!
  expect(scrollBounds.x).toBe(0)
  expect(scrollBounds.width).toBe(390)
  const projectBounds = (await page
    .getByRole('region', { name: '项目', exact: true })
    .boundingBox())!
  expect(bounds.x).toBeGreaterThan(projectBounds.x + projectBounds.width)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390)
  const jumpBounds = await jump.boundingBox()
  await jump.click()
  await expect(back).toBeVisible()
  expect(await jump.boundingBox()).toEqual(jumpBounds)
  const gallery = page.getByRole('region', { name: '案例市场' })
  await expect(gallery.getByRole('button', { name: '案例市场', exact: true })).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await expect(jump).toHaveAttribute('aria-current', 'location')
  await expect(back).not.toHaveAttribute('aria-current')
  await page.screenshot({ path: info.outputPath('home-navigation-small.png') })
  await back.click()
  await expect(
    page.getByRole('region', { name: '项目', exact: true }).getByRole('heading')
  ).toBeInViewport()
  const updates = (await page.getByRole('region', { name: '会话更新', exact: true }).boundingBox())!
  expect(updates.y + updates.height).toBeLessThanOrEqual(scrollBounds.y)
  await expect(back).toHaveAttribute('aria-current', 'location')
  await page.mouse.move(120, 350)
  await page.mouse.wheel(0, -10000)
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(0)
  await expect(back).not.toHaveAttribute('aria-current')
  await expect(jump).not.toHaveAttribute('aria-current')
})

test('refreshes marketplace data on demand, preserves filters and recovers from a failed refresh', async ({
  page
}, info) => {
  let fail = false
  let release: (() => void) | undefined
  let hold: Promise<void> | undefined
  let requests = 0
  let updated = false
  await page.route('**/usecases/manifest.json', async (route) => {
    requests++
    if (hold) await hold
    if (fail) return route.fulfill({ status: 503 })
    return route.fulfill({
      json: catalog.map((item) => ({
        ...item,
        title: updated ? `${item.title} updated` : item.title
      }))
    })
  })
  await page.goto('/home-use-cases.html')
  await page.getByRole('button', { name: 'Sharing marketplace', exact: true }).click()
  await expect(
    page.getByText('Discover and reuse research examples', { exact: true })
  ).toBeVisible()
  await page.getByRole('button', { name: 'Biology', exact: true }).click()
  const search = page.getByRole('textbox', { name: 'Search examples' })
  await search.fill('Research example 2')
  await expect(page.getByRole('article')).toHaveCount(1)
  const refresh = page.getByRole('button', { name: 'Refresh examples', exact: true })
  expect((await refresh.boundingBox())!.x).toBeGreaterThan(
    (await search.boundingBox())!.x + (await search.boundingBox())!.width
  )
  const searchBounds = await search.boundingBox()
  const before = requests
  hold = new Promise<void>((resolve) => {
    release = resolve
  })
  updated = true
  await refresh.click()
  await expect(refresh).toBeDisabled()
  await expect(refresh).toHaveAttribute('aria-busy', 'true')
  await expect(page.getByRole('article')).toHaveAttribute('aria-label', 'Research example 2')
  await expect.poll(() => requests).toBe(before + 1)
  release!()
  hold = undefined
  await expect(refresh).toBeEnabled()
  const confirmation = refresh.locator('.lucide-check')
  await expect(confirmation).toBeVisible()
  await expect(page.getByRole('main').getByRole('status')).toHaveCount(0)
  expect(await search.boundingBox()).toEqual(searchBounds)
  await expect(page.getByRole('article')).toHaveAttribute(
    'aria-label',
    'Research example 2 updated'
  )
  await expect(search).toHaveValue('Research example 2')
  await expect(page.getByRole('button', { name: 'Biology', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await page.screenshot({ path: info.outputPath('marketplace-refreshed.png') })
  await expect(confirmation).toHaveCount(0)
  fail = true
  await refresh.click()
  await expect(confirmation).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('main').getByRole('status')).toHaveCount(0)
  await expect(confirmation).toHaveCount(0)
  await expect(refresh.locator('.lucide-refresh-cw')).toBeVisible()
  await expect(page.getByRole('article')).toHaveAttribute(
    'aria-label',
    'Research example 2 updated'
  )
  fail = false
  await refresh.click()
  await expect(confirmation).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(refresh).toBeEnabled()
  await page.setViewportSize({ width: 390, height: 700 })
  await expect(search).toBeVisible()
  await expect(refresh).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('keeps the case title and import actions fixed while the introduction scrolls', async ({
  page
}, info) => {
  await page.route('**/intro.md', (route) =>
    route.fulfill({ body: '# Findings\n\n' + 'A detailed explanation.\n\n'.repeat(80) })
  )
  await page.goto('/home-use-cases.html')
  await page.getByRole('article').first().getByRole('button').first().click()
  const dialog = page.getByRole('dialog', { name: 'Case details', exact: true })
  const header = dialog.locator('[data-case-detail-header]')
  const body = dialog.locator('[data-case-detail-scroll]')
  await expect(dialog.getByRole('heading', { name: 'Findings', exact: true })).toBeVisible()
  await dialog.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished))
  })
  const before = await header.boundingBox()
  await body.hover()
  await page.mouse.wheel(0, 600)
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(100)
  expect(await header.boundingBox()).toEqual(before)
  await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toBeInViewport()
  await page.screenshot({ path: info.outputPath('case-detail-fixed-header.png') })
})

test('animates the capsule shape without moving its bounds and respects reduced motion', async ({
  page
}) => {
  await page.goto('/home-use-cases.html?long')
  const jump = page
    .locator('[data-home-navigation]')
    .getByRole('button', { name: 'Use Case Marketplace', exact: true })
  const capsule = jump.locator('[data-home-navigation-capsule]')
  const shape = jump.locator('[data-home-navigation-shape]')
  const initialBounds = await capsule.boundingBox()
  await expect(shape).toHaveCSS('clip-path', 'inset(1.5px 0px 1.5px 20px round 999px)')
  await shape.evaluate((element) => {
    element.addEventListener('transitionrun', (event) => {
      if ((event as TransitionEvent).propertyName === 'clip-path')
        element.setAttribute('data-shape-transition', 'running')
    })
  })
  await jump.hover()
  await expect(shape).toHaveAttribute('data-shape-transition', 'running')
  await expect(shape).toHaveCSS('clip-path', 'inset(0px round 999px)')
  expect(await capsule.boundingBox()).toEqual(initialBounds)
  await page.mouse.move(200, 200)
  await expect(shape).toHaveCSS('clip-path', 'inset(1.5px 0px 1.5px 20px round 999px)')
  expect(await capsule.boundingBox()).toEqual(initialBounds)
  await jump.focus()
  await expect(shape).toHaveCSS('clip-path', 'inset(0px round 999px)')
  expect(await capsule.boundingBox()).toEqual(initialBounds)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(shape).toHaveCSS('transition-property', 'none')
})

test('opens the marketplace in the conversation workbench and browses details in place', async ({
  page
}, info) => {
  await page.setViewportSize({ width: 1440, height: 800 })
  await page.goto('/home-use-cases.html?panel')
  const draft = page.getByRole('textbox', { name: 'Conversation draft' })
  await draft.fill('An unfinished research question')
  await page.getByRole('button', { name: 'Sharing marketplace', exact: true }).click()
  const panel = page.getByRole('tabpanel', { name: 'Sharing marketplace', exact: true })
  await expect(panel).toBeVisible()
  await expect(page.getByTestId('navigation')).toHaveText('workspace:research')
  await expect(draft).toHaveValue('An unfinished research question')
  expect((await panel.boundingBox())!.x).toBeGreaterThan((await draft.boundingBox())!.x)
  const heading = panel.getByRole('combobox', { name: 'Marketplace', exact: true })
  await expect(heading).toHaveCSS('font-size', '14px')
  const search = panel.getByRole('textbox', { name: 'Search examples' })
  const categories = panel.getByRole('group', { name: 'Category' })
  const openMarket = panel.getByRole('button', { name: 'View in sharing marketplace' })
  await expect(openMarket).toBeVisible()
  const headingBounds = (await heading.boundingBox())!
  const searchBounds = (await search.boundingBox())!
  const categoryBounds = (await categories.boundingBox())!
  expect(searchBounds.y).toBeGreaterThan(headingBounds.y + headingBounds.height)
  expect(searchBounds.width).toBeGreaterThan((await panel.boundingBox())!.width * 0.8)
  expect(categoryBounds.y).toBeGreaterThanOrEqual(searchBounds.y + searchBounds.height)
  expect(categoryBounds.y + categoryBounds.height - (await panel.boundingBox())!.y).toBeLessThan(
    140
  )
  const refresh = panel.getByRole('button', { name: 'Refresh examples', exact: true })
  await refresh.click()
  const confirmation = refresh.locator('.lucide-check')
  await expect(confirmation).toBeVisible()
  await expect(panel.getByRole('status')).toHaveCount(0)
  expect(await search.boundingBox()).toEqual(searchBounds)
  await page.screenshot({ path: info.outputPath('marketplace-refresh-check.png') })
  await expect(confirmation).toHaveCount(0)
  const cards = panel.getByRole('article')
  await expect(cards).toHaveCount(6)
  const first = (await cards.first().boundingBox())!
  const second = (await cards.nth(1).boundingBox())!
  const third = (await cards.nth(2).boundingBox())!
  expect(first.y).toBe(second.y)
  expect(third.y).toBeGreaterThan(first.y)
  await cards.first().getByRole('button').click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const details = panel.getByRole('region', { name: 'Case details', exact: true })
  await expect(details.getByRole('button', { name: 'Import', exact: true })).toBeVisible()
  const detailHeader = details.locator('[data-case-detail-header]')
  const effectiveBackground = (element: Element): string => {
    let current: Element | null = element
    while (current) {
      const color = getComputedStyle(current).backgroundColor
      if (color !== 'rgba(0, 0, 0, 0)') return color
      current = current.parentElement
    }
    return ''
  }
  const panelBackground = await panel.evaluate(effectiveBackground)
  await expect.poll(() => detailHeader.evaluate(effectiveBackground)).toBe(panelBackground)
  await expect(detailHeader).toHaveCSS('border-bottom-width', '0px')
  await expect(detailHeader).toHaveCSS('padding-top', '8px')
  await expect(detailHeader.getByRole('heading')).toHaveCSS('font-size', '20px')
  const headerBounds = await detailHeader.boundingBox()
  await details.locator('[data-case-detail-scroll]').evaluate((element) => {
    element.scrollTop = 200
  })
  expect(await detailHeader.boundingBox()).toEqual(headerBounds)
  await expect(draft).toHaveValue('An unfinished research question')
  await page.screenshot({ path: info.outputPath('marketplace-workspace-details.png') })
  await details.getByRole('button', { name: 'Back to list', exact: true }).click()
  await expect(cards).toHaveCount(6)
  await expect(cards.first().getByRole('button')).toBeFocused()
  await page.getByRole('button', { name: 'Sharing marketplace', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Sharing marketplace', exact: true })).toHaveCount(1)
  await page.screenshot({ path: info.outputPath('marketplace-workspace-list.png') })
  await page
    .getByRole('button', { name: 'Close preview of Sharing marketplace', exact: true })
    .click()
  await expect(draft).toHaveValue('An unfinished research question')
  await expect(panel).toHaveCount(0)
})

test('opens the full marketplace from its compact workbench header', async ({ page }) => {
  await page.goto('/home-use-cases.html?panel')
  await page.getByRole('button', { name: 'Sharing marketplace', exact: true }).click()
  const panel = page.getByRole('tabpanel', { name: 'Sharing marketplace', exact: true })
  await panel.getByRole('button', { name: 'View in sharing marketplace' }).click()
  await expect(page.getByTestId('navigation')).toHaveText('marketplace:research')
  await expect(page.getByRole('button', { name: 'Back to Home', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Back to Project', exact: true }).click()
  await expect(page.getByTestId('navigation')).toHaveText('workspace:research')
  await expect(panel).toBeVisible()
})

test('preserves the compact marketplace filters and visible case across full-page navigation', async ({
  page
}) => {
  const manyCases = Array.from({ length: 42 }, (_, index) => ({
    ...catalog[index % catalog.length],
    name: `case-${index + 1}`,
    title: `Research example ${index + 1}`,
    catalog: index % 2 ? 'Biology' : 'Science',
    catalog_name: index % 2 ? 'biology' : 'science'
  }))
  await page.route('**/manifest.json', (route) => route.fulfill({ json: manyCases }))
  await page.setViewportSize({ width: 1600, height: 700 })
  await page.goto('/home-use-cases.html?panel')
  await page.getByRole('button', { name: 'Sharing marketplace', exact: true }).click()
  const panel = page.getByRole('tabpanel', { name: 'Sharing marketplace', exact: true })
  await panel.getByRole('textbox', { name: 'Search examples' }).fill('Research example')
  await panel.getByRole('button', { name: 'Biology', exact: true }).click()
  const scroller = panel.locator('[data-use-case-browser-scroll]')
  for (const count of [12, 18]) {
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    await expect(panel.getByRole('article')).toHaveCount(count)
  }
  const anchor = panel.getByRole('article', { name: 'Research example 18', exact: true })
  await anchor.evaluate((el) => {
    const viewport = el.closest('[data-use-case-browser-scroll]')!
    viewport.scrollTop += el.getBoundingClientRect().top - viewport.getBoundingClientRect().top + 20
  })
  await panel.getByRole('button', { name: 'View in sharing marketplace' }).click()
  const full = page.getByRole('main')
  await expect(full.getByRole('textbox', { name: 'Search examples' })).toHaveValue(
    'Research example'
  )
  await expect(full.getByRole('button', { name: 'Biology', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(full.getByRole('article')).toHaveCount(18)
  await expect(
    full.getByRole('article', { name: 'Research example 18', exact: true })
  ).toBeInViewport()
  await expect
    .poll(() => full.locator('[data-use-case-browser-scroll]').evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0)
  await page.getByRole('button', { name: 'Back to Project', exact: true }).click()
  await expect(panel.getByRole('textbox', { name: 'Search examples' })).toHaveValue(
    'Research example'
  )
  await expect(panel.getByRole('button', { name: 'Biology', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(anchor).toBeInViewport()
  await page.getByRole('button', { name: 'All projects', exact: true }).click()
  await page.getByRole('button', { name: 'Sharing marketplace', exact: true }).click()
  await expect(full.getByRole('textbox', { name: 'Search examples' })).toHaveValue('')
  await expect(full.getByRole('button', { name: 'All categories', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect
    .poll(() => full.locator('[data-use-case-browser-scroll]').evaluate((el) => el.scrollTop))
    .toBe(0)
})

test('syncs changed and cleared full-page filters back to the project panel', async ({ page }) => {
  await page.goto('/home-use-cases.html?panel')
  await page.getByRole('button', { name: 'Sharing marketplace', exact: true }).click()
  const panel = page.getByRole('tabpanel', { name: 'Sharing marketplace', exact: true })
  const search = (surface: Locator): Locator =>
    surface.getByRole('textbox', { name: 'Search examples' })
  const category = (surface: Locator, name: string): Locator =>
    surface.getByRole('button', { name, exact: true })
  await search(panel).fill('Research example 2')
  await category(panel, 'Biology').click()
  await panel.getByRole('button', { name: 'View in sharing marketplace' }).click()
  const full = page.getByRole('main')
  await search(full).fill('Research example 3')
  await category(full, 'Science').click()
  await expect(full.getByRole('article')).toHaveCount(1)
  await page.getByRole('button', { name: 'Back to Project', exact: true }).click()
  await expect(search(panel)).toHaveValue('Research example 3')
  await expect(category(panel, 'Science')).toHaveAttribute('aria-pressed', 'true')
  await expect(panel.getByRole('article')).toHaveCount(1)
  await expect(
    panel.getByRole('article', { name: 'Research example 3', exact: true })
  ).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Conversation draft' })).toHaveValue(
    'Keep my draft'
  )

  // A second round trip must also transfer an empty query and the all-categories selection.
  await panel.getByRole('button', { name: 'View in sharing marketplace' }).click()
  await expect(search(full)).toHaveValue('Research example 3')
  await search(full).fill('')
  await category(full, 'All categories').click()
  await page.getByRole('button', { name: 'Back to Project', exact: true }).click()
  await expect(search(panel)).toHaveValue('')
  await expect(category(panel, 'All categories')).toHaveAttribute('aria-pressed', 'true')
  await expect(panel.getByRole('article')).toHaveCount(6)
  await expect
    .poll(() => panel.locator('[data-use-case-browser-scroll]').evaluate((el) => el.scrollTop))
    .toBe(0)
})

test('masks hovered card shadows behind the sticky home marketplace heading', async ({
  page
}, info) => {
  await page.goto('/home-use-cases.html?long')
  const scroller = page.locator('[data-home-scroll]')
  const gallery = page.getByRole('region', { name: 'Use Case Marketplace', exact: true })
  const card = gallery.getByRole('article').first()
  await card.scrollIntoViewIfNeeded()
  const viewport = (await scroller.boundingBox())!
  const initial = (await card.boundingBox())!
  await scroller.evaluate(
    (element, delta) => {
      element.scrollTop += delta
    },
    initial.y - viewport.y + 20
  )
  const bounds = (await card.boundingBox())!
  const grid = (await card.locator('..').boundingBox())!
  const header = gallery
    .getByRole('heading', { name: 'Use Case Marketplace', exact: true })
    .locator('..')
  const headerBounds = (await header.boundingBox())!
  expect(headerBounds.y).toBeCloseTo(viewport.y, 0)
  const clip = {
    x: grid.x - 10,
    y: viewport.y + 2,
    width: grid.width + 20,
    height: headerBounds.height - 4
  }
  await page.mouse.move(0, 0)
  const before = await page.screenshot({ clip })
  await page.mouse.move(bounds.x + bounds.width / 2, headerBounds.y + headerBounds.height + 12)
  await expect.poll(() => card.evaluate((element) => element.matches(':hover'))).toBe(true)
  await card.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations({ subtree: true }).map((animation) => animation.finished)
    )
  })
  const after = await page.screenshot({ clip })
  expect(after.equals(before)).toBe(true)
  await page.screenshot({ path: info.outputPath('home-marketplace-sticky-hover.png') })
})

test('returns home when the full marketplace was opened from home', async ({ page }) => {
  await page.goto('/home-use-cases.html')
  await page.getByRole('button', { name: 'Sharing marketplace', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Back to Project', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Back to Home', exact: true }).click()
  await expect(page.getByTestId('navigation')).toHaveText('home:')
})

test('selects the case marketplace without resetting its filters or opening details', async ({
  page
}, info) => {
  await page.goto('/home-use-cases.html?panel')
  await page.getByRole('button', { name: 'Sharing marketplace', exact: true }).click()
  const panel = page.getByRole('tabpanel', { name: 'Sharing marketplace', exact: true })
  const search = panel.getByRole('textbox', { name: 'Search examples' })
  await search.fill('Research example 1')
  const selector = panel.getByRole('combobox', { name: 'Marketplace', exact: true })
  await expect(selector).toHaveText('Use Case Marketplace')
  await selector.click()
  await expect(page.getByRole('option')).toHaveCount(1)
  const option = page.getByRole('option', { name: 'Use Case Marketplace', exact: true })
  await expect(option).toHaveAttribute('aria-selected', 'true')
  await page.screenshot({ path: info.outputPath('marketplace-type-selector.png') })
  await option.click()
  await expect(selector).toBeFocused()
  await expect(search).toHaveValue('Research example 1')
  await expect(panel.getByRole('article')).toHaveCount(1)
  await page.keyboard.press('ArrowDown')
  await expect(option).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await expect(selector).toBeFocused()
  await expect(panel.getByRole('group', { name: 'Category' })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

// Wide published tables must scroll independently instead of shifting the cover and prose.
for (const surface of ['panel', 'dialog'] as const) {
  test(`preserves table scroll during download progress in the ${surface}`, async ({ page }) => {
    const columns = Array.from({ length: 12 }, (_, i) => `Property ${i + 1}`)
    await page.route('**/intro.md', (route) =>
      route.fulfill({
        contentType: 'text/markdown',
        body:
          `| ${columns.join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |\n` +
          `| ${columns.map(() => 'Measured result').join(' | ')} |`
      })
    )
    await page.setViewportSize({ width: 1100, height: 800 })
    await page.goto(`/home-use-cases.html?download${surface === 'panel' ? '&panel' : ''}`)
    if (surface === 'panel')
      await page.getByRole('button', { name: 'Sharing marketplace', exact: true }).click()
    const owner =
      surface === 'panel'
        ? page.getByRole('tabpanel', { name: 'Sharing marketplace', exact: true })
        : page.getByRole('region', { name: 'Use Case Marketplace', exact: true })
    await owner.getByRole('article').first().getByRole('button').first().click()
    const detail =
      surface === 'panel' ? owner : page.getByRole('dialog', { name: 'Case details', exact: true })
    const scroller = detail.locator('[data-case-detail-scroll] [data-slot="scroll-area-viewport"]')
    await expect(scroller).toBeVisible()
    await scroller.evaluate((el) => {
      el.scrollLeft = 200
    })
    await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBe(200)
    await detail.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(detail.getByRole('button', { name: 'Downloading 35%', exact: true })).toBeVisible()
    await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBe(200)
    await detail.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(detail.getByRole('button', { name: 'Import', exact: true })).toBeVisible()
    await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBe(200)
  })

  test(`contains wide case tables inside the ${surface} at narrow and wide sizes`, async ({
    page
  }, info) => {
    const columns = Array.from({ length: 12 }, (_, i) => `Property ${i + 1}`)
    await page.route('**/intro.md', (route) =>
      route.fulfill({
        contentType: 'text/markdown',
        body: [
          '# Table findings',
          'A readable introduction before the table.',
          '| Key | Value |\n| --- | --- |\n| A | 1 |',
          '| Source | Role | Provenance |\n| --- | --- | --- |\n' +
            `| Dataset | Captured release | Archive SHA-256: \`${'a602502a'.repeat(8)}\` |`,
          `| ${columns.join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |\n` +
            `| ${columns.map(() => 'Measured result').join(' | ')} |`,
          'A readable conclusion after the table.'
        ].join('\n\n')
      })
    )
    await page.goto(`/home-use-cases.html${surface === 'panel' ? '?panel' : ''}`)
    if (surface === 'panel') {
      await page.getByRole('button', { name: 'Sharing marketplace', exact: true }).click()
    }
    const owner =
      surface === 'panel'
        ? page.getByRole('tabpanel', { name: 'Sharing marketplace', exact: true })
        : page.getByRole('region', { name: 'Use Case Marketplace', exact: true })
    await owner.getByRole('article').first().getByRole('button').first().click()
    const detail =
      surface === 'panel' ? owner : page.getByRole('dialog', { name: 'Case details', exact: true })
    const body = detail.locator('[data-case-detail-scroll]')
    await expect(body.getByRole('heading', { name: 'Table findings' })).toBeVisible()
    for (const width of [1100, 1600]) {
      await page.setViewportSize({ width, height: 800 })
      await expect
        .poll(() => body.evaluate((el) => el.scrollWidth - el.clientWidth))
        .toBeLessThanOrEqual(1)
      const fittingTable = body.getByRole('table').first()
      await fittingTable.hover()
      const fittingArea = body.locator('[data-slot="scroll-area-viewport"]').first().locator('..')
      await expect(fittingArea.locator('[data-slot="scroll-area-thumb"]')).toHaveCount(0)
      const table = body.getByRole('table').last()
      await table.scrollIntoViewIfNeeded()
      await table.hover()
      const scrollbar = body.locator('[data-orientation="horizontal"]').last()
      await scrollbar.scrollIntoViewIfNeeded()
      await table.hover()
      await expect(scrollbar).toHaveCSS('opacity', '1')
      await expect(scrollbar.locator('[data-slot="scroll-area-thumb"]')).toBeVisible()
      const scroller = body.locator('[data-slot="scroll-area-viewport"]').last()
      const prose = body.getByText('A readable conclusion after the table.')
      const before = await prose.boundingBox()
      const thumb = (await scrollbar.locator('[data-slot="scroll-area-thumb"]').boundingBox())!
      const track = (await scrollbar.boundingBox())!
      await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2)
      await page.mouse.down()
      await page.mouse.move(track.x + track.width - 2, thumb.y + thumb.height / 2, { steps: 8 })
      await page.mouse.up()
      await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)
      expect((await prose.boundingBox())!.x).toBe(before!.x)
      expect(await body.evaluate((el) => el.scrollLeft)).toBe(0)
      await page.mouse.move(0, 0)
      await expect(scrollbar).toHaveCSS('opacity', '0')
      await scroller.focus()
      await expect(scrollbar).toHaveCSS('opacity', '1')
      await scroller.evaluate((el) => (el as HTMLElement).blur())
    }
    await page.screenshot({ path: info.outputPath(`case-tables-${surface}.png`) })
  })
}

for (const outcome of ['changed', 'unchanged', 'failed'] as const) {
  test(`refreshes warm case details in the background when the body is ${outcome}`, async ({
    page
  }) => {
    let requests = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const explanation = '\n\n' + 'A detailed research explanation.\n\n'.repeat(40)
    await page.route('**/intro.md', async (route) => {
      requests++
      if (requests > 1) {
        await gate
        if (outcome === 'failed') return route.fulfill({ status: 503 })
      }
      return route.fulfill({
        contentType: 'text/markdown',
        body: `# ${requests > 1 && outcome === 'changed' ? 'Updated' : 'Original'} findings${explanation}`
      })
    })
    await page.goto('/home-use-cases.html?panel')
    await page.getByRole('button', { name: 'Sharing marketplace', exact: true }).click()
    const panel = page.getByRole('tabpanel', { name: 'Sharing marketplace', exact: true })
    const search = panel.getByRole('textbox', { name: 'Search examples' })
    await search.fill('Research example 1')
    await panel.getByRole('button', { name: 'Science', exact: true }).click()
    const card = panel.getByRole('article').first()
    await card.getByRole('button').click()
    await expect(panel.getByRole('heading', { name: 'Original findings' })).toBeVisible()
    await panel.getByRole('button', { name: 'Back to list' }).click()
    const cardNode = await card.elementHandle()
    await panel.getByRole('button', { name: 'Refresh examples', exact: true }).click()
    await expect.poll(() => requests).toBe(2)
    expect(await cardNode!.evaluate((element) => element.isConnected)).toBe(true)
    await expect(search).toHaveValue('Research example 1')
    await expect(panel.getByRole('button', { name: 'Science', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await card.getByRole('button').click()
    const body = panel.locator('[data-case-detail-scroll]')
    const heading = await body.getByRole('heading', { name: 'Original findings' }).elementHandle()
    await expect(body.getByText('Loading introduction…')).toHaveCount(0)
    await body.evaluate((element) => {
      element.scrollTop = 240
    })
    const before = await body.evaluate((element) => element.scrollTop)
    const completed = page.waitForResponse((response) => response.url().endsWith('/intro.md'))
    release()
    await completed
    await expect(
      body.getByRole('heading', {
        name: outcome === 'changed' ? 'Updated findings' : 'Original findings'
      })
    ).toBeAttached()
    await expect(body.getByText('Loading introduction…')).toHaveCount(0)
    await expect(body.getByRole('alert')).toHaveCount(0)
    expect(await body.evaluate((element) => element.scrollTop)).toBe(before)
    if (outcome !== 'changed')
      expect(await heading!.evaluate((element) => element.isConnected)).toBe(true)
    expect(requests).toBe(2)
  })
}

for (const surface of ['panel', 'standalone'] as const) {
  test(`distinguishes loading, failure, empty catalog and empty search in the ${surface}`, async ({
    page
  }, info) => {
    let outcome: 'failed' | 'empty' | 'available' = 'failed'
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route('**/manifest.json', async (route) => {
      await gate
      return outcome === 'failed'
        ? route.fulfill({ status: 503 })
        : route.fulfill({ json: outcome === 'empty' ? [] : catalog })
    })
    await page.goto(`/home-use-cases.html${surface === 'panel' ? '?panel' : ''}`)
    await page.getByRole('button', { name: 'Sharing marketplace', exact: true }).click()
    const market =
      surface === 'panel'
        ? page.getByRole('tabpanel', { name: 'Sharing marketplace', exact: true })
        : page.getByRole('main')
    await expect(market.getByRole('status')).toHaveText('Loading examples…')
    await expect(market.getByText('No matching examples')).toHaveCount(0)
    release()
    await expect(market.getByRole('alert')).toContainText('Could not load examples. Try again.')
    await expect(market.getByText('No matching examples')).toHaveCount(0)
    await page.screenshot({ path: info.outputPath(`market-first-load-failed-${surface}.png`) })
    outcome = 'empty'
    await market.getByRole('button', { name: 'Try again', exact: true }).click()
    await expect(market.getByText('No examples available yet.')).toBeVisible()
    await expect(market.getByRole('alert')).toHaveCount(0)
    outcome = 'available'
    await market.getByRole('button', { name: 'Refresh examples', exact: true }).click()
    await expect(market.getByRole('article')).toHaveCount(6)
    await market.getByRole('textbox', { name: 'Search examples' }).fill('does not exist')
    await expect(market.getByText('No matching examples')).toBeVisible()
    await expect(market.getByText('No examples available yet.')).toHaveCount(0)
  })
}

test('recovers from a retired category without losing search or restoring the retired selection', async ({
  page
}) => {
  const many = Array.from({ length: 19 }, (_, index) => ({
    ...catalog[index % catalog.length],
    name: `case-${index + 1}`,
    title: `Research example ${index + 1}`
  }))
  let current = many
  await page.route('**/manifest.json', (route) => route.fulfill({ json: current }))
  await page.goto('/home-use-cases.html?panel')
  await page.getByRole('button', { name: 'Sharing marketplace', exact: true }).click()
  const market = page.getByRole('tabpanel', { name: 'Sharing marketplace', exact: true })
  const search = market.getByRole('textbox', { name: 'Search examples' })
  await search.fill('Research example')
  await market.getByRole('button', { name: 'Biology', exact: true }).click()
  const scroller = market.locator('[data-use-case-browser-scroll]')
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await expect.poll(() => market.getByRole('article').count()).toBeGreaterThan(6)
  current = many.map((item) => ({ ...item, catalog: 'Science', catalog_name: 'science' }))
  await market.getByRole('button', { name: 'Refresh examples', exact: true }).click()
  await expect(market.getByRole('button', { name: 'Biology', exact: true })).toHaveCount(0)
  await expect(market.getByRole('button', { name: 'All categories', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(market.getByRole('article')).toHaveCount(6)
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(0)
  await expect(search).toHaveValue('Research example')
  current = many
  await market.getByRole('button', { name: 'Refresh examples', exact: true }).click()
  await expect(market.getByRole('button', { name: 'Biology', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false'
  )
  await expect(market.getByRole('button', { name: 'All categories', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
})
