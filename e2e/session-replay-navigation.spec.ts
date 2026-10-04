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
  // Retain the native file/Version storage while restoring an imported, read-only source.
  // A separate writable conversation receives its snapshots through the existing chooser.
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
  await app.restartWithSessionFixture(target)
  page = await app.restartWithSessionFixture(source)
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
    const chooser = page.getByRole('dialog', { name: 'Ask in a conversation', exact: true })
    await chooser.getByRole('combobox').fill(target.title)
    await chooser.getByRole('option').filter({ hasText: target.title }).click()
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
    await replay.getByRole('button', { name: 'Ask about this step', exact: true }).click()
    await chooser.getByRole('combobox').press('Escape')
    await expect(chooser).not.toBeVisible()
    await replay.getByRole('button', { name: 'Ask about this step', exact: true }).click()
    await chooser.getByRole('combobox').fill(target.title)
    await chooser.getByRole('option').filter({ hasText: target.title }).click()
    await expect(sessionRow(page, target.title)).toHaveAttribute('aria-current', 'page')
    await expect(editor).toContainText('Preserve this existing draft.')
    await expect(editor).not.toContainText(source.title)
    const stepChip = page.locator('[data-session-discussion-source]').last()
    await expect(stepChip).toContainText(source.title)
    await expect(stepChip.locator('.lucide-messages-square')).toBeVisible()
    await expect(page.locator('[data-session-discussion-source]')).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Discuss', exact: true })).toBeVisible()
    await expect(stepChip).not.toContainText('Discuss')
    const discussion = page.getByTestId('session-discussion-draft')
    for (const width of [240, 320, 480]) {
      await discussion.evaluate((node, width) => {
        ;(node as HTMLElement).style.width = `${width}px`
      }, width)
      const actionBox = await discussion
        .getByRole('button', { name: 'Discuss', exact: true })
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
