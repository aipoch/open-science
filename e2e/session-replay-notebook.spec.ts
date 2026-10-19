import { askReplayStep, openReplayFiles } from './helpers/research-replay'
import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'
import { createProject } from './certification/helpers'
import type { PersistedChatSession } from '../src/shared/session-persistence'
import type { NotebookRunRecord } from '../src/shared/notebook'

test.use({ windowMode: 'normal' })

test('asks about a standalone Notebook input and restores its exact step offset from the saved reference', async ({
  app
}, testInfo) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  const projectName = 'Standalone Notebook research'
  const projectId = await createProject(page, projectName)
  const source: PersistedChatSession = {
    id: 'imported-standalone-notebook',
    projectId,
    title: 'Archived standalone Notebook',
    // Native package import deliberately removes the originating machine's workspace path.
    cwd: '',
    status: 'idle',
    messages: [],
    activities: [],
    createdAt: 1000,
    updatedAt: 11000,
    packageOrigin: {
      importId: 'standalone-notebook-import',
      importedAt: 12000,
      sourceProjectId: 'foreign-project',
      sourceSessionId: 'foreign-source',
      manifestChecksum: 'c'.repeat(64)
    }
  }
  const run: NotebookRunRecord = {
    runId: 'standalone-run',
    cellId: 'standalone-cell',
    source: 'user',
    kernelKind: 'r',
    script: 'values <- c(19, 23)\nprint(sum(values))',
    status: 'completed',
    startedAt: 1000,
    endedAt: 11000,
    text: { stdout: 'ARCHIVED_RESULT_42\n', stderr: '', traceback: '', plain: [] },
    outputs: [],
    artifacts: [],
    workingFiles: []
  }
  page = await app.restartWithSessionFixture(source, [run])
  await expect(
    page.evaluate((request) => window.api.notebook.runIndex(request), {
      projectId,
      sessionId: source.id,
      workspaceCwd: source.cwd
    })
  ).resolves.toEqual([expect.objectContaining({ runId: run.runId, kernelKind: 'r' })])
  const open = async (restoreReference = false): Promise<void> => {
    await page
      .getByRole('region', { name: 'Projects', exact: true })
      .getByRole('button', { name: projectName, exact: true })
      .click()
    if (restoreReference) {
      const conversation = page.getByRole('region', { name: 'Conversation', exact: true })
      const showMore = conversation.getByRole('button', { name: 'Show more', exact: true })
      if (await showMore.isVisible()) await showMore.click()
      await conversation
        .getByRole('button', { name: 'Show annotation source', exact: true })
        .click()
    } else {
      await page
        .getByTestId('research-workspace-header')
        .getByRole('button', { name: 'View replay', exact: true })
        .click()
    }
    await expect(page.getByTestId('replay-panel')).toBeVisible()
  }
  await open()
  await page.getByTestId('replay-panel').getByRole('tab', { name: 'Notebook', exact: true }).click()
  await expect
    .poll(() =>
      page
        .locator('[data-replay-notebook-run="standalone-run"] [data-testid="source-code-token"]')
        .count()
    )
    .toBeGreaterThan(0)
  const tokenColors = await page
    .locator('[data-replay-notebook-run="standalone-run"] [data-testid="source-code-token"]')
    .evaluateAll((elements) => [
      ...new Set(elements.map((element) => getComputedStyle(element).color))
    ])
  expect(tokenColors.length).toBeGreaterThan(1)
  await page
    .getByTestId('replay-panel')
    .screenshot({ path: testInfo.outputPath('notebook-r-highlighted.png') })
  const sourceRequest = { projectId, sessionId: source.id, workspaceCwd: source.cwd }
  const before = await page.evaluate(
    (request) => window.api.sessions.loadOne(request),
    sourceRequest
  )
  const notebookBefore = await page.evaluate(
    (request) => window.api.notebook.state(request),
    sourceRequest
  )
  await testInfo.attach('notebook-state.json', {
    body: JSON.stringify(
      { notebookBefore, raw: await app.readNotebookFixtureRuns(projectId, source.id) },
      null,
      2
    ),
    contentType: 'application/json'
  })
  expect(notebookBefore.runs).toHaveLength(1)
  expect(notebookBefore.runs[0].promptMessageId).toBeUndefined()
  expect(notebookBefore.runs[0].executionInvocationId).toBeUndefined()
  const baseline = await app.readFakeAgentPrompts()
  const replay = page.getByTestId('replay-panel')
  const slider = replay.getByRole('slider', { name: 'Replay progress', exact: true })
  await slider.focus()
  await page.keyboard.press('Home')
  const sliderBox = await replay.getByTestId('replay-progress-track').boundingBox()
  await page.mouse.click(
    sliderBox!.x + sliderBox!.width * 0.06,
    sliderBox!.y + sliderBox!.height / 2
  )
  const offset = Number(await slider.getAttribute('aria-valuenow'))
  expect(offset).toBeGreaterThan(0)
  expect(offset).toBeLessThan(Number(await slider.getAttribute('aria-valuemax')) * 0.2)
  await expect(replay.locator('[data-replay-notebook-run="standalone-run"]')).toContainText(
    'values <- c(19, 23)'
  )
  await expect(replay.getByText('ARCHIVED_RESULT_42', { exact: true })).toHaveCount(0)
  const stepId = await replay.locator('[data-replay-active]').getAttribute('data-replay-step')
  const branchId = await page.getByTestId('replay-stage').getAttribute('data-replay-branch')
  await askReplayStep(replay)
  await expect(page.getByRole('dialog', { name: 'Ask in a conversation' })).toHaveCount(0)
  const editor = page.getByRole('textbox', { name: 'Ask anything', exact: true })
  await expect(page.locator('[data-session-discussion-source]')).toContainText(source.title)
  await expect(editor).not.toContainText('#session-replay:')
  await expect(editor).not.toContainText('notebook-run: standalone-run [input]')
  await expect(editor).not.toContainText('ARCHIVED_RESULT_42')
  expect(await app.readFakeAgentPrompts()).toEqual(baseline)
  await editor.focus()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText('\nExplain the input of this standalone run.')
  // Asking freezes the visible input, even if the reader reveals the result before sending.
  await slider.focus()
  await page.keyboard.press('End')
  await replay.getByRole('tab', { name: 'Notebook', exact: true }).click()
  await expect(replay.getByText('ARCHIVED_RESULT_42', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const conversation = page.getByRole('region', { name: 'Conversation', exact: true })
  await expect(conversation).toContainText('Deterministic reply:')
  await testInfo.attach('fake-prompts.json', {
    body: JSON.stringify(await app.readFakeAgentPrompts(), null, 2),
    contentType: 'application/json'
  })
  // New ordinary conversations also generate metadata through a separate provider request.
  const conversationPrompts = async (): ReturnType<typeof app.readFakeAgentPrompts> =>
    (await app.readFakeAgentPrompts()).filter(
      (entry) =>
        !entry.prompt.includes('Generate Session metadata only from the following JSON data:')
    )
  await expect.poll(async () => (await conversationPrompts()).length).toBe(baseline.length + 1)
  const target = await page.evaluate(
    async (projectId) =>
      (await window.api.sessions.loadAll()).sessions.find(
        (row) => row.projectId === projectId && !row.packageOrigin
      ),
    projectId
  )
  const user = target!.messages.find((message) => message.role === 'user')!
  expect(user.content).not.toContain('#session-replay:')
  const contextId = target!.runtimeContext!.sessionContext!.bindings[0].contextId
  const context = await page.evaluate(
    ({ projectId, id }) => window.api.sessionReplay.getSelectionSnapshot({ projectId, id }),
    { projectId, id: contextId }
  )
  expect(context).toMatchObject({
    stepId,
    branchId,
    stepOffsetMs: offset,
    evidence: [{ kind: 'notebook-run', id: run.runId, part: 'input' }]
  })
  expect(
    context!.evidence.some(
      (reference) => reference.kind === 'message' || reference.kind === 'activity'
    )
  ).toBe(false)
  expect(user.parts?.some((part) => part.type === 'session')).toBe(false)
  const prompts = await app.readFakeAgentPrompts()
  expect((await conversationPrompts()).at(-1)!.prompt).not.toContain('print(sum(values))')
  expect((await conversationPrompts()).at(-1)!.prompt).toContain('host.sessions.read()')
  expect((await conversationPrompts()).at(-1)!.prompt).not.toContain('readReference')
  expect((await conversationPrompts()).at(-1)!.prompt).not.toContain('#session-replay:')
  expect(
    context?.records
      ?.filter((record) => record.scope === 'step')
      .map((record) => record.text)
      .join('\n')
  ).toContain(run.script)
  expect((await conversationPrompts()).at(-1)!.prompt).not.toContain('ARCHIVED_RESULT_42')
  page = await app.restart()
  await open(true)
  await page
    .getByRole('region', { name: 'Conversation', exact: true })
    .getByRole('button', { name: 'Show annotation source', exact: true })
    .click()
  const restoredReplay = page.getByTestId('replay-panel')
  const restoredSlider = restoredReplay.getByRole('slider', {
    name: 'Replay progress',
    exact: true
  })
  await restoredSlider.focus()
  await page.keyboard.press('End')
  await restoredReplay.getByRole('tab', { name: 'Notebook', exact: true }).click()
  await expect(restoredReplay.getByText('ARCHIVED_RESULT_42', { exact: true })).toBeVisible()
  const restoredConversation = page.getByRole('region', { name: 'Conversation', exact: true })
  const expand = restoredConversation.getByRole('button', { name: 'Show more', exact: true })
  if (await expand.isVisible()) await expand.click()
  await restoredConversation
    .getByRole('button', { name: 'Show annotation source', exact: true })
    .click()
  await expect(restoredSlider).toHaveAttribute('aria-valuenow', String(offset))
  await expect(restoredReplay.locator('[data-replay-active]')).toHaveAttribute(
    'data-replay-step',
    stepId!
  )
  await expect(page.getByTestId('replay-stage')).toHaveAttribute('data-replay-branch', branchId!)
  await expect(restoredReplay.getByText('ARCHIVED_RESULT_42', { exact: true })).toHaveCount(0)
  await expect(
    restoredReplay.getByRole('button', { name: 'Play replay', exact: true })
  ).toBeVisible()
  expect(await app.readFakeAgentPrompts()).toEqual(prompts)
  expect(
    await page.evaluate((request) => window.api.sessions.loadOne(request), sourceRequest)
  ).toEqual(before)
  expect(
    (await page.evaluate((request) => window.api.notebook.state(request), sourceRequest)).runs
  ).toEqual(notebookBefore.runs)
  await page.screenshot({ path: testInfo.outputPath('standalone-notebook-restored-reference.png') })
})

test('renders archived research with shared workspace messages, grouped tools and inline figures', async ({
  app
}, testInfo) => {
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  const projectName = 'Archived tool presentation'
  const projectId = await createProject(page, projectName)
  const receipt = JSON.stringify({
    artifact: {
      artifact_id: 'archived-artifact-id',
      version_id: 'archived-version-id',
      filename: 'sin_plot_r.png',
      size_bytes: 50544
    }
  })
  const source: PersistedChatSession = {
    id: 'imported-tool-presentation',
    projectId,
    title: 'Archived plot',
    cwd: '',
    status: 'idle',
    messages: [
      {
        id: 'plot-request',
        role: 'user',
        content: 'Save the R plot.',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      }
    ],
    createdAt: 1,
    updatedAt: 3,
    activities: [
      {
        id: 'saved-artifact-tool',
        promptMessageId: 'plot-request',
        activityGroupId: 'saved-tools',
        kind: 'tool',
        title: 'Write file',
        status: 'completed',
        providerToolName: 'mcp__open-science-artifacts__write_artifact_file',
        sortIndex: 1,
        eventIds: [],
        createdAt: 2,
        updatedAt: 3,
        rawInput: { filename: 'sin_plot_r.png' },
        rawOutput: [{ type: 'text', text: receipt }],
        toolContent: [{ type: 'content', content: { type: 'text', text: receipt } }]
      }
    ],
    activityGroups: [
      {
        id: 'saved-tools',
        title: 'Saved a file, completed a Notebook run',
        sortIndex: 1,
        activityIds: ['saved-notebook-tool', 'saved-artifact-tool'],
        promptMessageId: 'plot-request',
        createdAt: 2,
        updatedAt: 4
      }
    ],
    packageOrigin: {
      importId: 'tool-presentation-import',
      importedAt: 4,
      sourceProjectId: 'foreign-project',
      sourceSessionId: 'foreign-source',
      manifestChecksum: 'd'.repeat(64)
    }
  }
  source.activities!.push({
    ...source.activities![0],
    id: 'saved-notebook-tool',
    sortIndex: 2,
    title: 'Notebook run',
    providerToolName: 'mcp__open-science-notebook__notebook_execute',
    rawInput: { code: 'print(sin(pi))', kernelKind: 'r' },
    executionInvocationId: 'plot-invocation',
    rawOutput: { runId: 'plot-run', status: 'completed', kernelKind: 'r' },
    toolContent: [],
    createdAt: 3,
    updatedAt: 4
  })
  source.activities![0].sortIndex = 2
  source.activities![1].sortIndex = 1
  source.activities![1].createdAt = 2
  source.activities![0].createdAt = 3
  source.messages.push({
    id: 'plot-response',
    role: 'agent',
    content:
      'Saved the R plot of **y = sin(x)** on [0, 2π].\n\nThe figure and recorded code are available for review.',
    status: 'complete',
    responseToMessageId: 'plot-request',
    eventIds: [],
    createdAt: 5,
    updatedAt: 5
  })
  const points = Array.from(
    { length: 101 },
    (_, index) => `${40 + index * 3.2},${110 - Math.sin((index / 100) * Math.PI * 2) * 70}`
  ).join(' ')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="230" viewBox="0 0 400 230"><rect width="400" height="230" fill="white"/><text x="140" y="18" font-size="13">y = sin(x), x ∈ [0, 2π]</text><path d="M40 30V190H370M40 110H370" fill="none" stroke="#aaa"/><polyline points="${points}" fill="none" stroke="#287fba" stroke-width="2"/><text x="185" y="216" font-size="12">x (rad)</text></svg>`
  const run: NotebookRunRecord = {
    runId: 'plot-run',
    cellId: 'plot-cell',
    source: 'agent',
    kernelKind: 'r',
    script: 'x <- seq(0, 2 * pi, length.out = 101)\nplot(x, sin(x), type = "l")',
    status: 'completed',
    startedAt: 3,
    endedAt: 4,
    executionInvocationId: 'plot-invocation',
    promptMessageId: 'plot-request',
    text: { stdout: 'Plot saved.\nDone.\n', stderr: '', traceback: '', plain: [] },
    outputs: [{ type: 'display', data: { 'image/svg+xml': Buffer.from(svg).toString('base64') } }],
    artifacts: [],
    workingFiles: []
  }
  const recordedEpoch = Date.UTC(2026, 8, 23, 6, 42)
  for (const record of [...source.messages, ...source.activities!, ...source.activityGroups!]) {
    record.createdAt = recordedEpoch + record.createdAt * 1000
    record.updatedAt = recordedEpoch + record.updatedAt * 1000
  }
  run.startedAt = recordedEpoch + 2000
  run.endedAt = recordedEpoch + 4000
  page = await app.restartWithSessionFixture(source, [run])
  await page
    .getByRole('region', { name: 'Projects', exact: true })
    .getByRole('button', { name: projectName, exact: true })
    .click()
  const replay = page.getByTestId('replay-panel')
  await page
    .getByTestId('research-workspace-header')
    .getByRole('button', { name: 'View replay', exact: true })
    .click()
  await expect(replay).toBeVisible()
  await replay.getByRole('slider', { name: 'Replay progress', exact: true }).focus()
  await page.keyboard.press('End')
  const record = replay.locator('[data-replay-activity="saved-artifact-tool"]')
  await expect(record.getByTestId('tool-chip')).toContainText('sin_plot_r.png')
  await expect(record).not.toContainText('archived-artifact-id')
  const group = replay.getByTestId('tool-group')
  await expect(group).toBeVisible()
  await expect(group.getByTestId('tool-group-header')).toContainText('2 steps')
  const figure = group.locator('img').first()
  await expect(figure).toBeVisible()
  await expect
    .poll(() => figure.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0)
  await expect(replay.locator('[data-slot="user-message-bubble"]')).toContainText(
    'Save the R plot.'
  )
  await expect(replay).toContainText('The figure and recorded code are available for review.')
  await expect(group).not.toContainText('Original recorded evidence')
  await group.getByTestId('tool-group-header').click()
  await expect(figure).not.toBeVisible()
  await group.getByTestId('tool-group-header').click()
  await expect(figure).toBeVisible()
  await page.setViewportSize({ width: 1280, height: 960 })
  await replay.getByRole('button', { name: 'Expand preview', exact: true }).click()
  const conversationPane = replay.getByRole('region', { name: 'Historical conversation' })
  const notebookPane = replay.getByRole('region', { name: 'Notebook', exact: true })
  const filesPane = replay.getByRole('complementary', { name: 'Files' })
  await expect(conversationPane).toBeVisible()
  await expect(notebookPane).toBeVisible()
  await expect(
    replay.getByRole('separator', {
      name: 'Resize Original conversation and Notebook',
      exact: true
    })
  ).toBeVisible()
  await expect(filesPane).not.toBeVisible()
  await replay.evaluate(async (element) => {
    const animations: Animation[] = []
    for (let node: Element | null = element; node; node = node.parentElement)
      animations.push(...node.getAnimations())
    await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)))
  })
  const conversationBox = (await conversationPane.boundingBox())!
  await replay.getByRole('tab', { name: 'Notebook', exact: true }).click()
  await expect(conversationPane).toBeVisible()
  await expect(notebookPane).toBeVisible()
  const notebookBox = (await notebookPane.boundingBox())!
  expect(notebookBox.x).toBeGreaterThanOrEqual(conversationBox.x + conversationBox.width)
  await openReplayFiles(replay)
  await expect(filesPane).toBeVisible()
  const filesBox = (await filesPane.boundingBox())!
  const expandedBox = (await replay.boundingBox())!
  expect(filesBox.x).toBeGreaterThanOrEqual(expandedBox.x)
  expect(filesBox.x + filesBox.width).toBeLessThanOrEqual(expandedBox.x + expandedBox.width)
  await expect(conversationPane).toBeVisible()
  await expect(notebookPane).toBeVisible()
  await replay.screenshot({
    path: testInfo.outputPath('replay-expanded-notebook-files-inspector.png')
  })
  await replay.getByRole('button', { name: 'Close files', exact: true }).click()
  await expect(notebookPane).toBeVisible()
  await expect(conversationPane).toBeVisible()
  await replay.getByRole('button', { name: 'Collapse preview', exact: true }).click()
  await replay.evaluate((element) => {
    element.style.width = '1000px'
  })
  await replay.getByRole('button', { name: 'Expand preview', exact: true }).click()
  await expect(replay).toHaveAttribute('data-replay-layout-mode', 'split')
  await expect(notebookPane).toBeVisible()
  await expect(
    replay.getByRole('separator', {
      name: 'Resize Original conversation and Notebook',
      exact: true
    })
  ).toBeVisible()
  await expect(filesPane).not.toBeVisible()
  // Expanded replay owns independent panes; collapse before exercising narrow single-tab layout.
  await replay.getByRole('button', { name: 'Collapse preview', exact: true }).click()
  await replay.getByRole('tab', { name: 'Original conversation', exact: true }).click()
  const expectCompleteGroup = async (): Promise<void> => {
    await expect
      .poll(() =>
        group.evaluate((element) => {
          const row = element.querySelector('[data-replay-activity="saved-artifact-tool"]')!
          return row.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom
        })
      )
      .toBeLessThanOrEqual(0)
  }
  for (const width of [320, 375, 414, 768]) {
    await replay.evaluate((element, width) => {
      element.style.width = `${width}px`
    }, width)
    const conversation = replay.getByRole('region', { name: 'Historical conversation' })
    const results = replay.getByRole('region', { name: 'Notebook', exact: true })
    await expect(conversation).toBeVisible()
    await expect(results).not.toBeVisible()
    await replay.getByRole('tab', { name: 'Notebook', exact: true }).click()
    await expect(conversation).not.toBeVisible()
    await expect(results).toBeVisible()
    await replay.getByRole('tab', { name: 'Original conversation', exact: true }).click()
    const rows = replay.locator('[data-replay-activity]')
    await expect(rows).toHaveCount(2)
    const overflow = await rows.evaluateAll((elements) =>
      elements.map((element) => element.scrollWidth - element.clientWidth)
    )
    for (const value of overflow) expect(value).toBeLessThanOrEqual(1)
    const bubble = replay.locator('[data-slot="user-message-bubble"]')
    expect(
      await bubble.evaluate((element) => {
        const parent = element.parentElement!.getBoundingClientRect()
        return Math.abs(parent.right - element.getBoundingClientRect().right)
      })
    ).toBeLessThanOrEqual(1)
    await expect(replay).not.toContainText('Recorded status: completed')
    await expectCompleteGroup()
    await replay.screenshot({
      path: testInfo.outputPath(`replay-workspace-transcript-${width}.png`)
    })
  }
  await page.setViewportSize({ width: 1280, height: 1050 })
  await replay.evaluate((element) => {
    element.style.width = '1024px'
  })
  await expectCompleteGroup()
  await replay.screenshot({
    path: testInfo.outputPath('replay-workspace-transcript-reference.png')
  })
  await replay.evaluate((element) => {
    element.style.removeProperty('width')
  })
  await record.getByTestId('tool-chip').click()
  await expect(record.getByTestId('tool-summary-card')).toContainText('49 KB')
  await expect(record).not.toContainText('archived-version-id')
  await replay.getByRole('slider', { name: 'Replay progress', exact: true }).focus()
  await page.keyboard.press('Home')
  await expect(replay.getByTestId('tool-group')).toHaveCount(0)
  const saved = await page.evaluate((request) => window.api.sessions.loadOne(request), {
    projectId,
    sessionId: source.id
  })
  expect(saved?.activities?.[0].rawOutput).toEqual(source.activities?.[0].rawOutput)
})
