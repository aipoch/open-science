import { expect } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { test } from './fixtures/electron-app'
import { createProjectViaUi } from './fixtures/project'
import { submitPromptViaUi } from './fixtures/conversation'

// Pacing must actually run: hidden windows emulate reduced motion (instant commits), so this
// journey needs a normal window with live animation frames.
test.use({ windowMode: 'normal' })

const PROJECT_NAME = 'Queue presentation gate project'
const WARMUP_PROMPT = 'Summarize the deterministic fixture.'
const GATE_PROMPT = 'Hold the queue until the reveal finishes.'
const FOLLOW_UP = 'Follow-up after the reveal.'
// The fake agent replies with this fixed text for any prompt without a journey route.
const AGENT_REPLY = 'Deterministic reply: Summarize the deterministic fixture.'

test('flushes a large completed reply before releasing the queued message', async ({
  app
}, testInfo) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()

  await createProjectViaUi(page, PROJECT_NAME)
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()

  const conversation = page.getByRole('region', { name: 'Conversation' })
  const textbox = page.getByRole('textbox', { name: 'Ask anything' })
  const sendButton = page.getByRole('button', { name: 'Send message' })

  // Warm-up turn: queueing during a brand-new conversation's first turn is a separate flow;
  // the presentation race this spec covers happens on an established session.
  await textbox.fill(WARMUP_PROMPT)
  await expect(sendButton).toBeEnabled()
  await sendButton.click()
  await expect(conversation.getByText(AGENT_REPLY, { exact: true })).toHaveCount(1)

  const releaseFile = join(await app.createTestDirectory('queue-stream'), 'release')
  await textbox.fill(`${GATE_PROMPT} Release file: ${JSON.stringify(releaseFile)}`)
  await expect(sendButton).toBeEnabled()
  const idleSendBounds = await sendButton.boundingBox()
  const idleMenuBounds = await page.getByTestId('branch-send-menu-trigger').boundingBox()
  await sendButton.click()

  // Queue a follow-up while the gated turn is still streaming.
  const queueSubmit = page.getByTestId('composer-queue-submit')
  const stop = page.getByRole('button', { name: 'Cancel run', exact: true })
  const options = page.getByTestId('running-side-chat-menu-trigger')
  await expect(stop).toBeVisible()
  await expect(sendButton).toHaveCount(0)
  await expect(queueSubmit).toHaveCount(0)
  const stopBounds = await stop.boundingBox()
  const runningMenuBounds = await options.boundingBox()
  expect(stopBounds!.x).toBeCloseTo(idleSendBounds!.x, 0)
  expect(stopBounds!.width).toBe(idleSendBounds!.width)
  expect(runningMenuBounds!.x).toBeCloseTo(idleMenuBounds!.x, 0)
  await page.screenshot({ path: testInfo.outputPath('running-primary-control.png') })
  await textbox.fill(FOLLOW_UP)
  await expect(queueSubmit).toBeVisible()
  await expect(stop).toHaveCount(0)
  const queueBounds = await queueSubmit.boundingBox()
  expect(queueBounds!.x).toBeCloseTo(stopBounds!.x, 0)
  expect(queueBounds!.width).toBe(stopBounds!.width)
  await textbox.fill('   ')
  await expect(stop).toBeVisible()
  await expect(queueSubmit).toHaveCount(0)
  await textbox.fill(FOLLOW_UP)
  await options.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menuitem', { name: 'Cancel run', exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('running-draft-stop-menu.png') })
  await page.keyboard.press('Escape')
  await expect(options).toBeFocused()
  await queueSubmit.click()
  await expect(stop).toBeVisible()
  await expect(queueSubmit).toHaveCount(0)
  const queueTrigger = page.getByTestId('composer-queue-trigger')
  await expect(queueTrigger).toBeVisible()
  await expect(conversation.getByText(FOLLOW_UP)).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('queued-during-reveal.png') })

  // A completed source now flushes a backlog over 600 graphemes. Observe the actual DOM at
  // queue release: even without a long catch-up animation, the previous reply must be complete
  // before the follow-up appears. Polling only the eventual text could miss a premature release.
  await conversation.evaluate((element, followUp) => {
    const state = { previousReplyComplete: false, observed: false }
    Object.assign(window, { __queueReleaseEvidence: state })
    const observer = new MutationObserver(() => {
      const text = element.textContent ?? ''
      if (!text.includes(followUp)) return
      state.observed = true
      state.previousReplyComplete = text.split('Queue gate backlog paragraph:').length - 1 === 200
      observer.disconnect()
    })
    observer.observe(element, { childList: true, characterData: true, subtree: true })
  }, FOLLOW_UP)
  await writeFile(releaseFile, '')

  await expect(conversation.getByText(FOLLOW_UP)).toBeVisible({ timeout: 30000 })
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            __queueReleaseEvidence: { previousReplyComplete: boolean; observed: boolean }
          }
        ).__queueReleaseEvidence
    )
  ).toEqual({ previousReplyComplete: true, observed: true })
  await expect(queueTrigger).toHaveCount(0)
  await expect(conversation.getByText(AGENT_REPLY, { exact: true }).last()).toBeVisible()
})

