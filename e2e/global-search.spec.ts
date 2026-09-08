import { expect } from '@playwright/test'
import { suppressWorkspaceStarNudge, test } from './fixtures/electron-app'

test('opens a Library PDF from search without leaving the current results', async ({
  app
}, testInfo) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await suppressWorkspaceStarNudge(page)
  await page.evaluate(async () => {
    const { id } = await window.api.literature.transact({
      kind: 'create-item',
      item: {
        itemType: 'journalArticle',
        title: 'Search PDF paper',
        abstract: 'Search PDF abstract',
        issuedText: '',
        containerTitle: '',
        shortTitle: '',
        language: '',
        rights: '',
        url: '',
        extra: '',
        typeFields: {},
        creators: [],
        identifiers: []
      }
    })
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 5 0 R >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 5 0 R >>',
      '<< /Length 35 >>\nstream\n0.2 0.6 0.5 rg 60 540 492 160 re f\n\nendstream'
    ]
    let body = '%PDF-1.4\n'
    const offsets = objects.map((object, index) => {
      const offset = body.length
      body += `${index + 1} 0 obj\n${object}\nendobj\n`
      return offset
    })
    const xrefOffset = body.length
    body += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
    const chunk = new TextEncoder().encode(body)
    const transferId = crypto.randomUUID()
    await window.api.uploads.beginTransfer({
      transferId,
      name: 'search-paper.pdf',
      mimeType: 'application/pdf',
      size: chunk.length
    })
    await window.api.uploads.appendTransfer({ transferId, offset: 0, chunk })
    const attachment = await window.api.uploads.finishTransfer({ transferId })
    await window.api.literature.importPdf({ itemId: id, attachment })
  })
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Global search' })
  await dialog.getByRole('combobox', { name: 'Global search' }).fill('Search PDF paper')
  await dialog.locator('[data-category="library"]').click()
  await dialog.getByRole('listbox').getByRole('option').click()
  await expect(dialog.getByText('Search PDF abstract')).toBeVisible()
  await dialog.getByRole('tab', { name: 'Preview', exact: true }).click()
  await expect(
    dialog.getByRole('region', { name: 'search-paper.pdf scrollable preview' })
  ).toBeVisible()
  const pdf = dialog.locator('[data-pdf-preview-root]')
  await expect
    .poll(async () =>
      pdf
        .locator('canvas')
        .first()
        .evaluate((canvas: HTMLCanvasElement) => {
          const context = canvas.getContext('2d')!
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
          let colored = 0
          for (let i = 0; i < pixels.length; i += 4)
            if (pixels[i + 1] > pixels[i] + 40 && pixels[i + 3] > 0) colored++
          return colored
        })
    )
    .toBeGreaterThan(1000)
  const scroll = dialog.locator('.search-detail-content')
  const tabsTop = (await dialog.getByRole('tablist').boundingBox())!.y
  await scroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(100)
  expect((await dialog.getByRole('tablist').boundingBox())!.y).toBe(tabsTop)
  await dialog.screenshot({ path: testInfo.outputPath('search-pdf-continuous.png') })
  await dialog.getByRole('tab', { name: 'Details', exact: true }).click()
  expect(await scroll.evaluate((element) => element.scrollTop)).toBe(0)
  await dialog.getByRole('tab', { name: 'Preview', exact: true }).click()
  await dialog.getByRole('button', { name: 'Open file' }).click()
  const preview = page.getByRole('dialog', { name: 'Preview search-paper.pdf' })
  await expect(preview).toBeVisible()
  await expect(
    preview.getByRole('region', { name: 'search-paper.pdf scrollable preview' })
  ).toBeVisible()
  await preview.getByRole('button', { name: 'Close preview of search-paper.pdf' }).click()
  await expect(preview).toBeHidden()
  await expect(dialog.getByTestId('global-search-detail')).toHaveAttribute('data-open', 'true')
})

