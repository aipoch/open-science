import { expect, test } from '@playwright/test'

test('loads the translated screening view after preparing its locale', async ({ page }) => {
  await page.goto('/smart-screening.html?lang=zh-Hans')
  await page.getByRole('button', { name: '筛选过程', exact: true }).click()
  await expect(page.getByRole('region', { name: '筛选过程' })).toBeVisible()
  await page.getByRole('button', { name: '完成下一篇', exact: true }).click()
  await expect(page.locator('[data-slot="screening-matches"] article')).toHaveCount(1)
})

test('pauses real analysis and resumes the same progress without repeating completed papers', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/smart-screening.html')
  await expect(page.getByRole('region', { name: 'Results', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Screening process' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Screening process', exact: true }).click()
  const candidates = page.locator('[data-slot="screening-candidates"]')
  const matches = page.locator('[data-slot="screening-matches"]')
  await expect(candidates.locator('article')).toHaveCount(4)
  await page.evaluate(() => {
    const left = document.querySelector('[data-paper-id="paper-0"]')!.getBoundingClientRect().x
    let frames = 0
    const sample = (): void => {
      const card = document.querySelector(
        '[data-slot="screening-matches"] [data-paper-id="paper-0"]'
      )
      if (
        card &&
        card.getBoundingClientRect().x > left + 2 &&
        getComputedStyle(card).transform !== 'none'
      )
        document.documentElement.dataset.screeningMoved = 'true'
      if (frames++ < 180) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  await page.getByRole('button', { name: 'Complete next paper', exact: true }).click()
  await expect(matches.locator('[data-paper-id="paper-0"]')).toBeVisible()
  await expect(page.locator('[data-slot="screening-result-stack"]')).toHaveCount(0)
  await expect(page.locator('html')).toHaveAttribute('data-screening-moved', 'true')
  await expect(candidates.locator('[data-paper-id="paper-0"]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Pause analysis', exact: true }).click()
  await page.getByRole('button', { name: 'Complete next paper', exact: true }).click()
  await expect(
    page.getByRole('region', { name: 'Screening process' }).getByText(/^Paused/)
  ).toBeVisible()
  await expect(matches.locator('article')).toHaveCount(1)
  await page.getByRole('button', { name: 'Back to results', exact: true }).click()
  await page.getByRole('button', { name: 'Screening process', exact: true }).click()
  await expect(
    page.getByRole('region', { name: 'Screening process' }).getByText(/^Paused/)
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Resume analysis', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Pause analysis', exact: true })).toHaveCount(0)
  await expect(matches.locator('article')).toHaveCount(1)
  await page.getByRole('button', { name: 'Resume analysis', exact: true }).click()
  await expect(matches.locator('[data-paper-id="paper-0"]')).toBeVisible()
  await page.getByRole('button', { name: 'Complete next paper', exact: true }).click()
  await expect(matches.locator('[data-paper-id="paper-1"]')).toBeVisible()
  await page.getByRole('button', { name: 'Complete remaining papers', exact: true }).click()
  await expect(page.getByText(/^Completed/)).toBeVisible()
  await expect(page.getByRole('region', { name: 'Screening process' })).toBeVisible()
  await page.getByRole('button', { name: 'Back to results', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Screening process' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Results', exact: true })).toBeVisible()
  await expect(
    page.getByRole('button', {
      name: 'Reader agreement in computer-assisted nodule assessment',
      exact: true
    })
  ).toBeVisible()
})

