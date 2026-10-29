import { mkdir, writeFile } from 'node:fs/promises'
import { expect } from '@playwright/test'
import type { Page } from 'playwright'
import { test } from './fixtures/electron-app'
import { createProject, openProjectSession } from './certification/helpers'
import { submitPromptViaUi } from './fixtures/conversation'
import { openSettingsPage } from './fixtures/settings-preferences'

const liveSettings = process.env.OPEN_SCIENCE_E2E_LIVE_SETTINGS
const liveModel = process.env.OPEN_SCIENCE_E2E_LIVE_MODEL
const statsPaiCommand = process.env.OPEN_SCIENCE_E2E_STATSPAI_COMMAND
// JSON { baseUrl, key, model, apiEndpoints } for a second real provider on a different API.
const switchProvider = process.env.OPEN_SCIENCE_E2E_LIVE_SWITCH_PROVIDER
const projectName = 'Pi live harness'
const initialPrompt =
  // Explicit dynamic execution is reviewed in Ask mode; plain analysis would not prompt.
  'Use the Notebook REPL tool repl_execute to execute exactly eval("console.log(\'PI_REPL_OK\')"). Do not use any other tool. After successful execution, reply exactly PI_TURN_OK.'

const selectPi = async (page: Page): Promise<void> => {
  const settings = await openSettingsPage(page, 'Agent')
  const pi = settings.getByRole('radio', { name: 'Use Pi', exact: true })
  const install = settings.getByRole('button', { name: 'Install Pi', exact: true })
  if (await install.isVisible()) {
    await install.click()
    await page
      .getByRole('menuitem', { name: 'App-managed download (recommended)', exact: true })
      .click()
  }
  await expect(pi).toBeVisible({ timeout: 180_000 })
  await pi.click()
  const confirmation = page.getByRole('alertdialog', { name: 'Switch to Pi?', exact: true })
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole('button', { name: 'Switch', exact: true }).click()
  await expect(confirmation).toHaveCount(0)
  await expect(pi).toHaveAttribute('aria-checked', 'true')
  await settings.getByRole('button', { name: 'Close settings' }).click()
}

test('Pi executes an approved MCP tool and resumes the provider session after restart', async ({
  app
}, testInfo) => {
  test.skip(
    !liveSettings || !liveModel,
    'Requires OPEN_SCIENCE_E2E_LIVE_SETTINGS and OPEN_SCIENCE_E2E_LIVE_MODEL with a real Chat Completions provider.'
  )
  test.setTimeout(300_000)
  await app.completeOnboarding()
  let page = await app.configureLiveAgent(
    liveSettings!,
    liveModel!,
    process.env.OPEN_SCIENCE_E2E_LIVE_PROFILE
  )
  await page.evaluate(() => window.api.settings.setDefaultPermissionProfile({ profile: 'ask' }))
  await selectPi(page)
  const projectId = await createProject(page, projectName)

  await submitPromptViaUi(page, initialPrompt)
  const permission = page.getByTestId('permission-card')
  await expect(permission).toBeVisible({ timeout: 120_000 })
  await testInfo.attach('pi-permission-request', {
    body: await permission.innerText(),
    contentType: 'text/plain'
  })
  await permission.getByTestId('allow-primary').click()
  await expect(permission).toHaveCount(0)
  await expect(page.getByText('PI_TURN_OK', { exact: true })).toBeVisible({ timeout: 120_000 })

  const sessionsBefore = await page.evaluate(
    async () => (await window.api.sessions.loadAll()).sessions
  )
  const before = sessionsBefore.find((session) => session.projectId === projectId)
  expect(before).toMatchObject({ agentFrameworkId: 'pi' })
  expect(before?.providerSessionId).toEqual(expect.any(String))
  expect(before?.agentModel).toContain(liveModel!)
  const runsBefore = await app.readNotebookFixtureRuns(projectId, before!.id)
  const replRuns = runsBefore.filter(
    (run) => run.kernelKind === 'repl' && run.script.includes('PI_REPL_OK')
  )
  expect(replRuns).toHaveLength(1)
  expect(replRuns[0].status).toBe('completed')
  expect(replRuns[0].text.stdout).toContain('PI_REPL_OK')
  await page.screenshot({ path: testInfo.outputPath('pi-approved-turn.png'), fullPage: true })

  page = await app.restart()
  await openProjectSession(page, projectName, initialPrompt)
  await expect(page.getByText('PI_TURN_OK', { exact: true })).toBeVisible()
  const resumedPrompt = 'Reply exactly PI_RESUMED_OK and do not call any tools.'
  await submitPromptViaUi(page, resumedPrompt)
  await expect(page.getByText('PI_RESUMED_OK', { exact: true })).toBeVisible({
    timeout: 120_000
  })

  const sessionsAfter = await page.evaluate(
    async () => (await window.api.sessions.loadAll()).sessions
  )
  const after = sessionsAfter.find((session) => session.id === before!.id)
  expect(after).toMatchObject({
    id: before!.id,
    agentFrameworkId: 'pi',
    providerSessionId: before!.providerSessionId
  })
  const runsAfter = await app.readNotebookFixtureRuns(projectId, before!.id)
  expect(
    runsAfter.filter((run) => run.kernelKind === 'repl' && run.script.includes('PI_REPL_OK'))
  ).toHaveLength(1)
  await page.screenshot({ path: testInfo.outputPath('pi-resumed-turn.png'), fullPage: true })
  await testInfo.attach('pi-live-evidence', {
    body: JSON.stringify(
      {
        framework: after?.agentFrameworkId,
        model: after?.agentModel,
        providerSessionPreserved: after?.providerSessionId === before?.providerSessionId,
        replRuns: replRuns.map((run) => ({
          status: run.status,
          stdout: run.text.stdout,
          script: run.script
        }))
      },
      null,
      2
    ),
    contentType: 'application/json'
  })
})