test('searches projects, sessions, message bodies and Library with paged disclosure previews', async ({
  app
}, testInfo) => {
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  await suppressWorkspaceStarNudge(page)
  const projectId = await page.evaluate(async () => {
    const project = await window.api.projects.create({
      name: 'Search research',
      description: 'Search fixture project'
    })
    const now = Date.now()
    for (let i = 0; i < 23; i++) {
      await window.api.sessions.saveSession({
        id: `search-session-${i}`,
        projectId: project.id,
        title: `Search session ${String(i).padStart(2, '0')}`,
        cwd: '/tmp',
        status: 'idle',
        createdAt: now - i,
        updatedAt: now - i,
        messages:
          i === 0
            ? Array.from({ length: 120 }, (_, index) => ({
                id: `search-message-${index}`,
                role: 'user' as const,
                status: 'complete' as const,
                content:
                  index === 8
                    ? 'First context line\nSecond context line\nThird context line\nHistorical needle in the message body\nFifth context line\nSixth context line\nSeventh context line'
                    : `Transcript entry ${index}`,
                eventIds: [],
                createdAt: now - 120 + index,
                updatedAt: now - 120 + index
              }))
            : []
      })
    }
    await window.api.literature.transact({ kind: 'create-collection', name: 'Search references' })
    return project.id
  })
  page = await app.restart()
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Global search' })
  const search = dialog.getByRole('combobox', { name: 'Global search' })
  const details = dialog.getByTestId('global-search-detail')
  await expect(details).toHaveAttribute('data-open', 'false')
  await search.fill('Search')
  const sessions = dialog.locator('[data-search-group="sessions"]')
  await expect(sessions.getByRole('option')).toHaveCount(10)
  const sessionHeading = sessions.locator('.search-group-heading')
  await expect(sessionHeading).toHaveCSS('box-shadow', 'none')
  await sessions.getByRole('button', { name: 'Load more 10/23' }).click()
  await expect(sessions.getByRole('option')).toHaveCount(20)
  const resultsViewport = dialog.locator('.global-search-list')
  await resultsViewport.evaluate((el) => {
    el.scrollTop = 180
  })
  await expect(sessionHeading).not.toHaveCSS('box-shadow', 'none')
  expect(
    Math.abs(
      (await sessions.locator('.search-group-heading').boundingBox())!.y -
        (await resultsViewport.boundingBox())!.y
    )
  ).toBeLessThanOrEqual(1)
  await dialog.screenshot({ path: testInfo.outputPath('global-search-sticky-heading.png') })
  await resultsViewport.evaluate((el) => {
    el.scrollTop = 0
  })
  await expect(sessionHeading).toHaveCSS('box-shadow', 'none')
  await sessions.getByRole('option').first().click()
  await dialog.locator('.global-search-body').evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((animation) => animation.finished))
  })
  await expect(details).toHaveAttribute('data-open', 'true')
  const order = dialog.getByRole('combobox', { name: 'Result order' })
  await order.focus()
  await order.press('Enter')
  await expect(page.getByRole('option', { name: 'Recently updated', exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('global-search-filter-menu.png') })
  await page.keyboard.press('Escape')
  await expect(order).toBeFocused()
  await expect(order).toHaveAttribute('aria-expanded', 'false')
  await expect(details).toHaveAttribute('data-open', 'true')
  await expect(dialog).toBeVisible()
  await expect(details.getByRole('tab', { name: 'Recent files' })).toBeVisible()
  await expect(details.locator('.search-detail-context')).toContainText('Search research')
  await expect(details.locator('.search-detail-context')).toContainText('#')
  await expect(details.locator('.search-detail-metrics')).toContainText('120 messages')
  await expect(details.locator('.search-detail-metrics')).toContainText('0 files')
  const headerLayout = await details.locator('header').evaluate((header) => {
    const title = header.querySelector('h3')!
    const context = header.querySelector('.search-detail-context')!
    const metrics = header.querySelector('.search-detail-metrics')!
    return {
      hasKindIcon: !!header.querySelector('.search-detail-kind-icon'),
      hasContextIcons: context.querySelectorAll('svg').length,
      contextBelowTitle:
        context.getBoundingClientRect().top >= title.getBoundingClientRect().bottom,
      metricsBelowContext:
        metrics.getBoundingClientRect().top >= context.getBoundingClientRect().bottom,
      titleFontSize: getComputedStyle(title).fontSize
    }
  })
  expect(headerLayout).toEqual({
    hasKindIcon: true,
    hasContextIcons: 2,
    contextBelowTitle: true,
    metricsBelowContext: true,
    titleFontSize: '15px'
  })
  await page.screenshot({ path: testInfo.outputPath('global-search-session-header.png') })
  await dialog.locator('[data-search-group="projects"]').getByRole('option').click()
  expect(
    await dialog.locator('.global-search-body').evaluate((el) => el.getAnimations().length)
  ).toBe(0)
  await expect(details.getByRole('tab', { name: 'Recent sessions' })).toBeVisible()
  await expect(details.locator('.search-detail-context')).toContainText('23 sessions')
  await expect(details.locator('.search-detail-context')).toContainText('0 files')
  await expect(details.getByRole('tabpanel').getByRole('button')).toHaveCount(10)
  await dialog.getByRole('button', { name: 'Collapse details' }).click()
  await dialog.locator('[data-category="sessions"]').click()
  await expect.poll(() => sessions.getByRole('option').count()).toBeGreaterThanOrEqual(10)
  await sessions.getByRole('option').last().scrollIntoViewIfNeeded()
  await dialog.locator('.global-search-list').hover()
  await page.mouse.wheel(0, 1200)
  await expect.poll(() => sessions.getByRole('option').count()).toBeGreaterThanOrEqual(20)
  await dialog.locator('[data-category="library"]').click()
  await dialog.locator('[data-search-group="library"]').getByRole('option').click()
  await expect(details.getByRole('tab', { name: 'Recent literature' })).toBeVisible()
  await details.getByRole('tab', { name: 'Details', exact: true }).click()
  await expect(details.getByRole('tabpanel')).toBeVisible()
  await dialog.locator('[data-category="all"]').click()
  await search.fill('Historical needle')
  const hit = dialog.locator('[data-search-group="messages"]').getByRole('option')
  await expect(hit).toHaveCount(1)
  await hit.click()
  await expect(details.getByRole('heading', { level: 3 })).toHaveText('First context line')
  await expect(details.locator('.search-detail-context')).toContainText('Search session 00')
  await expect(details.locator('.search-detail-context time')).toBeVisible()
  const excerpt = details.getByTestId('search-message-excerpt')
  await expect(excerpt.locator('mark')).toHaveText('Historical needle')
  const geometry = await excerpt.evaluate((element) => {
    const content = element.firstElementChild!
    const lineHeight = parseFloat(getComputedStyle(content).lineHeight)
    const top =
      element.querySelector('mark')!.getBoundingClientRect().top -
      element.getBoundingClientRect().top
    return { height: element.clientHeight, lineHeight, top }
  })
  expect(geometry.height).toBe(geometry.lineHeight * 7)
  expect(geometry.top).toBeGreaterThanOrEqual(geometry.lineHeight * 3)
  expect(geometry.top).toBeLessThan(geometry.lineHeight * 4)
  await page.screenshot({ path: testInfo.outputPath('global-search-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(details.getByRole('button', { name: 'Back to results' })).toBeVisible()
  await expect(details.getByRole('button', { name: 'Collapse details' })).toBeHidden()
  await expect(details.getByRole('button', { name: 'Jump to message' })).toBeVisible()
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('global-search-mobile.png') })
  await details.getByRole('button', { name: 'Back to results' }).click()
  await expect(details).toHaveAttribute('data-open', 'false')
  await hit.click()
  await page.setViewportSize({ width: 1280, height: 900 })
  await details.getByRole('button', { name: 'Jump to message' }).click()
  await expect(dialog).toBeHidden()
  const target = page.locator('[data-message-id="search-message-8"]').first()
  await expect(target).toBeVisible()
  await expect(target).toBeInViewport()
  expect(
    await page.evaluate(
      async (id) =>
        (await window.api.sessions.loadOne({ projectId: id, sessionId: 'search-session-0' }))
          ?.messages.length,
      projectId
    )
  ).toBe(120)
})

