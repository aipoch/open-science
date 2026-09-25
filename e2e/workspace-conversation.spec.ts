import { expect } from '@playwright/test'
import type { AxeResults } from 'axe-core'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Page } from 'playwright'
import { test } from './fixtures/electron-app'

const PROJECT_NAME = 'Agent journey project'
const USER_MESSAGE = 'Summarize the deterministic fixture.'
const EDITED_USER_MESSAGE = 'Summarize the revised deterministic fixture.'
const AGENT_REPLY = `Deterministic reply: ${USER_MESSAGE}`
const PERMISSION_PROMPT = 'Request fixture permission.'
const CONTEXT_COMPACTION_PROMPT = 'Preview context compaction.'
const CITATION_PREVIEW_PROMPT = 'Preview a cited source.'
const AXE_PATH = resolve(process.cwd(), 'node_modules/axe-core/axe.min.js')

test('preserves an unavailable saved model until an explicit replacement is selected', async ({
  app
}, testInfo) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await createProject(page)
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(USER_MESSAGE)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText(AGENT_REPLY, { exact: false })).toBeVisible()
  const saved = await page.evaluate(async () => {
    const loaded = await window.api.sessions.loadAll()
    return loaded.sessions[0].agentConfiguration!
  })
  expect(saved?.providerId).toBeTruthy()
  const fallback = await page.evaluate(async () => {
    const snapshot = await window.api.settings.upsertProvider({
      type: 'custom',
      name: 'Replacement provider',
      apiEndpoints: ['openai'],
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'replacement-model',
      key: 'e2e-key',
      reasoningEffortPreset: 'standard-5'
    })
    return snapshot.providers.find((provider) => provider.name === 'Replacement provider')!.id
  })
  await page.evaluate(async (id) => window.api.settings.deleteProvider({ id }), saved.providerId)
  const unavailable = page.getByRole('button', { name: 'Session model unavailable', exact: true })
  await expect(unavailable).toBeVisible()
  await page.getByRole('textbox', { name: 'Ask anything' }).fill('Do not send this draft.')
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled()
  await unavailable.click()
  await page.getByRole('menuitem', { name: /Model Provider and model for this chat/ }).hover()
  await expect(page.getByRole('menuitemradio', { name: /replacement-model/ })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('unavailable-session-model.png') })
  await expect
    .poll(async () =>
      page.evaluate(
        async () => (await window.api.sessions.loadAll()).sessions[0].agentConfiguration
      )
    )
    .toEqual(saved)
  await page.getByRole('menuitemradio', { name: /replacement-model/ }).focus()
  await page.keyboard.press('Enter')
  await expect(unavailable).toHaveCount(0)
  await expect
    .poll(async () =>
      page.evaluate(
        async () => (await window.api.sessions.loadAll()).sessions[0].agentConfiguration
      )
    )
    .toMatchObject({ providerId: fallback, model: 'replacement-model' })
})

test('keeps source icons inside table cells after expanding a message table', async ({ app }) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await allowCitationPreviewDomain(page)
  await page.route('https://citation.example/favicon.ico', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="teal"/></svg>'
    })
  )
  await createProject(page)
  await page
    .getByRole('textbox', { name: 'Ask anything' })
    .fill('Expand a table with source links.')
  await page.getByRole('button', { name: 'Send message' }).click()

  const table = page.getByRole('region', { name: 'Conversation' }).locator('table')
  await expect(table).toBeVisible()
  await expect(table.locator('[data-session-link-favicon]')).toHaveCount(2)
  await expect(table.locator('[data-session-link-favicon][data-state="local"]')).toHaveCount(1)
  await table.hover()
  await page.evaluate(() => navigator.clipboard.writeText('before-table-copy'))
  await page.getByTitle('Copy table', { exact: true }).click()
  await page.getByRole('menuitem', { name: 'Markdown', exact: true }).click()
  await expect.poll(() => app.readClipboardText()).toContain('| PMID | Journal |')

  await table.hover()
  await page.getByTitle('View fullscreen', { exact: true }).click()

  const fullscreen = page.locator('[data-streamdown="table-fullscreen"]')
  await expect(fullscreen).toBeVisible()
  await expect(fullscreen.locator('[data-session-link-favicon]')).toHaveCount(2)
  // Exercise the actual portal and stylesheet: jsdom cannot detect an icon covering the dialog.
  await expect
    .poll(() =>
      fullscreen.locator('[data-session-link-favicon]').evaluateAll((icons) =>
        icons.every((icon) => {
          const cell = icon.closest('td')!.getBoundingClientRect()
          return [...icon.querySelectorAll('svg, img')].every((image) => {
            const bounds = image.getBoundingClientRect()
            return (
              bounds.width > 0 &&
              bounds.width <= 20 &&
              bounds.height > 0 &&
              bounds.height <= 20 &&
              bounds.left >= cell.left &&
              bounds.right <= cell.right &&
              bounds.top >= cell.top &&
              bounds.bottom <= cell.bottom
            )
          })
        })
      )
    )
    .toBe(true)
  await fullscreen.getByTitle('Download table', { exact: true }).click()
  await expect(fullscreen.getByRole('button', { name: 'CSV', exact: true })).toBeVisible()
  await fullscreen.getByTitle('Exit fullscreen', { exact: true }).click()
  await expect(fullscreen).toHaveCount(0)
})

const persistedMemoryState = async (
  page: Page
): Promise<{
  memoryEnabled: boolean
  autoReviewEnabled: boolean
  pendingHistoryReplay: unknown
} | null> =>
  page.evaluate(async (title) => {
    const session = (await window.api.sessions.loadAll()).sessions.find(
      (candidate) => candidate.title === title
    )
    if (!session) return null
    return {
      memoryEnabled: session.memoryEnabled !== false,
      autoReviewEnabled: session.autoReviewEnabled === true,
      pendingHistoryReplay: session.pendingHistoryReplay ?? null
    }
  }, USER_MESSAGE)

const createProject = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill(PROJECT_NAME)
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()
}