// Fixed-effect panel with a known slope of 2; the alternating noise keeps the fit non-degenerate.
const statsPaiPanel = (): string => {
  const rows = ['unit,year,x,y']
  for (let unit = 0; unit < 6; unit += 1) {
    for (let year = 0; year < 8; year += 1) {
      const x = unit + year
      const noise = (unit + year) % 2 === 0 ? 0.1 : -0.1
      rows.push(`${unit},${year},${x},${(2 * x + unit + noise).toFixed(2)}`)
    }
  }
  return `${rows.join('\n')}\n`
}

test('Pi runs a StatsPAI Connector estimate through the Notebook host', async ({
  app
}, testInfo) => {
  test.skip(
    !liveSettings || !liveModel || !statsPaiCommand,
    'Requires OPEN_SCIENCE_E2E_LIVE_SETTINGS, OPEN_SCIENCE_E2E_LIVE_MODEL, and OPEN_SCIENCE_E2E_STATSPAI_COMMAND.'
  )
  test.setTimeout(300_000)
  const dataRoot = testInfo.outputPath('statspai-data')
  const dataPath = `${dataRoot}/panel.csv`
  await mkdir(dataRoot, { recursive: true })
  await writeFile(dataPath, statsPaiPanel())

  await app.completeOnboarding()
  const page = await app.configureLiveAgent(
    liveSettings!,
    liveModel!,
    process.env.OPEN_SCIENCE_E2E_LIVE_PROFILE
  )
  await page.evaluate(() => window.api.settings.setDefaultPermissionProfile({ profile: 'ask' }))
  await page.evaluate(
    async ({ command, root }) => {
      await window.api.settings.addCustomServer({
        name: 'statspai',
        displayName: 'StatsPAI',
        transport: 'stdio',
        command,
        args: ['--data-root', root]
      })
    },
    { command: statsPaiCommand!, root: dataRoot }
  )
  // A user starts the conversation after the Connector check settles; its Skill reload rotates the
  // idle Agent connection.
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const server = (await window.api.settings.listConnectors()).customServers.find(
            (candidate) => candidate.name === 'statspai'
          )
          return server && !server.checking ? (server.availability ?? 'ready') : 'checking'
        }),
      { timeout: 60_000 }
    )
    .toBe('ready')
  await selectPi(page)
  const projectId = await createProject(page, 'Pi StatsPAI')

  const code = `const response = await host.mcp('statspai', 'feols', { data_path: ${JSON.stringify(dataPath)}, fml: 'y ~ x | unit', vcov: 'iid' }); const result = response.structuredContent ?? response; console.log('STATSPAI_COEF=' + result.coefficients.x.estimate.toFixed(3))`
  await submitPromptViaUi(
    page,
    `Use the Notebook REPL tool repl_execute to execute exactly this JavaScript, without changes:\n${code}\nDo not use any other tool. After it succeeds, reply exactly PI_STATSPAI_OK.`
  )
  // Custom Connectors run under the default allow policy; per-tool Ask exists only for bundled ones.
  await expect(page.getByText('PI_STATSPAI_OK', { exact: true })).toBeVisible({
    timeout: 120_000
  })

  const session = (
    await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions)
  ).find((candidate) => candidate.projectId === projectId)
  expect(session).toMatchObject({ agentFrameworkId: 'pi' })
  const runs = (await app.readNotebookFixtureRuns(projectId, session!.id)).filter(
    (run) => run.kernelKind === 'repl' && run.script.includes("host.mcp('statspai', 'feols'")
  )
  expect(runs).toHaveLength(1)
  expect(runs[0].status).toBe('completed')
  const coefficient = Number(runs[0].text.stdout.match(/STATSPAI_COEF=(-?[\d.]+)/)?.[1])
  expect(coefficient).toBeCloseTo(2, 1)
  await page.screenshot({ path: testInfo.outputPath('pi-statspai-turn.png'), fullPage: true })
  await testInfo.attach('pi-statspai-evidence', {
    body: JSON.stringify(
      { coefficient, stdout: runs[0].text.stdout, script: runs[0].script },
      null,
      2
    ),
    contentType: 'application/json'
  })
})

