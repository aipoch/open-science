import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'

test.use({ windowMode: 'normal' })

test('records first renderer readiness before the fixture reload', async ({ app }, testInfo) => {
  await app.completeOnboarding()
  await app.beginResourceProfile({
    ...(process.env.OPEN_SCIENCE_PERF_OUTPUT_ROOT
      ? { outputRoot: process.env.OPEN_SCIENCE_PERF_OUTPUT_ROOT }
      : {})
  })
  try {
    await app.restart({ resourceProfilePhase: 'startup' })
  } finally {
    const result = await app.finishResourceProfile()
    await testInfo.attach('first-startup-summary', {
      path: result.summaryMarkdownPath,
      contentType: 'text/markdown'
    })
    const first = result.summary.timings?.['first-startup-ready']
    const fixture = result.summary.timings?.['startup-ready']
    expect(first?.count).toBe(1)
    expect(first?.median).toBeGreaterThan(0)
    expect(fixture?.median).toBeGreaterThan(first!.median)
  }
})