test('returns from Library to the originating conversation and New Conversation draft', async ({
  app
}, testInfo) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await page.setViewportSize({ width: 1280, height: 900 })
  await createProject(page)
  const composer = page.getByRole('textbox', { name: 'Ask anything' })
  const earlierPrompt = 'Review the evidence for our literature study.'
  const laterPrompt = 'Outline a separate research question.'
  for (const prompt of [earlierPrompt, laterPrompt]) {
    await composer.fill(prompt)
    await page.getByRole('button', { name: 'Send message' }).click()
    await expect(page.getByText(AGENT_REPLY, { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible()
    if (prompt === earlierPrompt)
      await page.getByRole('button', { name: 'New', exact: true }).click()
  }
  const earlier = page
    .locator('[data-slot="session-open-button"]')
    .filter({ hasText: earlierPrompt })
  await earlier.click()
  const draft = 'Compare these findings with the references in our library.'
  await composer.fill(draft)
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  const back = page.getByRole('button', { name: 'Back to Project', exact: true })
  await expect(back).toBeVisible()
  await expect(page.getByRole('button', { name: 'Back to Home', exact: true })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('library-return-project.png') })
  await back.focus()
  await page.keyboard.press('Enter')
  await expect(earlier).toHaveAttribute('aria-current', 'page')
  await expect(
    page.getByRole('region', { name: 'Conversation' }).getByText(earlierPrompt, { exact: true })
  ).toBeVisible()
  await expect(composer).toHaveText(draft)
  await composer.focus()
  await expect(composer).toBeFocused()
  await page.screenshot({ path: testInfo.outputPath('library-return-conversation.png') })

  await page.getByRole('button', { name: 'New', exact: true }).click()
  await composer.fill('Unsent new conversation draft')
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  await back.click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()
  await expect(composer).toHaveText('Unsent new conversation draft')

  await page.getByRole('button', { name: 'All projects', exact: true }).click()
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  await page.getByRole('button', { name: 'Back to Home', exact: true }).click()
  await expect(page.getByRole('button', { name: 'New project', exact: true })).toBeVisible()
})

const allowCitationPreviewDomain = async (page: Page): Promise<void> => {
  await page.evaluate(async () => {
    await window.api.settings.setNotebookNetwork({
      allowedDomains: ['citation.example'],
      disabledOpenScienceDomainGroups: [],
      disabledOpenScienceDomains: []
    })
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
}

const clickPermissionDecision = async (page: Page, decision: 'allow' | 'deny'): Promise<void> => {
  const button = page
    .getByTestId('permission-actions')
    .getByTestId(decision === 'allow' ? 'allow-primary' : 'deny-button')
  await expect(button).toBeEnabled()
  // Windows E2E can raise a session-persistence conflict toast over the sticky
  // Allow/Deny row. A pointer click, even with force, still hits that overlay;
  // Retry would reload the Session and drop the prompt. Activate the button
  // through its DOM click handler instead.
  await button.evaluate((element: HTMLButtonElement) => {
    element.click()
  })
}

test('explains disabled revision navigation while a turn is running', async ({ app }, testInfo) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await createProject(page)

  await page.getByRole('textbox', { name: 'Ask anything' }).fill(USER_MESSAGE)
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled()
  await page.getByRole('button', { name: 'Send message' }).click()

  const conversation = page.getByRole('region', { name: 'Conversation' })
  await expect(conversation.getByText(USER_MESSAGE, { exact: true })).toBeVisible()
  await expect(conversation.getByText(AGENT_REPLY, { exact: true })).toBeVisible()
  // Reply text can arrive before the Agent turn ends. Wait for Main to observe completion
  // before editing history and restarting, which otherwise can open a native quit dialog.
  await expect.poll(() => page.evaluate(() => window.api.storage.detectActive())).toEqual([])

  await conversation.getByText(USER_MESSAGE, { exact: true }).hover()
  await conversation.getByRole('button', { name: 'Edit message' }).click()
  await conversation.getByRole('textbox', { name: 'Edit message' }).fill(EDITED_USER_MESSAGE)
  await conversation.getByRole('button', { name: 'Send', exact: true }).click()

  const previous = conversation.getByRole('button', { name: 'Previous message revision' })
  await expect(previous).toBeEnabled()
  const releaseFile = resolve(await app.createTestDirectory('revision-hint'), 'release')
  await page
    .getByRole('textbox', { name: 'Ask anything' })
    .fill(`Hold the queue until the reveal finishes. Release file: ${JSON.stringify(releaseFile)}`)
  await page.getByRole('button', { name: 'Send message' }).click()
  try {
    await expect(page.getByTestId('composer-queue-submit')).toBeVisible()
    await expect(previous).toBeDisabled()
    const explanation = 'Message revisions are unavailable while this session is busy or blocked.'
    const trigger = previous.locator('..')
    // Scroll back like a reader before focusing: a focus-induced scroll dismisses Radix tooltips.
    await conversation.hover()
    await page.mouse.wheel(0, -100_000)
    await trigger.hover()
    await trigger.focus()
    await expect(page.getByRole('tooltip', { name: explanation })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('revision-navigation-running.png') })
    await expect(conversation.getByLabel('Message revision', { exact: true })).toHaveText('2/2')
  } finally {
    // Release even after an assertion failure so the fixture can close the active session.
    await writeFile(releaseFile, '')
  }
  await expect(previous).toBeEnabled()
  await previous.click()
  await expect(conversation.getByText(USER_MESSAGE, { exact: true })).toBeVisible()
  await expect(conversation.getByLabel('Message revision', { exact: true })).toHaveText('1/2')
  await page.screenshot({ path: testInfo.outputPath('revision-navigation-idle.png') })
})

test('edits and navigates message revisions that persist after relaunch @pr-mainline-conversation', async ({
  app
}, testInfo) => {
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  await createProject(page)

  await page.getByRole('textbox', { name: 'Ask anything' }).fill(USER_MESSAGE)
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled()
  await page.getByRole('button', { name: 'Send message' }).click()

  let conversation = page.getByRole('region', { name: 'Conversation' })
  await expect(conversation.getByText(USER_MESSAGE, { exact: true })).toBeVisible()
  await expect(conversation.getByText(AGENT_REPLY, { exact: true })).toBeVisible()
  // Reply text can arrive before the Agent turn ends. Wait for Main to observe completion
  // before editing history and restarting, which otherwise can open a native quit dialog.
  await expect.poll(() => page.evaluate(() => window.api.storage.detectActive())).toEqual([])

  await conversation.getByText(USER_MESSAGE, { exact: true }).hover()
  await conversation.getByRole('button', { name: 'Edit message' }).click()
  await conversation.getByRole('textbox', { name: 'Edit message' }).fill(EDITED_USER_MESSAGE)
  await conversation.getByRole('button', { name: 'Send', exact: true }).click()

  const revision = conversation.getByLabel('Message revision', { exact: true })
  const previousRevision = conversation.getByRole('button', {
    name: 'Previous message revision'
  })
  const nextRevision = conversation.getByRole('button', { name: 'Next message revision' })
  await expect(conversation.getByText(EDITED_USER_MESSAGE, { exact: true })).toBeVisible()
  await expect(revision).toHaveText(['2/2'])
  await expect(previousRevision).toBeEnabled()
  await expect(nextRevision).toBeDisabled()
  // Main can be idle while the renderer still drains the edited send. This existing control
  // also waits for the active run, pending queue and branch-switch guard to clear.
  await expect(conversation.getByRole('button', { name: 'Branch in new session' })).toBeEnabled()

  // The edit starts another Agent turn. Let it finish before switching branches or restarting,
  // otherwise application.close() can wait indefinitely on the native active-session quit dialog.
  await expect(conversation.getByText(AGENT_REPLY, { exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.api.storage.detectActive())).toEqual([])

  await previousRevision.click()
  await expect(conversation.getByText(USER_MESSAGE, { exact: true })).toBeVisible()
  await expect(revision).toHaveText(['1/2'])
  await expect(previousRevision).toBeDisabled()
  await expect(nextRevision).toBeEnabled()

  await page
    .getByRole('button', {
      name: 'Add attachment, save as skill, view context window, or request review',
      exact: true
    })
    .click()
  await expect(page.getByTestId('menu-save-as-skill')).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('completed-branch-save-as-skill.png') })
  await page.keyboard.press('Escape')

  await nextRevision.click()
  await expect(conversation.getByText(EDITED_USER_MESSAGE, { exact: true })).toBeVisible()
  await expect(revision).toHaveText(['2/2'])
  await previousRevision.click()
  await expect(conversation.getByText(USER_MESSAGE, { exact: true })).toBeVisible()
  await expect(revision).toHaveText(['1/2'])

  // Branch content renders before the asynchronous history switch and persistence drain finish.
  // Wait for the same idle control used above before asking Electron to quit for the restart.
  await expect(conversation.getByRole('button', { name: 'Branch in new session' })).toBeEnabled()
  await expect.poll(() => page.evaluate(() => window.api.storage.detectActive())).toEqual([])
  page = await app.restart()
  await page
    .getByRole('region', { name: 'Recent sessions' })
    .getByRole('button', { name: USER_MESSAGE })
    .click()
  conversation = page.getByRole('region', { name: 'Conversation' })
  await expect(conversation.getByText(USER_MESSAGE, { exact: true })).toBeVisible()
  await expect(conversation.getByText(AGENT_REPLY, { exact: true })).toBeVisible()
  await expect(conversation.getByLabel('Message revision', { exact: true })).toHaveText(['1/2'])
  await expect(
    conversation.getByRole('button', { name: 'Previous message revision' })
  ).toBeDisabled()
  await expect(conversation.getByRole('button', { name: 'Next message revision' })).toBeEnabled()

  await conversation.getByRole('button', { name: 'Next message revision' }).click()
  await expect(conversation.getByText(EDITED_USER_MESSAGE, { exact: true })).toBeVisible()
  await expect(conversation.getByLabel('Message revision', { exact: true })).toHaveText(['2/2'])
})

