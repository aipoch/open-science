import { expect } from '@playwright/test'
import type { Page } from 'playwright'

import { test } from './fixtures/electron-app'

const LONG_STREAM_PROMPT = 'Stream the long scroll journey.'
const LONG_STREAM_FINAL_SEGMENT = 'Segment 3 paragraph 7'
const VIEWPORT_SELECTOR = '[data-slot="message-scroller-viewport"]'
const MESSAGE_COUNT = 500
const JUMP_BACK_THRESHOLD_PX = 400
const LIVE_EDGE_THRESHOLD_PX = 50

type SeedMessage = {
  id: string
  role: 'user' | 'agent'
  content: string
  status: 'complete'
  eventIds: string[]
  createdAt: number
  updatedAt: number
}

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
      ['```ts', 'const sample = frames[0]', 'if (sample > 50) report(sample)', '```'].join('\n')
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
      id: `bind-message-${index}`,
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
      name: 'Session bind project',
      description: 'Seeded transcript for the session bind scroll regression.'
    })
    const now = Date.now()
    await bridge.api.sessions.saveSession({
      id: 'session-bind-source-session',
      projectId: project.id,
      title: 'Session bind session',
      cwd: '/tmp/session-bind',
      status: 'idle',
      agentFrameworkId: 'opencode',
      messages: seededMessages,
      createdAt: now - seededMessages.length * 1_000,
      updatedAt: now
    })
    await bridge.api.sessions.saveManifest({
      lastProjectId: project.id,
      lastSessionId: 'session-bind-source-session'
    })
  }, messages)
}

// The CI machine can run a non-English system locale; pin English via the app's own preference
// storage (survives restarts, no fixture changes needed).
const forceEnglishLocale = async (page: Page): Promise<Page> => {
  await page.evaluate(() => {
    globalThis.localStorage.setItem('open-science-language', 'en')
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByText('Loading settings...').waitFor({ state: 'hidden', timeout: 60_000 })
  return page
}

type ScrollSample = { t: number; top: number }
type SamplerResult = { samples: ScrollSample[]; firstRowConnected: boolean }

// Sampling covers two signals: scrollTop per frame (a full reset to the turn anchor is hundreds of
// px) and the DOM identity of the first transcript row (a full-transcript remount, the root cause
// of the reset, replaces every row node).
const startScrollSampler = (page: Page): Promise<void> =>
  page.evaluate((viewportSelector) => {
    const win = globalThis as unknown as {
      __scrollSampler: {
        samples: ScrollSample[]
        stop: () => SamplerResult
      }
    }
    const firstRow = document.querySelector('[data-slot="message-scroller-item"]')
    const samples: ScrollSample[] = []
    let active = true
    const sample = (): void => {
      if (!active) return
      const viewport = document.querySelector(viewportSelector)
      samples.push({
        t: performance.now(),
        top: viewport instanceof HTMLElement ? viewport.scrollTop : -1
      })
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
    win.__scrollSampler = {
      samples,
      stop: () => {
        active = false
        return { samples, firstRowConnected: firstRow?.isConnected ?? false }
      }
    }
  }, VIEWPORT_SELECTOR)

const stopScrollSampler = (page: Page): Promise<SamplerResult> =>
  page.evaluate(() =>
    (
      globalThis as unknown as {
        __scrollSampler: { stop: () => SamplerResult }
      }
    ).__scrollSampler.stop()
  )

const maxScrollDrop = (samples: ScrollSample[]): number => {
  let maxDrop = 0
  for (let index = 1; index < samples.length; index += 1) {
    maxDrop = Math.max(maxDrop, samples[index - 1].top - samples[index].top)
  }
  return Math.round(maxDrop)
}

// Anchor corrections while a reply streams are a few hundred px; a bind-time reset to the turn
// anchor from near the live edge is larger.
const expectNoBindReset = (result: SamplerResult): void => {
  expect(result.firstRowConnected).toBe(true)
  expect(maxScrollDrop(result.samples)).toBeLessThanOrEqual(JUMP_BACK_THRESHOLD_PX)
}

const expectLiveEdge = async (page: Page): Promise<void> => {
  const edge = await page.evaluate((viewportSelector) => {
    const viewport = document.querySelector(viewportSelector)
    if (!(viewport instanceof HTMLElement)) return { top: -1, maxTop: -1 }
    return {
      top: Math.round(viewport.scrollTop),
      maxTop: Math.round(viewport.scrollHeight - viewport.clientHeight)
    }
  }, VIEWPORT_SELECTOR)
  expect(edge.maxTop - edge.top).toBeLessThanOrEqual(LIVE_EDGE_THRESHOLD_PX)
}

test('keeps the transcript pinned when a branched session binds mid-run', async ({ app }) => {
  test.setTimeout(300_000)
  // The bind scroll reset only becomes observable when session creation is slow like a real
  // agent spawn; the fake agent honors this delay (see e2e/fixtures/fake-opencode.mjs).
  process.env.FAKE_OPENCODE_NEW_SESSION_DELAY_MS ??= '4000'

  let page = await app.completeOnboarding()
  page = await forceEnglishLocale(page)
  page = await app.configureFakeAgent()
  await seedSession(page, buildMessages(MESSAGE_COUNT))

  page = await app.restart()
  await page
    .getByRole('region', { name: 'Recent sessions' })
    .getByRole('button', { name: 'Session bind session' })
    .click()
  await expect(page.locator(`[data-message-id="bind-message-${MESSAGE_COUNT - 1}"]`)).toBeVisible({
    timeout: 300_000
  })

  const textbox = page.getByRole('textbox', { name: 'Ask anything' })
  const sendButton = page.getByRole('button', { name: 'Send message' })

  // Branch-submit (#1276): the pending branched session renders the copied transcript, the new
  // user message, and the loader immediately; binding swaps the session id once createSession
  // resolves. The transcript must not remount or jump back to the turn anchor across the bind.
  await textbox.fill(LONG_STREAM_PROMPT)
  await page.getByRole('button', { name: 'More send options' }).click()
  await page.getByTestId('menu-branch-in-new-session').click()
  await expect(page.getByText(LONG_STREAM_PROMPT).last()).toBeVisible({ timeout: 60_000 })
  // Let the pending session's initial anchor positioning finish before sampling the bind window.
  await page.waitForTimeout(800)

  await startScrollSampler(page)
  await expect(page.getByText(LONG_STREAM_FINAL_SEGMENT)).toBeVisible({ timeout: 120_000 })
  await page.waitForTimeout(500)
  expectNoBindReset(await stopScrollSampler(page))
  await expectLiveEdge(page)

  // A plain follow-up in the bound session stays at the live edge too.
  await textbox.fill(LONG_STREAM_PROMPT)
  await expect(sendButton).toBeEnabled()
  await startScrollSampler(page)
  await sendButton.click()
  await expect(page.getByText(LONG_STREAM_FINAL_SEGMENT).last()).toBeVisible({ timeout: 120_000 })
  await page.waitForTimeout(500)
  expectNoBindReset(await stopScrollSampler(page))
  await expectLiveEdge(page)
})