test('opens uploaded files from search using the existing file preview dialog', async ({ app }) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await suppressWorkspaceStarNudge(page)
  await page.getByRole('button', { name: 'New project', exact: true }).click()
  const create = page.getByRole('dialog', { name: 'New project' })
  await create.getByLabel('Name').fill('Search files')
  await create.getByRole('button', { name: 'Create project' }).click()
  await page.locator('input[type="file"][multiple]').setInputFiles({
    name: 'search-notes.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Search findings\n\nVerified file preview content.')
  })
  await page.getByRole('textbox', { name: 'Ask anything' }).fill('Read the attached notes.')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('Deterministic reply:', { exact: false })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+k')
  const dialog = page.getByRole('dialog', { name: 'Global search' })
  await dialog.getByRole('combobox', { name: 'Global search' }).fill('search-notes')
  await dialog.locator('[data-category="uploads"]').click()
  await dialog.getByRole('listbox').getByRole('option').click()
  await expect(
    dialog.getByTestId('global-search-detail').getByText('Verified file preview content.')
  ).toBeVisible()
  await dialog
    .getByTestId('global-search-detail')
    .getByRole('button', { name: 'Open full screen preview' })
    .click({ button: 'right' })
  await expect(page.getByTestId('search-preview-context-menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('search-preview-context-menu')).toBeHidden()
  await expect(dialog.getByTestId('global-search-detail')).toHaveAttribute('data-open', 'true')
  await dialog.getByRole('tab', { name: 'File information' }).click()
  await expect(dialog.getByText('File size', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Open file' }).click()
  await expect(page.getByRole('dialog', { name: 'Preview search-notes.md' })).toBeVisible()
  await expect(
    page
      .getByRole('dialog', { name: 'Preview search-notes.md' })
      .getByText('Verified file preview content.')
  ).toBeVisible()
})

test('keeps saved Notebook output and structured file previews visible inside search', async ({
  app
}, testInfo) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await suppressWorkspaceStarNudge(page)
  await page.getByRole('button', { name: 'New project', exact: true }).click()
  const create = page.getByRole('dialog', { name: 'New project' })
  await create.getByLabel('Name').fill('Search preview formats')
  await create.getByRole('button', { name: 'Create project' }).click()
  const notebook = JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { language_info: { name: 'python' }, retained: 'x'.repeat(1_100_000) },
    cells: [
      { cell_type: 'markdown', metadata: {}, source: ['# Search experiment\n', 'Saved analysis.'] },
      {
        cell_type: 'code',
        metadata: {},
        source: ['print(42)'],
        execution_count: 3,
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['Saved output: 42\n'] }]
      }
    ]
  })
  await page.locator('input[type="file"][multiple]').setInputFiles([
    {
      name: 'search-experiment.ipynb',
      mimeType: 'application/x-ipynb+json',
      buffer: Buffer.from(notebook)
    },
    {
      name: 'search-data.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('sample,result\ncontrol,42\ntreatment,84')
    },
    {
      name: 'search-molecule.smi',
      mimeType: 'chemical/x-daylight-smiles',
      buffer: Buffer.from('CCO')
    }
  ])
  await page
    .getByRole('textbox', { name: 'Ask anything' })
    .fill('Inspect the attached search files.')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('Deterministic reply:', { exact: false })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+k')
  const dialog = page.getByRole('dialog', { name: 'Global search' })
  const search = dialog.getByRole('combobox', { name: 'Global search' })
  await search.fill('search-')
  await dialog.locator('[data-category="uploads"]').click()
  await dialog.getByRole('combobox', { name: 'Refine category' }).click()
  await page.getByRole('option', { name: 'Notebook', exact: true }).click()
  await expect(dialog.getByRole('listbox').getByRole('option')).toHaveCount(1)
  await dialog.getByRole('listbox').getByRole('option').click()
  await expect(dialog.getByTestId('saved-notebook-preview')).toContainText('Saved output: 42')
  await dialog.screenshot({ path: testInfo.outputPath('search-saved-notebook.png') })
  await dialog.getByRole('combobox', { name: 'Refine category' }).click()
  await page.getByRole('option', { name: 'Spreadsheets / CSV', exact: true }).click()
  await expect(dialog.getByRole('listbox').getByRole('option')).toHaveCount(1)
  await dialog.getByRole('listbox').getByRole('option').click()
  await expect(dialog.locator('.search-csv-preview')).toContainText('treatment')
  expect(
    await dialog
      .locator('.search-csv-preview td')
      .first()
      .evaluate((el) => getComputedStyle(el).borderBottomWidth)
  ).toBe('0px')
  await dialog.getByRole('combobox', { name: 'Refine category' }).click()
  await page.getByRole('option', { name: 'All formats', exact: true }).click()
  await search.fill('search-molecule')
  await dialog.getByRole('listbox').getByRole('option').click()
  const structure = dialog.getByLabel('Structure preview of search-molecule.smi')
  await expect
    .poll(async () => structure.evaluate((el) => el.getBoundingClientRect().height))
    .toBeGreaterThan(100)
  await expect(structure.locator('svg')).toBeVisible()
  expect(
    await structure.locator('svg').evaluate((el) => el.getBoundingClientRect().height)
  ).toBeGreaterThan(20)
  await dialog.screenshot({ path: testInfo.outputPath('search-molecule.png') })
})