test('keeps Memory reversible while the replacement session awaits history replay', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await page.evaluate(async () => window.api.memory.setEnabled({ enabled: true }))
  await createProject(page)

  await page.getByRole('textbox', { name: 'Ask anything' }).fill(USER_MESSAGE)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText(AGENT_REPLY, { exact: true })).toBeVisible()

  await page.getByRole('button', { name: /Agent controls:/ }).click()
  const memory = page.getByRole('menuitem', { name: 'Memory', exact: true })
  await expect(memory).toBeEnabled()
  await memory.click()

  await expect
    .poll(() => persistedMemoryState(page))
    .toEqual({
      memoryEnabled: false,
      autoReviewEnabled: false,
      pendingHistoryReplay: { kind: 'all' }
    })

  await page.keyboard.press('Escape')
  page = await app.restart()
  await page
    .getByRole('region', { name: 'Recent sessions' })
    .getByRole('button', { name: USER_MESSAGE })
    .click()
  await expect(page.getByText(AGENT_REPLY, { exact: true })).toBeVisible()

  await page.getByRole('button', { name: /Agent controls:/ }).click()
  const restoredMemory = page.getByRole('menuitem', { name: 'Memory', exact: true })
  await expect(restoredMemory).toBeEnabled()
  await restoredMemory.click()

  await expect
    .poll(() => persistedMemoryState(page))
    .toEqual({
      memoryEnabled: true,
      autoReviewEnabled: false,
      pendingHistoryReplay: { kind: 'all' }
    })
})

test('resolves Agent permission requests through both Allow and Deny decisions @pr-mainline-conversation', async ({
  app
}) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await createProject(page)

  const composer = page.getByRole('textbox', { name: 'Ask anything' })
  await composer.fill(`${PERMISSION_PROMPT} allow`)
  await page.getByRole('button', { name: 'Send message' }).click()

  await expect(page.getByText('Write fixture output', { exact: true })).toBeVisible()
  await expect(page.getByTestId('permission-composer')).toBeVisible()
  await expect(composer).toBeHidden()
  const permissionHeader = page.getByTestId('permission-header')
  await expect(permissionHeader).toHaveCSS('position', 'sticky')
  await expect(permissionHeader).toHaveCSS('top', '0px')
  const permissionActions = page.getByTestId('permission-actions')
  await expect(permissionActions).toHaveCSS('position', 'sticky')
  await expect(permissionActions).toHaveCSS('bottom', '0px')
  const resizeHandle = page.getByRole('separator', { name: 'Resize permission panel' })
  await expect
    .poll(async () => Number(await resizeHandle.getAttribute('aria-valuenow')))
    .toBeGreaterThan(0)
  const handleBounds = await resizeHandle.boundingBox()
  expect(handleBounds).not.toBeNull()
  const restingHandleBackground = await resizeHandle.evaluate(
    (element) => getComputedStyle(element).backgroundColor
  )
  await page.mouse.move(
    (handleBounds?.x ?? 0) + (handleBounds?.width ?? 0) / 2,
    (handleBounds?.y ?? 0) + (handleBounds?.height ?? 0) / 2
  )
  await page.mouse.down()
  try {
    expect(
      await resizeHandle.evaluate((element) => getComputedStyle(element).backgroundColor)
    ).toBe(restingHandleBackground)
  } finally {
    await page.mouse.up()
  }
  await page.mouse.move(8, 8)
  await clickPermissionDecision(page, 'allow')
  await expect(page.getByText('Fixture permission allowed.', { exact: true })).toBeVisible()
  await expect(composer).toBeVisible()

  await composer.fill(`${PERMISSION_PROMPT} deny`)
  await page.getByRole('button', { name: 'Send message' }).click()

  await expect(page.getByText('Write fixture output', { exact: true })).toBeVisible()
  await expect(page.getByTestId('permission-composer')).toBeVisible()
  await expect(composer).toBeHidden()
  await clickPermissionDecision(page, 'deny')
  await expect(page.getByText('Fixture permission denied.', { exact: true })).toBeVisible()
  await expect(composer).toBeVisible()
})

test('shows context compaction loading and completion inside the Session transcript', async ({
  app
}) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await createProject(page)

  await page.getByRole('textbox', { name: 'Ask anything' }).fill(CONTEXT_COMPACTION_PROMPT)
  await page.getByRole('button', { name: 'Send message' }).click()

  const conversation = page.getByRole('region', { name: 'Conversation' })
  const compaction = conversation.getByTestId('context-compaction-activity')
  await expect(compaction).toContainText('Compacting context')
  await expect(compaction).toContainText('Summarizing earlier context')
  await expect(compaction).toHaveAttribute('role', 'status')
  await expect(compaction).toContainText('Context compacted')
  await expect(compaction).toContainText(
    'Earlier context was summarized so the session can continue.'
  )
  await expect(compaction).not.toHaveAttribute('role', 'status')
  await expect(compaction.getByTestId('tool-chip')).toHaveCount(0)

  for (const width of [320, 375, 414, 768]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(compaction).toBeVisible()
    expect(await compaction.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true
    )
  }
})

