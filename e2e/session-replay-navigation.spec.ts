import {
  askReplayStep,
  openReplayMaterial,
  chooseReplayConversation
} from './helpers/research-replay'
import { expect } from '@playwright/test'
import type { Locator, Page } from 'playwright'
import type { PersistedChatSession } from '../src/shared/session-persistence'
import type { SessionDiscussionSnapshot } from '../src/shared/session-replay'
import { createProject } from './certification/helpers'
import { test } from './fixtures/electron-app'

test.use({ windowMode: 'normal' })

const sourceFixture = (projectId: string, suffix: 'a' | 'b'): PersistedChatSession => ({
  id: `import-navigation-${suffix}`,
  projectId,
  title: `Navigation research ${suffix.toUpperCase()}`,
  cwd: '',
  status: 'idle',
  createdAt: 1,
  updatedAt: suffix === 'a' ? 4 : 3,
  messages: [
    {
      id: `question-${suffix}`,
      role: 'user',
      content: `What is recorded in research ${suffix.toUpperCase()}?`,
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: `answer-${suffix}`,
      role: 'agent',
      content: `Research ${suffix.toUpperCase()} retained its own recorded result.`,
      status: 'complete',
      eventIds: [],
      createdAt: 2,
      updatedAt: 3
    }
  ],
  packageOrigin: {
    importId:
      suffix === 'a'
        ? '2b13c144-2a80-4b51-b22f-ae5bcb57a07a'
        : '5a675f26-9826-46cc-9136-e98bb33149dd',
    importedAt: 5,
    manifestChecksum: suffix.repeat(64),
    sourceProjectId: 'original-project',
    sourceSessionId: `original-session-${suffix}`
  }
})

const sessionRow = (page: Page, title: string): Locator =>
  page.locator('[data-slot="session-open-button"]').filter({ hasText: title })

const replayTab = (page: Page, sourceId: string): Locator =>
  page.locator(`[id="preview-tab-${encodeURIComponent(`tool:${sourceId}:replay`)}"]`)