test('Pi switches to a model on another API and keeps the conversation', async ({
  app
}, testInfo) => {
  test.skip(
    !liveSettings || !liveModel || !switchProvider,
    'Requires OPEN_SCIENCE_E2E_LIVE_SETTINGS, OPEN_SCIENCE_E2E_LIVE_MODEL, and OPEN_SCIENCE_E2E_LIVE_SWITCH_PROVIDER.'
  )
  test.setTimeout(300_000)
  const second = JSON.parse(switchProvider!) as {
    baseUrl: string
    key: string
    model: string
    apiEndpoints: ['chat-completions' | 'responses' | 'messages']
  }
  await app.completeOnboarding()
  const page = await app.configureLiveAgent(
    liveSettings!,
    liveModel!,
    process.env.OPEN_SCIENCE_E2E_LIVE_PROFILE
  )
  await page.evaluate(
    (provider) =>
      window.api.settings.upsertProvider({
        type: 'custom',
        name: 'Pi switch target',
        supportsImageInput: true,
        ...provider
      }),
    second
  )
  await selectPi(page)
  const projectId = await createProject(page, 'Pi model switch')

  await submitPromptViaUi(page, 'Reply exactly PI_FIRST_OK and do not call any tools.')
  await expect(page.getByText('PI_FIRST_OK', { exact: true })).toBeVisible({ timeout: 120_000 })
  const loadSession = async (): Promise<
    { agentModel?: string; agentFrameworkId?: string } | undefined
  > =>
    (await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions)).find(
      (session) => session.projectId === projectId
    )
  const before = await loadSession()
  expect(before?.agentModel).toContain(liveModel!)

  await page.getByRole('button', { name: 'Select model', exact: true }).click()
  await page.getByRole('menuitem', { name: /^Model/ }).hover()
  await page.getByRole('menuitemradio', { name: second.model, exact: true }).focus()
  await page.keyboard.press('Enter')
  // Another provider is another backend: the app opens a fresh Pi session and replays history.
  await submitPromptViaUi(
    page,
    'Repeat exactly the text of your previous reply and do not call any tools.'
  )
  await expect(page.getByText('PI_FIRST_OK', { exact: true })).toHaveCount(2, { timeout: 120_000 })

  const after = await loadSession()
  expect(after).toMatchObject({ agentFrameworkId: 'pi' })
  expect(after?.agentModel).toContain(second.model)
  await page.screenshot({ path: testInfo.outputPath('pi-model-switch.png'), fullPage: true })
})

