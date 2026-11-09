import { expect } from '@playwright/test'
import type { Locator, Page } from 'playwright'
import type { PersistedChatSession } from '../src/shared/session-persistence'
import type { SessionDiscussionSnapshot } from '../src/shared/session-replay'
import { createProject } from './certification/helpers'
import { test } from './fixtures/electron-app'
import { submitPromptViaUi } from './fixtures/conversation'

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
  await submitPromptViaUi(page, 'Create preview context menu artifacts.')
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
  // Retain the native file/Version storage while restoring an imported, read-only source.
  // Asking opens the project draft and preserves the parked writable conversation.
  const source: PersistedChatSession = {
    ...recorded,
    title: 'Imported recorded file evidence',
    packageOrigin: sourceFixture(projectId, 'a').packageOrigin
  }
  const target: PersistedChatSession = {
    ...sourceFixture(projectId, 'b'),
    id: 'recorded-file-question-target',
    title: 'File question discussion',
    packageOrigin: undefined,
    messages: []
  }
  page = await app.restartWithSessionFixture(source, [], target)
  await page
    .getByRole('region', { name: 'Projects', exact: true })
    .getByRole('button', { name: projectName, exact: true })
    .click()
  await sessionRow(page, source.title).click()
  await page
    .getByRole('region', { name: 'Imported research history', exact: true })
    .getByRole('button', { name: 'View replay', exact: true })
    .click()
  await sessionRow(page, target.title).click()
  const replay = page.getByTestId('replay-panel')
  const editor = page.getByRole('textbox', { name: 'Ask anything', exact: true })
  const draft = 'Which recorded file supports this conclusion?'
  await expect(replay).toBeVisible()
  await editor.fill(draft)
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
    await replay.getByRole('button', { name: 'Ask about this step', exact: true }).click()
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
    if (!captured.length) await editor.fill(draft)
    captured.push(snapshot)
    await expect(editor).toContainText(draft)
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
          .map((session) => session.id)
          .sort(),
      projectId
    )
  ).toEqual([source.id, target.id].sort())
  expect(
    await page.evaluate((request) => window.api.sessions.loadOne(request), {
      projectId,
      sessionId: source.id
    })
  ).toEqual(before)
  // Selecting a second file adds a separate immutable capture; it does not rewrite the first.
  expect(await snapshots()).toEqual(expect.arrayContaining(captured))
})

