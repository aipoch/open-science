import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import sharp from 'sharp'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { expect } from '@playwright/test'
import type { Page } from 'playwright'
import { test, type ElectronApp } from './fixtures/electron-app'
import { createProject, openProjectSession } from './certification/helpers'
import { submitPromptViaUi } from './fixtures/conversation'
import { openSettingsPage } from './fixtures/settings-preferences'
import type { PersistedChatSession } from '../src/shared/session-persistence'
import type { SideChatSnapshot } from '../src/shared/side-chat'

const liveSettings = process.env.OPEN_SCIENCE_E2E_LIVE_SETTINGS
const liveModel = process.env.OPEN_SCIENCE_E2E_LIVE_MODEL
const statsPaiCommand = process.env.OPEN_SCIENCE_E2E_STATSPAI_COMMAND
// JSON { baseUrl, key, model, apiEndpoints } for a second real provider on a different API.
const switchProvider = process.env.OPEN_SCIENCE_E2E_LIVE_SWITCH_PROVIDER
const projectName = 'Pi live harness'
const initialPrompt =
  // Explicit dynamic execution is reviewed in Ask mode; plain analysis would not prompt.
  'Use the Notebook REPL tool repl_execute to execute exactly eval("console.log(\'PI_REPL_OK\')"). Do not use any other tool. After successful execution, reply exactly PI_TURN_OK.'

