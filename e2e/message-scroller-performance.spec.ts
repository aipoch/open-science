import { expect } from '@playwright/test'
import type { Page } from 'playwright'

import { test } from './fixtures/electron-app'

const ROW_SELECTOR = '[data-slot="message-scroller-item"]'
const VIEWPORT_SELECTOR = '[data-slot="message-scroller-viewport"]'
const LONG_STREAM_PROMPT = 'Stream the long scroll journey.'
const LONG_STREAM_FINAL_SEGMENT = 'Segment 3 paragraph 7'
const SCROLL_STEPS = 20
const RAF_FALLBACK_MS = 500

type SeedMessage = {
  id: string
  role: 'user' | 'agent'
  content: string
  status: 'complete'
  eventIds: string[]
  createdAt: number
  updatedAt: number
}

type FrameSummary = {
  count: number
  p50: number
  p95: number
  max: number
  over50ms: number
}

type LongTaskSummary = {
  count: number
  totalMs: number
  max: number
}

const round = (value: number): number => Math.round(value * 100) / 100

const summarizeFrames = (frames: number[]): FrameSummary => {
  const sorted = [...frames].sort((a, b) => a - b)
  const percentile = (p: number): number =>
    sorted.length === 0
      ? 0
      : sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
  return {
    count: sorted.length,
    p50: round(percentile(50)),
    p95: round(percentile(95)),
    max: round(sorted.at(-1) ?? 0),
    over50ms: sorted.filter((frame) => frame > 50).length
  }
}

const summarizeLongTasks = (durations: number[]): LongTaskSummary => ({
  count: durations.length,
  totalMs: round(durations.reduce((total, duration) => total + duration, 0)),
  max: round(Math.max(0, ...durations))
})

const USER_TOPICS = [
  'Compare the benchmark runs for the parser rewrite.',
  'Why does the index rebuild take longer on cold cache?',
  'Summarize the flame graph from the latest profile.',
  'Draft the rollout plan for the streaming change.',
  'Explain the regression in the scroll anchoring test.',
  'What changed in the persistence envelope format?',
  'Review the memory numbers from the stress run.',
  'How should we shard the transcript fixture data?'
]

const AGENT_PARAGRAPHS = [
  'The profile shows layout work dominating the main thread while the transcript grows. Most of the cost comes from style recalculation on rows that are far outside the viewport, which suggests containment is not applied uniformly.',
  'Breaking the run into phases makes the pattern clearer. Hydration is cheap, the first paint is bounded by the rows near the anchor, and the expensive tail is markdown re-parsing for messages that have not changed since the last render.',
  'The scroll samples tell a consistent story. Median frames stay near the vsync budget, but the p95 spikes line up with the moments the scroller crosses rows that carry code fences, because those rows re-measure once syntax highlighting resolves.',
  'A reasonable mitigation is to memoize the rendered markdown per message id and revision. The transcript is append-mostly, so a cache keyed by id plus updatedAt should collapse almost all of the repeated parse work without changing the rendering pipeline.',
  'Long tasks cluster around streaming bursts. Each chunk notification triggers a re-render of the streaming row, and when the chunk cadence is faster than the frame budget the main thread never gets back below fifty milliseconds between chunks.',
  'The manifest-driven restore path is linear in the number of messages. Normalization is tolerant and cheap, but the downstream React tree construction is not, so the open-time cost scales with transcript length rather than with viewport size.',
  'Containment with an estimated intrinsic size keeps offscreen rows from participating in layout, but the estimate has to be close to the real row height or the scrollbar thumb drifts while rows resolve their actual size during fast scrolls.',
  'None of these costs are inherent to the data model. They are all rendering-pipeline costs, which means the fix belongs in the scroller and the message row components rather than in persistence or in the agent bridge.'
]

const agentContent = (index: number): string => {
  const paragraphCount = 3 + (index % 6)
  const parts: string[] = []
  for (let paragraph = 0; paragraph < paragraphCount; paragraph += 1) {
    parts.push(AGENT_PARAGRAPHS[(index + paragraph) % AGENT_PARAGRAPHS.length])
  }
  if (index % 14 === 1) {
    parts.push(
      [
        '```ts',
        `const sample = frames[${index} % SCROLL_STEPS]`,
        'if (sample > 50) reportLongFrame(sample)',
        '```'
      ].join('\n')
    )
  } else if (index % 14 === 7) {
    parts.push(
      [
        `- Median frame stayed under budget in run ${index % 5}`,
        '- P95 spiked near the code-fence rows',
        '- Long tasks clustered around streaming bursts'
      ].join('\n')
    )
  }
  return parts.join('\n\n')
}