test('previews and opens an Agent HTTPS source link in the isolated preview tab', async ({
  app
}, testInfo) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await allowCitationPreviewDomain(page)
  await app.showMainWindow()
  let sourceDocumentRequestCount = 0
  let replicationDocumentRequestCount = 0
  await page.context().route('https://citation.example/paper', async (route) => {
    sourceDocumentRequestCount++
    await route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><body><main><h1>Fixture source</h1><p>Peer-reviewed evidence.</p><p data-preview-context-menu-passthrough>Native area</p></main></body></html>'
    })
  })
  await page.context().route('https://citation.example/replication', async (route) => {
    replicationDocumentRequestCount++
    await route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><body><main><h1>Replication source</h1></main></body></html>'
    })
  })
  await createProject(page)

  await page.getByRole('textbox', { name: 'Ask anything' }).fill(CITATION_PREVIEW_PROMPT)
  await page.getByRole('button', { name: 'Send message' }).click()

  const sourceLink = page.getByRole('link', { name: 'Torre et al. 2026' })
  await expect(sourceLink).toBeVisible()
  await page.evaluate(await readFile(AXE_PATH, 'utf8'))
  const citationAccessibility = (await sourceLink.evaluate(async (element) => {
    const axe = (
      globalThis as unknown as {
        axe: { run: (context: Element, options: unknown) => Promise<unknown> }
      }
    ).axe

    return axe.run(element, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }
    })
  })) as AxeResults
  expect(
    citationAccessibility.violations.filter(
      ({ impact }) => impact === 'critical' || impact === 'serious'
    )
  ).toEqual([])
  const hoverCard = page.locator('[data-source-preview-hover-card]')

  await sourceLink.dispatchEvent('pointerdown', { pointerType: 'touch' })
  await sourceLink.evaluate((element) => (element as HTMLElement).click())
  await expect(hoverCard).toBeVisible()
  expect(sourceDocumentRequestCount).toBe(0)
  await expect(page.locator('[data-source-preview-frame]')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(hoverCard).toHaveCount(0)
  await expect(sourceLink).toBeFocused()
  await sourceLink.evaluate((element) => (element as HTMLElement).blur())
  await expect(sourceLink).not.toBeFocused()
  await page.mouse.move(5, 5)
  await sourceLink.hover()
  const hoverTitle = hoverCard.locator('[data-source-preview-hover-title]')
  await expect(hoverTitle).toHaveText('Fixture study')
  await expect(hoverTitle).toHaveClass(/text-text-000/)
  await expect(hoverCard.locator('[data-source-preview-hover-hostname]')).toHaveText(
    'citation.example'
  )
  const hoverSummary = hoverCard.locator('[data-source-preview-hover-summary]')
  const hoverActions = hoverCard.locator('[data-source-preview-hover-actions]')
  const hoverUrl = hoverCard.locator('[data-source-preview-hover-url]')
  await expect(hoverUrl).toHaveText('https://citation.example/paper')
  await expect(hoverUrl).toHaveClass(/text-text-000/)
  const externalButton = hoverCard.locator('[data-source-preview-hover-external]')
  await expect(externalButton).toHaveAttribute('aria-label', 'Open source in browser')
  await expect(hoverSummary).toContainText('Fixture study')
  await expect(hoverActions.locator('[data-source-preview-hover-url]')).toBeVisible()
  await expect(hoverActions.locator('[data-source-preview-hover-external]')).toBeVisible()
  const hoverLayout = await hoverCard.evaluate((card) => {
    const summary = card.querySelector<HTMLElement>('[data-source-preview-hover-summary]')
    const actions = card.querySelector<HTMLElement>('[data-source-preview-hover-actions]')
    const title = card.querySelector<HTMLElement>('[data-source-preview-hover-title]')
    const hostname = card.querySelector<HTMLElement>('[data-source-preview-hover-hostname]')
    const url = card.querySelector<HTMLElement>('[data-source-preview-hover-url]')
    const external = card.querySelector<HTMLElement>('[data-source-preview-hover-external]')
    const iconColumn = card.querySelector<HTMLElement>('[data-source-preview-hover-icon-column]')
    const contentColumn = card.querySelector<HTMLElement>(
      '[data-source-preview-hover-content-column]'
    )
    if (
      !summary ||
      !actions ||
      !title ||
      !hostname ||
      !url ||
      !external ||
      !iconColumn ||
      !contentColumn
    ) {
      throw new Error('Source hover layout is incomplete')
    }
    const cardRect = card.getBoundingClientRect()
    const titleRect = title.getBoundingClientRect()
    const hostnameRect = hostname.getBoundingClientRect()
    const actionsRect = actions.getBoundingClientRect()
    const urlRect = url.getBoundingClientRect()
    const externalRect = external.getBoundingClientRect()
    const iconColumnRect = iconColumn.getBoundingClientRect()
    const contentColumnRect = contentColumn.getBoundingClientRect()
    const contentStarts = [titleRect.left, hostnameRect.left, urlRect.left]
    return {
      width: cardRect.width,
      titleColor: getComputedStyle(title).color,
      descriptionColor: getComputedStyle(hostname).color,
      actionGap: actionsRect.top - hostnameRect.bottom,
      contentStartDelta: Math.max(...contentStarts) - Math.min(...contentStarts),
      iconColumnPrecedesContent: iconColumnRect.right <= contentColumnRect.left,
      iconColumnHeightDelta: Math.abs(iconColumnRect.height - contentColumnRect.height),
      actionCenterDelta: Math.abs(
        urlRect.top + urlRect.height / 2 - (externalRect.top + externalRect.height / 2)
      )
    }
  })
  expect(hoverLayout.width).toBeLessThan(320)
  expect(hoverLayout.titleColor).not.toBe(hoverLayout.descriptionColor)
  expect(hoverLayout.actionGap).toBeGreaterThanOrEqual(8)
  expect(hoverLayout.contentStartDelta).toBeLessThanOrEqual(1)
  expect(hoverLayout.iconColumnPrecedesContent).toBe(true)
  expect(hoverLayout.iconColumnHeightDelta).toBeLessThanOrEqual(1)
  expect(hoverLayout.actionCenterDelta).toBeLessThanOrEqual(1)
  await expect(hoverCard.locator('[data-session-link-favicon-skeleton]')).toHaveCount(0)
  expect(sourceDocumentRequestCount).toBe(0)
  await expect(page.locator('[data-source-preview-frame]')).toHaveCount(0)
  const hoverAccessibility = (await hoverCard.evaluate(async (element) => {
    const axe = (
      globalThis as unknown as {
        axe: { run: (context: Element, options: unknown) => Promise<unknown> }
      }
    ).axe

    return axe.run(element, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }
    })
  })) as AxeResults
  expect(
    hoverAccessibility.violations.filter(
      ({ impact }) => impact === 'critical' || impact === 'serious'
    )
  ).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('source-link-hover-card.png') })
  await externalButton.hover()
  await expect(page.getByRole('tooltip')).toHaveText('Open source in browser')
  expect(sourceDocumentRequestCount).toBe(0)
  await sourceLink.focus()
  await page.keyboard.press('Tab')
  await expect(hoverUrl).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Open external link?' })).toHaveCount(0)

  await expect(page.getByRole('tab', { name: 'Fixture study' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  const sourceFrame = page.locator(
    '[data-source-preview-frame][data-source-url="https://citation.example/paper"]'
  )
  await expect(sourceFrame).toHaveAttribute('data-source-url', 'https://citation.example/paper')
  await expect.poll(() => sourceDocumentRequestCount).toBe(1)
  const sourceProgress = page.locator('[data-source-preview-progress]')
  const sourceSkeleton = page.locator('[data-source-preview-skeleton]')
  expect(await sourceFrame.evaluate((element) => element.tagName)).toBe('WEBVIEW')
  const sourceHeader = page.locator('[data-source-preview-header]')
  const sourceHeaderTitle = sourceHeader.locator('[data-source-preview-header-title]')
  const sourceHeaderUrl = sourceHeader.locator('[data-source-preview-header-url]')
  const sourceHeaderButtons = sourceHeader.locator('button')
  await expect(sourceHeader.locator('.lucide-link-2')).toHaveCount(0)
  await expect(sourceHeaderButtons).toHaveCount(2)
  await expect(sourceHeaderButtons.nth(0)).toHaveAttribute(
    'data-source-preview-header-external',
    ''
  )
  await expect(sourceHeaderButtons.nth(1)).toHaveAttribute('data-source-preview-header-close', '')
  await expect(sourceHeaderTitle).toHaveText('Fixture study')
  await expect(
    sourceHeaderUrl.getByText('https://citation.example/paper', { exact: true })
  ).toBeVisible()
  const sourceHeaderVisuals = await sourceHeader.evaluate((header) => {
    const title = header.querySelector<HTMLElement>('[data-source-preview-header-title]')
    const url = header.querySelector<HTMLElement>('[data-source-preview-header-url]')
    const externalButton = header.querySelector<HTMLElement>(
      '[data-source-preview-header-external]'
    )
    const closeButton = header.querySelector<HTMLElement>('[data-source-preview-header-close]')
    const externalIcon = header.querySelector<SVGElement>(
      '[data-source-preview-header-external-icon]'
    )
    if (!title || !url || !externalButton || !closeButton || !externalIcon) {
      throw new Error('Source header layout is incomplete')
    }
    const headerRect = header.getBoundingClientRect()
    const titleRect = title.getBoundingClientRect()
    const externalButtonRect = externalButton.getBoundingClientRect()
    const closeButtonRect = closeButton.getBoundingClientRect()
    return {
      titleColor: getComputedStyle(title).color,
      urlColor: getComputedStyle(url).color,
      actionColor: getComputedStyle(externalButton).color,
      closeColor: getComputedStyle(closeButton).color,
      externalButtonWidth: externalButtonRect.width,
      externalButtonHeight: externalButtonRect.height,
      closeButtonWidth: closeButtonRect.width,
      closeButtonHeight: closeButtonRect.height,
      externalIconWidth: externalIcon.getBoundingClientRect().width,
      actionTopOffset: externalButtonRect.top - headerRect.top,
      actionTitleTopDelta: Math.abs(externalButtonRect.top - titleRect.top)
    }
  })
  expect(sourceHeaderVisuals.titleColor).not.toBe(sourceHeaderVisuals.urlColor)
  expect(sourceHeaderVisuals.actionColor).toBe(sourceHeaderVisuals.closeColor)
  expect(sourceHeaderVisuals.actionColor).not.toBe(sourceHeaderVisuals.titleColor)
  expect(sourceHeaderVisuals.externalButtonWidth).toBe(24)
  expect(sourceHeaderVisuals.externalButtonHeight).toBe(24)
  expect(sourceHeaderVisuals.closeButtonWidth).toBe(24)
  expect(sourceHeaderVisuals.closeButtonHeight).toBe(24)
  expect(sourceHeaderVisuals.externalIconWidth).toBe(12)
  expect(sourceHeaderVisuals.actionTopOffset).toBeCloseTo(4, 0)
  expect(sourceHeaderVisuals.actionTitleTopDelta).toBeLessThanOrEqual(1)
  const sourcePanel = page.getByRole('tabpanel').filter({ has: sourceFrame })
  const sourceIslandVisuals = await sourcePanel.evaluate((panel) => {
    const parent = panel.parentElement
    if (!parent) throw new Error('Source preview island has no layout parent')
    const panelRect = panel.getBoundingClientRect()
    const parentRect = parent.getBoundingClientRect()
    const style = getComputedStyle(panel)
    return {
      leftInset: panelRect.left - parentRect.left,
      rightInset: parentRect.right - panelRect.right,
      borderRadius: Number.parseFloat(style.borderTopLeftRadius),
      boxShadow: style.boxShadow
    }
  })
  expect(sourceIslandVisuals.leftInset).toBeCloseTo(8, 0)
  expect(sourceIslandVisuals.rightInset).toBeCloseTo(4, 0)
  expect(sourceIslandVisuals.borderRadius).toBeGreaterThan(0)
  expect(sourceIslandVisuals.boxShadow).not.toBe('none')
  await expect
    .poll(() => sourceFrame.evaluate((element) => (element as Electron.WebviewTag).getURL()))
    .toBe('https://citation.example/paper')
  await expect
    .poll(() =>
      page
        .context()
        .pages()
        .some((candidate) => candidate.url() === 'https://citation.example/paper')
    )
    .toBe(true)
  const nativePage = page
    .context()
    .pages()
    .find((candidate) => candidate.url() === 'https://citation.example/paper')!
  await expect(nativePage.getByRole('heading', { name: 'Fixture source' })).toBeVisible()
  await expect(sourceProgress).toHaveCount(0)
  await expect(sourceSkeleton).toHaveCount(0)
  await app.showMainWindow()
  const guestId = await sourceFrame.evaluate((element) =>
    (element as Electron.WebviewTag).getWebContentsId()
  )
  await nativePage.evaluate(() => {
    sessionStorage.setItem('overlay-session', 'retained')
    const form = document.createElement('input')
    form.id = 'overlay-form'
    form.value = '页面表单保留'
    document.body.append(form)
    const canvas = document.createElement('canvas')
    canvas.id = 'overlay-animation'
    canvas.width = 240
    canvas.height = 80
    canvas.style.cssText = 'display:block;width:240px;height:80px'
    document.body.append(canvas)
    const state = { frames: 0, marker: crypto.randomUUID() }
    Object.assign(window, { overlayState: state })
    const draw = (): void => {
      state.frames++
      const context = canvas.getContext('2d')!
      context.fillStyle = Math.floor(state.frames / 20) % 2 ? '#008080' : '#ff8000'
      context.fillRect(0, 0, 240, 80)
      context.fillStyle = 'white'
      context.font = '24px sans-serif'
      context.fillText(String(state.frames), 20, 48)
      requestAnimationFrame(draw)
    }
    requestAnimationFrame(draw)
  })
  const readSourceState = (): Promise<{
    frames: number
    marker: string
    session: string | null
    form: string
  }> =>
    nativePage.evaluate(() => ({
      ...(window as unknown as { overlayState: { frames: number; marker: string } }).overlayState,
      session: sessionStorage.getItem('overlay-session'),
      form: (document.getElementById('overlay-form') as HTMLInputElement).value
    }))
  const initialState = await readSourceState()
  for (let iteration = 0; iteration < 3; iteration++) {
    await page.getByRole('button', { name: PROJECT_NAME, exact: true }).click()
    await page.getByRole('menuitem', { name: 'New project', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'New project' })
    await expect(dialog).toBeVisible()
    await expect
      .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
      .toBe(true)
    const before = await readSourceState()
    await expect
      .poll(async () => (await readSourceState()).frames)
      .toBeGreaterThan(before.frames + 5)
    await expect(sourceFrame).toBeVisible()
    expect(
      await sourceFrame.evaluate((element) => (element as Electron.WebviewTag).getWebContentsId())
    ).toBe(guestId)
    await page.screenshot({ path: testInfo.outputPath(`source-under-dialog-${iteration}.png`) })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.tagName !== 'WEBVIEW'))
      .toBe(true)
  }
  expect(await readSourceState()).toMatchObject({
    marker: initialState.marker,
    session: 'retained',
    form: '页面表单保留'
  })
  expect(sourceDocumentRequestCount).toBe(1)
  await app.setMainWindowSize(1400, 950)
  await app.setMainWindowZoomFactor(1.25)
  await expect(sourceFrame).toBeVisible()
  const rightClickTarget = nativePage.getByRole('heading', { name: 'Fixture source' })
  const sourceBounds = (await sourceFrame.boundingBox())!
  const headingBounds = (await rightClickTarget.boundingBox())!
  await rightClickTarget.click({ button: 'right', position: { x: 8, y: 10 } })
  const sourceMenu = page.getByRole('menu')
  await expect(sourceMenu.getByText('Copy link', { exact: true })).toBeVisible()
  const menuBounds = (await sourceMenu.boundingBox())!
  expect(Math.abs(menuBounds.x - (sourceBounds.x + headingBounds.x + 8))).toBeLessThan(5)
  expect(Math.abs(menuBounds.y - (sourceBounds.y + headingBounds.y + 10))).toBeLessThan(5)
  await page.screenshot({ path: testInfo.outputPath('source-context-menu-zoom.png') })
  await page.keyboard.press('Escape')
  await expect(sourceMenu).toHaveCount(0)
  await expect.poll(() => nativePage.evaluate(() => document.hasFocus())).toBe(true)
  await nativePage.getByText('Native area', { exact: true }).click({ button: 'right' })
  await expect(sourceMenu).toHaveCount(0)
  await nativePage.locator('#overlay-form').click({ button: 'right' })
  await expect(sourceMenu).toHaveCount(0)
  await page.context().route('https://nested.citation.example/frame', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<h2>Nested source</h2><p data-preview-context-menu-passthrough>Nested native area</p>'
    })
  )
  await nativePage.evaluate(() => {
    const frame = document.createElement('iframe')
    frame.id = 'nested-source'
    frame.src = 'https://nested.citation.example/frame'
    frame.style.cssText = 'display:block;width:260px;height:130px'
    document.body.prepend(frame)
  })
  const nested = nativePage.frameLocator('#nested-source')
  const nestedHeading = nested.getByRole('heading', { name: 'Nested source' })
  await expect(nestedHeading).toBeVisible()
  const nestedBounds = (await nestedHeading.boundingBox())!
  await nestedHeading.click({ button: 'right', position: { x: 8, y: 10 } })
  await expect(sourceMenu.getByText('Copy link', { exact: true })).toBeVisible()
  const nestedMenuBounds = (await sourceMenu.boundingBox())!
  expect(Math.abs(nestedMenuBounds.x - (sourceBounds.x + nestedBounds.x + 8))).toBeLessThan(5)
  expect(Math.abs(nestedMenuBounds.y - (sourceBounds.y + nestedBounds.y + 10))).toBeLessThan(5)
  await page.keyboard.press('Escape')
  await expect(sourceMenu).toHaveCount(0)
  await nested.getByText('Nested native area').click({ button: 'right' })
  await expect(sourceMenu).toHaveCount(0)
  await nativePage.locator('#nested-source').evaluate((element) => element.remove())
  await app.setMainWindowZoomFactor(1)
  // Exercise Chromium composition events without changing the operating system's input source.
  const composition = await page.context().newCDPSession(nativePage)
  await nativePage.locator('#overlay-form').fill('')
  await composition.send('Input.imeSetComposition', {
    text: '中文输入',
    selectionStart: 4,
    selectionEnd: 4
  })
  await composition.send('Input.insertText', { text: '中文输入' })
  await expect(nativePage.locator('#overlay-form')).toHaveValue('中文输入')
  await composition.detach()

  await app.showMainWindow()
  // Native content must forward window shortcuts and search its own document when focused.
  await nativePage.getByRole('heading', { name: 'Fixture source' }).click()
  await app.pressSourcePreviewShortcut(
    nativePage.url(),
    'F',
    process.platform === 'darwin' ? ['meta'] : ['control']
  )
  await expect.poll(() => app.findOverlayIsVisible()).toBe(true)
  const findPage = page
    .context()
    .pages()
    .find((candidate) => candidate.url().includes('/find-overlay/'))!
  await findPage.getByRole('textbox').fill('Peer-reviewed evidence')
  await expect(findPage.locator('#find-overlay-count')).toHaveText('1 / 1')
  await findPage.getByRole('textbox').press('Escape')
  await expect.poll(() => app.findOverlayIsVisible()).toBe(false)
  await expect.poll(() => nativePage.evaluate(() => document.hasFocus())).toBe(true)
  await app.pressSourcePreviewShortcut(
    nativePage.url(),
    'F',
    process.platform === 'darwin' ? ['meta'] : ['control']
  )
  await expect.poll(() => app.findOverlayIsVisible()).toBe(true)
  const reopenedFindPage = page
    .context()
    .pages()
    .find((candidate) => candidate.url().includes('/find-overlay/'))!
  await reopenedFindPage.getByRole('textbox').fill('Fixture source')
  await expect(reopenedFindPage.locator('#find-overlay-count')).toHaveText('1 / 1')
  await reopenedFindPage.getByRole('textbox').press('Escape')
  await expect.poll(() => app.findOverlayIsVisible()).toBe(false)

  // Use real Chromium same-document navigations; IPC injection cannot verify this adapter.
  const sourceDocument = nativePage.locator('body')
  for (const operation of ['anchor', 'push', 'replace', 'back', 'forward']) {
    const previousUrl = await sourceHeaderUrl.textContent()
    await sourceDocument.evaluate((_body, action) => {
      if (action === 'anchor') location.hash = 'methods'
      else if (action === 'push') history.pushState({}, '', '?section=results')
      else if (action === 'replace') history.replaceState({}, '', '?section=discussion')
      else if (action === 'back') history.back()
      else history.forward()
    }, operation)
    await expect.poll(() => sourceDocument.evaluate(() => location.href)).not.toBe(previousUrl)
    await expect(sourceHeaderUrl).toHaveText(await sourceDocument.evaluate(() => location.href))
    await expect(sourceSkeleton).toHaveCount(0)
    await expect(sourceProgress).toHaveCount(0)
    await expect(sourceFrame).toHaveAttribute('data-source-url', 'https://citation.example/paper')
  }

  await page.screenshot({ path: testInfo.outputPath('citation-source-preview.png') })

  const replicationLink = page.getByRole('link', { name: 'Chen et al. 2026' })
  await replicationLink.focus()
  await page.keyboard.press('Tab')
  await expect(page.locator('[data-source-preview-hover-url]')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('tab', { name: 'Replication study' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await expect.poll(() => replicationDocumentRequestCount).toBe(1)
  await expect(page.locator('[data-source-preview-frame]')).toHaveCount(2)
  await expect(sourceFrame).toBeHidden()

  const fixtureTab = page.getByRole('tab', { name: 'Fixture study' })
  await fixtureTab.click()
  await expect(fixtureTab).toHaveAttribute('aria-selected', 'true')
  await expect(sourceFrame).toBeVisible()
  expect(sourceDocumentRequestCount).toBe(1)

  await sourcePanel.locator('[data-source-preview-header-close]').click()
  await expect(sourceFrame).toHaveCount(0)
  await expect.poll(() => nativePage.isClosed()).toBe(true)
  await sourceLink.focus()
  await page.keyboard.press('Tab')
  await expect(page.locator('[data-source-preview-hover-url]')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(() => sourceDocumentRequestCount).toBe(2)

  // Close the searched source while the native find overlay is still open. The overlay must not
  // restore focus to the destroyed guest when Escape dismisses it.
  const reopenedSourceFrame = page.locator(
    '[data-source-preview-frame][data-source-url="https://citation.example/paper"]'
  )
  await expect(reopenedSourceFrame).toBeVisible()
  await expect
    .poll(() =>
      page
        .context()
        .pages()
        .some((candidate) => candidate.url() === 'https://citation.example/paper')
    )
    .toBe(true)
  const reopenedNativePage = page
    .context()
    .pages()
    .find((candidate) => candidate.url() === 'https://citation.example/paper')!
  await reopenedNativePage.getByRole('heading', { name: 'Fixture source' }).click()
  await app.pressSourcePreviewShortcut(
    reopenedNativePage.url(),
    'F',
    process.platform === 'darwin' ? ['meta'] : ['control']
  )
  await expect.poll(() => app.findOverlayIsVisible()).toBe(true)
  const closingFindPage = page
    .context()
    .pages()
    .find((candidate) => candidate.url().includes('/find-overlay/'))!
  await closingFindPage.getByRole('textbox').fill('Peer-reviewed evidence')
  await expect(closingFindPage.locator('#find-overlay-count')).toHaveText('1 / 1')
  await page
    .getByRole('tabpanel')
    .filter({ has: reopenedSourceFrame })
    .locator('[data-source-preview-header-close]')
    .click()
  await expect(reopenedSourceFrame).toHaveCount(0)
  await expect.poll(() => reopenedNativePage.isClosed()).toBe(true)
  await closingFindPage.getByRole('textbox').press('Escape')
  await expect.poll(() => app.findOverlayIsVisible()).toBe(false)
  await expect(page.getByRole('tab', { name: 'Replication study' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
})

test('shows the Electron failure reason when a source request fails', async ({ app }, testInfo) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await allowCitationPreviewDomain(page)
  app.allowRendererConsoleError('Failed to load resource: net::ERR_CONNECTION_REFUSED')
  let sourceDocumentRequestCount = 0
  await page.context().route('https://citation.example/paper', async (route) => {
    sourceDocumentRequestCount += 1
    await route.abort('connectionrefused')
  })
  await page.context().route('https://citation.example/replication', async (route) => {
    await route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><body><main><h1>Replication source</h1></main></body></html>'
    })
  })
  await createProject(page)

  await page.getByRole('textbox', { name: 'Ask anything' }).fill(CITATION_PREVIEW_PROMPT)
  await page.getByRole('button', { name: 'Send message' }).click()

  const sourceLink = page.getByRole('link', { name: 'Torre et al. 2026' })
  await sourceLink.hover()
  await page.locator('[data-source-preview-hover-url]').click()

  const sourceError = page.locator('[data-source-preview-error]')
  await expect(sourceError).toContainText('Could not load this source')
  await expect(sourceError).toContainText('The source could not be reached.')
  await expect(sourceError).toContainText('ERR_CONNECTION_REFUSED (-102)')
  await expect(page.locator('[data-source-preview-skeleton]')).toHaveCount(0)
  await expect(page.locator('[data-source-preview-progress]')).toHaveCount(0)
  const errorNotice = sourceError.locator('[data-source-preview-error-content] > section')
  const [errorBounds, noticeBounds] = await Promise.all([
    sourceError.boundingBox(),
    errorNotice.boundingBox()
  ])
  expect(errorBounds).not.toBeNull()
  expect(noticeBounds).not.toBeNull()
  const centeredTopGap = (errorBounds!.height - noticeBounds!.height) / 2
  const actualTopGap = noticeBounds!.y - errorBounds!.y
  expect(actualTopGap).toBeCloseTo(centeredTopGap * 0.8, 0)
  expect(sourceDocumentRequestCount).toBe(1)
  await page.screenshot({ path: testInfo.outputPath('source-preview-error.png') })

  await page.getByRole('link', { name: 'Chen et al. 2026' }).hover()
  await page.locator('[data-source-preview-hover-url]').click()
  await expect(page.getByRole('tab', { name: 'Replication study' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await page.getByRole('tab', { name: 'Fixture study' }).click()
  await expect(sourceError).toContainText('ERR_CONNECTION_REFUSED (-102)')
  expect(sourceDocumentRequestCount).toBe(1)

  await sourceError.getByRole('button', { name: 'Try again' }).click()
  await expect.poll(() => sourceDocumentRequestCount).toBe(2)
  await expect(sourceError).toContainText('ERR_CONNECTION_REFUSED (-102)')
  await page.context().route('https://citation.example/paper', (route) =>
    route.fulfill({
      status: 302,
      headers: { location: 'http://blocked.example/paper' }
    })
  )
  await sourceError.getByRole('button', { name: 'Try again' }).click()
  await expect(sourceError).toContainText('This source does not allow embedded previews.')
  await expect(page.locator('[data-source-preview-skeleton]')).toHaveCount(0)
  await expect(page.locator('[data-source-preview-progress]')).toHaveCount(0)
})

test('archives a completed session from its mobile sidebar actions', async ({ app }, testInfo) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await createProject(page)

  await page.getByRole('textbox', { name: 'Ask anything' }).fill(USER_MESSAGE)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText(AGENT_REPLY, { exact: true })).toBeVisible()

  const advanceRevision = async (): Promise<void> => {
    const session = await page.evaluate(async (title) => {
      const session = (await window.api.sessions.loadAll()).sessions.find(
        (candidate) => candidate.title === title
      )
      if (!session) throw new Error('Archive fixture Session was not persisted.')
      return session
    }, USER_MESSAGE)
    await page.getByRole('menuitem', { name: 'Archive' }).evaluate((element, session) => {
      // Queue another client's write immediately before the menu submits its captured version.
      element.addEventListener(
        'click',
        () => {
          void window.api.sessions.editDetails({
            projectId: session.projectId!,
            sessionId: session.id,
            title: session.title,
            description: `${session.description ?? ''} concurrent edit`,
            expectedTitle: session.title,
            expectedDescription: session.description ?? ''
          })
        },
        { capture: true, once: true }
      )
    }, session)
  }

  await page.setViewportSize({ width: 375, height: 900 })
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByRole('button', { name: `Open actions for ${USER_MESSAGE}` }).click()
  // Chromium names a popup menu from its trigger, so the computed accessible name is the
  // session-specific trigger label rather than the content aria-label "Session actions".
  const sessionActions = page.getByRole('menu', {
    name: `Open actions for ${USER_MESSAGE}`
  })
  await expect(sessionActions).toBeVisible()
  expect(await sessionActions.evaluate((element) => Number(getComputedStyle(element).zIndex))).toBe(
    80
  )

  await sessionActions.getByRole('menuitem', { name: 'Export', exact: true }).hover()
  await page.getByRole('menuitem', { name: 'Export conversation…' }).click()
  const exportDialog = page.getByRole('dialog', { name: 'Export conversation' })
  await expect(exportDialog).toBeVisible()
  await expect(exportDialog.getByRole('radio', { name: 'Markdown' })).toBeVisible()
  await exportDialog.getByRole('button', { name: 'Close' }).click()
  await expect(exportDialog).toBeHidden()

  const undo = page.getByTestId('archive-undo-snackbar')
  const conflict = page.getByText(/Session revision conflict:/)
  // Exercise two consecutive authority changes, not just one lucky retry. Each conflict
  // must finish refreshing the projection before a fresh user action opens the menu again.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.getByRole('button', { name: 'Open navigation' }).click()
    await page.getByRole('button', { name: `Open actions for ${USER_MESSAGE}` }).click()
    const archive = page.getByRole('menuitem', { name: 'Archive' })
    await expect(archive).toBeEnabled()
    if (attempt < 2) await advanceRevision()
    await archive.click()
    if (attempt < 2) {
      await expect(conflict).toBeVisible()
      await expect(undo).toBeHidden()
    } else {
      await expect(undo).toContainText('Archived session')
    }
  }
  await expect(page.getByRole('button', { name: `Open actions for ${USER_MESSAGE}` })).toBeHidden()
  await page.screenshot({
    path: testInfo.outputPath('mobile-session-archived.png'),
    animations: 'disabled'
  })
})

test('identifies the Project before deleting a workspace Session', async ({ app }, testInfo) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await createProject(page)
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(USER_MESSAGE)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText(AGENT_REPLY, { exact: true })).toBeVisible()

  await page.setViewportSize({ width: 375, height: 900 })
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByRole('button', { name: `Open actions for ${USER_MESSAGE}` }).click()
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  const confirmation = page.getByRole('alertdialog', { name: 'Delete Session?' })
  await expect(confirmation).toContainText(`Project: ${PROJECT_NAME}`)
  await expect(confirmation).toContainText(USER_MESSAGE)
  await page.screenshot({
    path: testInfo.outputPath('workspace-delete-project.png'),
    animations: 'disabled'
  })
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(confirmation).toBeHidden()
})

