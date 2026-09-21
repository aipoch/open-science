import { expect } from '@playwright/test'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication } from 'playwright'
import { x as extract } from 'tar'
import { test } from './fixtures/electron-app'

// Real native IPC + bundled worker; only the operating-system save picker is substituted.
test.use({ windowMode: 'normal' })

test('exports selected diagnostics without changing the persisted session', async ({
  app
}, testInfo) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await page.getByRole('button', { name: 'New project', exact: true }).click()
  const project = page.getByRole('dialog', { name: 'New project' })
  await project.getByLabel('Name').fill('Diagnostic research')
  await project.getByRole('button', { name: 'Create project' }).click()
  const prompt = 'Summarize the deterministic fixture.'
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(prompt)
  await page.getByRole('button', { name: 'Send message' }).click()
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
  const original = await readFile(sourcePath, 'utf8')
  const secret = 'diagnostic-e2e-credential-do-not-export'
  const evidence = JSON.stringify({
    ...JSON.parse(original),
    diagnosticFixture: { apiKey: secret }
  })
  await writeFile(sourcePath, evidence)
  const logsRoot = await application.evaluate(({ app }) => app.getPath('logs'))
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
  await expect(diagnosticButton.locator('.lucide-stethoscope')).toHaveCount(1)
  await page.screenshot({ path: testInfo.outputPath('diagnostic-header.png') })
  await diagnosticButton.click()
  const dialog = page.getByRole('dialog', { name: 'Export diagnostics…', exact: true })
  const sessionCheckbox = dialog.getByRole('checkbox', { name: /^session\.json/ })
  await expect(sessionCheckbox).toBeEnabled()
  await expect(sessionCheckbox).toBeChecked()
  await expect(dialog.getByRole('checkbox', { name: /^main\.log/ })).toBeChecked()
  await expect(dialog.getByRole('checkbox', { name: /^main\.1\.log/ })).toBeEnabled()
  await expect(dialog.getByRole('checkbox', { name: /^main\.1\.log/ })).not.toBeChecked()
  const checkboxes = dialog.getByRole('checkbox')
  for (const checkbox of await checkboxes.all()) {
    if ((await checkbox.isEnabled()) && (await checkbox.isChecked())) await checkbox.uncheck()
  }
  await sessionCheckbox.check()
  await page.screenshot({ path: testInfo.outputPath('diagnostic-selection.png') })
  await dialog.getByRole('button', { name: 'Export', exact: true }).click()
  await expect(dialog.getByText(/^Diagnostics exported/)).toBeVisible({ timeout: 45_000 })
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
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Ask anything' })).toBeEnabled()

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
  await expect(sessionCheckbox).toBeEnabled()
  for (const checkbox of await dialog.getByRole('checkbox').all()) {
    if ((await checkbox.isEnabled()) && (await checkbox.isChecked())) await checkbox.uncheck()
  }
  await sessionCheckbox.check()
  await dialog.getByRole('button', { name: 'Export', exact: true }).click()
  await expect(
    dialog.getByText('Diagnostics exported with missing information.', { exact: true })
  ).toBeVisible({ timeout: 45_000 })
  expect(await readFile(sourcePath, 'utf8')).toBe(malformed)
  const partialDirectory = testInfo.outputPath('partial-unpacked')
  await mkdir(partialDirectory)
  await extract({ file: partialPath, cwd: partialDirectory })
  expect(
    await readFile(join(partialDirectory, 'session.json.metadata.json'), 'utf8')
  ).not.toContain(secret)
  expect(await readFile(join(partialDirectory, 'export.log'), 'utf8')).toContain('invalid-json')
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
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