const selectPi = async (page: Page, app?: ElectronApp): Promise<void> => {
  const runtime = process.env.OPEN_SCIENCE_E2E_PI_RUNTIME
  if (runtime && app) {
    const root = dirname(await app.createTestDirectory('pi-runtime-seed'))
    await cp(runtime, join(root, 'storage/pi-managed'), { recursive: true, errorOnExist: true })
  }
  const settings = await openSettingsPage(page, 'Agent')
  if (runtime && app) {
    await settings.getByRole('button', { name: 'Re-detect', exact: true }).click()
    await expect(settings.getByRole('button', { name: 'Re-detect', exact: true })).toBeEnabled({
      timeout: 60_000
    })
  }
  const pi = settings.getByRole('radio', { name: 'Use Pi', exact: true })
  const install = settings.getByRole('button', { name: 'Install Pi', exact: true })
  await expect(pi.or(install)).toBeVisible({ timeout: 60_000 })
  if (await install.isVisible()) {
    await expect(settings.getByRole('button', { name: 'Re-detect', exact: true })).toBeEnabled()
    await page.evaluate(() => window.api.settings.getPreflight())
    console.log('PI_HARNESS installing managed runtime')
    await install.click()
    await page
      .getByRole('menuitem', { name: 'App-managed download (recommended)', exact: true })
      .click()
  }
  await expect(pi).toBeVisible({ timeout: 360_000 })
  console.log('PI_HARNESS selecting Pi')
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

test('Pi sees Notebook images, image uploads and PDF attachments on a visual model', async ({
  app
}, testInfo) => {
  test.skip(
    !liveSettings || !liveModel,
    'Requires OPEN_SCIENCE_E2E_LIVE_SETTINGS and OPEN_SCIENCE_E2E_LIVE_MODEL with a real visual provider.'
  )
  test.setTimeout(720_000)
  const image = async (marker: string): Promise<Buffer> =>
    sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="240"><rect width="960" height="240" fill="white"/><text x="40" y="150" font-family="sans-serif" font-size="64" fill="black">${marker}</text></svg>`
      )
    )
      .png()
      .toBuffer()
  const notebookMarker = `VISION-${randomUUID().slice(0, 8).toUpperCase()}`
  const uploadMarker = `UPLOAD-${randomUUID().slice(0, 8).toUpperCase()}`
  const pdfMarker = `PDF-${randomUUID().slice(0, 8).toUpperCase()}`
  await app.completeOnboarding()
  let page = await app.configureLiveAgent(liveSettings!, liveModel!)
  await page.evaluate(() => window.api.settings.setDefaultPermissionProfile({ profile: 'ask' }))
  await selectPi(page, app)
  const projectId = await createProject(page, 'Pi visual evidence')
  const session = async (): Promise<PersistedChatSession | undefined> =>
    (await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions)).find(
      (candidate) => candidate.projectId === projectId
    )
  const turn = async (prompt: string): Promise<void> => {
    const before =
      (await session())?.messages.filter((message) => message.role === 'agent').length ?? 0
    await submitPromptViaUi(page, prompt)
    await expect
      .poll(
        async () => {
          const current = await session()
          return (
            current?.status === 'idle' &&
            current.messages.filter((message) => message.role === 'agent').length > before
          )
        },
        { timeout: 150_000 }
      )
      .toBe(true)
  }
  console.log('PI_VISUAL workspace')
  await turn(
    'Use repl_execute to run exactly console.log("PI_IMAGE_WORKSPACE_READY"). Then reply READY.'
  )
  const current = await session()
  expect(current?.agentFrameworkId).toBe('pi')
  const initialRuns = await app.readNotebookFixtureRuns(projectId, current!.id)
  const workspace = initialRuns.find((run) =>
    run.script.includes('PI_IMAGE_WORKSPACE_READY')
  )!.cwdBefore
  expect(workspace).toEqual(expect.any(String))
  await writeFile(join(workspace!, 'visual-probe.png'), await image(notebookMarker))
  console.log('PI_VISUAL host.viewImage')
  await turn(
    'Use repl_execute to run exactly await host.viewImage({ path: "visual-probe.png" }). ' +
      'Then read the code printed inside the returned image and reply only with that code. ' +
      'Do not open the file with any other tool. If the tool fails, report the error and stop; do not retry.'
  )
  const imageRuns = (await app.readNotebookFixtureRuns(projectId, current!.id)).filter((run) =>
    run.script.includes('host.viewImage(')
  )
  expect(imageRuns).toHaveLength(1)
  expect(imageRuns[0].status, JSON.stringify(imageRuns[0].text)).toBe('completed')
  await expect(page.getByText(notebookMarker, { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('pi-notebook-vision.png'), fullPage: true })
  console.log('PI_VISUAL upload')
  await page.locator('input[type="file"][multiple]').setInputFiles({
    name: 'image-probe.png',
    mimeType: 'image/png',
    buffer: await image(uploadMarker)
  })
  await turn(
    'Read the code printed inside the attached image. Reply only with that code. Do not call tools.'
  )
  await expect(page.getByText(uploadMarker, { exact: true })).toBeVisible()
  console.log('PI_VISUAL PDF')
  const pdf = await PDFDocument.create()
  const pdfPage = pdf.addPage([600, 300])
  pdfPage.drawText(pdfMarker, {
    x: 40,
    y: 180,
    size: 32,
    font: await pdf.embedFont(StandardFonts.Helvetica)
  })
  await page.locator('input[type="file"][multiple]').setInputFiles({
    name: 'document-probe.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save())
  })
  await turn('Read the code in the attached PDF. Reply only with that code.')
  await expect(page.getByText(pdfMarker, { exact: true })).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath('pi-image-pdf-attachments.png'),
    fullPage: true
  })
  console.log('PI_VISUAL restart')
  page = await app.restart()
  await openProjectSession(
    page,
    'Pi visual evidence',
    'Use repl_execute to run exactly console.log'
  )
  await turn(
    'What was the code in the uploaded image (not the Notebook image or PDF)? Reply only with that code. Do not call tools.'
  )
  await expect(page.getByText(uploadMarker, { exact: true })).toHaveCount(2)
  await testInfo.attach('pi-visual-evidence', {
    body: JSON.stringify(
      {
        model: liveModel,
        notebookMarker,
        uploadMarker,
        pdfMarker,
        imageRuns: imageRuns.map((run) => ({ status: run.status, script: run.script }))
      },
      null,
      2
    ),
    contentType: 'application/json'
  })
})

test('Pi Side chat changes model with context and is discarded on an in-flight restart', async ({
  app
}, testInfo) => {
  test.skip(
    !liveSettings || !liveModel || !switchProvider,
    'Requires live settings and OPEN_SCIENCE_E2E_LIVE_SWITCH_PROVIDER with a second available model.'
  )
  test.setTimeout(720_000)
  const second = JSON.parse(switchProvider!) as {
    baseUrl: string
    key: string
    model: string
    apiEndpoints: ['chat-completions' | 'responses' | 'messages']
  }
  expect(second.model).not.toBe(liveModel)
  await app.completeOnboarding()
  let page = await app.configureLiveAgent(liveSettings!, liveModel!)
  await page.evaluate(async (provider) => {
    const snapshot = await window.api.settings.upsertProvider({
      type: 'custom',
      name: 'Pi Side chat switch target',
      supportsImageInput: true,
      ...provider
    })
    if (!snapshot.providers.some((item) => item.name === 'Pi Side chat switch target'))
      throw new Error('The second visual provider was not registered.')
  }, second)
  await selectPi(page, app)
  const projectId = await createProject(page, 'Pi Side chat model and restart')
  const mainMarker = `MAIN-${randomUUID().slice(0, 8)}`
  const sideMarker = `SIDE-${randomUUID().slice(0, 8)}`
  await submitPromptViaUi(page, `Remember ${mainMarker}. Reply only READY. Do not call tools.`)
  await expect(page.getByText('READY', { exact: true })).toBeVisible({ timeout: 120_000 })
  await expect(page.getByRole('button', { name: 'Cancel run', exact: true })).toHaveCount(0)
  const parent = (
    await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions)
  ).find((candidate) => candidate.projectId === projectId)!
  await page.getByTestId('branch-send-menu-trigger').click()
  await page.getByTestId('menu-side-chat').click()
  await page
    .getByPlaceholder('Follow up…')
    .fill(`Remember ${sideMarker}. Reply only SIDE_READY. Do not call tools.`)
  await page.getByRole('button', { name: 'Send Side chat follow up', exact: true }).click()
  await expect(page.getByText('SIDE_READY', { exact: true })).toBeVisible({ timeout: 120_000 })
  const loadChat = async (): Promise<SideChatSnapshot | undefined> =>
    (await page.evaluate(() => window.api.sideChat.list())).chats.find(
      (chat) => chat.parentSessionId === parent.id
    )
  await expect.poll(async () => (await loadChat())?.running).toBe(false)
  const side = await loadChat()
  expect(side?.sideSessionId).toBeTruthy()
  console.log('PI_SIDE model change')
  const sidePanel = page.getByRole('tabpanel', { name: 'Side chat', exact: true })
  await sidePanel.getByRole('button', { name: 'Select model', exact: true }).click()
  await page.getByRole('menuitem', { name: /^Model/ }).hover()
  await page.getByRole('menuitemradio', { name: second.model, exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(sidePanel.getByRole('button', { name: 'Select model', exact: true })).toHaveText(
    second.model
  )
  await sidePanel
    .getByPlaceholder('Follow up…')
    .fill('What is the SIDE marker from this chat? Reply only with that marker. Do not call tools.')
  await sidePanel.getByRole('button', { name: 'Send Side chat follow up', exact: true }).click()
  await expect
    .poll(
      async () => {
        const chat = await loadChat()
        return (
          !chat?.running &&
          chat?.entries.some(
            (entry) =>
              entry.kind === 'message' &&
              entry.role === 'assistant' &&
              entry.text.trim() === sideMarker
          )
        )
      },
      { timeout: 120_000 }
    )
    .toBe(true)
  expect((await loadChat())?.modelSelection?.model).toBe(second.model)
  const root = dirname(await app.createTestDirectory('side-chat-evidence'))
  const nativeRoot = join(root, 'storage/runtime-support/side-chat', side!.sideSessionId!)
  const models = new Set<string>()
  for (const name of await readdir(nativeRoot, { recursive: true })) {
    if (!name.endsWith('.jsonl')) continue
    for (const line of (await readFile(join(nativeRoot, name), 'utf8')).trim().split('\n')) {
      const entry = JSON.parse(line)
      if (entry.message?.role === 'assistant' && typeof entry.message.model === 'string')
        models.add(entry.message.model)
    }
  }
  expect([...models].some((model) => model.includes(`${liveModel}@`))).toBe(true)
  expect([...models].some((model) => model.includes(`${second.model}@`))).toBe(true)
  await page.screenshot({
    path: testInfo.outputPath('pi-side-chat-model-change.png'),
    fullPage: true
  })
  const startStreamingSideTurn = async (): Promise<void> => {
    const entriesBeforePrompt = (await loadChat())!.entries.length
    await sidePanel
      .getByPlaceholder('Follow up…')
      .fill('Write a detailed 5000-word essay about statistical inference. Do not call tools.')
    await sidePanel.getByRole('button', { name: 'Send Side chat follow up', exact: true }).click()
    await expect.poll(async () => (await loadChat())?.running).toBe(true)
    await expect
      .poll(
        async () =>
          (await loadChat())?.entries
            .slice(entriesBeforePrompt)
            .some(
              (entry) =>
                entry.kind === 'message' && entry.role === 'assistant' && entry.text.length > 0
            ),
        { timeout: 120_000 }
      )
      .toBe(true)
    await expect(
      sidePanel.getByRole('button', { name: 'Cancel Side chat response', exact: true })
    ).toBeVisible()
  }
  console.log('PI_SIDE active-turn model selection')
  await startStreamingSideTurn()
  await sidePanel.getByRole('button', { name: 'Select model', exact: true }).click()
  await page.getByRole('menuitem', { name: /^Model/ }).hover()
  await page.getByRole('menuitemradio', { name: liveModel!, exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(sidePanel.getByRole('button', { name: 'Select model', exact: true })).toHaveText(
    liveModel!
  )
  expect((await loadChat())?.modelSelection?.model).toBe(second.model)
  expect((await loadChat())?.running).toBe(true)
  await page.screenshot({
    path: testInfo.outputPath('pi-side-chat-active-model-selection.png'),
    fullPage: true
  })
  await sidePanel.getByRole('button', { name: 'Cancel Side chat response', exact: true }).click()
  await expect.poll(async () => (await loadChat())?.running).toBe(false)
  await sidePanel
    .getByPlaceholder('Follow up…')
    .fill('What is the SIDE marker from this chat? Reply only with that marker. Do not call tools.')
  await sidePanel.getByRole('button', { name: 'Send Side chat follow up', exact: true }).click()
  await expect(sidePanel.getByText(sideMarker, { exact: true })).toHaveCount(2, {
    timeout: 120_000
  })
  await expect.poll(async () => (await loadChat())?.running).toBe(false)
  expect((await loadChat())?.modelSelection?.model).toBe(liveModel)
  console.log('PI_SIDE in-flight restart')
  await startStreamingSideTurn()
  const restarting = app.restart()
  const confirmQuit = page.getByRole('button', { name: 'Quit', exact: true })
  await expect(confirmQuit).toBeVisible({ timeout: 5_000 })
  await confirmQuit.click()
  page = await restarting
  expect((await page.evaluate(() => window.api.sideChat.list())).chats).toEqual([])
  await expect
    .poll(() => readdir(join(root, 'storage/runtime-support/side-chat')))
    .not.toContain(side!.sideSessionId)
  await openProjectSession(page, 'Pi Side chat model and restart', `Remember ${mainMarker}`)
  await expect(page.getByPlaceholder('Follow up…')).toHaveCount(0)
  await submitPromptViaUi(page, 'What is the MAIN marker? Reply only with it. Do not call tools.')
  await expect(page.getByText(mainMarker, { exact: true })).toBeVisible({ timeout: 120_000 })
  const recovered = (
    await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions)
  ).find((candidate) => candidate.id === parent.id)!
  expect(
    recovered.messages.some(
      (message) => message.role === 'agent' && message.content.includes(sideMarker)
    )
  ).toBe(false)
  await testInfo.attach('pi-side-chat-evidence', {
    body: JSON.stringify(
      {
        models: [...models],
        modelSwitchRetainedSideContext: true,
        activeTurnModelSelection: { currentTurn: second.model, nextTurn: liveModel },
        restartDuringPrompt: 'discarded',
        mainHistoryPreserved: true
      },
      null,
      2
    ),
    contentType: 'application/json'
  })
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