test('asks immediately after seeking recorded artifact and upload steps without sending or replacing the draft', async ({
  app
}) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  const projectName = 'Recorded file step questions'
  const projectId = await createProject(page, projectName)
  const uploadName = 'recorded-observations.csv'
  await page.locator('input[type="file"][multiple]').setInputFiles({
    name: uploadName,
    mimeType: 'text/csv',
    buffer: Buffer.from('sample,value\nA,42\n')
  })
  await expect(
    page.getByRole('button', { name: `Remove attachment ${uploadName}`, exact: true })
  ).toBeVisible()
  await page
    .getByRole('textbox', { name: 'Ask anything', exact: true })
    .fill('Create preview context menu artifacts.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(
    page.getByText('Preview context menu artifacts created.', { exact: true })
  ).toBeVisible({ timeout: 90_000 })
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0)
  const recorded = await page.evaluate(async (projectId) => {
    const session = (await window.api.sessions.loadAll()).sessions.find(
      (session) => session.projectId === projectId
    )!
    return (await window.api.sessions.loadOne({ projectId, sessionId: session.id }))!
  }, projectId)
  const artifact = recorded.artifacts!.find((item) => item.name === 'context-menu.html')!
  const upload = recorded.messages.flatMap((message) => message.uploads ?? [])[0]
  expect(artifact.versionId).toBeTruthy()
  expect(upload.versionId).toBeTruthy()
  // Retain native file/Version storage and exercise the same imported-research workspace as
  // a .science import. No mocked replay document or annotation bridge can hide missing evidence.
  const source: PersistedChatSession = {
    ...recorded,
    title: 'Imported recorded file evidence',
    packageOrigin: sourceFixture(projectId, 'a').packageOrigin
  }
  page = await app.restartWithSessionFixture(source)
  await page
    .getByRole('region', { name: 'Projects', exact: true })
    .getByRole('button', { name: projectName, exact: true })
    .click()
  await sessionRow(page, source.title).click()
  const replay = page.getByTestId('replay-panel')
  const editor = page.getByRole('textbox', { name: 'Ask anything', exact: true })
  const draft = 'Which recorded file supports this conclusion?'
  await expect(replay).toBeVisible()
  await editor.fill(draft)
  await expect(page.getByTestId('research-workspace-header')).toContainText(
    'Original record · Read-only'
  )
  await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toContainText(
    source.messages.at(-1)!.content
  )
  const prompts = await app.readFakeAgentPrompts()
  const before = await page.evaluate((request) => window.api.sessions.loadOne(request), {
    projectId,
    sessionId: source.id
  })
  const snapshots = (): Promise<SessionDiscussionSnapshot[]> =>
    page.evaluate((request) => window.api.sessionReplay.listSelectionSnapshots(request), {
      projectId,
      sourceSessionId: source.id
    })
  const captured: SessionDiscussionSnapshot[] = []
  // The imported research workspace persists its initial whole-research draft asynchronously.
  // Settle that baseline before measuring the single explicit selection produced by Ask.
  await expect
    .poll(async () => (await snapshots()).filter((snapshot) => snapshot.scope === 'session').length)
    .toBe(1)

  for (const file of [
    { name: artifact.name!, kind: 'artifact-version', versionId: artifact.versionId! },
    { name: uploadName, kind: 'upload-version', versionId: upload.versionId! }
  ]) {
    const previousIds = (await snapshots()).map((snapshot) => snapshot.id)
    await replay.getByRole('button', { name: 'Browse steps', exact: true }).click()
    const directory = page.getByRole('dialog', { name: 'Browse steps', exact: true })
    await directory
      .getByRole('button', { name: /^Go to step \d+:/ })
      .filter({ hasText: file.name })
      .click()
    // Seek lands at offset zero and pauses. Asking immediately must use the recorded Version,
    // without playing through a fabricated input/activity phase to make that evidence available.
    await askReplayStep(replay)
    await expect
      .poll(async () =>
        (await snapshots()).filter((snapshot) => !previousIds.includes(snapshot.id))
      )
      .toHaveLength(1)
    const snapshot = (await snapshots()).find((snapshot) => !previousIds.includes(snapshot.id))!
    expect(snapshot.scope ?? 'step').toBe('step')
    expect(snapshot).toMatchObject({
      sourceSessionId: source.id,
      stepTitle: file.name,
      stepOffsetMs: 0,
      phase: 'result',
      evidence: [
        expect.objectContaining({
          kind: file.kind,
          projectId,
          sessionId: source.id,
          versionId: file.versionId,
          part: 'record'
        })
      ]
    })
    captured.push(snapshot)
    await expect(editor).toContainText(draft)
    await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toContainText(
      source.messages.at(-1)!.content
    )
    await expect(editor).toBeFocused()
    await expect(page.getByTestId('session-discussion-draft')).toContainText(source.title)
    await expect(page.getByTestId('session-discussion-draft')).not.toContainText('Entire research')
    await expect(
      page.getByText('The recorded evidence is unavailable.', { exact: true })
    ).toHaveCount(0)
    await expect(replay.getByRole('button', { name: 'Play replay', exact: true })).toBeVisible()
    const progress = replay.getByRole('slider', { name: 'Replay progress', exact: true })
    const position = await progress.getAttribute('aria-valuenow')
    const previewTabs = page.locator('[role="tab"][id^="preview-tab-"]')
    const tabCount = await previewTabs.count()
    await page
      .getByTestId('session-discussion-draft')
      .locator('[data-session-discussion-source]')
      .getByRole('button')
      .first()
      .click()
    await expect(replayTab(page, source.id)).toHaveAttribute('aria-selected', 'true')
    await expect(progress).toHaveAttribute('aria-valuenow', position!)
    await expect(previewTabs).toHaveCount(tabCount)
    await expect(editor).toContainText(draft)
  }

  expect(await app.readFakeAgentPrompts()).toEqual(prompts)
  expect(
    await page.evaluate(
      async (projectId) =>
        (await window.api.sessions.loadAll()).sessions
          .filter((session) => session.projectId === projectId)
          .map((session) => session.id),
      projectId
    )
  ).toEqual([source.id])
  expect(
    await page.evaluate((request) => window.api.sessions.loadOne(request), {
      projectId,
      sessionId: source.id
    })
  ).toEqual(before)
  // Selecting a second file adds a separate immutable capture; it does not rewrite the first.
  expect(await snapshots()).toEqual(expect.arrayContaining(captured))
})

