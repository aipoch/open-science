import { expect } from '@playwright/test'
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication } from 'playwright'
import { x as extract } from 'tar'
import { test } from './fixtures/electron-app'
import { createProjectViaUi } from './fixtures/project'
import { submitPromptViaUi } from './fixtures/conversation'

// Real native IPC + bundled worker; only the operating-system save picker is substituted.
test.use({ windowMode: 'hidden' })

test('exports selected diagnostics without changing the persisted session', async ({
  app
}, testInfo) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await createProjectViaUi(page, 'Diagnostic research')
  const prompt = 'Summarize the deterministic fixture.'
  await submitPromptViaUi(page, prompt)
  await expect(page.getByText(`Deterministic reply: ${prompt}`, { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0)
  const identity = await page.evaluate(async () => {
    const { sessions } = await window.api.sessions.list()
    const session = sessions.find((item) => item.title === 'Summarize the deterministic fixture.')
    if (!session) throw new Error('Diagnostic fixture session was not persisted')
    return { projectId: session.projectId, sessionId: session.id }
  })
  const application = (app as unknown as { application: ElectronApplication }).application
  const configRoot = await application.evaluate(() => process.env.OPEN_SCIENCE_CONFIG_ROOT!)
  const sourcePath = join(configRoot, 'sessions', identity.projectId, `${identity.sessionId}.json`)
  // The reply can finish before its background title/description attempt is persisted.
  await expect
    .poll(async () => {
      const saved = JSON.parse(await readFile(sourcePath, 'utf8'))
      return saved.session.sessionDetailsGeneration?.status
    })
    .toMatch(/^(succeeded|failed|disabled|superseded)$/)
  const original = await readFile(sourcePath, 'utf8')
  const secret = 'diagnostic-e2e-credential-do-not-export'
  const evidence = JSON.stringify({
    ...JSON.parse(original),
    diagnosticFixture: { apiKey: secret }
  })
  await writeFile(sourcePath, evidence)
  const logsRoot = await application.evaluate(() => {
    const root = process.env.OPEN_SCIENCE_CONFIG_ROOT ?? process.env.OPEN_SCIENCE_STORAGE_ROOT
    if (!root) throw new Error('Isolated backend config root is unavailable.')
    return process.getBuiltinModule('node:path').join(root, 'logs')
  })
  await mkdir(logsRoot, { recursive: true })
  await writeFile(
    join(logsRoot, 'main.1.log'),
    JSON.stringify({ level: 'error', msg: 'private backup evidence' }) + '\n'
  )
  const archivePath = testInfo.outputPath('session-diagnostics.tar.gz')
  await mkdir(testInfo.outputPath(), { recursive: true })
  // The harness keeps its ElectronApplication private to normal user journeys. This regression
  // needs one native-dialog substitution and leaves production APIs and worker creation intact.
  await application.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
  }, archivePath)
  const diagnosticButton = page
    .getByTestId('conversation-header')
    .getByRole('button', { name: 'Export diagnostics…', exact: true })
  await expect(diagnosticButton).toBeVisible()
  await diagnosticButton.click()
  const dialog = page.getByRole('dialog', { name: 'Export diagnostics', exact: true })
  const sessionCheckbox = dialog.getByRole('checkbox', { name: 'Session state', exact: true })
  await expect(sessionCheckbox).toBeEnabled()
  await expect(sessionCheckbox).toBeChecked()
  await dialog.getByRole('heading', { name: 'Export diagnostics', exact: true }).click()
  await testInfo.attach('diagnostics-dialog', {
    body: await page.screenshot({ path: testInfo.outputPath('diagnostics-dialog.png') }),
    contentType: 'image/png'
  })
  await dialog.getByRole('button', { name: 'More information', exact: true }).hover()
  await expect(page.getByRole('tooltip')).toContainText(
    'Individual file failures do not stop the export'
  )
  await testInfo.attach('diagnostics-help', {
    body: await page.screenshot({ path: testInfo.outputPath('diagnostics-help.png') }),
    contentType: 'image/png'
  })
  await dialog.getByRole('heading', { name: 'Export diagnostics', exact: true }).click()
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await dialog.locator('button[aria-label="Close"]').hover()
  await expect(page.getByRole('tooltip')).toHaveText('Close')
  await testInfo.attach('diagnostics-close-tooltip', {
    body: await page.screenshot({ path: testInfo.outputPath('diagnostics-close-tooltip.png') }),
    contentType: 'image/png'
  })
  await dialog.getByRole('heading', { name: 'Export diagnostics', exact: true }).click()
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await expect(dialog.getByRole('checkbox', { name: 'Current log', exact: true })).toBeChecked()
  await expect(
    dialog.getByRole('checkbox', { name: 'Historical log 1', exact: true })
  ).toBeEnabled()
  await expect(
    dialog.getByRole('checkbox', { name: 'Historical log 1', exact: true })
  ).not.toBeChecked()
  const checkboxes = dialog.getByRole('checkbox')
  for (const checkbox of await checkboxes.all()) {
    if ((await checkbox.isEnabled()) && (await checkbox.isChecked())) await checkbox.uncheck()
  }
  await sessionCheckbox.check()
  await dialog.getByRole('button', { name: 'Export', exact: true }).click()
  await expect(
    dialog.getByText(/^Diagnostic package (exported successfully|partially exported)/)
  ).toBeVisible({
    timeout: 45_000
  })
  await expect(dialog.locator('pre')).toHaveCount(0)
  await expect(dialog.getByRole('status')).toBeInViewport({ ratio: 1 })
  await expect(dialog.getByRole('button', { name: 'Show in folder', exact: true })).toBeInViewport({
    ratio: 1
  })
  await page.screenshot({ path: testInfo.outputPath('diagnostics-export-result.png') })
  expect(await readFile(sourcePath, 'utf8')).toBe(evidence)
  const extracted = testInfo.outputPath('unpacked')
  await mkdir(extracted)
  await extract({ file: archivePath, cwd: extracted })
  const files = await readdir(extracted)
  expect(files).toEqual(
    expect.arrayContaining(['session.json', 'manifest.json', 'export.log', 'README.txt'])
  )
  expect(files).not.toContain('db')
  expect(files).not.toContain('logs')
  const contents = await Promise.all(files.map((file) => readFile(join(extracted, file), 'utf8')))
  expect(contents.join('\n')).not.toContain(secret)
  const projected = JSON.parse(await readFile(join(extracted, 'session.json'), 'utf8'))
  expect(projected.format).toBe('diagnostic-session-projection')
  expect(projected.diagnosticFixture).toBeUndefined()
  expect(contents.join('\n')).not.toContain(prompt)
  await dialog.locator('button[aria-label="Close"]').click()
  await expect(page.getByRole('textbox', { name: 'Ask anything' })).toBeEnabled()

  // Real desktop export of persisted evidence fixtures: default log selection remains unchanged.
  const dataRoot = await page.evaluate(async () => (await window.api.storage.getInfo()).dataRoot)
  const notebookRoot = join(dataRoot, 'notebooks', identity.projectId, identity.sessionId)
  await mkdir(join(notebookRoot, 'frames', 'diagnostic-frame'), { recursive: true })
  const runDocument = JSON.stringify({
    ...identity,
    version: 1,
    runs: [
      {
        runId: 'diagnostic-run',
        status: 'error',
        script:
          '# research-code-do-not-export\nprint(1 / 2)\npath = "/private/e2e/input.txt"\napi_key = "' +
          secret +
          '"',
        text: {
          stdout: 'research-output-do-not-export',
          stderr: 'execution evidence; api_key=' + secret
        }
      }
    ]
  })
  await writeFile(join(notebookRoot, 'run.json'), runDocument)
  await writeFile(join(notebookRoot, 'frames', 'diagnostic-frame', 'run.json'), runDocument)
  await appendFile(
    join(logsRoot, 'main.log'),
    JSON.stringify({
      t: new Date().toISOString(),
      level: 'error',
      scope: 'unregistered-e2e-component',
      msg: 'evidence export boundary failed',
      data: {
        ...identity,
        operation: 'unregistered-e2e-operation',
        error: {
          message: 'temporary evidence failure; api_key=' + secret
        },
        payload: 'research-payload-do-not-export'
      }
    }) + '\n'
  )
  const evidenceArchive = testInfo.outputPath('evidence-diagnostics.tar.gz')
  await application.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
  }, evidenceArchive)
  await diagnosticButton.click()
  await expect(dialog.getByRole('checkbox', { name: 'Current log', exact: true })).toBeChecked()
  await expect(
    dialog.getByRole('checkbox', { name: 'Historical log 1', exact: true })
  ).not.toBeChecked()
  const executionCheckbox = dialog.getByRole('checkbox', { name: 'Execution records', exact: true })
  const includeCode = dialog.getByRole('checkbox', { name: 'Include execution code', exact: true })
  await expect(includeCode).not.toBeChecked()
  await expect(executionCheckbox).toBeEnabled()
  await expect(executionCheckbox).toBeChecked()
  await expect(executionCheckbox).toContainText('2 available, 0 unavailable')
  const executionFiles = executionCheckbox.locator('..').locator('details')
  await executionFiles.locator('summary').click()
  await expect(executionFiles).toContainText('notebook/run.json')
  await expect(executionFiles).toContainText('notebook/frames/diagnostic-frame/run.json')
  await expect(dialog.getByText(/Review for sensitive content before sharing/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Export', exact: true }).click()
  await expect(
    dialog.getByText(/^Diagnostic package (exported successfully|partially exported)/)
  ).toBeVisible({
    timeout: 45_000
  })
  const evidenceDirectory = testInfo.outputPath('evidence-unpacked')
  await mkdir(evidenceDirectory)
  await extract({ file: evidenceArchive, cwd: evidenceDirectory })
  const evidenceLog = await readFile(join(evidenceDirectory, 'logs/main.log'), 'utf8')
  expect(evidenceLog).toContain('unregistered-e2e-component')
  expect(evidenceLog).toContain('temporary evidence failure')
  expect(await readdir(join(evidenceDirectory, 'logs'))).not.toContain('main.1.log')
  const notebookEvidence = await readFile(join(evidenceDirectory, 'notebook/run.json'), 'utf8')
  expect(notebookEvidence).toContain('execution evidence')
  const frameEvidence = await readFile(
    join(evidenceDirectory, 'notebook/frames/diagnostic-frame/run.json'),
    'utf8'
  )
  expect(frameEvidence).toContain('diagnostic-run')
  for (const excluded of [
    secret,
    '/private/e2e',
    'research-code-do-not-export',
    'research-output-do-not-export',
    'research-payload-do-not-export'
  ]) {
    expect(evidenceLog + notebookEvidence + frameEvidence).not.toContain(excluded)
  }
  expect(await readFile(join(notebookRoot, 'run.json'), 'utf8')).toBe(runDocument)
  expect(await readFile(sourcePath, 'utf8')).toBe(evidence)
  expect(JSON.parse(notebookEvidence).runs[0].script).toBeUndefined()
  // Explicit opt-in preserves the existing script in its owning root/frame run, without stdout.
  const codeArchive = testInfo.outputPath('code-diagnostics.tar.gz')
  await application.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
  }, codeArchive)
  await includeCode.check()
  await dialog.getByRole('button', { name: 'Export', exact: true }).click()
  await expect(
    dialog.getByText(/^Diagnostic package (exported successfully|partially exported)/)
  ).toBeVisible({
    timeout: 45_000
  })
  const codeDirectory = testInfo.outputPath('code-unpacked')
  await mkdir(codeDirectory)
  await extract({ file: codeArchive, cwd: codeDirectory })
  for (const path of ['notebook/run.json', 'notebook/frames/diagnostic-frame/run.json']) {
    const document = JSON.parse(await readFile(join(codeDirectory, path), 'utf8'))
    expect(document.runs[0].script).toContain('print(1 / 2)')
    expect(document.runs[0].script).toContain('/private/e2e/input.txt')
    expect(document.runs[0].script).not.toContain(secret)
    expect(JSON.stringify(document)).not.toContain('research-output-do-not-export')
  }
  const codeManifest = JSON.parse(await readFile(join(codeDirectory, 'manifest.json'), 'utf8'))
  expect(codeManifest.includeExecutionCode).toBe(true)
  expect(await readFile(join(notebookRoot, 'run.json'), 'utf8')).toBe(runDocument)
  await dialog.locator('button[aria-label="Close"]').click()

  // A damaged source yields safe metadata without retaining raw private text or triggering recovery.
  const malformed = '{"credentials":["' + secret + '"],"broken":'
  await writeFile(sourcePath, malformed)
  const partialPath = testInfo.outputPath('partial-diagnostics.tar.gz')
  await application.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
  }, partialPath)
  await page.getByRole('button', { name: `Open actions for ${prompt}` }).click()
  await page.getByRole('menuitem', { name: 'Export', exact: true }).hover()
  await page.getByRole('menuitem', { name: 'Export diagnostics…', exact: true }).click()
  await expect(includeCode).not.toBeChecked()
  await expect(sessionCheckbox).toBeEnabled()
  for (const checkbox of await dialog.getByRole('checkbox').all()) {
    if ((await checkbox.isEnabled()) && (await checkbox.isChecked())) await checkbox.uncheck()
  }
  await sessionCheckbox.check()
  await dialog.getByRole('button', { name: 'Export', exact: true }).click()
  await expect(
    dialog.getByText('Some selected material could not be included in full.', { exact: true })
  ).toBeVisible({ timeout: 45_000 })
  expect(await readFile(sourcePath, 'utf8')).toBe(malformed)
  const partialDirectory = testInfo.outputPath('partial-unpacked')
  await mkdir(partialDirectory)
  await extract({ file: partialPath, cwd: partialDirectory })
  expect(
    await readFile(join(partialDirectory, 'session.json.metadata.json'), 'utf8')
  ).not.toContain(secret)
  expect(await readFile(join(partialDirectory, 'export.log'), 'utf8')).toContain('invalid-json')
  await dialog.locator('button[aria-label="Close"]').click()
  await expect(page.getByRole('textbox', { name: 'Ask anything' })).toBeEnabled()

  // Exercise the real session-scoped SQL reader against the live application database.
  const databasePath = join(configRoot, 'open-science.db')
  const unrelatedId = 'diagnostic-unrelated-session'
  const baseline = await application.evaluate(
    (_electron, { databasePath, sessionId, unrelatedId }) => {
      const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
      const db = new DatabaseSync(databasePath)
      try {
        const columns = db
          .prepare('PRAGMA table_info("Session")')
          .all()
          .map((row) => String(row.name))
        const names = columns.map((column) => '"' + column + '"').join(', ')
        const select = columns
          .map((column) =>
            column === 'id' ? '?' : column === 'number' ? '"number" + 100000' : '"' + column + '"'
          )
          .join(', ')
        db.prepare(
          `INSERT INTO "Session" (${names}) SELECT ${select} FROM "Session" WHERE "id" = ?`
        ).run(unrelatedId, sessionId)
        return JSON.stringify(db.prepare('SELECT * FROM "Session" ORDER BY "id"').all())
      } finally {
        db.close()
      }
    },
    { databasePath, sessionId: identity.sessionId, unrelatedId }
  )
  const dbArchive = testInfo.outputPath('database-diagnostics.tar.gz')
  await application.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
  }, dbArchive)
  const dbResult = await page.evaluate(async (identity) => {
    const inspection = await window.api.sessions.inspectDiagnostics({
      ...identity,
      operationId: crypto.randomUUID()
    })
    const database = inspection.items.find((item) => item.kind === 'database')
    if (!database?.available) throw new Error('Live diagnostic database is unavailable')
    return window.api.sessions.exportDiagnostics({
      ...identity,
      operationId: crypto.randomUUID(),
      selectedItems: [database.id]
    })
  }, identity)
  expect(['exported', 'partial']).toContain(dbResult.status)
  const dbDirectory = testInfo.outputPath('database-unpacked')
  await mkdir(dbDirectory)
  await extract({ file: dbArchive, cwd: dbDirectory })
  const rows = JSON.parse(await readFile(join(dbDirectory, 'db', 'Session.json'), 'utf8'))
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ id: identity.sessionId, projectId: identity.projectId })
  for (const file of await readdir(join(dbDirectory, 'db'))) {
    expect(await readFile(join(dbDirectory, 'db', file), 'utf8')).not.toContain(unrelatedId)
  }
  const after = await application.evaluate((_electron, databasePath) => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const db = new DatabaseSync(databasePath, { readOnly: true })
    try {
      return JSON.stringify(db.prepare('SELECT * FROM "Session" ORDER BY "id"').all())
    } finally {
      db.close()
    }
  }, databasePath)
  expect(after).toBe(baseline)
  expect(await readFile(sourcePath, 'utf8')).toBe(malformed)
})

