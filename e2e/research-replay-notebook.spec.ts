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
    createdAt: 1,
    updatedAt: 3,
    packageOrigin: {
      importId: 'standalone-notebook-import',
      importedAt: 4,
      sourceProjectId: 'foreign-project',
      sourceSessionId: 'foreign-source',
      manifestChecksum: 'c'.repeat(64)
    }
  }
  const run: NotebookRunRecord = {
    runId: 'standalone-run',
    cellId: 'standalone-cell',
    source: 'user',
    kernelKind: 'python',
    script: 'values = [19, 23]\nprint(sum(values))',
    status: 'completed',
    startedAt: 1,
    endedAt: 2,
    text: { stdout: 'ARCHIVED_RESULT_42\n', stderr: '', traceback: '', plain: [] },
    outputs: [],
    artifacts: [],
    workingFiles: []
  }
  page = await app.restartWithSessionFixture(source, [run])
  const open = async (): Promise<void> => {
    await page
      .getByRole('region', { name: 'Projects', exact: true })
      .getByRole('button', { name: projectName, exact: true })
      .click()
    await expect(page.getByTestId('replay-panel')).toBeVisible()
  }
  await open()
  const scope = { projectId, sourceSessionId: source.id }
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
  await page.keyboard.press('PageUp')
  const offset = Number(await slider.inputValue())
  expect(offset).toBeGreaterThan(0)
  expect(offset).toBeLessThan(Number(await slider.getAttribute('max')) * 0.2)
  await expect(replay.locator('[data-replay-notebook-run="standalone-run"]')).toContainText(
    'values = [19, 23]'
  )
  await expect(replay.getByText('ARCHIVED_RESULT_42', { exact: true })).toHaveCount(0)
  const stepId = await replay.locator('[data-replay-active]').getAttribute('data-replay-step')
  const branchId = await page.getByTestId('replay-stage').getAttribute('data-replay-branch')
  await replay.getByRole('button', { name: 'Ask about this step', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Ask anything', exact: true })
  await expect(editor).toContainText('Replay step reference')
  await expect(editor).toContainText('notebook-run: standalone-run [input]')
  await expect(editor).not.toContainText('ARCHIVED_RESULT_42')
  expect(await app.readFakeAgentPrompts()).toEqual(baseline)
  await editor.focus()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText('\nExplain the input of this standalone run.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const conversation = page.getByRole('region', { name: 'Conversation', exact: true })
  await expect(conversation).toContainText('Deterministic reply:')
  await expect.poll(async () => (await app.readFakeAgentPrompts()).length).toBe(baseline.length + 1)
  const linked = await page.evaluate((scope) => window.api.researchWorkspaces.get(scope), scope)
  const user = linked.discussionSession!.messages.find((message) => message.role === 'user')!
  const contextId = /#research-replay:([a-zA-Z0-9-]+)/.exec(user.content)![1]
  const context = await page.evaluate(
    ({ projectId, id }) => window.api.researchWorkspaces.getQuestionContext({ projectId, id }),
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
  expect(user.parts).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: 'session', sessionId: source.id })])
  )
  const prompts = await app.readFakeAgentPrompts()
  expect(prompts.at(-1)!.prompt).toContain('notebook-run: standalone-run [input]')
  expect(prompts.at(-1)!.prompt).not.toContain('ARCHIVED_RESULT_42')
  page = await app.restart()
  await open()
  const restoredReplay = page.getByTestId('replay-panel')
  const restoredSlider = restoredReplay.getByRole('slider', {
    name: 'Replay progress',
    exact: true
  })
  await restoredSlider.focus()
  await page.keyboard.press('End')
  await expect(restoredReplay.getByText('ARCHIVED_RESULT_42', { exact: true })).toBeVisible()
  const restoredConversation = page.getByRole('region', { name: 'Conversation', exact: true })
  const expand = restoredConversation.getByRole('button', { name: 'Show more', exact: true })
  if (await expand.isVisible()) await expand.click()
  await restoredConversation
    .getByRole('button', { name: 'Replay step reference', exact: true })
    .click()
  await expect(restoredSlider).toHaveValue(String(offset))
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
