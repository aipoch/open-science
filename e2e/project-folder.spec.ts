import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { basename, join, relative, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect } from '@playwright/test'
import type { Page } from 'playwright'
import type { PersistedChatSession } from '../src/shared/session-persistence'
import { test } from './fixtures/electron-app'
import { createProjectViaUi, homeNewProjectButton } from './fixtures/project'
import { expectCompletedAssistant, submitPromptViaUi } from './fixtures/conversation'

async function sessionFor(page: Page, projectId: string): Promise<PersistedChatSession> {
  return page.evaluate(async (id) => {
    const session = (await window.api.sessions.loadAll()).sessions.find(
      (candidate) => candidate.projectId === id
    )
    if (!session) throw new Error('Project folder Session was not persisted.')
    return session
  }, projectId)
}

async function finishFolderStepWithStandardPermissions(page: Page, reply: string): Promise<void> {
  const completed = page.getByText(reply, { exact: false })
  const allow = page
    .getByTestId('permission-actions')
    .getByRole('button', { name: 'Allow', exact: true })
  // Ask can separately approve reading the input and creating its derived result. These ordinary
  // tool permissions must not be mistaken for the independent backup/replace decision below.
  for (let count = 0; count < 4; count++) {
    await expect
      .poll(async () => (await completed.isVisible()) || (await allow.isVisible()))
      .toBe(true)
    if (await completed.isVisible()) return
    await allow.click()
  }
  await expect(completed).toBeVisible()
}

async function verifyAndCloseCsvPreview(page: Page): Promise<void> {
  const preview = page.getByRole('dialog', {
    name: 'Preview folder-mention-only.csv',
    exact: true
  })
  await expect(preview.getByRole('columnheader', { name: 'value', exact: true })).toBeVisible()
  await expect(preview.getByRole('cell', { name: '42', exact: true })).toBeVisible()
  await preview.getByRole('button', { name: 'Close preview of folder-mention-only.csv' }).click()
  await expect(preview).toBeHidden()
}