const buildMessages = (count: number): SeedMessage[] => {
  const base = Date.now() - count * 1_000
  return Array.from({ length: count }, (_, index) => {
    const createdAt = base + index * 1_000
    const isUser = index % 2 === 0
    return {
      id: `perf-message-${index}`,
      role: isUser ? 'user' : 'agent',
      content: isUser
        ? `${USER_TOPICS[(index / 2) % USER_TOPICS.length]} (turn ${index / 2})`
        : agentContent(index),
      status: 'complete',
      eventIds: [],
      createdAt,
      updatedAt: createdAt
    }
  })
}

const seedSession = async (page: Page, messages: SeedMessage[]): Promise<void> => {
  await page.evaluate(async (seededMessages) => {
    const bridge = globalThis as unknown as {
      api: {
        projects: {
          create: (request: { name: string; description: string }) => Promise<{ id: string }>
        }
        sessions: {
          saveManifest: (request: { lastProjectId: string; lastSessionId: string }) => Promise<void>
          saveSession: (session: Record<string, unknown>) => Promise<void>
        }
      }
    }
    const project = await bridge.api.projects.create({
      name: 'Transcript perf project',
      description: 'Seeded long transcript for performance measurement.'
    })
    const now = Date.now()
    await bridge.api.sessions.saveSession({
      id: 'perf-seed-session',
      projectId: project.id,
      title: 'Transcript performance session',
      cwd: '/tmp/transcript-perf',
      status: 'idle',
      agentFrameworkId: 'opencode',
      messages: seededMessages,
      createdAt: now - seededMessages.length * 1_000,
      updatedAt: now
    })
    await bridge.api.sessions.saveManifest({
      lastProjectId: project.id,
      lastSessionId: 'perf-seed-session'
    })
  }, messages)
}

const measureScroll = (
  page: Page
): Promise<{
  frames: number[]
  longTasks: number[]
  startTop: number
  endTop: number
  minTop: number
}> =>
  page.evaluate(
    async ({ viewportSelector, steps, rafFallbackMs }) => {
      const viewport = document.querySelector(viewportSelector)
      if (!(viewport instanceof HTMLElement)) {
        throw new Error('Message scroller viewport not found.')
      }
      viewport.style.scrollBehavior = 'auto'
      const frames: number[] = []
      const longTasks: number[] = []
      let collecting = true
      let last = performance.now()
      const collect = (now: number): void => {
        if (!collecting) return
        frames.push(now - last)
        last = now
        requestAnimationFrame(collect)
      }
      requestAnimationFrame(collect)
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push(entry.duration)
      })
      observer.observe({ type: 'longtask' })
      const nextFrame = (): Promise<void> =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, rafFallbackMs)
          requestAnimationFrame(() => {
            clearTimeout(timer)
            resolve()
          })
        })
      const stepTo = async (target: number): Promise<void> => {
        const origin = viewport.scrollTop
        for (let step = 1; step <= steps; step += 1) {
          viewport.scrollTop = origin + ((target - origin) * step) / steps
          await nextFrame()
        }
      }
      const startTop = viewport.scrollTop
      // Offscreen rows resolve their real heights during the upward pass and scroll anchoring can
      // nudge scrollTop off an exact target, so track the minimum reached instead of the endpoint.
      let minTop = startTop
      const trackMin = async (target: number): Promise<void> => {
        const origin = viewport.scrollTop
        for (let step = 1; step <= steps; step += 1) {
          viewport.scrollTop = origin + ((target - origin) * step) / steps
          await nextFrame()
          minTop = Math.min(minTop, viewport.scrollTop)
        }
      }
      await trackMin(0)
      await stepTo(viewport.scrollHeight)
      collecting = false
      observer.disconnect()
      return { frames, longTasks, startTop, endTop: viewport.scrollTop, minTop }
    },
    {
      viewportSelector: VIEWPORT_SELECTOR,
      steps: SCROLL_STEPS,
      rafFallbackMs: RAF_FALLBACK_MS
    }
  )