test('View replay opens the player from materials or a collapsed pane without changing the draft or playhead', async ({
  app
}) => {
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  const projectName = 'View replay navigation'
  const projectId = await createProject(page, projectName)
  const source = sourceFixture(projectId, 'a')
  page = await app.restartWithSessionFixture(source)
  await page
    .getByRole('region', { name: 'Projects', exact: true })
    .getByRole('button', { name: projectName, exact: true })
    .click()
  await sessionRow(page, source.title).click()

  const header = page.getByTestId('research-workspace-header')
  const viewReplay = header.getByRole('button', { name: 'View replay', exact: true })
  const replay = page.getByTestId('replay-panel')
  const editor = page.getByRole('textbox', { name: 'Ask anything', exact: true })
  const progress = replay.getByRole('slider', { name: 'Replay progress', exact: true })
  const browse = replay.getByRole('button', { name: 'Browse steps', exact: true })
  const directory = page.getByRole('dialog', { name: 'Browse steps', exact: true })
  await expect(replay).toBeVisible()
  await browse.click()
  await directory.getByRole('button', { name: /^Go to step 2:/ }).click()
  const position = await progress.getAttribute('aria-valuenow')
  expect(Number(position)).toBeGreaterThan(0)
  const draft = 'Which evidence supports this recorded conclusion?'
  await editor.fill(draft)
  await expect(page.getByTestId('research-workspace-header')).toContainText(
    'Original record · Read-only'
  )
  await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toContainText(
    source.messages.at(-1)!.content
  )
  const prompts = await app.readFakeAgentPrompts()

  const expectUnchangedPlayer = async (): Promise<void> => {
    await expect(replay).toBeVisible()
    await expect(
      replay.getByRole('tab', { name: 'Original conversation', exact: true })
    ).toHaveAttribute('aria-selected', 'true')
    await expect(progress).toHaveAttribute('aria-valuenow', position!)
    await expect(replay.getByRole('button', { name: 'Play replay', exact: true })).toBeVisible()
    await expect(editor).toContainText(draft)
    await expect(header).toContainText(source.title)
    await expect(header).toContainText('Original record · Read-only')
    await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toContainText(
      'Research A retained its own recorded result.'
    )
    await expect(page.getByTestId('session-discussion-draft')).toContainText('Entire research')
  }

  for (const mode of ['Source files', 'Original records']) {
    await openReplayMaterial(replay, mode)
    const material = page.getByRole('region', { name: mode, exact: true })
    await expect(material).toBeVisible()
    await expect(replay).not.toBeVisible()
    await viewReplay.click()
    await expect(material).not.toBeVisible()
    await expectUnchangedPlayer()
  }

  await browse.click()
  await directory
    .getByRole('button', { name: 'Open original evidence for step 2', exact: true })
    .click()
  const evidence = page.getByRole('region', { name: 'Original recorded evidence', exact: true })
  await expect(evidence).toBeVisible()
  await viewReplay.click()
  await expect(evidence).not.toBeVisible()
  await expectUnchangedPlayer()

  await page.getByRole('button', { name: 'Collapse preview panel', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Expand preview panel', exact: true })
  ).toBeVisible()
  await viewReplay.click()
  await expect(
    page.getByRole('button', { name: 'Collapse preview panel', exact: true })
  ).toBeVisible()
  await expectUnchangedPlayer()
  // A second explicit request must remain idempotent when the player is already visible.
  await viewReplay.click()
  await expectUnchangedPlayer()
  expect(await app.readFakeAgentPrompts()).toEqual(prompts)
  expect(
    await page.evaluate(
      async (projectId) =>
        (await window.api.sessions.loadAll()).sessions
          .filter((session) => session.projectId === projectId)
          .map((session) => session.id),
      projectId
    )
  ).toEqual([source.id])
})

test('replaces the discussion Session without replacing the draft or changing source records', async ({
  app
}, testInfo) => {
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  const projectName = 'Research navigation'
  const projectId = await createProject(page, projectName)
  const sourceA = sourceFixture(projectId, 'a')
  const sourceB = sourceFixture(projectId, 'b')
  const target: PersistedChatSession = {
    ...sourceA,
    id: 'ordinary-target',
    title: 'Existing conversation',
    packageOrigin: undefined,
    messages: [],
    updatedAt: 2
  }
  await app.restartWithSessionFixture(target)
  await app.restartWithSessionFixture(sourceA)
  page = await app.restartWithSessionFixture(sourceB)
  await page
    .getByRole('region', { name: 'Projects', exact: true })
    .getByRole('button', { name: projectName, exact: true })
    .click()
  const editor = page.getByRole('textbox', { name: 'Ask anything', exact: true })
  const replay = page.locator('[data-testid="replay-panel"]:visible')
  await sessionRow(page, target.title).click()
  await editor.fill('Preserve this existing draft. ')
  const originals = await Promise.all(
    [sourceA, sourceB].map((source) =>
      page.evaluate((request) => window.api.sessions.loadOne(request), {
        projectId,
        sessionId: source.id
      })
    )
  )
  const baseline = await app.readFakeAgentPrompts()
  for (const source of [sourceA, sourceB]) {
    await sessionRow(page, source.title).click()
    const header = page.getByTestId('research-workspace-header')
    await expect(header).toContainText(source.title)
    if (source.id === sourceB.id) {
      // Opening another source retains a reference deliberately opened for the previous study.
      await expect(replayTab(page, sourceA.id)).toHaveAttribute('aria-selected', 'true')
      await expect(
        page.locator('[data-testid="replay-information-trigger"]:visible')
      ).toHaveAccessibleName(`Session information: ${sourceA.title}`)
    }
    await header.getByRole('button', { name: 'View replay', exact: true }).click()
    await expect(replay).toBeVisible()
    await expect(replayTab(page, source.id)).toHaveAttribute('aria-selected', 'true')
    await page
      .getByRole('button', { name: `Close preview of ${source.title}`, exact: true })
      .click()
    await sessionRow(page, target.title).click()
    await sessionRow(page, source.title).click()
    await expect(header).toContainText(source.title)
    if (source.id === sourceB.id)
      await expect(replayTab(page, sourceA.id)).toHaveAttribute('aria-selected', 'true')
    await header.getByRole('button', { name: 'View replay', exact: true }).click()
    await expect(replayTab(page, source.id)).toHaveAttribute('aria-selected', 'true')
    await chooseReplayConversation(replay)
    const chooser = page.getByRole('dialog', { name: 'Ask in a conversation' })
    if (source.id === sourceA.id) {
      await expect(chooser.getByRole('combobox')).toBeFocused()
      await expect(chooser.locator('kbd')).toHaveCount(0)
      for (const width of [320, 375, 414, 512]) {
        await chooser.evaluate((node, width) => {
          ;(node as HTMLElement).style.width = `${width}px`
        }, width)
        const heading = chooser.getByRole('heading', { name: 'Ask in a conversation' })
        const description = chooser.getByText('Add to a draft. Send when ready.')
        expect(
          await heading.evaluate((node) => parseFloat(getComputedStyle(node).fontSize))
        ).toBeGreaterThan(
          await description.evaluate((node) => parseFloat(getComputedStyle(node).fontSize))
        )
        expect(await chooser.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
        const footer = await chooser.evaluate((node) => {
          const buttons = Array.from(node.querySelectorAll('button'))
          const cancel = buttons
            .find((button) => button.textContent === 'Cancel')!
            .getBoundingClientRect()
          const create = buttons
            .find((button) => button.textContent === 'New conversation')!
            .getBoundingClientRect()
          return {
            cancelY: cancel.y + cancel.height / 2,
            createY: create.y + create.height / 2,
            belowList:
              create.y > node.querySelector('[role="listbox"]')!.getBoundingClientRect().bottom
          }
        })
        expect(Math.abs(footer.cancelY - footer.createY)).toBeLessThan(1)
        expect(footer.belowList).toBe(true)
        if (width === 375 || width === 512)
          await chooser.screenshot({
            path: testInfo.outputPath(`replay-conversation-dialog-${width}.png`)
          })
      }
    }
    await expect(chooser.getByRole('option').filter({ hasText: sourceA.title })).toHaveCount(0)
    await expect(chooser.getByRole('option').filter({ hasText: sourceB.title })).toHaveCount(0)
    await chooser.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(chooser).not.toBeVisible()
    await chooseReplayConversation(replay)
    await chooser.getByRole('combobox').press('Escape')
    await expect(chooser).not.toBeVisible()
    await chooseReplayConversation(replay)
    await chooser.getByRole('combobox').fill(target.title)
    await chooser.getByRole('option').filter({ hasText: target.title }).click()
    await expect(sessionRow(page, target.title)).toHaveAttribute('aria-current', 'page')
    await expect(editor).toContainText('Preserve this existing draft.')
    await expect(editor).not.toContainText(source.title)
    const stepChip = page.locator('[data-session-discussion-source]').last()
    await expect(stepChip).toContainText(source.title)
    await expect(stepChip.locator('.lucide-messages-square')).toBeVisible()
    await expect(page.locator('[data-session-discussion-source]')).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Question scope', exact: true })).toBeVisible()
    await expect(stepChip).not.toContainText('Question scope')
    const discussion = page.getByTestId('session-discussion-draft')
    for (const width of [240, 320, 480]) {
      await discussion.evaluate((node, width) => {
        ;(node as HTMLElement).style.width = `${width}px`
      }, width)
      const actionBox = await discussion
        .getByRole('button', { name: 'Question scope', exact: true })
        .boundingBox()
      const sourceBox = await stepChip.boundingBox()
      expect(sourceBox!.x).toBeGreaterThan(actionBox!.x + actionBox!.width)
      expect(await discussion.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
      const remove = stepChip.getByRole('button', { name: 'Remove annotation', exact: true })
      await expect(remove).toBeVisible()
      const removeBox = (await remove.boundingBox())!
      const discussionBox = (await discussion.boundingBox())!
      expect(removeBox.x + removeBox.width).toBeLessThanOrEqual(
        discussionBox.x + discussionBox.width + 1
      )
      await remove.click({ trial: true })
      await discussion.screenshot({
        path: testInfo.outputPath(`discuss-source-${source.id}-${width}.png`)
      })
    }
    await discussion.evaluate((node) => {
      ;(node as HTMLElement).style.width = ''
    })
    // The width probes move the controls under the pointer; leave the tooltip's
    // pointer-grace area before testing a fresh hover on the source.
    await editor.focus()
    await page.mouse.move(0, 0)
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    await stepChip.getByRole('button').first().hover()
    const tip = page.locator('[data-session-discussion-tooltip]')
    await expect(tip).toContainText(`View replay · ${source.title}`)
    expect((await tip.boundingBox())!.height).toBeLessThan(72)
    await page.screenshot({ path: testInfo.outputPath(`replay-reference-${source.id}.png`) })
    await editor.hover()
  }
  expect(await app.readFakeAgentPrompts()).toEqual(baseline)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toContainText(
    'Deterministic reply:'
  )
  const saved = await page.evaluate((request) => window.api.sessions.loadOne(request), {
    projectId,
    sessionId: target.id
  })
  const user = saved!.messages.find((message) => message.role === 'user')!
  expect(user.parts?.some((part) => part.type === 'session')).toBe(false)
  expect(user.annotations).toHaveLength(1)
  expect(saved!.researchMembership).toBeUndefined()
  expect(saved!.runtimeContext!.sessionContext!.bindings).toHaveLength(1)
  expect(saved!.runtimeContext!.sessionContext!.bindings[0].sessionId).toBe(sourceB.id)
  expect(
    user.annotations?.every(
      (annotation) =>
        annotation.kind === 'text' &&
        annotation.quote.includes(sourceB.title) &&
        !annotation.quote.includes('readReference')
    )
  ).toBe(true)
  for (const source of [sourceA, sourceB]) {
    const retained = await page.evaluate((request) => window.api.sessions.loadOne(request), {
      projectId,
      sessionId: source.id
    })
    expect(retained?.messages).toEqual(originals.find((row) => row?.id === source.id)?.messages)
    expect(retained?.packageOrigin).toEqual(source.packageOrigin)
  }
  await page.screenshot({
    path: testInfo.outputPath('discussion-session-replaced.png')
  })
})

test('keeps ordinary and two research drafts independent, persists research ownership and restores child navigation', async ({
  app
}, testInfo) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  const projectName = 'Research workspace isolation'
  const projectId = await createProject(page, projectName)
  const sourceA = sourceFixture(projectId, 'a')
  const sourceB = sourceFixture(projectId, 'b')
  page = await app.restartWithSessionFixture(sourceA)
  page = await app.restartWithSessionFixture(sourceB)
  const openProject = async (): Promise<void> => {
    await page
      .getByRole('region', { name: 'Projects', exact: true })
      .getByRole('button', { name: projectName, exact: true })
      .click()
  }
  await openProject()
  const sourceRecords = await Promise.all(
    [sourceA, sourceB].map((source) =>
      page.evaluate((request) => window.api.sessions.loadOne(request), {
        projectId,
        sessionId: source.id
      })
    )
  )
  const editor = (): Locator => page.getByRole('textbox', { name: 'Ask anything', exact: true })
  const header = (): Locator => page.getByTestId('research-workspace-header')
  const research = (source: PersistedChatSession): Locator =>
    page.locator(`[data-research-id="${source.id}"]`)
  const openResearch = async (
    source: PersistedChatSession,
    retainedSource?: PersistedChatSession
  ): Promise<void> => {
    await research(source).locator('[data-slot="session-open-button"]').first().click()
    await expect(header()).toContainText(source.title)
    await expect(header()).toContainText('Original record · Read-only')
    await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toContainText(
      source.messages.at(-1)!.content
    )
    await expect(
      research(source).getByRole('button', { name: 'Original record · Read-only', exact: true })
    ).toHaveCount(0)
    await expect(
      research(source).getByRole('button', { name: 'New discussion', exact: true })
    ).toBeVisible()
    await expect(
      research(source).locator('[data-slot="session-open-button"]').first()
    ).toHaveAttribute('aria-current', 'page')
    if (retainedSource) {
      await expect(replayTab(page, retainedSource.id)).toHaveAttribute('aria-selected', 'true')
      await expect(
        page.locator('[data-testid="replay-information-trigger"]:visible')
      ).toHaveAccessibleName(`Session information: ${retainedSource.title}`)
    }
    // Opening the original transcript does not replace a deliberate viewer selection.
    // Explicitly viewing this source must preserve its inline question draft.
    await header().getByRole('button', { name: 'View replay', exact: true }).click()
    await expect(header()).toContainText(source.title)
    await expect(replayTab(page, source.id)).toHaveAttribute('aria-selected', 'true')
    await expect(
      page.locator('[data-testid="replay-information-trigger"]:visible')
    ).toHaveAccessibleName(`Session information: ${source.title}`)
  }
  const openDiscussion = async (
    source: PersistedChatSession,
    discussion: PersistedChatSession
  ): Promise<void> => {
    const child = research(source).locator(
      `[data-session-id="${discussion.id}"] [data-slot="session-open-button"]`
    )
    await child.click()
    await expect(child).toHaveAttribute('aria-current', 'page')
    await expect(header()).toContainText(source.title)
    await expect(header()).not.toContainText('Original record · Read-only')
  }
  const savedSessions = async (): Promise<PersistedChatSession[]> =>
    page.evaluate(
      async (projectId) =>
        (await window.api.sessions.loadAll()).sessions.filter(
          (session) => session.projectId === projectId
        ),
      projectId
    )
  const freshOrdinary = (): Locator =>
    page
      .getByRole('navigation', { name: 'Sessions', exact: true })
      .getByRole('button', { name: 'New', exact: true })

  await freshOrdinary().click()
  await editor().fill('Ordinary project notes remain here.')
  await openResearch(sourceA)
  await expect(page.getByTestId('session-discussion-draft')).toContainText(sourceA.title)
  await editor().fill('Draft question for study A.')
  await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toContainText(
    'Research A retained its own recorded result.'
  )
  await openResearch(sourceB, sourceA)
  await expect(editor()).toBeEmpty()
  await expect(page.getByTestId('session-discussion-draft')).toContainText(sourceB.title)
  await editor().fill('Draft question for study B.')
  await freshOrdinary().click()
  await expect(header()).toHaveCount(0)
  await expect(editor()).toContainText('Ordinary project notes remain here.')
  await expect(page.getByTestId('session-discussion-draft')).toHaveCount(0)
  expect((await savedSessions()).map((session) => session.id).sort()).toEqual(
    [sourceA.id, sourceB.id].sort()
  )

  await openResearch(sourceA)
  await expect(editor()).toContainText('Draft question for study A.')
  const separator = page.getByRole('separator', { name: 'Resize right panel', exact: true })
  const replay = page.locator('[data-testid="replay-panel"]:visible')
  // Opening a project preview restores its saved size with a short transition. Drag only after
  // the pane has settled, otherwise the restore can legitimately override an in-flight gesture.
  let previousWidth = 0
  let settledSamples = 0
  await expect
    .poll(
      async () => {
        const width = (await replay.boundingBox())!.width
        settledSamples = Math.abs(width - previousWidth) < 0.5 ? settledSamples + 1 : 0
        previousWidth = width
        return settledSamples
      },
      { intervals: [100, 100, 100] }
    )
    .toBeGreaterThanOrEqual(3)
  const beforeWidth = (await replay.boundingBox())!.width
  const handle = (await separator.boundingBox())!
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x + 80, handle.y + handle.height / 2, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => (await replay.boundingBox())!.width).toBeLessThan(beforeWidth - 20)
  await expect(editor()).toContainText('Draft question for study A.')
  await openReplayMaterial(replay, 'Original records')
  const records = page.getByRole('region', { name: 'Original records', exact: true })
  await expect(records).toContainText('Research A retained its own recorded result.')
  await expect(records.getByRole('textbox')).toHaveCount(0)
  await openReplayMaterial(replay, 'Source files')
  await expect(page.getByRole('region', { name: 'Source files', exact: true })).toBeVisible()
  await expect(header()).toContainText(sourceA.title)
  await openReplayMaterial(replay, 'Session process')
  await page.screenshot({ path: testInfo.outputPath('research-workspace-draft-isolation.png') })

  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toContainText(
    'Deterministic reply:'
  )
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0)
  const discussionA = (await savedSessions()).find(
    (session) => session.researchMembership?.sourceSessionId === sourceA.id
  )!
  expect(discussionA.researchMembership).toEqual({
    sourceProjectId: projectId,
    sourceSessionId: sourceA.id,
    sourceImportId: sourceA.packageOrigin!.importId,
    sourceTitle: sourceA.title
  })
  await expect(research(sourceA).locator(`[data-session-id="${discussionA.id}"]`)).toBeVisible()
  await openResearch(sourceB, sourceA)
  await expect(editor()).toContainText('Draft question for study B.')
  await openResearch(sourceA, sourceB)
  await expect(editor()).toBeEmpty()
  await expect(page.getByRole('region', { name: 'Conversation', exact: true })).not.toContainText(
    'Draft question for study A.'
  )
  await openDiscussion(sourceA, discussionA)
  await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toContainText(
    'Draft question for study A.'
  )

  // Sidebar New discussion stays available beside saved children and reuses the unsent
  // source draft. Opening it never creates an empty Session or hides the saved discussion.
  const newDiscussionA = research(sourceA).getByRole('button', {
    name: 'New discussion',
    exact: true
  })
  await newDiscussionA.click()
  await expect(header()).toContainText('Original record · Read-only')
  await expect(editor()).toBeFocused()
  await editor().fill('Unsent question from the sidebar.')
  await newDiscussionA.click()
  await expect(editor()).toBeFocused()
  await expect(editor()).toContainText('Unsent question from the sidebar.')
  expect((await savedSessions()).filter((session) => !session.packageOrigin)).toHaveLength(1)
  await openDiscussion(sourceA, discussionA)
  await newDiscussionA.click()
  await expect(editor()).toContainText('Unsent question from the sidebar.')
  await editor().fill('')
  await openDiscussion(sourceA, discussionA)

  // Watching B from A does not change ownership; Ask explicitly enters B's pending draft.
  await replayTab(page, sourceB.id).click()
  await askReplayStep(page.getByTestId('replay-panel'))
  await expect(header()).toContainText(sourceB.title)
  await expect(editor()).toContainText('Draft question for study B.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toContainText(
    'Deterministic reply:'
  )
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0)
  const discussionB = (await savedSessions()).find(
    (session) => session.researchMembership?.sourceSessionId === sourceB.id
  )!
  expect(discussionB.id).not.toBe(discussionA.id)
  expect((await savedSessions()).filter((session) => !session.packageOrigin)).toHaveLength(2)
  await freshOrdinary().click()
  await expect(editor()).toContainText('Ordinary project notes remain here.')
  await page.screenshot({ path: testInfo.outputPath('research-sidebar-with-discussions.png') })

  page = await app.restart()
  await openProject()
  await openResearch(sourceA)
  await expect(editor()).toBeEmpty()
  await openDiscussion(sourceA, discussionA)
  await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toContainText(
    'Draft question for study A.'
  )
  await openResearch(sourceB, sourceA)
  await expect(editor()).toBeEmpty()
  await openDiscussion(sourceB, discussionB)
  await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toContainText(
    'Draft question for study B.'
  )
  expect((await savedSessions()).filter((session) => !session.packageOrigin)).toHaveLength(2)
  for (const before of sourceRecords) {
    expect(
      await page.evaluate((request) => window.api.sessions.loadOne(request), {
        projectId,
        sessionId: before!.id
      })
    ).toEqual(before)
  }
  await page.screenshot({ path: testInfo.outputPath('research-workspace-restored-membership.png') })
})