test('Pi delegates a task to a Pi Subagent and receives its result', async ({ app }, testInfo) => {
  test.skip(
    !liveSettings || !liveModel,
    'Requires OPEN_SCIENCE_E2E_LIVE_SETTINGS and OPEN_SCIENCE_E2E_LIVE_MODEL with a real provider.'
  )
  test.setTimeout(300_000)
  await app.completeOnboarding()
  const page = await app.configureLiveAgent(
    liveSettings!,
    liveModel!,
    process.env.OPEN_SCIENCE_E2E_LIVE_PROFILE
  )
  await page.evaluate(() => window.api.settings.setDefaultPermissionProfile({ profile: 'ask' }))
  await selectPi(page)
  const projectId = await createProject(page, 'Pi delegation')

  // The child's own reviewed REPL call must reach the same human approval surface.
  const childTask =
    'Use the Notebook REPL tool repl_execute to execute exactly eval("console.log(\'PI_CHILD_TOOL_OK\')"). Then reply exactly PI_CHILD_OK.'
  const code = `return await host.delegate({ task: ${JSON.stringify(childTask)}, name: 'Pi child' }, { wait: true })`
  await submitPromptViaUi(
    page,
    `Use the Notebook REPL tool repl_execute to execute exactly this JavaScript, without changes:\n${code}\nDo not use any other tool. After it returns, reply exactly PI_PARENT_OK.`
  )
  const reply = page.getByText('PI_PARENT_OK', { exact: true })
  const permission = page.getByTestId('permission-card')
  // Approve whatever the default profile asks for until the parent turn finishes.
  await expect(async () => {
    if (await permission.isVisible()) await permission.getByTestId('allow-primary').click()
    await expect(reply).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 240_000 })

  const session = (
    await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions)
  ).find((candidate) => candidate.projectId === projectId)
  expect(session).toMatchObject({ agentFrameworkId: 'pi' })
  const runs = (await app.readNotebookFixtureRuns(projectId, session!.id)).filter(
    (run) => run.kernelKind === 'repl' && run.script.includes('host.delegate(')
  )
  expect(runs).toHaveLength(1)
  expect(runs[0].status).toBe('completed')
  // Only the run result counts as evidence; the script itself also names the child's token.
  const output = JSON.stringify({ outputs: runs[0].outputs, text: runs[0].text })
  expect(output).toContain('PI_CHILD_OK')
  const records = (
    session as unknown as {
      runtimeContext?: {
        delegatedWork?: { records: Array<{ attempts: Array<{ status: string }> }> }
      }
    }
  ).runtimeContext?.delegatedWork?.records
  expect(records?.[0]?.attempts.at(-1)?.status).toBe('completed')
  const childRuns = (await app.readNotebookFixtureRuns(projectId, session!.id)).filter(
    (run) =>
      run.kernelKind === 'repl' &&
      run.script.includes('PI_CHILD_TOOL_OK') &&
      !run.script.includes('host.delegate(')
  )
  expect(childRuns.map((run) => run.text.stdout)).toEqual([
    expect.stringContaining('PI_CHILD_TOOL_OK')
  ])
  await page.screenshot({ path: testInfo.outputPath('pi-delegation.png'), fullPage: true })
  await testInfo.attach('pi-delegation-run', { body: output, contentType: 'application/json' })
})

test('Pi stops a running turn and accepts the next prompt', async ({ app }) => {
  test.skip(
    !liveSettings || !liveModel,
    'Requires OPEN_SCIENCE_E2E_LIVE_SETTINGS and OPEN_SCIENCE_E2E_LIVE_MODEL with a real provider.'
  )
  test.setTimeout(300_000)
  await app.completeOnboarding()
  const page = await app.configureLiveAgent(
    liveSettings!,
    liveModel!,
    process.env.OPEN_SCIENCE_E2E_LIVE_PROFILE
  )
  await selectPi(page)
  await createProject(page, 'Pi stop')

  await submitPromptViaUi(
    page,
    'Write a detailed 3000-word essay on the history of econometrics. Do not call any tools.'
  )
  const cancel = page.getByRole('button', { name: 'Cancel run', exact: true })
  await expect(cancel).toBeVisible({ timeout: 60_000 })
  // Let Pi dispatch the model request so Stop cancels a live provider call.
  await page.waitForTimeout(5_000)
  await cancel.click()
  await expect(cancel).toHaveCount(0, { timeout: 60_000 })
  await expect
    .poll(
      async () =>
        (await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions)).map(
          (session) => session.status
        ),
      { timeout: 60_000 }
    )
    .toEqual(['idle'])

  await submitPromptViaUi(page, 'Reply exactly PI_AFTER_STOP_OK and do not call any tools.')
  await expect(page.getByText('PI_AFTER_STOP_OK', { exact: true })).toBeVisible({
    timeout: 120_000
  })
})
