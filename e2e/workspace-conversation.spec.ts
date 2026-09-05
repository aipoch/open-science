import { expect } from '@playwright/test'
import type { AxeResults } from 'axe-core'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
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

test('edits and navigates message revisions that persist after relaunch', async ({ app }) => {
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

  await nextRevision.click()
  await expect(conversation.getByText(EDITED_USER_MESSAGE, { exact: true })).toBeVisible()
  await expect(revision).toHaveText(['2/2'])
  await previousRevision.click()
  await expect(conversation.getByText(USER_MESSAGE, { exact: true })).toBeVisible()
  await expect(revision).toHaveText(['1/2'])

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

test('resolves Agent permission requests through both Allow and Deny decisions', async ({
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
  const resizeHandle = page.getByRole('button', { name: 'Resize permission panel' })
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
  let sourceDocumentRequestCount = 0
  let releaseSourceDocument: (() => void) | undefined
  const sourceDocumentGate = new Promise<void>((resolve) => {
    releaseSourceDocument = resolve
  })
  await page.route('https://citation.example/paper', async (route) => {
    sourceDocumentRequestCount += 1
    await sourceDocumentGate
    await route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><body><main><h1>Fixture source</h1><p>Peer-reviewed evidence.</p></main></body></html>'
    })
  })
  let replicationDocumentRequestCount = 0
  await page.route('https://citation.example/replication', async (route) => {
    replicationDocumentRequestCount += 1
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
    '[data-source-preview-frame][src="https://citation.example/paper"]'
  )
  await expect(sourceFrame).toHaveAttribute('src', 'https://citation.example/paper')
  await expect.poll(() => sourceDocumentRequestCount).toBe(1)
  const sourceProgress = page.locator('[data-source-preview-progress]')
  const sourceSkeleton = page.locator('[data-source-preview-skeleton]')
  await expect(sourceProgress).toBeVisible()
  await expect(sourceSkeleton).toBeVisible()
  expect(await sourceProgress.evaluate((element) => getComputedStyle(element).height)).toBe('2px')
  await page.screenshot({ path: testInfo.outputPath('source-preview-loading.png') })
  await expect(sourceFrame).toHaveAttribute(
    'sandbox',
    'allow-same-origin allow-scripts allow-forms'
  )
  await expect(sourceFrame).toHaveAttribute('referrerpolicy', 'no-referrer')
  await expect(sourceFrame).toHaveAttribute('name', 'open-science-source-preview')
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
  releaseSourceDocument?.()
  await expect(
    page.frameLocator('[data-source-preview-frame]').getByRole('heading', {
      name: 'Fixture source'
    })
  ).toBeVisible()
  await expect(sourceProgress).toHaveCount(0)
  await expect(sourceSkeleton).toHaveCount(0)

  await page.screenshot({ path: testInfo.outputPath('citation-source-preview.png') })

  const replicationLink = page.getByRole('link', { name: 'Chen et al. 2026' })
  await replicationLink.hover()
  await page.locator('[data-source-preview-hover-url]').click()
  await expect(page.getByRole('tab', { name: 'Replication study' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await expect.poll(() => replicationDocumentRequestCount).toBe(1)
  await expect(page.locator('[data-source-preview-frame]')).toHaveCount(2)

  const fixtureTab = page.getByRole('tab', { name: 'Fixture study' })
  await fixtureTab.click()
  await expect(fixtureTab).toHaveAttribute('aria-selected', 'true')
  await expect(sourceFrame).toBeVisible()
  expect(sourceDocumentRequestCount).toBe(1)

  await sourcePanel.locator('[data-source-preview-header-close]').click()
  await expect(sourceFrame).toHaveCount(0)
  await sourceLink.hover()
  await page.locator('[data-source-preview-hover-url]').click()
  await expect.poll(() => sourceDocumentRequestCount).toBe(2)
})

test('shows the Electron failure reason when a source request fails', async ({ app }, testInfo) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await allowCitationPreviewDomain(page)
  app.allowRendererConsoleError('Failed to load resource: net::ERR_CONNECTION_REFUSED')
  let sourceDocumentRequestCount = 0
  await page.route('https://citation.example/paper', async (route) => {
    sourceDocumentRequestCount += 1
    await route.abort('connectionrefused')
  })
  await page.route('https://citation.example/replication', async (route) => {
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
})

test('archives a completed session from its mobile sidebar actions', async ({ app }) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await createProject(page)

  await page.getByRole('textbox', { name: 'Ask anything' }).fill(USER_MESSAGE)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText(AGENT_REPLY, { exact: true })).toBeVisible()

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

  await page.getByRole('menuitem', { name: 'Export conversation…' }).click()
  const exportDialog = page.getByRole('dialog', { name: 'Export conversation' })
  await expect(exportDialog).toBeVisible()
  await expect(exportDialog.getByRole('radio', { name: 'Markdown' })).toBeVisible()
  await exportDialog.getByRole('button', { name: 'Close' }).click()
  await expect(exportDialog).toBeHidden()

  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByRole('button', { name: `Open actions for ${USER_MESSAGE}` }).click()
  const archive = page.getByRole('menuitem', { name: 'Archive' })
  await expect(archive).toBeEnabled()
  await archive.click()

  await expect(page.getByTestId('archive-undo-snackbar')).toContainText('Archived session')
  await expect(page.getByRole('button', { name: `Open actions for ${USER_MESSAGE}` })).toBeHidden()
})