test('Send now returns to a usable queue when the provider cannot inject into the current turn', async ({
  app
}) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await createProjectViaUi(page, 'Send now lifecycle project')
  const textbox = page.getByRole('textbox', { name: 'Ask anything' })
  const send = page.getByRole('button', { name: 'Send message' })
  const conversation = page.getByRole('region', { name: 'Conversation' })
  await textbox.fill(WARMUP_PROMPT)
  await send.click()
  await expect(conversation.getByText(AGENT_REPLY, { exact: true })).toHaveCount(1)

  const releaseFile = join(await app.createTestDirectory('send-now'), 'release')
  await textbox.fill(`${GATE_PROMPT} Release file: ${JSON.stringify(releaseFile)}`)
  await expect(send).toBeEnabled()
  await send.click()
  const queueSubmit = page.getByTestId('composer-queue-submit')
  await expect(page.getByRole('button', { name: 'Cancel run', exact: true })).toBeVisible()
  await textbox.fill(FOLLOW_UP)
  await queueSubmit.click()
  await page.getByTestId('composer-queue-trigger').click()
  const sendNow = page.getByRole('button', { name: 'Send now', exact: true })
  await expect(sendNow).toBeVisible()
  // The deterministic provider deliberately has no mid-turn injection capability.
  // Each click must settle without interrupting the current turn or losing the queued text.
  await sendNow.click()
  await expect(
    page
      .getByRole('region', { name: 'Message queue' })
      .getByText('Queued message will send after the current run finishes.', { exact: true })
  ).toBeVisible()
  await expect(sendNow).toBeEnabled()
  await sendNow.click()
  await expect(sendNow).toBeEnabled()
  await expect(conversation.getByText(FOLLOW_UP, { exact: true })).toHaveCount(0)

  await writeFile(releaseFile, '')
  await expect(conversation.getByText(FOLLOW_UP, { exact: true })).toHaveCount(1, {
    timeout: 30000
  })
  await expect(page.getByTestId('composer-queue-trigger')).toHaveCount(0)
  await textbox.fill('Next message after Send now')
  await expect(send).toBeEnabled()
  await send.click()
  await expect(conversation.getByText('Next message after Send now', { exact: true })).toHaveCount(
    1
  )
})

test('renders expensive streamed output through the native parser Worker and completes the reply', async ({
  app
}) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await page.evaluate(() => {
    let parsedSnapshots = 0
    Object.assign(window, { __nativeMarkdownParses: () => parsedSnapshots })
    window.Worker = new Proxy(window.Worker, {
      construct(Target, args: ConstructorParameters<typeof Worker>) {
        const worker = new Target(...args)
        if (String(args[0]).includes('markdown-parser')) {
          worker.addEventListener('message', (event: MessageEvent) => {
            // An empty warmup alone is not evidence that streamed content used the Worker.
            if (event.data.tree?.children?.length > 0) parsedSnapshots++
          })
        }
        return worker
      }
    })
  })
  await createProjectViaUi(page, 'Native Markdown streaming')
  const conversation = page.getByRole('region', { name: 'Conversation' })
  // Match the browser Worker journey: exercise the measured-cost boundary on fast hosts too.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  const releaseFile = join(await app.createTestDirectory('markdown-parser'), 'release')
  await submitPromptViaUi(
    page,
    `Run the native Markdown parser journey. Release file: ${JSON.stringify(releaseFile)}`
  )
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (window as unknown as { __nativeMarkdownParses: () => number }).__nativeMarkdownParses()
        ),
      { timeout: 30000 }
    )
    .toBeGreaterThan(0)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  await writeFile(releaseFile, '')
  await expect(
    conversation.getByText('Native Markdown parser journey complete.', { exact: false })
  ).toBeVisible({ timeout: 60000 })
  await page.getByRole('textbox', { name: 'Ask anything' }).fill('Next message after streaming')
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled()
  await cdp.detach()
})