test('saved run inspection stays read-only and preserves a research draft without execution controls', async ({
  app
}) => {
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  const projectName = 'Read-only run inspection'
  const projectId = await createProject(page, projectName)
  // No retained run recording or receipt: browsing this imported source must stay
  // read-only and preserve its pending discussion instead of creating execution work.
  const source = sourceFixture(projectId, 'a')
  page = await app.restartWithSessionFixture(source)
  await page
    .getByRole('region', { name: 'Projects', exact: true })
    .getByRole('button', { name: projectName, exact: true })
    .click()
  await sessionRow(page, source.title).click()
  const draft = 'Keep this separate question while inspecting a run.'
  const editor = page.getByRole('textbox', { name: 'Ask anything', exact: true })
  await editor.fill(draft)
  const before = await page.evaluate((request) => window.api.sessions.loadOne(request), {
    projectId,
    sessionId: source.id
  })
  const prompts = await app.readFakeAgentPrompts()
  await expect(
    page.getByTestId('research-workspace-header').getByRole('button', { name: 'Run…', exact: true })
  ).toHaveCount(0)
  const replay = page.getByTestId('replay-panel')
  await openReplayMaterial(replay, 'Run recordings')
  const recordings = page.getByRole('region', { name: 'Run recordings', exact: true })
  await expect(recordings).toBeVisible()
  await expect(recordings).toContainText('Opening a recording does not run the experiment.')
  await expect(recordings).toContainText('No saved run recordings were found.')
  await expect(recordings.getByRole('button', { name: 'Start run', exact: true })).toHaveCount(0)
  await openReplayMaterial(replay, 'Session process')
  await expect(editor).toContainText(draft)
  expect(await app.readFakeAgentPrompts()).toEqual(prompts)
  expect(
    await page.evaluate((request) => window.api.sessions.loadOne(request), {
      projectId,
      sessionId: source.id
    })
  ).toEqual(before)
  expect(
    await page.evaluate(
      async (projectId) =>
        (await window.api.sessions.loadAll()).sessions
          .filter((row) => row.projectId === projectId)
          .map((row) => row.id),
      projectId
    )
  ).toEqual([source.id])
})
