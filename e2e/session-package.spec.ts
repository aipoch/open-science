import { expect } from '@playwright/test'
import { stat, writeFile, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from './fixtures/electron-app'

test('preserves transfer outcomes while showing pending temporary cleanup', async ({
  app
}, testInfo) => {
  const page = await app.completeOnboarding()
  for (const { kind, state } of [
    { kind: 'export', state: 'succeeded' },
    { kind: 'import', state: 'succeeded' },
    { kind: 'import', state: 'failed' },
    { kind: 'import', state: 'cancelled' }
  ] as const) {
    const status =
      state === 'succeeded'
        ? 'Completed, cleanup pending'
        : state === 'failed'
          ? 'Package operation failed'
          : 'Package operation cancelled'
    const operation = {
      id: `cleanup-${kind}-${state}`,
      kind,
      state,
      progress: { phase: kind === 'export' ? ('saving' as const) : ('importing' as const) },
      cleanupPending: true,
      result:
        state !== 'succeeded'
          ? undefined
          : kind === 'export'
            ? { filePath: '/tmp/research.science' }
            : { imported: { projectId: 'p', sessionId: 's' } }
    }
    const dialog = page.getByRole('dialog', {
      name: kind === 'export' ? 'Export Session package' : 'Import Session package',
      exact: true
    })
    await expect(async () => {
      await app.emitSessionPackageProgress({ ...operation, state: 'running' })
      await app.emitSessionPackageProgress(operation)
      await expect(dialog.getByText(status, { exact: true })).toBeVisible({
        timeout: 1000
      })
    }).toPass({ timeout: 10000 })
    await expect(dialog.getByRole('button', { name: 'Retry cleanup', exact: true })).toBeVisible()
    if (state === 'succeeded')
      await expect(
        dialog.getByRole('button', {
          name: kind === 'export' ? 'Show in folder' : 'Open imported Session',
          exact: true
        })
      ).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`${kind}-${state}-cleanup-pending.png`) })
    await app.emitSessionPackageProgress({
      ...operation,
      state: 'running',
      progress: { phase: 'cleaning' }
    })
    await expect(dialog.getByRole('progressbar')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`${kind}-${state}-cleanup-running.png`) })
    await app.emitSessionPackageProgress({ ...operation, cleanupPending: false })
    await expect(dialog.getByRole('button', { name: 'Retry cleanup', exact: true })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  }
})

test('keeps import progress visible when a stage has no measurable total', async ({
  app
}, testInfo) => {
  const page = await app.completeOnboarding()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const operation = {
    id: 'import-progress-fixture',
    kind: 'import' as const,
    state: 'running' as const,
    ioBytesPerSecond: 12 * 1024 ** 2,
    transferBytesPerSecond: 16 * 1024 ** 2
  }
  const dialog = page.getByRole('dialog', { name: 'Import Session package', exact: true })
  const meter = dialog.getByRole('progressbar')
  // Startup may still be mounting the event subscriber. Acknowledge the idempotent fixture
  // before testing its presentation; production operations also have an owner snapshot.
  await expect(async () => {
    await app.emitSessionPackageProgress({ ...operation, progress: { phase: 'validating' } })
    await expect(dialog.getByText('Validating package…', { exact: true })).toBeVisible({
      timeout: 1000
    })
  }).toPass({ timeout: 10000 })
  // A screen-reader-only progress element is not a visual progress bar.
  await expect.poll(async () => (await meter.boundingBox())?.height ?? 0).toBeGreaterThan(3)
  await expect(meter).not.toHaveAttribute('aria-valuenow')
  await expect(meter).not.toHaveAttribute('value')
  const segment = meter.locator('[aria-hidden="true"]')
  await expect(segment).toHaveCSS('animation-name', 'install-progress-indeterminate')
  const initialTransform = await segment.evaluate((element) => getComputedStyle(element).transform)
  await expect
    .poll(() => segment.evaluate((element) => getComputedStyle(element).transform))
    .not.toBe(initialTransform)
  await page.screenshot({ path: testInfo.outputPath('import-validating.png') })
  await dialog.getByRole('button', { name: 'Run in background' }).click()
  const background = page.getByRole('region', { name: 'Package progress', exact: true })
  await expect
    .poll(async () => (await background.getByRole('progressbar').boundingBox())?.height ?? 0)
    .toBeGreaterThan(3)
  await page.screenshot({ path: testInfo.outputPath('import-background.png') })
  await background.getByRole('button', { name: 'View progress' }).click()
  await app.emitSessionPackageProgress({
    ...operation,
    progress: { phase: 'importing', completedBytes: 40, totalBytes: 100 }
  })
  await expect(dialog.getByText('40%', { exact: true })).toBeVisible()
  await app.emitSessionPackageProgress({ ...operation, progress: { phase: 'importing' } })
  await expect(dialog.getByText('40%', { exact: true })).toHaveCount(0)
  await expect.poll(async () => (await meter.boundingBox())?.height ?? 0).toBeGreaterThan(3)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(meter.locator('[aria-hidden="true"]')).toHaveCSS('animation-name', 'none')
  await page.screenshot({ path: testInfo.outputPath('import-reduced-motion.png') })
  await app.emitSessionPackageProgress({ ...operation, progress: { phase: 'confirming' } })
  await expect(dialog.getByText('Waiting for you', { exact: true })).toBeVisible()
  await expect(meter).toHaveCount(0)
})