test('exports a CLI conversation first opened after completion', async ({ app }, testInfo) => {
  test.setTimeout(300_000)
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await createProject(page)
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(USER_MESSAGE)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText(AGENT_REPLY, { exact: true })).toBeVisible()
  const projectId = await page.evaluate(
    async () =>
      (await window.api.projects.list()).find((p) => p.name === 'Agent journey project')!.id
  )
  // Slow projection delivery so the renderer's reply save overlaps Main's Task completion.
  const runtimeProjection = await page.context().newCDPSession(page)
  await runtimeProjection.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  await app.authenticatedWebUrl()
  const directory = await app.createTestDirectory('cli-export')
  const output = await promisify(execFile)(
    process.execPath,
    [
      'cli/index.mjs',
      'run',
      '--config-root',
      join(dirname(directory), 'storage'),
      '--project',
      projectId,
      '--prompt',
      'CLI export completed before opening.',
      '--no-memory',
      '--no-auto-review',
      '--wait',
      '--json'
    ],
    { cwd: process.cwd(), timeout: 60_000 }
  )
  const run = JSON.parse(output.stdout)
  expect(run.status).toBe('completed')
  // Match the report's settled-before-export interval without forcing a persistence flush.
  await new Promise((resolve) => setTimeout(resolve, 30_000))
  const saved = await page.evaluate(
    async ({ projectId, sessionId }) => window.api.sessions.loadOne({ projectId, sessionId }),
    { projectId, sessionId: run.sessionId }
  )
  expect(saved).toBeTruthy()
  expect(saved!.status).toBe('idle')
  expect(saved!.activeRun).toBeUndefined()
  expect(saved!.messages.filter((message) => message.role === 'agent')).toHaveLength(1)
  const destination = await app.configureSessionPackageDialogs()
  await page
    .getByRole('navigation', { name: 'Sessions' })
    .locator('button[data-slot="session-open-button"]')
    .filter({ hasText: saved!.title })
    .click()
  await expect(
    page
      .getByRole('region', { name: 'Conversation' })
      .getByText('CLI export completed before opening.', { exact: true })
  ).toBeVisible()
  await page.getByRole('button', { name: `Open actions for ${saved!.title}` }).click()
  await page.getByRole('menuitem', { name: 'Export', exact: true }).hover()
  await page.getByRole('menuitem', { name: 'Export conversation…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Export conversation', exact: true })
  await dialog.getByRole('radio', { name: 'Markdown' }).click()
  await dialog.getByTestId('conversation-export-confirm').click()
  await expect(dialog).toBeHidden()
  // The report retries a freshly reviewed snapshot after two idle minutes.
  await new Promise((resolve) => setTimeout(resolve, 120_000))
  await page.getByRole('button', { name: `Open actions for ${saved!.title}` }).click()
  await page.getByRole('menuitem', { name: 'Export', exact: true }).hover()
  await page.getByRole('menuitem', { name: 'Export conversation…' }).click()
  await dialog.getByRole('radio', { name: 'Markdown' }).click()
  await dialog.getByTestId('conversation-export-confirm').click()
  await expect(dialog).toBeHidden()
  const markdown = await readFile(destination, 'utf8')
  expect(markdown).toContain('CLI export completed before opening.')
  expect(markdown).toContain(AGENT_REPLY)
  await page.screenshot({ path: testInfo.outputPath('cli-export-completed.png') })
  await page.getByRole('textbox', { name: 'Ask anything' }).fill('Continue after export.')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText(AGENT_REPLY, { exact: true })).toHaveCount(2)
})
