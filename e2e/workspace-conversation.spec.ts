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

const createProject = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill(PROJECT_NAME)
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()
}

test('edits and navigates message revisions that persist after relaunch', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page)

  await page.getByRole('textbox', { name: 'Ask anything' }).fill(USER_MESSAGE)
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled()
  await page.getByRole('button', { name: 'Send message' }).click()

  let conversation = page.getByRole('region', { name: 'Conversation' })
  await expect(conversation.getByText(USER_MESSAGE, { exact: true })).toBeVisible()
  await expect(conversation.getByText(AGENT_REPLY, { exact: true })).toBeVisible()

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
  await expect(revision).toHaveText('2/2')
  await expect(previousRevision).toBeEnabled()
  await expect(nextRevision).toBeDisabled()

  await previousRevision.click()
  await expect(conversation.getByText(USER_MESSAGE, { exact: true })).toBeVisible()
  await expect(revision).toHaveText('1/2')
  await expect(previousRevision).toBeDisabled()
  await expect(nextRevision).toBeEnabled()

  await nextRevision.click()
  await expect(conversation.getByText(EDITED_USER_MESSAGE, { exact: true })).toBeVisible()
  await expect(revision).toHaveText('2/2')
  await previousRevision.click()
  await expect(conversation.getByText(USER_MESSAGE, { exact: true })).toBeVisible()
  await expect(revision).toHaveText('1/2')

  page = await app.restart()
  await page
    .getByRole('region', { name: 'Recent sessions' })
    .getByRole('button', { name: USER_MESSAGE })
    .click()
  conversation = page.getByRole('region', { name: 'Conversation' })
  await expect(conversation.getByText(USER_MESSAGE, { exact: true })).toBeVisible()
  await expect(conversation.getByText(AGENT_REPLY, { exact: true })).toBeVisible()
  await expect(conversation.getByLabel('Message revision', { exact: true })).toHaveText('1/2')
  await expect(
    conversation.getByRole('button', { name: 'Previous message revision' })
  ).toBeDisabled()
  await expect(conversation.getByRole('button', { name: 'Next message revision' })).toBeEnabled()

  await conversation.getByRole('button', { name: 'Next message revision' }).click()
  await expect(conversation.getByText(EDITED_USER_MESSAGE, { exact: true })).toBeVisible()
  await expect(conversation.getByLabel('Message revision', { exact: true })).toHaveText('2/2')
})

test('resolves Agent permission requests through both Allow and Deny decisions', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
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
  await page.getByRole('button', { name: /^Allow/ }).click()
  await expect(page.getByText('Fixture permission allowed.', { exact: true })).toBeVisible()
  await expect(composer).toBeVisible()

  await composer.fill(`${PERMISSION_PROMPT} deny`)
  await page.getByRole('button', { name: 'Send message' }).click()

  await expect(page.getByText('Write fixture output', { exact: true })).toBeVisible()
  await expect(page.getByTestId('permission-composer')).toBeVisible()
  await expect(composer).toBeHidden()
  await page.getByRole('button', { name: 'Deny', exact: true }).click()
  await expect(page.getByText('Fixture permission denied.', { exact: true })).toBeVisible()
  await expect(composer).toBeVisible()
})

test('shows context compaction loading and completion inside the Session transcript', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
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
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
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
    if (!summary || !actions || !title || !hostname || !url || !external) {
      throw new Error('Source hover layout is incomplete')
    }
    const cardRect = card.getBoundingClientRect()
    const hostnameRect = hostname.getBoundingClientRect()
    const actionsRect = actions.getBoundingClientRect()
    const urlRect = url.getBoundingClientRect()
    const externalRect = external.getBoundingClientRect()
    return {
      width: cardRect.width,
      titleColor: getComputedStyle(title).color,
      descriptionColor: getComputedStyle(hostname).color,
      actionGap: actionsRect.top - hostnameRect.bottom,
      actionCenterDelta: Math.abs(
        urlRect.top + urlRect.height / 2 - (externalRect.top + externalRect.height / 2)
      )
    }
  })
  expect(hoverLayout.width).toBeLessThan(320)
  expect(hoverLayout.titleColor).not.toBe(hoverLayout.descriptionColor)
  expect(hoverLayout.actionGap).toBeGreaterThanOrEqual(8)
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
  const sourceFrame = page.locator('[data-source-preview-frame]')
  await expect(sourceFrame).toHaveAttribute('src', 'https://citation.example/paper')
  await expect.poll(() => sourceDocumentRequestCount).toBe(1)
  const sourceProgress = page.locator('[data-source-preview-progress]')
  await expect(sourceProgress).toBeVisible()
  expect(await sourceProgress.evaluate((element) => getComputedStyle(element).height)).toBe('2px')
  await page.screenshot({ path: testInfo.outputPath('source-preview-loading.png') })
  await expect(sourceFrame).toHaveAttribute('sandbox', 'allow-same-origin allow-scripts')
  await expect(sourceFrame).toHaveAttribute('referrerpolicy', 'no-referrer')
  await expect(sourceFrame).toHaveAttribute('name', 'open-science-source-preview')
  const sourcePreview = sourceFrame.locator('..')
  const sourceHeader = sourcePreview.locator('[data-source-preview-header]')
  const sourceHeaderTitle = sourceHeader.locator('[data-source-preview-header-title]')
  const sourceHeaderUrl = sourceHeader.locator('[data-source-preview-header-url]')
  await expect(sourceHeader.locator('.lucide-link-2')).toHaveCount(0)
  await expect(sourceHeaderTitle).toHaveText('Fixture study')
  await expect(
    sourceHeaderUrl.getByText('https://citation.example/paper', { exact: true })
  ).toBeVisible()
  const sourceHeaderVisuals = await sourceHeader.evaluate((header) => {
    const title = header.querySelector<HTMLElement>('[data-source-preview-header-title]')
    const url = header.querySelector<HTMLElement>('[data-source-preview-header-url]')
    const externalIcon = header.querySelector<SVGElement>(
      '[data-source-preview-header-external-icon]'
    )
    if (!title || !url || !externalIcon) throw new Error('Source header layout is incomplete')
    return {
      titleColor: getComputedStyle(title).color,
      urlColor: getComputedStyle(url).color,
      externalIconWidth: externalIcon.getBoundingClientRect().width
    }
  })
  expect(sourceHeaderVisuals.titleColor).not.toBe(sourceHeaderVisuals.urlColor)
  expect(sourceHeaderVisuals.externalIconWidth).toBeGreaterThanOrEqual(16)
  releaseSourceDocument?.()
  await expect(
    page.frameLocator('[data-source-preview-frame]').getByRole('heading', {
      name: 'Fixture source'
    })
  ).toBeVisible()
  await expect(sourceProgress).toHaveCount(0)

  await page.screenshot({ path: testInfo.outputPath('citation-source-preview.png') })
})

test('archives a completed session from its mobile sidebar actions', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
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
