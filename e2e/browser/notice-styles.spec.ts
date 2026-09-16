import { expect, test } from '@playwright/test'

for (const width of [320, 375, 414, 768]) {
  for (const dark of [false, true]) {
    test(`localized link confirmation and recovery fit ${width}px ${dark ? 'dark' : 'light'}`, async ({
      page
    }) => {
      await page.setViewportSize({ width, height: 600 })
      await page.goto(`/notice-styles.html?locale=zh-Hans${dark ? '&dark' : ''}`)
      await page.getByRole('button', { name: 'External link', exact: true }).click()
      const link = page.getByRole('dialog')
      const heading = link.getByRole('heading')
      await expect(heading).toBeVisible()
      expect(await heading.textContent()).toBe(await link.getAttribute('aria-label'))
      expect(await heading.textContent()).not.toBe('Open external link?')
      expect(await link.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      for (const button of await link.getByRole('button').all()) {
        const bounds = (await button.boundingBox())!
        expect(bounds.x).toBeGreaterThanOrEqual(0)
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(600)
      }
      await page.keyboard.press('Escape')
      await expect(link).toHaveCount(0)
      await page.getByRole('button', { name: 'Verified copy', exact: true }).click()
      const recovery = page.getByRole('dialog')
      await expect(recovery).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(recovery).toBeVisible()
      expect(await recovery.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      const keep = recovery.getByRole('button').first()
      await keep.click()
      await expect(recovery).toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      )
    })
  }
}

test('external-link confirmation calls its owner once and dismisses', async ({ page }) => {
  await page.goto('/notice-styles.html')
  await page.getByRole('button', { name: 'External link', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Open link', exact: true }).click()
  await expect(page.getByTestId('actions')).toHaveText('1')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

for (const width of [320, 375, 414, 639, 640, 768]) {
  for (const dark of [false, true]) {
    test(`notices keep local guidance and recoverable errors readable at ${width}px ${dark ? 'dark' : 'light'}`, async ({
      page
    }) => {
      await page.setViewportSize({ width, height: 812 })
      await page.goto(`/notice-styles.html?locale=zh-Hans${dark ? '&dark' : ''}`)
      const examples = page.getByTestId('inline-notice-examples')
      await expect(examples).toBeVisible()
      expect(await examples.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      const network = page.getByTestId('notebook-network-protection-banner')
      const networkButton = network.getByRole('button')
      const buttonBounds = (await networkButton.boundingBox())!
      expect(buttonBounds.height).toBe(width < 640 ? 44 : 32)
      if (width < 640) {
        const innerWidth = await network.evaluate((el) => {
          const style = getComputedStyle(el)
          return el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
        })
        expect(buttonBounds.width).toBeCloseTo(innerWidth, 0)
      }
      const undo = page.getByTestId('archive-undo-snackbar')
      expect(await undo.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      await page.getByRole('button', { name: 'Notebook environment error', exact: true }).click()
      const environment = page.getByTestId('env-status-banner')
      await expect(environment).toBeVisible()
      expect(await environment.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      const reason = environment.locator('p')
      expect(await reason.textContent()).toContain('python-runtime-package '.repeat(20).trim())
      await environment.getByRole('button').click()
      await expect(page.getByTestId('actions')).toHaveText('1')
      await page.goto(`/notice-styles.html?locale=zh-Hans${dark ? '&dark' : ''}`)
      await page.getByRole('button', { name: 'Bottom storage error', exact: true }).click()
      const storage = page.getByTestId('session-persistence-alert')
      await expect(storage).toBeVisible()
      expect(await storage.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      await storage.getByTestId('session-persistence-retry').click()
      await expect(page.getByTestId('actions')).toHaveText('1')
      await storage.getByTestId('session-persistence-dismiss').click()
      await expect(storage).toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      )
    })
  }
}

for (const width of [320, 1000]) {
  test(`Notebook recovery stacks above other bottom notices at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 812 })
    await page.goto('/notice-styles.html?locale=zh-Hans')
    await page.getByRole('button', { name: 'Environment and storage errors', exact: true }).click()
    const environment = page.getByTestId('env-status-banner')
    const storage = page.getByTestId('session-persistence-alert')
    const envBounds = (await environment.boundingBox())!
    const storageBounds = (await storage.boundingBox())!
    expect(envBounds.x + envBounds.width).toBe(width - 12)
    expect(envBounds.y + envBounds.height).toBeLessThanOrEqual(storageBounds.y - 8)
    expect(storageBounds.y + storageBounds.height).toBe(800)
    await environment.getByRole('button').click()
    await storage.getByTestId('session-persistence-retry').click()
    await expect(page.getByTestId('actions')).toHaveText('2')
    await storage.getByTestId('session-persistence-dismiss').click()
    await expect(storage).toHaveCount(0)
    await expect(environment).toBeVisible()
    const remaining = (await environment.boundingBox())!
    expect(remaining.y + remaining.height).toBe(800)
    await page.goto('/notice-styles.html?locale=zh-Hans')
    await page.getByRole('button', { name: 'Notebook update progress', exact: true }).click()
    const progress = page.getByTestId('env-status-banner')
    await expect(progress).toContainText('60%')
    expect(await progress.getAttribute('role')).toBe('status')
    const progressBounds = (await progress.boundingBox())!
    expect(progressBounds.x + progressBounds.width).toBe(width - 12)
    expect(progressBounds.y + progressBounds.height).toBe(800)
  })
}

for (const dark of [false, true]) {
  test(`embedded and floating messages share one surface in ${dark ? 'dark' : 'light'} theme`, async ({
    page
  }) => {
    await page.setViewportSize({ width: 1000, height: 1100 })
    await page.goto(`/notice-styles.html?locale=zh-Hans${dark ? '&dark' : ''}`)
    await page.getByRole('button', { name: 'Notebook environment error', exact: true }).click()
    const surfaces = page.locator('[data-notice-level]')
    const styles = await surfaces.evaluateAll((nodes) =>
      nodes.map((node) => {
        const style = getComputedStyle(node)
        const icon = node.querySelector('svg')
        return {
          level: node.getAttribute('data-notice-level'),
          surface: [
            style.backgroundColor,
            style.borderRadius,
            style.borderTopWidth,
            style.padding
          ].join('|'),
          icon: icon ? getComputedStyle(icon).color : null
        }
      })
    )
    expect(new Set(styles.map((style) => style.surface)).size).toBe(1)
    expect(
      new Set(
        ['info', 'warning', 'error'].map(
          (level) => styles.find((style) => style.level === level)?.icon
        )
      ).size
    ).toBe(3)
    const network = page.getByTestId('notebook-network-protection-banner')
    await network.getByRole('button').click()
    await expect(page.getByTestId('actions')).toHaveText('1')
    await page.getByTestId('env-status-banner').getByRole('button').click()
    await expect(page.getByTestId('actions')).toHaveText('2')
  })
}

for (const width of [320, 1000]) {
  test(`short messages fit their content and stay centered at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/notice-styles.html?locale=zh-Hans')
    const standalone = page.getByTestId('short-action-notice')
    expect((await standalone.boundingBox())!.width).toBeLessThan(Math.min(384, width - 24))
    await page.getByRole('button', { name: 'Short message stack', exact: true }).click()
    const short = page.getByTestId('stacked-short-message')
    const long = page.getByTestId('stacked-long-message')
    const shortBounds = (await short.boundingBox())!
    const longBounds = (await long.boundingBox())!
    expect(shortBounds.width).toBeLessThan(longBounds.width)
    expect(shortBounds.x + shortBounds.width / 2).toBeCloseTo(width / 2, 0)
    expect(longBounds.x + longBounds.width / 2).toBeCloseTo(width / 2, 0)
    expect(longBounds.width).toBeLessThanOrEqual(Math.min(384, width - 24))
    expect(longBounds.height).toBe(shortBounds.height)
    expect(await long.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    await short.getByRole('button').click()
    await expect(short).toHaveCount(0)
  })
}

for (const width of [320, 1000]) {
  test(`long messages use a single line and retain existing actions at ${width}px`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/notice-styles.html?locale=zh-Hans&longArchive')
    const archive = page.getByTestId('archive-undo-snackbar')
    await archive.scrollIntoViewIfNeeded()
    const text = archive.locator('span[title]')
    expect(await text.getAttribute('title')).toBe(await text.textContent())
    expect(
      await text.evaluate((node) => {
        const style = getComputedStyle(node)
        return (
          style.whiteSpace === 'nowrap' &&
          style.textOverflow === 'ellipsis' &&
          node.scrollWidth > node.clientWidth
        )
      })
    ).toBe(true)
    expect((await archive.boundingBox())!.height).toBe(50)
    await expect(archive.getByRole('button')).toHaveCount(2)
    await expect(archive.getByRole('button', { name: /撤销/ }).first()).toBeVisible()
    expect(await archive.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
    await page.goto('/notice-styles.html?locale=zh-Hans')
    await expect(page.getByTestId('short-action-notice').getByRole('button')).toHaveCount(1)
    await page.getByRole('button', { name: 'Short message stack', exact: true }).click()
    const long = page.getByTestId('stacked-long-message')
    await expect(long.getByRole('button')).toHaveCount(1)
    expect((await long.boundingBox())!.height).toBe(50)
  })
}

for (const width of [320, 1000]) {
  for (const dark of [false, true]) {
    test(`Settings keeps operation messages and input validation distinct at ${width}px ${dark ? 'dark' : 'light'}`, async ({
      page
    }) => {
      await page.setViewportSize({ width, height: 1100 })
      await page.goto(`/notice-styles.html?locale=zh-Hans&settingsInline${dark ? '&dark' : ''}`)
      await page.getByRole('button', { name: '保存', exact: true }).click()
      const error = page.locator('[data-notice-level="error"]')
      await expect(error).toContainText('无法保存代理配置。')
      await expect(error.getByRole('alert')).toBeVisible()
      const warning = page.locator('[data-notice-level="warning"]')
      await expect(warning).toContainText('Notebook 网络保护尚未设置。')
      const styles = await page.locator('[data-notice-level]').evaluateAll((nodes) =>
        nodes.map((node) => {
          const style = getComputedStyle(node)
          return [style.backgroundColor, style.borderRadius, style.padding].join('|')
        })
      )
      expect(new Set(styles).size).toBe(1)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      )
      const server = page.locator('#network-proxy-server')
      await server.fill('invalid-proxy')
      await server.blur()
      await expect(error).toHaveCount(0)
      const validation = page.locator('#network-proxy-server-help')
      await expect(validation).toHaveAttribute('role', 'alert')
      await expect(server).toHaveAttribute('aria-describedby', 'network-proxy-server-help')
      expect(await validation.evaluate((node) => node.closest('[data-notice-level]'))).toBeNull()
      expect(await validation.evaluate((node) => getComputedStyle(node).fontSize)).toBe('12px')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      )
    })
  }
}

for (const width of [320, 1000]) {
  for (const dark of [false, true]) {
    test(`archive feedback is centered with unclipped shadow space at ${width}px, dark=${dark}`, async ({
      page
    }) => {
      await page.setViewportSize({ width, height: 700 })
      await page.goto(`/notice-styles.html?floatingArchive&longArchive${dark ? '&dark' : ''}`)
      const archive = page.getByTestId('archive-undo-snackbar')
      const bounds = (await archive.boundingBox())!
      expect(bounds.x + bounds.width / 2).toBeCloseTo(width / 2, 0)
      expect(bounds.y).toBeLessThan(25)
      expect(bounds.height).toBeCloseTo(50, 2)
      const stack = page.locator('[data-action-toast-stack]')
      const stackBounds = (await stack.boundingBox())!
      expect(stackBounds.x).toBe(0)
      expect(stackBounds.width).toBe(width)
      expect(stackBounds.y + stackBounds.height - bounds.y - bounds.height).toBeGreaterThanOrEqual(
        40
      )
      expect(
        await archive.evaluate((el) => {
          for (
            let parent = el.parentElement;
            parent && !parent.hasAttribute('data-action-toast-stack');
            parent = parent.parentElement
          ) {
            const style = getComputedStyle(parent)
            if (style.overflowX !== 'visible' || style.overflowY !== 'visible') return false
          }
          return true
        })
      ).toBe(true)
      // The viewport-wide shadow space must not intercept interactions with the page below.
      expect(
        await page.evaluate(() =>
          document.elementFromPoint(2, 40)?.closest('[data-action-toast-stack]')
        )
      ).toBeNull()
      await archive.getByRole('button', { name: 'Dismiss archive Undo' }).click()
      await expect(archive).toHaveCount(0)
    })
  }
}