test('presents waiting, measurable work and cleanup through native progress events', async ({
  app
}, testInfo) => {
  const page = await app.completeOnboarding()
  const operation = { id: 'progress-fixture', kind: 'export' as const, state: 'running' as const }
  const dialog = page.getByRole('dialog', { name: 'Export Session package', exact: true })
  await expect(async () => {
    await app.emitSessionPackageProgress({
      ...operation,
      progress: {
        phase: 'copying',
        completedBytes: 300 * 1024 ** 2,
        totalBytes: 800 * 1024 ** 2,
        completedFiles: 12,
        totalFiles: 36,
        currentFile: 'results/microscopy-analysis.csv'
      }
    })
    await expect(dialog.getByText('37%', { exact: true })).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 10000 })
  await page.screenshot({
    path: testInfo.outputPath('transfer-working-fixture.png'),
    animations: 'disabled'
  })
  await dialog.getByText('Transfer details', { exact: true }).click()
  await expect(dialog.getByText('results/microscopy-analysis.csv', { exact: true })).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath('transfer-details.png'),
    animations: 'disabled'
  })
  await dialog.getByText('Transfer details', { exact: true }).click()
  await dialog.getByRole('button', { name: 'Run in background' }).click()
  const inline = page.getByRole('region', { name: 'Package progress', exact: true })
  await expect(inline.getByText('37%', { exact: true })).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath('transfer-background-fixture.png'),
    animations: 'disabled'
  })
  await inline.getByRole('button', { name: 'View progress' }).click()
  await app.emitSessionPackageProgress({ ...operation, progress: { phase: 'compressing' } })
  await expect(dialog.getByRole('progressbar')).not.toHaveAttribute('value')
  await page.screenshot({
    path: testInfo.outputPath('transfer-indeterminate-fixture.png'),
    animations: 'disabled'
  })
  await app.emitSessionPackageProgress({ ...operation, progress: { phase: 'choosing-location' } })
  await expect(dialog.getByText('Waiting for you', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('progressbar')).toHaveCount(0)
  await page.screenshot({
    path: testInfo.outputPath('transfer-waiting-fixture.png'),
    animations: 'disabled'
  })
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  await page.setViewportSize({ width: 375, height: 800 })
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await expect(dialog.getByRole('button', { name: 'Cancel operation' })).toBeInViewport()
  await page.screenshot({
    path: testInfo.outputPath('transfer-waiting-narrow-fixture.png'),
    animations: 'disabled'
  })
  await page.setViewportSize(viewport)
  await app.emitSessionPackageProgress({
    ...operation,
    state: 'cancelling',
    progress: { phase: 'copying', completedBytes: 300 * 1024 ** 2, totalBytes: 800 * 1024 ** 2 }
  })
  await expect(dialog.getByRole('button', { name: 'Cancel operation' })).toBeDisabled()
  await expect(dialog.getByRole('progressbar')).toHaveCount(0)
  await page.screenshot({
    path: testInfo.outputPath('transfer-cleanup-fixture.png'),
    animations: 'disabled'
  })
  await app.emitSessionPackageProgress({
    ...operation,
    state: 'cancelled',
    progress: { phase: 'copying' }
  })
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
})