const startStreamingCollector = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const frames: number[] = []
    const longTasks: number[] = []
    let active = true
    let last = performance.now()
    const collect = (now: number): void => {
      if (!active) return
      frames.push(now - last)
      last = now
      requestAnimationFrame(collect)
    }
    requestAnimationFrame(collect)
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(entry.duration)
    })
    observer.observe({ type: 'longtask' })
    ;(globalThis as unknown as { __perfStreamCollector: unknown }).__perfStreamCollector = {
      stop: () => {
        active = false
        observer.disconnect()
        return { frames, longTasks }
      }
    }
  })

const stopStreamingCollector = (page: Page): Promise<{ frames: number[]; longTasks: number[] }> =>
  page.evaluate(() =>
    (
      globalThis as unknown as {
        __perfStreamCollector: { stop: () => { frames: number[]; longTasks: number[] } }
      }
    ).__perfStreamCollector.stop()
  )

for (const messageCount of [500, 2000]) {
  test(`transcript performance with ${messageCount} messages`, async ({ app }) => {
    test.setTimeout(600_000)
    let page = await app.completeOnboarding()
    page = await app.configureFakeAgent()
    await seedSession(page, buildMessages(messageCount))

    const relaunchStartedAt = Date.now()
    page = await app.restart()
    // The app restores to home; open the seeded session like message-scroll-reanchor does.
    await page
      .getByRole('region', { name: 'Recent sessions' })
      .getByRole('button', { name: 'Transcript performance session' })
      .click()

    // The transcript is virtualized past 100 rows: only the window around the reopen position
    // (last user-message anchor) is mounted, so wait for the final message row specifically.
    const lastRow = page.locator(`[data-message-id="perf-message-${messageCount - 1}"]`)
    await expect(lastRow).toBeVisible({ timeout: 300_000 })
    const ttiFromNavigationMs = await page.evaluate(async () => {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_000)
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            clearTimeout(timer)
            resolve()
          })
        )
      })
      return performance.now()
    })
    const ttiWallMs = Date.now() - relaunchStartedAt

    const dom = await page.evaluate(
      ({ rowSelector }) => ({
        messageRows: document.querySelectorAll(rowSelector).length,
        totalElements: document.querySelectorAll('*').length
      }),
      { rowSelector: ROW_SELECTOR }
    )

    const scroll = await measureScroll(page)

    await page.getByRole('textbox', { name: 'Ask anything' }).fill(LONG_STREAM_PROMPT)
    await page.getByRole('button', { name: 'Send message' }).click()
    // Start collecting after the click so Playwright's actionability checks stay out of the
    // window; the fixed wait covers the deterministic ~2.5s fake-agent stream without polling.
    await startStreamingCollector(page)
    await page.waitForTimeout(4_000)
    const streaming = await stopStreamingCollector(page)
    await expect(page.getByText(LONG_STREAM_FINAL_SEGMENT)).toBeVisible({ timeout: 120_000 })

    console.log(
      `PERF_RESULT ${JSON.stringify({
        scenario: `${messageCount}-messages`,
        tti: { wallMs: ttiWallMs, fromNavigationMs: round(ttiFromNavigationMs) },
        dom,
        scroll: {
          startTop: round(scroll.startTop),
          endTop: round(scroll.endTop),
          minTop: round(scroll.minTop),
          frames: summarizeFrames(scroll.frames),
          longTasks: summarizeLongTasks(scroll.longTasks)
        },
        streaming: {
          frames: summarizeFrames(streaming.frames),
          longTasks: summarizeLongTasks(streaming.longTasks)
        }
      })}`
    )

    expect(dom.messageRows).toBeGreaterThan(0)
    // Virtualization must actually window the transcript: far fewer rows mounted than exist.
    expect(dom.messageRows).toBeLessThan(messageCount)
    expect(scroll.startTop).toBeGreaterThan(0)
    // Scroll anchoring compensates while offscreen rows resolve real heights, so an exact top
    // landing is not guaranteed; reaching the top quartile proves the upward sweep happened.
    expect(scroll.minTop).toBeLessThan(scroll.startTop * 0.25)
    expect(scroll.endTop).toBeGreaterThan(scroll.minTop)
    expect(scroll.frames.length).toBeGreaterThan(0)
  })
}