test('enters from progress and returns to the preserved results without stopping analysis', async ({
  page
}) => {
  await page.goto('/smart-screening.html')
  const results = page.getByRole('region', { name: 'Results', exact: true })
  const entry = page.getByRole('button', { name: 'Screening process', exact: true })
  await expect(results).toBeVisible()
  await expect(page.getByRole('group', { name: 'Collection view' })).toHaveCount(0)
  await expect(entry.locator('[role="progressbar"]')).toHaveCount(1)
  await expect(entry).toHaveAccessibleDescription(/Updating.*0\/16/)
  const cdp = await page.context().newCDPSession(page)
  const accessibility = await cdp.send('Accessibility.getFullAXTree')
  expect(
    accessibility.nodes.some(
      (node) => !node.ignored && node.role?.value === 'progressbar' && node.value?.value === 0
    )
  ).toBe(true)
  await cdp.detach()
  // The existing product intentionally locks search while analysis is running.
  // Set a draft while idle, then start analysis before entering its process view.
  await page.getByRole('button', { name: 'Pause analysis', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Resume analysis', exact: true })).toBeEnabled()
  const search = page.getByRole('textbox', { name: 'Search references' })
  await search.fill('lung')
  await page.getByRole('button', { name: 'Resume analysis', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Screening process' })).toBeVisible()
  await page.getByRole('button', { name: 'Back to results', exact: true }).click()
  await entry.focus()
  await page.keyboard.press('Enter')
  const back = page.getByRole('button', { name: 'Back to results', exact: true })
  await expect(back).toBeFocused()
  await expect(results).toBeHidden()
  await expect(page.getByRole('button', { name: 'Pause analysis', exact: true })).toBeEnabled()
  await back.click()
  await expect(results).toBeVisible()
  await expect(results).toBeFocused()
  await expect(search).toHaveValue('lung')
  await entry.click()
  await expect(page.getByRole('region', { name: 'Screening process' })).toBeVisible()
  await page.getByRole('button', { name: 'Pause analysis', exact: true }).click()
  await expect(entry).toBeEnabled()
  await expect(
    page.getByRole('region', { name: 'Screening process' }).getByText(/^Paused/)
  ).toBeVisible()
  await back.click()
  await expect(results).toBeVisible()
  await expect(page.getByRole('region', { name: 'Screening process' })).toHaveCount(0)
})

test('keeps successive cards visibly in flight while the destination list makes room', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/smart-screening.html')
  await page.getByRole('button', { name: 'Screening process', exact: true }).click()
  const matches = page.locator('[data-slot="screening-matches"]')
  await page.getByRole('button', { name: 'Complete next paper', exact: true }).click()
  const first = matches.locator('[data-paper-id="paper-0"]')
  await expect(first).toBeVisible()
  await expect.poll(() => first.evaluate((node) => getComputedStyle(node).transform)).toBe('none')
  await page.getByRole('button', { name: 'AI matches', exact: true }).click()
  const destination = await first.boundingBox()
  await page.evaluate(() => {
    const left = document.querySelector('[data-paper-id="paper-1"]')!.getBoundingClientRect().x
    const right = document
      .querySelector('[data-slot="screening-matches"]')!
      .getBoundingClientRect().x
    let frames = 0
    let started = 0
    const sample = (): void => {
      const card = document.querySelector(
        '[data-slot="screening-matches"] [data-paper-id="paper-1"]'
      )
      if (card) {
        const x = card.getBoundingClientRect().x
        if (x > left + (right - left) * 0.15 && x < right - (right - left) * 0.15) {
          if (!started) started = performance.now()
          document.documentElement.dataset.flightDuration = String(performance.now() - started)
        }
      }
      if (frames++ < 180) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  await page.getByRole('button', { name: 'Complete next paper', exact: true }).click()
  await expect
    .poll(async () => Number(await page.locator('html').getAttribute('data-flight-duration')))
    .toBeGreaterThan(30)
  await expect(matches.locator('article')).toHaveCount(2)
  await expect
    .poll(async () => (await first.boundingBox())!.y)
    .toBeGreaterThan(destination!.y + 100)
})

test('uses static updates with reduced motion and fits narrow layouts', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/smart-screening.html')
  await page.getByRole('button', { name: 'Screening process', exact: true }).click()
  await page.getByRole('button', { name: 'Complete next paper', exact: true }).click()
  const card = page.locator('[data-slot="screening-matches"] article').first()
  await expect(card).toBeVisible()
  expect(await card.evaluate((node) => getComputedStyle(node).transform)).toBe('none')
  for (const slot of ['screening-robot-head', 'screening-robot-eyes', 'screening-robot-activity']) {
    const parts = page.locator(`[data-slot="${slot}"]`)
    await expect(parts).toHaveCount(slot === 'screening-robot-activity' ? 3 : 1)
    for (const part of await parts.all()) {
      expect(await part.evaluate((node) => getComputedStyle(node).transform)).toBe('none')
    }
  }
  await page.getByRole('button', { name: 'Pause analysis', exact: true }).click()
  await expect(page.locator('[data-slot="screening-indicator-core"]')).toHaveCSS('opacity', '1')
  await expect(
    page.locator('[data-slot="screening-indicator-core"] svg.lucide-pause')
  ).toBeVisible()
  await page.getByRole('button', { name: 'Resume analysis', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Collapse sidebar panel' }).click()
  const process = page.getByRole('region', { name: 'Screening process' })
  await expect(process).toBeVisible()
  expect(await process.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
  await page.getByRole('button', { name: 'Pause analysis', exact: true }).click()
  await expect(
    page.getByRole('region', { name: 'Screening process' }).getByText(/^Paused/)
  ).toBeVisible()
})

test('animates the working robot, reflects analysis pause, and retains completion until Back', async ({
  page
}) => {
  await page.goto('/smart-screening.html')
  await page.getByRole('button', { name: 'Screening process', exact: true }).click()
  const indicator = page.locator('[data-slot="screening-flow-indicator"]')
  const core = page.locator('[data-slot="screening-indicator-core"]')
  await expect(indicator).toHaveAttribute('data-processing', 'true')
  await expect(core.locator('[data-slot="screening-robot"]')).toBeVisible()
  await expect(core.locator('[data-slot="screening-robot-activity"]')).toHaveCount(3)
  await expect(core.locator('[data-slot="screening-scanner"]')).toHaveCount(0)
  const eyes = core.locator('[data-slot="screening-robot-eyes"]')
  const initialEyeTransform = await eyes.evaluate((node) => getComputedStyle(node).transform)
  await expect
    .poll(() => eyes.evaluate((node) => getComputedStyle(node).transform))
    .not.toBe(initialEyeTransform)
  await page.getByRole('button', { name: 'Pause analysis', exact: true }).click()
  await expect(indicator).toHaveAttribute('data-paused', 'true')
  await expect(indicator).toHaveAttribute('data-processing', 'false')
  await expect(core.locator('svg.lucide-pause')).toBeVisible()
  await expect(core.locator('[data-slot="screening-robot-eyes"]')).toHaveCount(0)
  const pausedOpacity = await core.evaluate((node) => getComputedStyle(node).opacity)
  await expect
    .poll(() => core.evaluate((node) => getComputedStyle(node).opacity))
    .not.toBe(pausedOpacity)
  await page.getByRole('button', { name: 'Resume analysis', exact: true }).click()
  await page.evaluate(() =>
    (
      window as unknown as { screeningFixture: { advance: (count: number) => void } }
    ).screeningFixture.advance(100)
  )
  await expect(page.getByRole('region', { name: 'Screening process' })).toBeVisible()
  await expect(page.getByText(/^Completed/)).toBeVisible()
  await expect(core.locator('svg.lucide-check')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Pause analysis', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Pause display', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Back to results', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Results', exact: true })).toBeFocused()
  await expect(page.getByRole('region', { name: 'Results', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Screening process', exact: true })).toHaveCount(0)
})

test('keeps the demo paused and waits for manual return after completion', async ({ page }) => {
  await page.goto('/smart-screening.html?autoplay=1&rate=8')
  await page.getByRole('button', { name: 'Toggle automatic demo', exact: true }).click()
  await page.getByRole('button', { name: 'Screening process', exact: true }).click()
  await expect(page.locator('[data-slot="screening-matches"] article')).toHaveCount(0)
  await page.getByRole('button', { name: 'Toggle automatic demo', exact: true }).click()
  await expect(page.locator('[data-slot="screening-matches"] article')).not.toHaveCount(0)
  await expect(page.getByText(/^Completed/)).toBeVisible()
  await page.getByRole('button', { name: 'Back to results', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Screening process' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Results', exact: true })).toBeVisible()
})

for (const rate of [8, 20]) {
  test(`follows ${rate} committed papers per second without a playback backlog`, async ({
    page
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto('/smart-screening.html?size=96&overrides=1&distribution=no-match')
    await page.getByRole('button', { name: 'Screening process', exact: true }).click()
    await expect(page.locator('[data-slot="screening-candidates"] article')).toHaveCount(4)
    await page.evaluate((papersPerSecond) => {
      const fixture = (
        window as unknown as { screeningFixture: { advance: (count?: number) => void } }
      ).screeningFixture
      const left = document
        .querySelector('[data-slot="screening-candidates"]')!
        .getBoundingClientRect().x
      const right = document
        .querySelector('[data-slot="screening-unmatched"]')!
        .getBoundingClientRect().x
      let delivered = 0
      let lastCommit = 0
      let pileBottom: number | undefined
      const deadline = performance.now() + 6000
      const batchSize = papersPerSecond === 20 ? 4 : 1
      const timer = setInterval(
        () => {
          fixture.advance(batchSize)
          delivered += batchSize
          if (delivered === 16) {
            lastCommit = performance.now()
            clearInterval(timer)
          }
        },
        (1000 / papersPerSecond) * batchSize
      )
      const sample = (): void => {
        const cards = [...document.querySelectorAll('[data-slot="screening-unmatched"] article')]
        if (
          cards.some((card) => {
            const x = card.getBoundingClientRect().x
            return x > left + 5 && x < right - 5
          })
        )
          document.documentElement.dataset.fastFlowMoved = 'true'
        const stack = document.querySelector('[data-slot="screening-result-stack"]')
        const landed = cards.filter((card) => card.getAttribute('data-flight') !== 'true')
        const flying = cards.filter((card) => card.getAttribute('data-flight') === 'true')
        document.documentElement.dataset.maxFlights = String(
          Math.max(Number(document.documentElement.dataset.maxFlights ?? 0), flying.length)
        )
        if (stack && landed.length === 1) {
          const receiving = flying.at(-1) ?? landed[0]
          const cover = receiving.getBoundingClientRect()
          const edge = stack.getBoundingClientRect()
          const listTop = document
            .querySelector('[data-slot="screening-unmatched"]')!
            .getBoundingClientRect().top
          const relativeBottom = edge.bottom - listTop
          pileBottom ??= relativeBottom
          const drift = Math.abs(relativeBottom - pileBottom)
          const previous = Number(document.documentElement.dataset.pileDrift ?? 0)
          document.documentElement.dataset.pileDrift = String(Math.max(previous, drift))
          if (
            getComputedStyle(receiving).transform !== 'none' &&
            (Math.abs(edge.bottom - cover.bottom) > 2 || Math.abs(edge.x - cover.x) > 2)
          ) {
            document.documentElement.dataset.pileReceivedCard = 'true'
          }
          if (!document.querySelector('[data-slot="screening-pile-cover"]')?.textContent?.trim()) {
            document.documentElement.dataset.pileExposedBlank = 'true'
          }
        }
        const caughtUp = document.querySelector(
          '[data-slot="screening-candidates"] [data-paper-id="paper-16"]'
        )
        if (
          lastCommit &&
          caughtUp &&
          cards.some((card) => card.getAttribute('data-paper-id') === 'paper-15') &&
          cards.every((card) => getComputedStyle(card).transform === 'none')
        ) {
          document.documentElement.dataset.fastFlowSettled = String(performance.now() - lastCommit)
        } else if (performance.now() < deadline) requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    }, rate)
    await expect(page.locator('html')).toHaveAttribute('data-fast-flow-moved', 'true')
    await expect(page.locator('html')).toHaveAttribute('data-fast-flow-settled', /.+/)
    // At most the current 650ms flight plus the latest coalesced flight, never 16 queued flights.
    expect(Number(await page.locator('html').getAttribute('data-fast-flow-settled'))).toBeLessThan(
      1500
    )
    await expect(
      page.locator('[data-slot="screening-unmatched"] [data-paper-id="paper-15"]')
    ).toBeVisible()
    await expect(page.locator('[data-slot="screening-unmatched"] article')).toHaveCount(1)
    await expect(page.locator('[data-slot="screening-candidates"] article')).toHaveCount(4)
    expect(Number(await page.locator('html').getAttribute('data-max-flights'))).toBeLessThanOrEqual(
      8
    )
    await expect(page.locator('html')).toHaveAttribute('data-pile-received-card', 'true')
    expect(Number(await page.locator('html').getAttribute('data-pile-drift'))).toBeLessThan(1)
    await expect(page.locator('html')).not.toHaveAttribute('data-pile-exposed-blank', 'true')
    await expect(page.locator('[data-slot="screening-result-pile"]')).toHaveAttribute(
      'aria-hidden',
      'true'
    )
    const stack = page.locator('[data-slot="screening-result-stack"]')
    await expect(stack.locator('span')).toHaveCount(3)
    const lastCard = await page
      .locator('[data-slot="screening-unmatched"] article')
      .last()
      .boundingBox()
    // The landed paper must paint in front of the stationary older cover.
    expect(
      await page
        .locator('[data-slot="screening-unmatched"] article')
        .last()
        .evaluate((card) => {
          const box = card.getBoundingClientRect()
          return (
            document
              .elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
              ?.closest('article') === card
          )
        })
    ).toBe(true)
    const furthestSheet = await stack.locator('span').first().boundingBox()
    expect(furthestSheet!.y + furthestSheet!.height).toBeGreaterThan(
      lastCard!.y + lastCard!.height + 12
    )
  })
}

for (const language of ['en', 'zh-Hans']) {
  test(`aligns empty and populated piles with single-line headings in ${language}`, async ({
    page
  }) => {
    await page.setViewportSize({ width: 1200, height: 1000 })
    await page.goto(`/smart-screening.html?lang=${language}&distribution=no-match&size=96`)
    await page
      .getByRole('button', {
        name: language === 'en' ? 'Screening process' : '筛选过程',
        exact: true
      })
      .click()
    await page.evaluate(() =>
      (
        window as unknown as { screeningFixture: { advance: (n: number) => void } }
      ).screeningFixture.advance(12)
    )
    await expect(page.locator('[data-slot="screening-unmatched"] article')).toHaveCount(1)
    await expect
      .poll(() =>
        page.evaluate(() => {
          const groups = [
            ...document.querySelectorAll('[data-slot="screening-result-groups"] > section')
          ]
          const boxes = groups.map((group) => {
            const list = group.querySelector('[data-slot^="screening-"]')!
            const body = list.querySelector('article > div') ?? list.querySelector('p')!
            return {
              y: list.getBoundingClientRect().y,
              height: body.getBoundingClientRect().height,
              header: group.querySelector('button')!.getBoundingClientRect().height
            }
          })
          return (
            boxes.length === 4 &&
            Math.abs(boxes[0].y - boxes[1].y) < 1 &&
            Math.abs(boxes[2].y - boxes[3].y) < 1 &&
            boxes.every((box) => box.height === 118 && box.header === 28)
          )
        })
      )
      .toBe(true)
    await expect(
      page.getByText('Showing recent results from this run. Go back to see the full collection.')
    ).toHaveCount(0)
  })
}

test('flies a batched result from beyond the preview over the previous pile cover', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/smart-screening.html?distribution=no-match&size=96')
  await page.getByRole('button', { name: 'Screening process', exact: true }).click()
  await page.evaluate(() =>
    (
      window as unknown as { screeningFixture: { advance: (n: number) => void } }
    ).screeningFixture.advance(4)
  )
  const pile = page.locator('[data-slot="screening-unmatched"]')
  await expect(pile.locator('article[data-paper-id="paper-3"]')).toBeVisible()
  await expect
    .poll(() =>
      pile
        .locator('article[data-paper-id="paper-3"]')
        .evaluate((node) => getComputedStyle(node).transform)
    )
    .toBe('none')
  await page.evaluate(() => {
    const pile = document.querySelector('[data-slot="screening-unmatched"]')!
    const oldTitle = pile.querySelector('article p')!.textContent
    const right = pile.getBoundingClientRect().x
    const deadline = performance.now() + 2000
    const sample = (): void => {
      const card = pile.querySelector('article[data-paper-id="paper-11"]')
      if (card && card.getBoundingClientRect().x < right - 5) {
        document.documentElement.dataset.batchFlight = 'true'
        if (pile.querySelector('[data-slot="screening-pile-cover"] p')?.textContent !== oldTitle)
          document.documentElement.dataset.coverChangedBeforeLanding = 'true'
      }
      if (performance.now() < deadline) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
    ;(
      window as unknown as { screeningFixture: { advance: (n: number) => void } }
    ).screeningFixture.advance(8)
  })
  await expect(pile.locator('article[data-paper-id="paper-11"]')).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-batch-flight', 'true')
  await expect(page.locator('html')).not.toHaveAttribute(
    'data-cover-changed-before-landing',
    'true'
  )
})

test('flies all four committed papers per second concurrently into the same pile', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/smart-screening.html?distribution=no-match&size=96')
  await page.getByRole('button', { name: 'Screening process', exact: true }).click()
  await expect(page.locator('[data-slot="screening-candidates"] article')).toHaveCount(4)
  const result = await page.evaluate(async () => {
    const fixture = (window as unknown as { screeningFixture: { advance: (n: number) => void } })
      .screeningFixture
    const seen = new Set<string>()
    let peak = 0
    let delivered = 0
    let live = true
    const sample = (): void => {
      const flying = [
        ...document.querySelectorAll('[data-slot="screening-unmatched"] article')
      ].filter((card) =>
        card.getAnimations().some((animation) => animation.playState === 'running')
      )
      peak = Math.max(peak, flying.length)
      for (const card of flying) seen.add(card.getAttribute('data-paper-id')!)
      if (live) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
    const timer = setInterval(() => {
      fixture.advance(1)
      if (++delivered === 4) clearInterval(timer)
    }, 250)
    await new Promise((resolve) => setTimeout(resolve, 1900))
    live = false
    return { peak, seen: [...seen].sort() }
  })
  expect(result.peak).toBeGreaterThanOrEqual(2)
  expect(result.seen).toEqual(['paper-0', 'paper-1', 'paper-2', 'paper-3'])
  await expect(page.locator('[data-slot="screening-unmatched"] article')).toHaveCount(1)
  await expect(page.locator('[data-slot="screening-unmatched"] article')).toHaveAttribute(
    'data-paper-id',
    'paper-3'
  )
})

test('keeps the newer pile cover when older parallel flights land later', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/smart-screening.html?distribution=no-match&size=96')
  await page.getByRole('button', { name: 'Screening process', exact: true }).click()
  await expect(page.locator('[data-slot="screening-candidates"] article')).toHaveCount(4)
  await page.evaluate(async () => {
    const ready = new Promise<void>((resolve) => {
      const sample = (): void => {
        const cards = [
          ...document.querySelectorAll('[data-slot="screening-unmatched"] [data-flight="true"]')
        ]
        if (cards.length === 4 && cards.every((card) => card.getAnimations().length)) {
          for (const card of cards) for (const animation of card.getAnimations()) animation.pause()
          resolve()
        } else requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })
    ;(
      window as unknown as { screeningFixture: { advance: (n: number) => void } }
    ).screeningFixture.advance(4)
    await ready
    for (const animation of document
      .querySelector('[data-slot="screening-unmatched"] [data-paper-id="paper-3"]')!
      .getAnimations())
      animation.finish()
  })
  const settled = page.locator('[data-slot="screening-unmatched"] article:not([data-flight])')
  await expect(settled).toHaveAttribute('data-paper-id', 'paper-3')
  await page.evaluate(() => {
    for (const card of document.querySelectorAll(
      '[data-slot="screening-unmatched"] [data-flight="true"]'
    ))
      for (const animation of card.getAnimations()) animation.finish()
  })
  await expect(page.locator('[data-slot="screening-unmatched"] [data-flight="true"]')).toHaveCount(
    0
  )
  await expect(settled).toHaveAttribute('data-paper-id', 'paper-3')
})

test('shrinks the flying card continuously from candidate width into its pile', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/smart-screening.html?distribution=no-match&size=96')
  await page.getByRole('button', { name: 'Screening process', exact: true }).click()
  await expect(page.locator('[data-slot="screening-candidates"] article')).toHaveCount(4)
  const geometry = await page.evaluate(async () => {
    const candidate = document
      .querySelector('[data-slot="screening-candidates"] article')!
      .getBoundingClientRect()
    const pile = document
      .querySelector('[data-slot="screening-unmatched"]')!
      .getBoundingClientRect()
    const flight = new Promise<{ card: Element; animation: Animation }>((resolve, reject) => {
      const deadline = performance.now() + 2000
      const sample = (): void => {
        const card = document.querySelector('[data-slot="screening-unmatched"] article')
        const animation = card?.getAnimations()[0]
        if (card && animation) {
          animation.pause()
          resolve({ card, animation })
          return
        }
        if (performance.now() > deadline) {
          reject(new Error('No incoming flight'))
          return
        }
        requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })
    ;(
      window as unknown as { screeningFixture: { advance: (n: number) => void } }
    ).screeningFixture.advance(1)
    const { card, animation } = await flight
    const duration = Number(animation.effect!.getComputedTiming().duration)
    const samples = [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
      animation.currentTime = duration * fraction
      const box = card.getBoundingClientRect()
      return { x: box.x, width: box.width, height: box.height }
    })
    animation.finish()
    return {
      duration,
      source: { x: candidate.x, width: candidate.width },
      target: { x: pile.x, width: pile.width },
      samples
    }
  })
  expect(geometry.duration).toBe(650)
  expect(geometry.source.width).toBeGreaterThan(geometry.target.width * 1.5)
  expect(Math.abs(geometry.samples[0].width - geometry.source.width)).toBeLessThan(1)
  expect(Math.abs(geometry.samples[0].x - geometry.source.x)).toBeLessThan(1)
  for (let i = 1; i < geometry.samples.length; i++) {
    expect(geometry.samples[i].width).toBeLessThan(geometry.samples[i - 1].width - 1)
    expect(geometry.samples[i].x).toBeGreaterThan(geometry.samples[i - 1].x)
    expect(geometry.samples[i].height).toBe(118)
  }
  expect(Math.abs(geometry.samples[4].width - geometry.target.width)).toBeLessThan(1)
  expect(Math.abs(geometry.samples[4].x - geometry.target.x)).toBeLessThan(1)
  await expect
    .poll(() =>
      page
        .locator('[data-slot="screening-unmatched"] article')
        .evaluate((node) => node.getBoundingClientRect().width)
    )
    .toBeCloseTo(geometry.target.width, 0)
})

test('routes every outcome into a visible expandable pile', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/smart-screening.html?distribution=all&size=96')
  await page.getByRole('button', { name: 'Screening process', exact: true }).click()
  const slots = [
    'screening-matches',
    'screening-unmatched',
    'screening-review',
    'screening-unavailable'
  ]
  for (const [index, slot] of slots.entries()) {
    await page.evaluate(
      ({ index, slot }) => {
        const left = document
          .querySelector(`[data-slot="screening-candidates"] [data-paper-id="paper-${index}"]`)!
          .getBoundingClientRect().x
        const destination = document
          .querySelector(`[data-slot="${slot}"]`)!
          .getBoundingClientRect().x
        const deadline = performance.now() + 3000
        const sample = (): void => {
          const card = document.querySelector(
            `[data-slot="${slot}"] [data-paper-id="paper-${index}"]`
          )
          if (card) {
            const x = card.getBoundingClientRect().x
            if (x > left + 5 && x < destination - 5)
              document.documentElement.setAttribute(`data-routed-${index}`, 'true')
          }
          if (performance.now() < deadline) requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      },
      { index, slot }
    )
    await page.getByRole('button', { name: 'Complete next paper', exact: true }).click()
    await expect(page.locator(`[data-slot="${slot}"] article`)).toHaveCount(1)
    await expect(page.locator('html')).toHaveAttribute(`data-routed-${index}`, 'true')
  }
  await page.evaluate(() =>
    (
      window as unknown as { screeningFixture: { advance: (n: number) => void } }
    ).screeningFixture.advance(12)
  )
  for (const slot of slots) {
    const group = page.locator(`[data-slot="${slot}"]`)
    await expect(group.locator('article')).toHaveCount(1)
    await expect(group.locator('[data-slot="screening-result-stack"] span')).toHaveCount(3)
    const toggle = group.locator('xpath=ancestor::section[1]').getByRole('button')
    await toggle.click()
    await expect(group.locator('article')).toHaveCount(4)
    await toggle.click()
    await expect(group.locator('article')).toHaveCount(1)
  }
})

test('opens immediately after re-analysis confirmation and respects Back while starting', async ({
  page
}) => {
  await page.goto('/smart-screening.html?startDelay=1500')
  await page.getByRole('button', { name: 'Pause analysis', exact: true }).click()
  await page.getByRole('button', { name: 'Collection actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Re-evaluate all', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Screening process' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Re-evaluate all', exact: true }).click()
  const process = page.getByRole('region', { name: 'Screening process' })
  await expect(process.getByText('Loading…', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Back to results', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Screening process', exact: true })).toBeEnabled()
  await expect(process).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Results', exact: true })).toBeVisible()
})