test('shows a recoverable disk-capacity error before copying an import', async ({
  app
}, testInfo) => {
  const page = await app.completeOnboarding()
  const archive = await app.configureSessionPackageDialogs({ availableBytes: 0 })
  await writeFile(archive, 'No archive bytes should be parsed')
  await page.getByRole('button', { name: 'New project', exact: true }).click()
  const project = page.getByRole('dialog', { name: 'New project' })
  await project.getByLabel('Name').fill('Capacity test')
  await project.getByRole('button', { name: 'Create project' }).click()
  await page.getByRole('button', { name: 'Capacity test', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Import Session package…', exact: true }).click()
  const operation = page.getByRole('dialog', { name: 'Import Session package', exact: true })
  await expect(operation.getByText(/Not enough disk space at/)).toBeVisible()
  await expect(operation.getByRole('button', { name: 'Try again', exact: true })).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('session-package-capacity-error.png') })
  await operation.getByRole('button', { name: 'Close', exact: true }).click()
})

test('exports a Session package and imports its conversation as read-only history', async ({
  app
}, testInfo) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  page.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error') console.log(message.text())
  })
  const archive = await app.configureSessionPackageDialogs()
  await page.getByRole('button', { name: 'New project', exact: true }).click()
  const project = page.getByRole('dialog', { name: 'New project' })
  await project.getByLabel('Name').fill('Portable research')
  await project.getByRole('button', { name: 'Create project' }).click()
  await page.locator('input[type="file"][multiple]').setInputFiles([
    {
      name: 'research-notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Research notes\nA portable summary.\n')
    },
    {
      name: 'raw-results.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('sample,value\n' + 'A,1\n'.repeat(300_000))
    }
  ])
  await expect(
    page.getByRole('button', { name: 'Remove attachment raw-results.csv' })
  ).toBeVisible()
  const prompt = 'Summarize the deterministic fixture.'
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(prompt)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText(`Deterministic reply: ${prompt}`, { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0)
  await page.getByRole('button', { name: `Open actions for ${prompt}` }).click()
  await page.getByRole('menuitem', { name: 'Export', exact: true }).hover()
  const exportPackage = page.getByRole('menuitem', { name: 'Export Session package', exact: true })
  await expect(exportPackage).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('session-package-export.png') })
  await exportPackage.click()
  const operation = page.getByRole('dialog', { name: 'Export Session package', exact: true })
  await expect(operation.getByRole('button', { name: 'Choose save location' })).toBeVisible()
  await expect(operation.getByRole('spinbutton')).toHaveCount(0)
  await expect(operation.getByRole('checkbox')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('session-package-default.png') })
  await operation.getByRole('button', { name: 'About the size estimate' }).focus()
  await expect(page.getByRole('tooltip')).toContainText(
    'Uncompressed upper estimate. The final package may be smaller.'
  )
  await page.screenshot({ path: testInfo.outputPath('session-package-estimate-help.png') })
  await page.keyboard.press('Escape')
  await expect(operation).toBeVisible()
  await operation.getByRole('button', { name: 'Customize contents' }).click()
  await operation.getByText('Transfer settings', { exact: true }).click()
  await operation.getByLabel('Disk activity limit').selectOption(String(4 * 1024 ** 2))
  await expect(operation.getByLabel('Disk activity limit')).toHaveValue(String(4 * 1024 ** 2))
  await page.screenshot({ path: testInfo.outputPath('session-package-transfer-settings.png') })
  await operation.getByLabel('Disk activity limit').selectOption(String(16 * 1024 ** 2))
  await expect(operation.getByLabel('Disk activity limit')).toHaveValue(String(16 * 1024 ** 2))
  await operation.getByText('Transfer settings', { exact: true }).click()
  await operation.getByRole('button', { name: 'Customize contents' }).click()
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  for (const width of [320, 375, 414, 768]) {
    await page.setViewportSize({ width, height: 800 })
    await expect(operation.getByRole('button', { name: 'Choose save location' })).toBeInViewport()
    expect(await operation.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true
    )
  }
  await page.screenshot({ path: testInfo.outputPath('session-package-default-narrow.png') })
  await page.setViewportSize(viewport)
  await operation.getByRole('button', { name: 'Customize contents' }).click()
  await expect(
    operation.getByText(
      'Optional files are sorted by size, largest first. Files larger than 32.0 GiB cannot be included.',
      { exact: true }
    )
  ).toBeVisible()
  await expect(operation.getByText('raw-results.csv', { exact: true })).toBeVisible()
  await expect(page.getByText('Conversation storage needs attention', { exact: true })).toHaveCount(
    0
  )
  await expect(operation.getByRole('spinbutton')).not.toBeVisible()
  await operation.getByText('File filters', { exact: true }).click()
  await operation.getByRole('spinbutton').fill('1')
  await operation.getByRole('button', { name: 'Exclude large files' }).click()
  await expect(operation.getByText(/Selected: 1 \/ 2 files/)).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('session-package-selection.png') })
  for (const width of [320, 375, 414, 768]) {
    await page.setViewportSize({ width, height: 800 })
    await expect(operation.getByRole('button', { name: 'Choose save location' })).toBeInViewport()
    expect(await operation.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true
    )
  }
  await page.screenshot({ path: testInfo.outputPath('session-package-selection-narrow.png') })
  await page.setViewportSize(viewport)
  await operation.getByRole('button', { name: 'Hide progress' }).click()
  await expect(page.getByRole('region', { name: 'Session export in progress' })).toBeVisible()
  await expect(
    page.getByTestId('conversation-header').getByRole('button', { name: 'Export Session package' })
  ).toHaveCount(0)
  await expect(page.getByTestId('composer-card-backdrop')).toBeHidden()
  await expect(page.getByRole('textbox', { name: 'Ask anything' })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('session-package-background.png') })
  await page.getByRole('button', { name: 'New', exact: true }).click()
  await page
    .getByRole('textbox', { name: 'Ask anything' })
    .fill('Continue another Session during export.')
  await page.getByRole('button', { name: 'Send message' }).click()
  // The installed fake Agent returns its configured fixed response for every Session.
  await expect(page.getByText(`Deterministic reply: ${prompt}`, { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0)
  await page
    .getByRole('navigation', { name: 'Sessions' })
    .getByRole('button', { name: new RegExp(`Session status:.*${prompt}`) })
    .click()
  await page
    .getByRole('region', { name: 'Package progress', exact: true })
    .getByRole('button', { name: 'View progress', exact: true })
    .click()
  await expect(operation.getByText(/Selected: 1 \/ 2 files/)).toBeVisible()
  await operation.getByRole('button', { name: 'Customize contents' }).click()
  await operation.getByText('File filters', { exact: true }).click()
  await expect(operation.getByRole('spinbutton')).toHaveValue('1')
  await operation.getByRole('button', { name: 'Choose save location' }).click()
  await expect(operation.getByText('Package operation completed', { exact: true })).toBeVisible({
    timeout: 60_000
  })
  await page.screenshot({ path: testInfo.outputPath('session-package-progress.png') })
  await expect(operation.getByRole('button', { name: 'Show in folder', exact: true })).toBeVisible()
  await operation.getByRole('button', { name: 'Close', exact: true }).click()
  expect((await stat(archive)).size).toBeGreaterThan(0)
  await testInfo.attach('selected-session-package', {
    path: archive,
    contentType: 'application/gzip'
  })
  await page.getByRole('button', { name: 'All projects', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Import Session package', exact: true })
  ).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'More actions', exact: true })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('session-package-home.png') })
  await page
    .getByRole('region', { name: 'Projects', exact: true })
    .getByRole('button', { name: 'Portable research', exact: true })
    .click()
  await page.getByRole('button', { name: 'Portable research', exact: true }).click()
  await page.screenshot({ path: testInfo.outputPath('session-package-project-menu.png') })
  await page.getByRole('menuitem', { name: 'Import Session package…', exact: true }).click()
  await expect(page.getByLabel('Destination project')).toHaveCount(0)
  const importing = page.getByRole('dialog', { name: 'Import Session package', exact: true })
  await expect(
    importing.getByRole('button', { name: 'Import Session package', exact: true })
  ).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('session-package-import-progress.png') })
  await importing.getByRole('button', { name: 'Hide progress' }).click()
  const backgroundImport = page.getByRole('region', { name: 'Package progress', exact: true })
  await expect(backgroundImport.getByText('Waiting for import confirmation…')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('session-package-import-background.png') })
  await backgroundImport.getByRole('button', { name: 'View progress' }).click()
  await importing.getByRole('button', { name: 'Import Session package', exact: true }).click()
  await expect(importing.getByText('Package operation completed', { exact: true })).toBeVisible({
    timeout: 60_000
  })
  await expect(page.getByRole('region', { name: 'Imported research history' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('session-package-import-completed.png') })
  await importing.getByRole('button', { name: 'Open imported Session', exact: true }).click()
  const imported = page.getByRole('region', { name: 'Imported research history' })
  await expect(imported).toBeVisible()
  await expect(imported.getByText(/^Imported on /)).toBeVisible()
  const origins = await page.evaluate(async () =>
    (await window.api.sessions.loadAll()).sessions
      .filter((session) => session.packageOrigin)
      .map((session) => session.packageOrigin)
  )
  expect(origins).toEqual([
    expect.objectContaining({
      excludedFiles: expect.arrayContaining([
        expect.objectContaining({ filename: 'raw-results.csv' })
      ])
    })
  ])
  await imported.getByText('Package source', { exact: true }).click()
  await expect(imported.getByText(origins[0]!.sourceProjectId, { exact: true })).toBeVisible()
  await expect(imported.getByText(origins[0]!.sourceSessionId, { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('session-package-source.png') })
  await imported.getByText('Not included in this package', { exact: true }).click()
  await expect(imported.getByText('raw-results.csv', { exact: true })).toBeVisible()
  await expect(page.getByText(`Deterministic reply: ${prompt}`, { exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Ask anything' })).toHaveCount(0)
  const sessionRow = page
    .getByRole('navigation', { name: 'Sessions', includeHidden: true })
    .locator('[data-session-id]')
    .filter({ hasText: prompt })
    .filter({ has: page.getByRole('img', { name: 'Read-only', exact: true, includeHidden: true }) })
  const readOnlyBadge = sessionRow.getByRole('img', {
    name: 'Read-only',
    exact: true,
    includeHidden: true
  })
  const sessionMenu = sessionRow.getByRole('button', { name: `Open actions for ${prompt}` })
  await page.getByRole('region', { name: 'Imported research history' }).hover()
  await expect(readOnlyBadge).toHaveCSS('opacity', '1')
  await page
    .getByRole('navigation', { name: 'Sessions' })
    .screenshot({ path: testInfo.outputPath('session-package-sidebar.png') })
  await sessionRow.hover()
  await expect(readOnlyBadge).toHaveCSS('opacity', '0')
  await expect(sessionMenu).toHaveCSS('opacity', '1')
  await page
    .getByRole('navigation', { name: 'Sessions' })
    .screenshot({ path: testInfo.outputPath('session-package-sidebar-hover.png') })
  await sessionMenu.click()
  await expect(page.getByRole('menu', { name: `Open actions for ${prompt}` })).toBeVisible()
  await expect(readOnlyBadge).toHaveCSS('opacity', '0')
  await page.keyboard.press('Escape')
  await page.getByRole('region', { name: 'Imported research history' }).click()
  await expect(readOnlyBadge).toHaveCSS('opacity', '1')
  await sessionMenu.focus()
  await expect(readOnlyBadge).toHaveCSS('opacity', '0')
  await expect(sessionMenu).toHaveCSS('opacity', '1')
  await page.getByRole('region', { name: 'Imported research history' }).click()
  await expect(readOnlyBadge).toHaveCSS('opacity', '1')
  await page.screenshot({ path: testInfo.outputPath('session-package-imported.png') })
  await page.getByRole('button', { name: 'New', exact: true }).click()
  await page.getByRole('textbox', { name: 'Ask anything' }).fill('Continue in an ordinary Session.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByText(`Deterministic reply: ${prompt}`, { exact: true })).toBeVisible()
  await expect(page.getByText('Conversation storage needs attention', { exact: true })).toHaveCount(
    0
  )
  await app.restart()
  await expect(
    app.page
      .getByRole('region', { name: 'Projects', exact: true })
      .getByRole('button', { name: 'Portable research', exact: true })
  ).toHaveCount(1)
  await app.page
    .getByRole('region', { name: 'Projects', exact: true })
    .getByRole('button', { name: 'Portable research', exact: true })
    .first()
    .click()
  await app.page
    .getByRole('navigation', { name: 'Sessions' })
    .locator('[data-session-id]')
    .filter({
      has: app.page.getByRole('img', { name: 'Read-only', exact: true, includeHidden: true })
    })
    .getByRole('button', { name: new RegExp(`Session status:.*${prompt}`) })
    .click()
  await expect(app.page.getByRole('region', { name: 'Imported research history' })).toBeVisible()
  await expect(app.page.getByText(`Deterministic reply: ${prompt}`, { exact: true })).toBeVisible()
  const identity = await app.page.evaluate(async () => {
    const session = (await window.api.sessions.loadAll()).sessions.find(
      (entry) => entry.packageOrigin
    )!
    return {
      projectId: session.projectId,
      sessionId: session.id,
      importId: session.packageOrigin!.importId
    }
  })
  await app.page
    .getByRole('navigation', { name: 'Sessions' })
    .locator(`[data-session-id="${identity.sessionId}"]`)
    .getByRole('button', { name: `Open actions for ${prompt}` })
    .click()
  await app.page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  const deleting = app.page.getByRole('alertdialog', { name: 'Delete Session?' })
  await expect(deleting.getByText(/the next time Open Science starts/)).toBeVisible()
  await app.page.screenshot({ path: testInfo.outputPath('session-package-delete.png') })
  await deleting.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(deleting).toHaveCount(0)
  const cleanupJournal = join(
    dirname(archive),
    'storage',
    'session-package-cleanup',
    `${identity.importId}.json`
  )
  expect(JSON.parse(await readFile(cleanupJournal, 'utf8'))).toMatchObject(identity)
  await app.restart()
  expect(
    await app.page.evaluate(
      async (id) => (await window.api.sessions.loadAll()).sessions.some((entry) => entry.id === id),
      identity.sessionId
    )
  ).toBe(false)
  await expect(
    app.page
      .getByRole('region', { name: 'Projects', exact: true })
      .getByRole('button', { name: 'Portable research', exact: true })
  ).toBeVisible()
  // Other live research in this fixture has Notebook/sidecar evidence. Conservatively retain
  // this entire package rather than treating the SQLite catalog as a complete reference index.
  const retainedIntent = await readFile(cleanupJournal, 'utf8')
  await testInfo.attach('retained-package-cleanup', {
    body: retainedIntent,
    contentType: 'application/json'
  })
  expect(JSON.parse(retainedIntent).retentionReason).toContain('External references')
  expect((await stat(archive)).size).toBeGreaterThan(0)
})

test('receives a package from cold launch arguments and a subsequent file-open event', async ({
  app
}, testInfo) => {
  await app.completeOnboarding()
  const archive = await app.configureSessionPackageDialogs()
  await writeFile(archive, 'No payload parsing before Project selection')
  const page = await app.restartWithPackage(archive)
  const dialog = page.getByRole('dialog', { name: 'Import Session package', exact: true })
  await expect(dialog.getByText('research.science', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled()
  await expect(dialog.getByText('Could not complete', { exact: false })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('file-open-cold.png') })
  await dialog.getByRole('button', { name: 'Hide progress' }).click()
  await app.emitPackageFileOpen(archive)
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(/^Waiting packages/)).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Cancel operation', exact: true }).click()
  await expect(dialog.getByText('Package operation cancelled', { exact: true })).toBeVisible()
})