test('uses the same preview and information tabs for generated files', async ({
  app
}, testInfo) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await suppressWorkspaceStarNudge(page)
  await page.getByRole('button', { name: 'New project', exact: true }).click()
  const create = page.getByRole('dialog', { name: 'New project' })
  await create.getByLabel('Name').fill('Generated search previews')
  await create.getByRole('button', { name: 'Create project' }).click()
  await page
    .getByRole('textbox', { name: 'Ask anything' })
    .fill('Create preview context menu artifacts.')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(
    page.getByText('Preview context menu artifacts created.', { exact: true })
  ).toBeVisible({ timeout: 90_000 })
  await page.keyboard.press('ControlOrMeta+k')
  const dialog = page.getByRole('dialog', { name: 'Global search' })
  await dialog.getByRole('combobox', { name: 'Global search' }).fill('context-menu.html')
  await dialog.locator('[data-category="generated"]').click()
  await dialog.getByRole('listbox').getByRole('option').click()
  await expect(
    dialog
      .frameLocator('iframe[title="Preview of context-menu.html"]')
      .getByRole('heading', { name: 'HTML context menu fixture' })
  ).toBeVisible()
  await dialog.screenshot({ path: testInfo.outputPath('search-generated-file.png') })
  await dialog.getByRole('tab', { name: 'File information' }).click()
  await expect(dialog.getByRole('tabpanel')).toContainText('Generated files')
  await dialog.getByRole('button', { name: 'Open file' }).click()
  await expect(page.getByRole('dialog', { name: 'Preview context-menu.html' })).toBeVisible()
})
