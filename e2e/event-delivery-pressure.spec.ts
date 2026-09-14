import { expect } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProject, sendPrompt } from './certification/helpers'
import { test } from './fixtures/electron-app'

test('records concurrent session delivery with a stalled renderer and cancellation', async ({
  app
}, testInfo) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  await app.configureFakeAgent()
  await app.beginResourceProfile({ sampleIntervalMs: 500 })
  const pages = [app.page, await app.openAdditionalRenderer()]
  const releaseFile = join(await app.createTestDirectory('pressure'), 'release')
  await createProject(pages[0], 'Pressure first session')
  await createProject(pages[1], 'Pressure second session')
  const observers = await Promise.all(
    pages.map((page, index) =>
      page.evaluateHandle((stall) => {
        const samples: Array<{
          id: string
          sessionId?: string
          messageId?: string
          chunks: number[]
          emittedAt: number
          receivedAt: number
          bytes: number
        }> = []
        let stalled = false
        const unsubscribe = window.api.acp.onEvent((events) => {
          if (stall && !stalled && events.some((event) => event.kind === 'message')) {
            stalled = true
            const until = performance.now() + 1_000
            while (performance.now() < until) {
              /* Intentionally block this renderer only. */
            }
          }
          for (const event of events)
            samples.push({
              id: event.id,
              sessionId: event.sessionId,
              messageId: event.messageId,
              chunks: Array.from(
                (event.text ?? '').matchAll(/Resource stress chunk (\d+):/g),
                (match) => Number(match[1])
              ),
              emittedAt: event.timestamp,
              receivedAt: Date.now(),
              bytes: new TextEncoder().encode(JSON.stringify(event)).length
            })
        })
        return { samples, unsubscribe, wasStalled: () => stalled }
      }, index === 1)
    )
  )
  try {
    await app.markResourceProfilePhase('parallel-streams')
    await Promise.all(
      pages.map((page, index) =>
        sendPrompt(
          page,
          `Run the runtime resource stress journey. Session ${index + 1}.`,
          'Runtime resource stress journey complete.',
          90_000
        )
      )
    )
    await expect.poll(() => pages[0].evaluate(() => window.api.storage.detectActive())).toEqual([])
    await app.sampleResourceProfileNow()
    await expect
      .poll(async () => {
        const ids = await Promise.all(
          observers.map((observer) =>
            observer.evaluate((value) => value.samples.map((sample) => sample.id))
          )
        )
        return JSON.stringify(ids[0]) === JSON.stringify(ids[1])
      })
      .toBe(true)
    const streams = await Promise.all(
      observers.map((observer) => observer.evaluate((value) => value.samples))
    )
    expect(streams[0].length).toBeGreaterThan(90)
    expect(new Set(streams[0].map((sample) => sample.id)).size).toBe(streams[0].length)
    expect(streams[1].map((sample) => sample.id)).toEqual(streams[0].map((sample) => sample.id))
    expect(await observers[1].evaluate((value) => value.wasStalled())).toBe(true)
    const expectedChunks = Array.from({ length: 90 }, (_, index) => index)
    await expect
      .poll(
        async () =>
          pages[0].evaluate(async () => {
            const loaded = await window.api.sessions.loadAll()
            return loaded.sessions
              .map((session) =>
                session.messages.flatMap((message) =>
                  Array.from(message.content.matchAll(/Resource stress chunk (\d+):/g), (match) =>
                    Number(match[1])
                  )
                )
              )
              .filter((chunks) => chunks.length > 0)
          }),
        { timeout: 60_000 }
      )
      .toEqual([expectedChunks, expectedChunks])
    for (const page of pages) {
      // The presentation scheduler can still be revealing the earlier large message
      // after the final short reply appears. Wait for the full displayed transcript.
      await expect
        .poll(
          async () => {
            const transcript = await page.getByRole('region', { name: 'Conversation' }).innerText()
            return Array.from(transcript.matchAll(/Resource stress chunk (\d+):/g), (match) =>
              Number(match[1])
            )
          },
          { timeout: 60_000 }
        )
        .toEqual(expectedChunks)
      // Both clients must remain settled after reveal and delayed save receipts; a revived old
      // activeRun can leave Cancel visible even though Main has no active provider.
      await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Cancel run', exact: true })).toHaveCount(0)
    }
    await expect
      .poll(
        async () =>
          pages[0].evaluate(async () => {
            const { sessions } = await window.api.sessions.loadAll()
            return sessions
              .filter((session) =>
                session.messages.some((message) =>
                  message.content.startsWith('Run the runtime resource stress journey.')
                )
              )
              .map((session) => ({ status: session.status, active: Boolean(session.activeRun) }))
          }),
        { timeout: 60_000 }
      )
      .toEqual([
        { status: 'idle', active: false },
        { status: 'idle', active: false }
      ])
    await app.markResourceProfilePhase('cancellation')
    await pages[0]
      .getByRole('textbox', { name: 'Ask anything' })
      .fill(
        `Hold the queue until the reveal finishes. Release file: ${JSON.stringify(releaseFile)}`
      )
    await pages[0].getByRole('button', { name: 'Send message' }).click()
    const cancel = pages[0].getByRole('button', { name: 'Cancel run', exact: true })
    await expect(cancel).toBeVisible()
    await expect
      .poll(async () =>
        (await app.readFakeAgentPrompts()).some((entry) =>
          entry.prompt.includes('Hold the queue until the reveal finishes.')
        )
      )
      .toBe(true)
    await expect
      .poll(async () => (await pages[0].evaluate(() => window.api.storage.detectActive())).length)
      .toBeGreaterThan(0)
    const started = performance.now()
    // Send the pointer click immediately; measure cancellation, not layout-stability waiting.
    await cancel.click({ force: true })
    await expect.poll(() => pages[0].evaluate(() => window.api.storage.detectActive())).toEqual([])
    const cancellationMs = performance.now() - started
    const metrics = streams.map((samples) => {
      const delays = samples
        .map((sample) => Math.max(0, sample.receivedAt - sample.emittedAt))
        .sort((a, b) => a - b)
      return {
        events: samples.length,
        bytes: samples.reduce((sum, sample) => sum + sample.bytes, 0),
        p95DeliveryMs: delays[Math.floor(delays.length * 0.95)],
        maxDeliveryMs: delays.at(-1)
      }
    })
    const metricsPath = testInfo.outputPath('event-delivery-metrics.json')
    await writeFile(
      metricsPath,
      JSON.stringify({ rendererStallMs: 1_000, cancellationMs, renderers: metrics }, null, 2)
    )
    await testInfo.attach('event-delivery-metrics', {
      path: metricsPath,
      contentType: 'application/json'
    })
  } finally {
    const evidence = await Promise.all(
      observers.map((observer) => observer.evaluate((value) => value.samples))
    )
    const persisted = await pages[0].evaluate(async () => {
      const loaded = await window.api.sessions.loadAll()
      return loaded.sessions.map((session) => ({
        id: session.id,
        messages: session.messages.map((message) => ({
          id: message.id,
          chunks: Array.from(
            JSON.stringify(message).matchAll(/Resource stress chunk (\d+):/g),
            (match) => Number(match[1])
          )
        }))
      }))
    })
    await writeFile(
      testInfo.outputPath('delivery-evidence.json'),
      JSON.stringify({ events: evidence, persisted })
    )
    await writeFile(releaseFile, '')
    for (const observer of observers) await observer.evaluate((value) => value.unsubscribe())
    const result = await app.finishResourceProfile()
    await testInfo.attach('runtime-resource-summary', {
      path: result.summaryMarkdownPath,
      contentType: 'text/markdown'
    })
    await pages[1].close()
  }
})