// One production journey runs unchanged on macOS, Windows and Linux. The external agent executable
// is deterministic; picker IPC, provider transport, fs requests, persistence and recovery stay real.
test('uses a project folder, reviews changes, then locates and resumes the same Session', async ({
  app
}, info) => {
  test.setTimeout(240_000)
  // Home's illustrative thumbnails are outside this filesystem journey.
  await app.page.context().route('https://statics.aipoch.com/open-science/usecases/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64'
      )
    })
  )
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  const folder = await realpath(await app.createTestDirectory('research-folder'))
  const moved = folder + '-moved'
  const original = 'sample,value\nA,10\n'
  const relocatedInput = 'sample,value\nA,11\n'
  await writeFile(join(folder, 'raw.csv'), original)
  const nestedFolders = [
    'sequencing-run-with-a-long-directory-name',
    'primary-analysis-with-a-long-directory-name',
    'data'
  ]
  await mkdir(join(folder, 'measurements', ...nestedFolders), { recursive: true })
  await writeFile(join(folder, 'measurements', 'folder-mention-only.csv'), 'sample,value\nB,42\n')
  await writeFile(join(folder, '.DS_Store'), 'metadata')
  await writeFile(join(folder, 'measurements', '.folder-mention-only.csv'), 'hidden')
  await mkdir(join(folder, 'measurements', '.private'))
  await writeFile(join(folder, 'measurements', '.private', 'folder-mention-only.csv'), 'hidden')
  await writeFile(
    join(folder, 'AGENTS.md'),
    'Project-local instructions must not change provider cwd.'
  )
  await app.selectDirectoryInNextDialog(folder)
  await homeNewProjectButton(page).click()
  const create = page.getByRole('dialog', { name: 'New project', exact: true })
  await expect(create.getByText('Default data location', { exact: true })).toBeVisible()
  await create.getByRole('button', { name: 'Choose folder…', exact: true }).click()
  await expect(create.getByText(folder, { exact: true })).toBeVisible()
  const name = create.getByLabel('Name', { exact: true })
  await expect(name).toHaveValue(basename(folder))
  await name.fill('Project folder journey')
  await expect(create.getByRole('button', { name: 'Create project', exact: true })).toBeEnabled()
  await create.screenshot({ path: info.outputPath('folder-create.png') })
  await create.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(create).toBeHidden()
  const project = await page.evaluate(async () => {
    const project = (await window.api.projects.list()).find(
      (candidate) => candidate.name === 'Project folder journey'
    )
    if (!project) throw new Error('Created project was not persisted.')
    return project
  })
  expect(project.rootPath).toBe(folder)
  expect(await readFile(join(folder, 'raw.csv'), 'utf8')).toBe(original)
  const prompt =
    'Run project folder filename-only journey. Read raw.csv, double its value into result.txt, then wait for Stop. After Resume, read raw.csv again and write resumed.txt.'
  await submitPromptViaUi(page, prompt)
  await finishFolderStepWithStandardPermissions(page, 'Project folder result ready for Stop.')
  expect(await readFile(join(folder, 'result.txt'), 'utf8')).toBe('sample,double\nA,20\n')
  const before = await sessionFor(page, project.id)
  const dataRoot = await page.evaluate(async () => (await window.api.storage.getInfo()).dataRoot)
  expect(before.providerSessionId).toBeTruthy()
  expect(relative(join(dataRoot, 'workspaces'), before.cwd)).not.toMatch(/^\.\./)
  expect(isAbsolute(relative(join(dataRoot, 'workspaces'), before.cwd))).toBe(false)
  expect(before.cwd).not.toBe(folder)
  expect(
    before.messages.some((message) => message.role === 'user' && message.content === prompt)
  ).toBe(true)
  await page.getByRole('button', { name: 'Cancel run', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Resume session', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await page.getByRole('button', { name: 'Filter project files' }).click()
  await expect(
    page.getByRole('menuitemradio', { name: /^All artifacts(?:\s+\d[\d,]*)?$/ })
  ).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('menuitemradio', { name: /^Project folder/ }).click()
  await expect(page.getByText('result.txt', { exact: true }).first()).toBeVisible()
  const files = page.getByTestId('project-folder-browser')
  await expect(files.getByText('.DS_Store', { exact: true })).toHaveCount(0)
  await files.getByRole('button', { name: 'measurements', exact: true }).click()
  await expect(files.getByText('folder-mention-only.csv', { exact: true })).toBeVisible()
  await expect(files.getByText('.folder-mention-only.csv', { exact: true })).toHaveCount(0)
  await expect(files.getByText('.private', { exact: true })).toHaveCount(0)
  await files.getByText('folder-mention-only.csv', { exact: true }).click()
  await verifyAndCloseCsvPreview(page)
  const contents = files.getByRole('list', { name: 'Directory contents' })
  for (const name of nestedFolders) {
    await contents.getByRole('button', { name, exact: true }).click()
  }
  const folderPath = files.getByRole('navigation', { name: 'Folder path' })
  await expect(folderPath.locator('[aria-current="page"]')).toHaveAttribute(
    'title',
    join(folder, 'measurements', ...nestedFolders)
  )
  const hiddenParents = folderPath.getByRole('button', { name: 'Show parent folders' })
  await hiddenParents.press('ArrowDown')
  const hiddenAncestor = page.getByRole('menuitem', { name: 'measurements', exact: true })
  await expect(hiddenAncestor).toBeFocused()
  await hiddenAncestor.press('Enter')
  await expect(folderPath).toBeFocused()
  await expect(contents.getByRole('button', { name: 'folder-mention-only.csv' })).toBeVisible()
  await folderPath.getByRole('button', { name: basename(folder), exact: true }).click()
  await page.screenshot({ path: info.outputPath('folder-result.png') })
  await rename(folder, moved)
  // A real disk edit distinguishes a fresh ACP read after relocation from cached input bytes.
  await writeFile(join(moved, 'raw.csv'), relocatedInput)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByText('Project folder not found', { exact: true }).first()).toBeVisible()
  await page.screenshot({ path: info.outputPath('folder-missing.png') })
  await app.selectDirectoryInNextDialog(moved)
  await page.getByRole('button', { name: 'Locate folder…', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(async (id) => (await window.api.projects.get(id))?.rootPath, project.id)
    )
    .toBe(moved)
  await expect(page.getByText('Project folder not found', { exact: true })).toHaveCount(0)
  await expect(page.getByText('result.txt', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Resume session', exact: true }).click()
  await finishFolderStepWithStandardPermissions(page, 'Project folder Resume completed.')
  await expect.poll(async () => (await sessionFor(page, project.id)).status).toBe('idle')
  const after = await sessionFor(page, project.id)
  expect(after.id).toBe(before.id)
  expect(after.providerSessionId).toBe(before.providerSessionId)
  expect(after.cwd).toBe(before.cwd)
  expect(
    after.messages.find(
      (message) => message.id === before.messages.find((entry) => entry.role === 'user')?.id
    )?.content
  ).toBe(prompt)
  expect(after.messages.filter((message) => message.role === 'user')).toHaveLength(1)
  expect(await readFile(join(moved, 'resumed.txt'), 'utf8')).toBe('sample,double\nA,22\n')
  expect(await readFile(join(moved, 'raw.csv'), 'utf8')).toBe(relocatedInput)
  await page.screenshot({ path: info.outputPath('folder-resumed.png') })

  await submitPromptViaUi(
    page,
    'Replace project folder input by filename. Read raw.csv and increase its value by one.'
  )
  const review = page.getByTestId('project-folder-change-review')
  await expect(review).toBeVisible()
  await expect(review.getByText('raw.csv', { exact: true })).toBeVisible()
  expect(await readFile(join(moved, 'raw.csv'), 'utf8')).toBe(relocatedInput)
  await page
    .getByTestId('permission-card')
    .screenshot({ path: info.outputPath('folder-replacement-review.png') })
  await page
    .getByTestId('permission-actions')
    .getByRole('button', { name: 'Back up and replace', exact: true })
    .click()
  await expect(
    page.getByText('Project folder replacement completed.', { exact: false })
  ).toBeVisible()
  expect(await readFile(join(moved, 'raw.csv'), 'utf8')).toBe('sample,value\nA,12\n')
  const history = page.getByTestId('project-folder-change-history')
  await history.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect.poll(() => readFile(join(moved, 'raw.csv'), 'utf8')).toBe(relocatedInput)
  await page.screenshot({ path: info.outputPath('folder-restored.png') })

  const resultPath = join(moved, 'result.txt')
  const generated = await stat(resultPath)
  await writeFile(resultPath, 'sample,double\nA,56\n')
  const edited = await stat(resultPath)
  expect([edited.dev, edited.ino, edited.size]).toEqual([
    generated.dev,
    generated.ino,
    generated.size
  ])
  const permissionCard = page.getByTestId('permission-card')
  const outputReview = permissionCard.getByTestId('project-folder-change-review')
  const editPrompt = 'Revise the app-created project folder result.'
  const skipped = page.getByText('Project folder edit was skipped.', { exact: true })

  await submitPromptViaUi(page, editPrompt)
  await expect(outputReview.getByText('result.txt', { exact: true })).toBeVisible()
  await outputReview.getByRole('button', { name: 'View changes', exact: true }).click()
  await expect(outputReview.getByText('A,56', { exact: false })).toBeVisible()
  await permissionCard.getByRole('button', { name: 'Reject', exact: true }).click()
  await expect(skipped).toHaveCount(1)
  await expect.poll(async () => (await sessionFor(page, project.id)).status).toBe('idle')
  expect(await readFile(resultPath, 'utf8')).toBe('sample,double\nA,56\n')

  await submitPromptViaUi(page, editPrompt + ' Keep the earlier analysis.')
  await expect(outputReview.getByText('result.txt', { exact: true })).toBeVisible()
  await writeFile(resultPath, 'sample,double\nA,78\n')
  await permissionCard.getByRole('button', { name: 'Back up and replace', exact: true }).click()
  await expect(skipped).toHaveCount(2)
  await expect.poll(async () => (await sessionFor(page, project.id)).status).toBe('idle')
  expect(await readFile(resultPath, 'utf8')).toBe('sample,double\nA,78\n')

  await submitPromptViaUi(page, 'Save the project folder result under another name.')
  await finishFolderStepWithStandardPermissions(page, 'Project folder output saved.')
  await expect.poll(async () => (await sessionFor(page, project.id)).status).toBe('idle')
  expect(await readFile(join(moved, 'alternate-result.txt'), 'utf8')).toBe('revised analysis\n')
  expect(await readFile(resultPath, 'utf8')).toBe('sample,double\nA,78\n')
  expect(await sessionFor(page, project.id)).toMatchObject({
    id: after.id,
    providerSessionId: after.providerSessionId,
    messages: expect.arrayContaining([
      expect.objectContaining({
        role: 'agent',
        content: expect.stringContaining('Project folder Resume completed.')
      })
    ])
  })

  // Existing disk files remain live project references: no upload or immutable Version is needed.
  // Search after Locate also proves the picker and provider resolve the current folder binding.
  const composer = page.getByRole('textbox', { name: 'Ask anything' })
  await composer.fill('@folder-mention-only')
  const suggestion = page.getByRole('option').filter({ hasText: 'folder-mention-only.csv' })
  await expect(suggestion).toHaveCount(1)
  await expect(suggestion).toBeVisible()
  await expect(suggestion).toContainText('measurements/folder-mention-only.csv')
  await suggestion.click()
  await expect(composer.locator('[data-mention-source="project-folder"]')).toHaveCount(1)
  await composer.locator('[data-mention-source="project-folder"]').click()
  await verifyAndCloseCsvPreview(page)
  await composer.press('End')
  await composer.pressSequentially(' Summarize this project folder file.')
  await page.screenshot({ path: info.outputPath('folder-mention.png') })
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect
    .poll(async () =>
      (await sessionFor(page, project.id)).messages.flatMap((message) => message.parts ?? [])
    )
    .toContainEqual(
      expect.objectContaining({
        type: 'artifact',
        source: 'project-folder',
        projectId: project.id,
        path: 'measurements/folder-mention-only.csv'
      })
    )
  await expect
    .poll(async () => JSON.stringify((await app.readFakeAgentPrompts()).at(-1)?.content))
    .toContain(pathToFileURL(join(moved, 'measurements', 'folder-mention-only.csv')).href)
  expect(JSON.stringify((await app.readFakeAgentPrompts()).at(-1)?.content)).toContain('B,42')
  expect(await readFile(join(moved, 'measurements', 'folder-mention-only.csv'), 'utf8')).toBe(
    'sample,value\nB,42\n'
  )
  const openSentMention = async (page: Page, expectedValue: string): Promise<void> => {
    const mention = page
      .getByRole('region', { name: 'Conversation', exact: true })
      .getByRole('button', { name: 'Preview folder-mention-only.csv', exact: true })
    await expect(mention).toHaveClass(/\bbg-mention-chip\b/)
    await expect(mention).toHaveAttribute('title', '@measurements/folder-mention-only.csv')
    const tab = page
      .getByRole('tab')
      .and(page.getByTitle('folder-mention-only.csv', { exact: true }))
    const panel = page.getByTestId('preview-card')
    await mention.click()
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    await expect(panel.getByRole('columnheader', { name: 'value', exact: true })).toBeVisible()
    await expect(panel.getByRole('cell', { name: expectedValue, exact: true })).toBeVisible()
    await expect(page.getByRole('dialog', { name: 'Preview folder-mention-only.csv' })).toHaveCount(
      0
    )
    await mention.click()
    await expect(tab).toHaveCount(1)
  }
  await openSentMention(page, '42')
  await page.getByRole('tab', { name: 'Files', exact: true }).click()
  await openSentMention(page, '42')
  await page
    .getByTestId('preview-panel-top-bar')
    .getByRole('button', { name: 'Close preview of folder-mention-only.csv' })
    .click()
  await expect(
    page.getByRole('tab').and(page.getByTitle('folder-mention-only.csv', { exact: true }))
  ).toHaveCount(0)
  await expect.poll(async () => (await sessionFor(page, project.id)).status).toBe('idle')

  // A live reference should re-read the file when clicked from the rehydrated transcript.
  await writeFile(join(moved, 'measurements', 'folder-mention-only.csv'), 'sample,value\nB,43\n')
  page = await app.restart()
  await page
    .getByRole('region', { name: 'Projects', exact: true })
    .getByRole('button', { name: 'Project folder journey', exact: true })
    .click()
  await page.locator(`[data-session-id="${after.id}"] [data-slot="session-open-button"]`).click()
  await openSentMention(page, '43')
  await page.screenshot({ path: info.outputPath('folder-mention-reopened.png') })
  await info.attach('folder-platform-evidence', {
    contentType: 'application/json',
    body: Buffer.from(
      JSON.stringify({
        platform: process.platform,
        sessionId: after.id,
        providerSessionId: after.providerSessionId,
        providerCwdPreserved: after.cwd === before.cwd,
        filenameOnlyInputReadBeforeAndAfterRelocation: true,
        relocated: true,
        mediatedReplacementRestored: true
      })
    )
  })
})

test('retains Notebook and Artifact records when a project is removed and selected again', async ({
  app
}, info) => {
  test.setTimeout(240_000)
  await app.page
    .context()
    .route('https://statics.aipoch.com/open-science/usecases/**', (route) =>
      route.fulfill({ status: 204, body: '' })
    )
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  let folder = await realpath(await app.createTestDirectory('portable-research'))
  const name = 'Portable research records'
  const createBoundProject = async (): Promise<void> => {
    await app.selectDirectoryInNextDialog(folder)
    await homeNewProjectButton(page).click()
    const dialog = page.getByRole('dialog', { name: 'New project', exact: true })
    await dialog.getByLabel('Name', { exact: true }).fill(name)
    await dialog.getByRole('button', { name: 'Choose folder…', exact: true }).click()
    await dialog.getByRole('button', { name: 'Create project', exact: true }).click()
    await expect(dialog).toBeHidden()
  }
  await createBoundProject()
  const project = await page.evaluate(
    async (name) => (await window.api.projects.list()).find((p) => p.name === name)!,
    name
  )
  let records = join(folder, '.open-science')
  expect(JSON.parse(await readFile(join(records, 'project.json'), 'utf8')).projectId).toBe(
    project.id
  )
  await submitPromptViaUi(page, 'Create portable project records.')
  await finishFolderStepWithStandardPermissions(page, 'Portable project research saved.')
  await expect.poll(async () => (await sessionFor(page, project.id)).status).toBe('idle')
  const session = await sessionFor(page, project.id)
  let recordPath = join(records, 'notebooks', project.id, session.id, 'run.json')
  const originalRecord = await readFile(recordPath, 'utf8')
  expect(originalRecord).toContain('portable-result.txt')
  // The fixture publishes inline bytes: no Notebook write pre-creates this public target.
  const deliveredRelative = join('artifacts', project.id, session.id, 'portable-result.txt')
  await expect
    .poll(() => readFile(join(folder, deliveredRelative), 'utf8'))
    .toBe('portable research result')
  await expect(readFile(join(folder, 'portable-result.txt'), 'utf8')).rejects.toMatchObject({
    code: 'ENOENT'
  })
  const indexBefore = await readFile(join(records, 'artifact-index.json'), 'utf8')
  expect(indexBefore).toContain('portable-result.txt')
  const version = JSON.parse(indexBefore).tables.ArtifactVersion.find(
    (row: { filename: string }) => row.filename === 'portable-result.txt'
  )
  let artifactPath = join(records, version.contentStorageKey)
  expect(await readFile(artifactPath, 'utf8')).toBe('portable research result')
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await expect(
    page.getByText('portable-result.txt', { exact: true }).filter({ visible: true }).first()
  ).toBeVisible()
  page = await app.restart()
  await page
    .getByRole('region', { name: 'Projects', exact: true })
    .getByRole('button', { name, exact: true })
    .click()
  const indexPath = join(records, 'artifact-index.json')
  const lineageRequest = {
    projectId: project.id,
    appSessionId: session.id,
    artifactId: version.artifactId as string
  }
  const readLineage = (): ReturnType<Window['api']['artifacts']['getLineage']> =>
    page.evaluate((request) => window.api.artifacts.getLineage(request), lineageRequest)
  await page.locator(`[data-session-id="${session.id}"] [data-slot="session-open-button"]`).click()
  await expect(page.getByText('Portable project research saved.', { exact: false })).toBeVisible()

  const damagedIndex = '{incomplete checkpoint'
  const plainPrompt = 'Summarize the deterministic fixture.'
  const plainReply = `Deterministic reply: ${plainPrompt}`
  await writeFile(indexPath, damagedIndex)
  try {
    expect(await readLineage()).toMatchObject({ failure: { kind: 'load-failed' } })
    await expect(async () => {
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await expect(
        page.getByRole('heading', {
          name: 'Some research records could not be restored',
          exact: true
        })
      ).toBeVisible({ timeout: 500 })
    }).toPass({ timeout: 20_000 })
    expect(
      await page.evaluate((request) => window.api.projects.readFolderPreview(request), {
        projectId: project.id,
        relativePath: deliveredRelative,
        encoding: 'utf8' as const
      })
    ).toMatchObject({ content: 'portable research result' })
    await submitPromptViaUi(page, plainPrompt)
    await expectCompletedAssistant(page, plainReply, { projectId: project.id })
    expect((await sessionFor(page, project.id)).id).toBe(session.id)

    await page.getByRole('button', { name: 'All projects', exact: true }).click()
    const managed = 'Independent managed project'
    await createProjectViaUi(page, managed)
    const managedId = await page.evaluate(async (name) => {
      const project = (await window.api.projects.list()).find((entry) => entry.name === name)
      if (!project) throw new Error('Managed project was not persisted.')
      return project.id
    }, managed)
    await submitPromptViaUi(page, plainPrompt)
    await expectCompletedAssistant(page, plainReply, { projectId: managedId })
    expect(await readFile(indexPath, 'utf8')).toBe(damagedIndex)
  } finally {
    await writeFile(indexPath, indexBefore)
  }
  await page.getByRole('button', { name: 'All projects', exact: true }).click()
  await page
    .getByRole('region', { name: 'Projects', exact: true })
    .getByRole('button', { name, exact: true })
    .click()
  expect(await readLineage()).toMatchObject({ artifactId: lineageRequest.artifactId })

  const runs = await page.evaluate((request) => window.api.notebook.runIndex(request), {
    projectId: project.id,
    sessionId: session.id,
    workspaceCwd: session.cwd
  })
  expect(runs.length).toBeGreaterThan(0)
  const moved = folder + '-moved'
  await rename(folder, moved)
  await expect(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(
      page.getByRole('heading', { name: 'Project folder not found', exact: true }).first()
    ).toBeVisible({ timeout: 500 })
  }).toPass({ timeout: 20_000 })
  await app.selectDirectoryInNextDialog(moved)
  await page.getByRole('button', { name: 'Locate folder…', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(async (id) => (await window.api.projects.get(id))?.rootPath, project.id)
    )
    .toBe(moved)
  folder = moved
  records = join(folder, '.open-science')
  recordPath = join(records, 'notebooks', project.id, session.id, 'run.json')
  artifactPath = join(records, version.contentStorageKey)
  expect(await readFile(recordPath, 'utf8')).toBe(originalRecord)
  expect(await readFile(join(folder, deliveredRelative), 'utf8')).toBe('portable research result')
  const relocatedSession = await sessionFor(page, project.id)
  expect(relocatedSession.cwd).toBe(session.cwd)
  expect(relocatedSession.providerSessionId).toBe(session.providerSessionId)
  await page.getByRole('button', { name: 'All projects', exact: true }).click()
  const projects = page.getByRole('region', { name: 'Projects', exact: true })
  await projects.getByRole('button', { name, exact: true }).hover()
  await projects.getByRole('button', { name: `Open actions for ${name}` }).click()
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  const remove = page.getByRole('alertdialog', { name: 'Delete project?', exact: true })
  await remove.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(projects.getByRole('button', { name, exact: true })).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(async () => (await window.api.projects.listDeletionCleanup()).length))
    .toBe(0)
  expect(await readFile(recordPath, 'utf8')).toBe(originalRecord)
  expect(await readFile(join(records, 'artifact-index.json'), 'utf8')).toBe(indexBefore)
  expect(await readFile(artifactPath, 'utf8')).toBe('portable research result')
  expect(await readFile(join(folder, deliveredRelative), 'utf8')).toBe('portable research result')
  await createBoundProject()
  const reopened = await page.evaluate(async (id) => window.api.projects.get(id), project.id)
  expect(reopened?.id).toBe(project.id)
  const restored = await sessionFor(page, project.id)
  expect(restored.id).toBe(session.id)
  expect(restored.providerSessionId).toBeUndefined()
  expect(restored.cwd).not.toBe(session.cwd)
  expect(
    (
      await page.evaluate((request) => window.api.notebook.runIndex(request), {
        projectId: project.id,
        sessionId: restored.id,
        workspaceCwd: restored.cwd
      })
    ).length
  ).toBe(runs.length)
  const files = await page.evaluate(
    (projectId) =>
      window.api.projectFiles.listFiles({ projectId, collection: { kind: 'all' }, limit: 100 }),
    project.id
  )
  expect(files.items.some((item) => item.name === 'portable-result.txt')).toBe(true)
  await page.screenshot({ path: info.outputPath('project-records-reopened.png') })
})