test('protects the other study’s unsent draft before starting a child discussion', async ({
  app
}, testInfo) => {
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  const projectName = 'Research navigation'
  const projectId = await createProject(page, projectName)
  const sourceA = {
    ...sourceFixture(projectId, 'a'),
    title: 'Navigation research A — comparing long-term results across three study groups'
  }
  const sourceB = sourceFixture(projectId, 'b')
  const target: PersistedChatSession = {
    ...sourceA,
    id: 'ordinary-target',
    title: 'Existing conversation',
    packageOrigin: undefined,
    messages: [],
    updatedAt: 2
  }
  page = await app.restartWithSessionFixture(sourceB, [], sourceA, target)
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
    await expect(replayTab(page, source.id)).toHaveCount(0)
    await page
      .getByRole('region', { name: 'Imported research history', exact: true })
      .getByRole('button', { name: 'View replay', exact: true })
      .click()
    await expect(replay).toBeVisible()
    await replayTab(page, source.id).click()
    await page
      .getByRole('button', { name: `Close preview of ${source.title}`, exact: true })
      .click()
    await sessionRow(page, target.title).click()
    await sessionRow(page, source.title).click()
    await expect(replayTab(page, source.id)).toHaveCount(0)
    await page
      .getByRole('region', { name: 'Imported research history', exact: true })
      .getByRole('button', { name: 'View replay', exact: true })
      .click()
    await replay.getByRole('button', { name: 'Ask about this step', exact: true }).click()
    if (source.id === sourceB.id) {
      await expect(
        page.getByText('Send or clear your current draft before starting a discussion.')
      ).toBeVisible()
      await expect(page.getByTestId('session-discussion-draft')).toContainText(sourceA.title)
      await expect(page.getByText('An unexpected application error occurred')).toHaveCount(0)
      await expect(editor).toContainText('Keep A')
      await page.screenshot({ path: testInfo.outputPath('discussion-draft-conflict.png') })
      const draftSource = page.getByTestId('session-discussion-draft')
      const sourceTab = replayTab(page, sourceA.id)
      const progress = replay.getByRole('slider', { name: 'Replay progress', exact: true })
      await draftSource.getByText(sourceA.title, { exact: true }).click()
      await expect(sourceTab).toHaveAttribute('aria-selected', 'true')
      await expect(sourceTab).toContainText(sourceA.title)
      await expect(progress).toHaveAttribute('aria-valuenow', '0')
      await progress.focus()
      await page.keyboard.press('End')
      await expect(progress).not.toHaveAttribute('aria-valuenow', '0')
      await expect(draftSource).toContainText('Step 1')
      await replayTab(page, sourceB.id).click()
      await draftSource.getByText('Step 1', { exact: true }).click()
      await expect(sourceTab).toHaveAttribute('aria-selected', 'true')
      await expect(progress).toHaveAttribute('aria-valuenow', '0')
      await expect(editor).toContainText('Keep A')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await page.screenshot({ path: testInfo.outputPath('discussion-direct-reveal.png') })
      await replayTab(page, sourceB.id).click()
      await page
        .getByRole('button', { name: 'Cancel discussion and keep draft', exact: true })
        .click()
      await expect(editor).toContainText('Keep A')
      await expect(page.getByTestId('session-discussion-draft')).toHaveCount(0)
      await editor.fill('')
      await replay.getByRole('button', { name: 'Ask about this step', exact: true }).click()
    }
    await expect(editor).toBeEmpty()
    const stepChip = page.locator('[data-session-discussion-source]').last()
    await expect(stepChip).toContainText(source.title)
    await expect(stepChip.locator('.lucide-messages-square')).toBeVisible()
    await expect(page.locator('[data-session-discussion-source]')).toHaveCount(1)
    await expect(stepChip.getByRole('button', { name: /View replay:/ })).toBeVisible()
    await expect(stepChip).not.toContainText('Discuss')
    const discussion = page.getByTestId('session-discussion-draft')
    for (const width of [240, 320, 480]) {
      await discussion.evaluate((node, width) => {
        ;(node as HTMLElement).style.width = `${width}px`
      }, width)
      if (source.id === sourceA.id) {
        const title = stepChip.getByText(source.title, { exact: true })
        await expect(title).toHaveCSS('text-overflow', 'ellipsis')
        expect(await title.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true)
        const step = stepChip.getByText('Step 1', { exact: true })
        expect(await step.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
      }
      const actionBox = await discussion
        .getByRole('button', { name: 'Cancel discussion and keep draft', exact: true })
        .boundingBox()
      const sourceBox = await stepChip.boundingBox()
      expect(actionBox!.x).toBeGreaterThanOrEqual(sourceBox!.x + sourceBox!.width)
      expect(await discussion.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
      await expect(
        stepChip.getByRole('button', { name: 'Remove annotation', exact: true })
      ).toHaveCount(0)
      await discussion.screenshot({
        path: testInfo.outputPath(`discuss-source-${source.id}-${width}.png`)
      })
    }
    await editor.hover()
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
    await expect(tip).toContainText(`View replay: ${source.title}`)
    expect(await tip.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
    await editor.fill(source.id === sourceA.id ? 'Keep A' : 'Explain B')
    await page.screenshot({ path: testInfo.outputPath(`replay-reference-${source.id}.png`) })
    await editor.hover()
  }
  expect(await app.readFakeAgentPrompts()).toEqual(baseline)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toContainText(
    'Deterministic reply:'
  )
  const saved = await page.evaluate(
    async ({ projectId, parent }) =>
      (await window.api.sessions.loadAll()).sessions.find(
        (s) => s.projectId === projectId && s.parentSessionId === parent
      ),
    { projectId, parent: sourceB.id }
  )
  await sessionRow(page, target.title).click()
  await expect(editor).toContainText('Preserve this existing draft.')
  const user = saved!.messages.find((message) => message.role === 'user')!
  expect(user.parts?.some((part) => part.type === 'session')).toBe(false)
  expect(user.annotations).toHaveLength(1)
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

test('keeps the unsent question when its imported source is deleted before the first send', async ({
  app
}) => {
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  const projectName = 'Draft source deletion'
  const projectId = await createProject(page, projectName)
  const source = sourceFixture(projectId, 'a')
  source.id = `import-${source.packageOrigin!.importId}`
  page = await app.restartWithSessionFixture(source, [])
  const openProject = (): Promise<void> =>
    page
      .getByRole('region', { name: 'Projects', exact: true })
      .getByRole('button', { name: projectName, exact: true })
      .click()
  const editor = (): Locator => page.getByRole('textbox', { name: 'Ask anything', exact: true })
  await openProject()
  await sessionRow(page, source.title).click()
  await page
    .getByRole('region', { name: 'Imported research history' })
    .getByRole('button', { name: 'View replay', exact: true })
    .click()
  await page
    .getByTestId('replay-panel')
    .getByRole('button', { name: 'Ask about this step' })
    .click()
  await expect(page.getByTestId('session-discussion-draft')).toContainText(source.title)
  const question = 'Keep this question after deleting its source.'
  await editor().fill(question)
  await page.getByRole('button', { name: `Open actions for ${source.title}` }).click()
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(sessionRow(page, source.title)).toHaveCount(0)
  await expect(page.getByTestId('session-discussion-draft')).toHaveCount(0)
  await expect(editor()).toHaveText(question)
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()

  page = await app.restart()
  await openProject()
  await expect(editor()).toHaveText(question)
  await expect(page.getByTestId('session-discussion-draft')).toHaveCount(0)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toContainText(
    'Deterministic reply:'
  )
  const agentPrompt = (await app.readFakeAgentPrompts()).find(
    ({ prompt }) => prompt.includes(question) && !prompt.includes('Generate Session metadata')
  )
  expect(agentPrompt).toBeDefined()
  expect(agentPrompt!.prompt).not.toContain('Current discussion focus for this turn')
  const saved = await page.evaluate(async (projectId) => {
    const summary = (await window.api.sessions.loadAll()).sessions.find(
      (session) => session.projectId === projectId
    )!
    return window.api.sessions.loadOne({ projectId, sessionId: summary.id })
  }, projectId)
  expect(saved).toBeTruthy()
  expect(saved?.parentSessionId).toBeUndefined()
  expect(saved?.runtimeContext?.sessionContext).toBeUndefined()
})
