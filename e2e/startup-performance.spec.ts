import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'

test.use({ windowMode: 'normal' })

for (const locale of ['en', 'zh-Hans'] as const) {
  test(`records ${locale} startup milestones before the fixture reload`, async ({
    app
  }, testInfo) => {
    const page = await app.completeOnboarding()
    await page.evaluate(
      async (preference) => window.api.locale.setPreference({ preference }),
      locale
    )
    await expect(page.locator('html')).toHaveAttribute('lang', locale)
    await app.beginResourceProfile({
      firstReadySurface: 'home',
      runId: `startup-${locale}-${testInfo.repeatEachIndex}-${Date.now()}`,
      ...(process.env.OPEN_SCIENCE_PERF_OUTPUT_ROOT
        ? { outputRoot: process.env.OPEN_SCIENCE_PERF_OUTPUT_ROOT }
        : {})
    })
    try {
      const restarted = await app.restart({ resourceProfilePhase: 'startup' })
      await expect(restarted.locator('html')).toHaveAttribute('lang', locale)
      await expect(restarted.getByTestId('home-page')).toBeVisible()
      await expect(restarted.getByTestId('home-new-project')).toBeEnabled()
    } finally {
      const result = await app.finishResourceProfile()
      await testInfo.attach('first-startup-summary', {
        path: result.summaryMarkdownPath,
        contentType: 'text/markdown'
      })
      const first = result.summary.timings?.['first-startup-ready']
      const visible = result.summary.timings?.['first-window-visible']
      const runtime = result.summary.timings?.['first-runtime-ready']
      const interactive = result.summary.timings?.['first-workspace-ready']
      const fixture = result.summary.timings?.['startup-ready']
      expect(first?.count).toBe(1)
      expect(visible?.median).toBeGreaterThan(0)
      expect(runtime?.median).toBeGreaterThan(0)
      expect(first?.median).toBeGreaterThanOrEqual(runtime!.median)
      expect(interactive?.median).toBeGreaterThanOrEqual(first!.median)
      expect(interactive?.median).toBeGreaterThan(0)
      expect(fixture?.median).toBeGreaterThan(first!.median)
      expect(
        result.summary.startupTrace.some((event) => event.operation === 'application-startup')
      ).toBe(true)
      const compositionTrace = result.summary.startupTrace.filter(
        (event) => event.operation === 'application-composition'
      )
      expect(
        new Set(compositionTrace.flatMap((event) => (event.phase ? [event.phase] : []))).size
      ).toBeGreaterThan(2)
      expect(compositionTrace.some((event) => event.event === 'completed')).toBe(true)
    }
  })
}