test('exports separate Desktop and Runtime diagnostic evidence through real IPC', async ({
  app
}, testInfo) => {
  await app.completeOnboarding()
  const page = app.page
  const application = (app as unknown as { application: ElectronApplication }).application
  const paths = await application.evaluate(({ app }) => ({
    configRoot: process.env.OPEN_SCIENCE_CONFIG_ROOT!,
    desktopLog: process.getBuiltinModule('node:path').join(app.getPath('logs'), 'main.log')
  }))
  const identity = await page.evaluate(async (cwd) => {
    const project = await window.api.projects.create({ name: 'Diagnostic transport fixture' })
    const sessionId = 'diagnostic-transport-session'
    await window.api.sessions.saveSession({
      id: sessionId,
      projectId: project.id,
      cwd,
      title: 'Diagnostic transport fixture',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
      messages: []
    })
    return { projectId: project.id, sessionId }
  }, paths.configRoot)
  const secret = 'windows-diagnostic-synthetic-secret'
  const budgets = { queuedBytes: 21, bufferedBytes: 8, byteBudget: 34, frameBudget: 5 }
  // Synthetic records make the redaction assertion deterministic. Real Desktop/Runtime log
  // sources, authenticated IPC, inspection and bundled export worker remain unchanged.
  await appendFile(
    paths.desktopLog,
    JSON.stringify({
      t: new Date().toISOString(),
      level: 'error',
      scope: 'desktop',
      msg: 'desktop evidence failure',
      data: {
        ...identity,
        error: { message: 'Stop failed api_key=' + secret, code: 'EIO' }
      }
    }) + '\n'
  )
  await appendFile(
    join(paths.configRoot, 'logs', 'main.log'),
    JSON.stringify({
      t: new Date().toISOString(),
      level: 'warn',
      scope: 'desktop-transport',
      msg: 'transport evidence failure',
      data: budgets
    }) + '\n'
  )
  const inspection = await page.evaluate(
    (identity) =>
      window.api.sessions.inspectDiagnostics({
        ...identity,
        operationId: 'windows-inspect-evidence'
      }),
    identity
  )
  for (const id of ['log:main.log', 'desktop-log:main.log'])
    expect(inspection.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id, available: true })])
    )
  const archivePath = testInfo.outputPath('desktop-runtime-diagnostics.tar.gz')
  await mkdir(testInfo.outputPath(), { recursive: true })
  await application.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
  }, archivePath)
  const result = await page.evaluate(
    (identity) =>
      window.api.sessions.exportDiagnostics({
        ...identity,
        operationId: 'windows-export-evidence',
        selectedItems: ['log:main.log', 'desktop-log:main.log']
      }),
    identity
  )
  expect(result).toMatchObject({ status: 'exported', path: archivePath })
  const extracted = testInfo.outputPath('desktop-runtime-diagnostics')
  await mkdir(extracted)
  await extract({ file: archivePath, cwd: extracted })
  const desktop = await readFile(join(extracted, 'logs', 'desktop', 'main.log'), 'utf8')
  const runtime = await readFile(join(extracted, 'logs', 'main.log'), 'utf8')
  expect(desktop).toContain('Stop failed')
  expect(desktop).toContain('EIO')
  expect(desktop).not.toContain(secret)
  expect(desktop).not.toContain('transport evidence failure')
  const record = runtime
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((line) => line.event === 'transport evidence failure')
  expect(record.diagnostics).toMatchObject(budgets)
  expect(runtime).not.toContain('desktop evidence failure')
  await writeFile(
    testInfo.outputPath('diagnostic-proof.json'),
    JSON.stringify(
      {
        scope:
          'real source IPC and exporter; synthetic error records; native save picker substituted',
        identity,
        inspection,
        result,
        budgets
      },
      null,
      2
    )
  )
  await page.screenshot({ path: testInfo.outputPath('diagnostic-source-desktop.png') })
})
